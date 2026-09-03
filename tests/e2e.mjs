// e2e.mjs — install into a real repository and check every promise the CLI makes.
//
// Unit tests would pass while the thing that actually matters is broken: the
// installed tree. So this builds a scratch git repo, installs into it, and then
// tries to break the guarantees one at a time —
//
//   · does the install put files where each tool actually looks?
//   · does --dry-run genuinely write nothing?
//   · does update protect a file the user edited?
//   · does update restore a file the user deleted?
//   · do the gates still work FROM THE INSTALLED LOCATION, not just from source?
//   · does a second init refuse instead of overwriting?
//
//   node tests/e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pkgRoot } from "../src/cli/util.mjs";
import { hashFile } from "../src/cli/manifest.mjs";

const fails = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) fails.push(msg); };

const CLI = path.join(pkgRoot, "bin", "ai-qa.mjs");
const run = (cwd, args, opts = {}) =>
  spawnSync("node", [CLI, ...args], {
    cwd, encoding: "utf8", timeout: 180_000,
    env: { ...process.env, NO_COLOR: "1" }, ...opts,
  });

// ---- a repo that looks like a real project -----------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiqa-e2e-"));
const repo = path.join(tmp, "shop");
const write = (rel, text) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

write("package.json", JSON.stringify({
  name: "shop", scripts: { dev: "next dev", test: "vitest", seed: "tsx seed.ts" },
  dependencies: { next: "14.0.0", react: "18.0.0" },
}, null, 2));
write("README.md", "# Shop\n\nDev server: http://localhost:4000\n");
write("docs/specs/orders.md", "## AC1\nGiven a cart\nWhen I change the quantity\nThen the total recalculates\n");
write("docs/specs/checkout.md", "Checkout rules.\n");
write("prisma/schema.prisma", "model Order {\n  id Int @id\n  total Int\n}\n");
write(".env.example", "DATABASE_URL=\nJWT_SECRET=\n");
write("app/page.tsx", "export default function Page() { return null; }\n");
write(".gitignore", "node_modules/\n");

for (const args of [["init"], ["config", "user.email", "e2e@example.com"],
                    ["config", "user.name", "e2e"], ["add", "-A"],
                    ["commit", "-m", "fixture", "--no-gpg-sign"]]) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0 && args[0] !== "commit") {
    console.error(`git ${args.join(" ")} failed: ${r.stderr}`);
    process.exit(1);
  }
}

// ---- 1. scan works on a repo with nothing installed --------------------------
{
  const r = run(repo, ["scan"]);
  check(r.status === 0, `scan exited ${r.status}: ${r.stderr}`);
  check(/QA readiness/.test(r.stdout), "scan printed no readiness header");
  check(/\d+\/100/.test(r.stdout), "scan printed no score");
  check(!fs.existsSync(path.join(repo, ".ai-qa")), "scan must be read-only — it created .ai-qa");
}

// ---- 2. install ---------------------------------------------------------------
const initRes = run(repo, ["init", "--yes", "--key", "SHOP", "--language", "en",
  "--surfaces", "web,database", "--tools", "claude-code,cursor", "--tracker", "github"]);
check(initRes.status === 0, `init exited ${initRes.status}:\n${initRes.stdout}\n${initRes.stderr}`);

const exists = (rel) => fs.existsSync(path.join(repo, rel));
for (const rel of [
  "aiqa.config.yaml",
  ".ai-qa/manifest.json",
  ".ai-qa/scripts/evd_check.py",
  ".ai-qa/scripts/db_verify.py",
  ".ai-qa/scripts/browser.mjs",
  ".ai-qa/scripts/lib/ctx.py",
  ".ai-qa/profiles/web/gates.yaml",
  ".ai-qa/profiles/database/gates.yaml",
  "docs/qa/onboarding.md",
  "docs/qa/known-issues.md",
  "docs/qa/method/roles-qa.md",
  "docs/qa/method/severity.md",
  ".claude/skills/qa/SKILL.md",
  ".claude/skills/onboard/SKILL.md",
  ".cursor/rules/aiqa-qa.mdc",
]) check(exists(rel), `init did not create ${rel}`);

// Surfaces that were NOT chosen must not be installed — an api gate with no api
// is a gate nobody can satisfy and everybody learns to ignore.
check(!exists(".ai-qa/profiles/api/gates.yaml"), "api profile installed although api was not chosen");
check(!exists(".ai-qa/profiles/mobile/gates.yaml"), "mobile profile installed although mobile was not chosen");

// Tools that were not chosen get nothing.
check(!exists(".windsurf/workflows/qa.md"), "windsurf files installed although windsurf was not chosen");

// The detected values should have been picked up, not defaulted.
const cfgText = fs.readFileSync(path.join(repo, "aiqa.config.yaml"), "utf8");
check(/key: SHOP/.test(cfgText), "the ticket key was not written");
check(/surfaces: \[web, database\]/.test(cfgText), `surfaces line wrong:\n${cfgText.match(/surfaces:.*/)}`);
check(/start: 'npm run dev'/.test(cfgText), `start command not detected: ${cfgText.match(/start:.*/)}`);
check(/url: 'http:\/\/localhost:4000'/.test(cfgText), `URL not detected from the README: ${cfgText.match(/url:.*/)}`);
check(/schema: 'prisma\/schema\.prisma'/.test(cfgText), `schema not detected: ${cfgText.match(/schema:.*/)}`);
check(/url_env: 'DATABASE_URL'/.test(cfgText), "database env var not detected from .env.example");

// The gitignore is appended to, never replaced.
const gi = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
check(gi.startsWith("node_modules/"), "init overwrote the existing .gitignore instead of appending");
check(gi.includes("evd/**") && gi.includes(".env"), "init did not append its ignore rules");

// The rendered workflow must be surface-filtered and config-substituted.
const qaSkill = fs.readFileSync(path.join(repo, ".claude/skills/qa/SKILL.md"), "utf8");
check(qaSkill.includes("SHOP-nnn"), "the ticket key was not substituted into the workflow");
check(qaSkill.includes("http://localhost:4000"), "the app URL was not substituted into the workflow");
check(qaSkill.includes("db_verify.py"), "database was chosen but its tooling is missing from the workflow");
check(!/<!-- surface:/.test(qaSkill), "surface markers leaked into the rendered workflow");
check(!qaSkill.includes("cannot spawn subagents"), "claude-code should not carry the no-subagent note");

const cursorQa = fs.readFileSync(path.join(repo, ".cursor/rules/aiqa-qa.mdc"), "utf8");
check(cursorQa.includes("cannot spawn subagents"), "cursor is missing the no-subagent note");

// ---- 3. a second init must refuse ---------------------------------------------
{
  const r = run(repo, ["init", "--yes"]);
  check(r.status !== 0, "a second init should refuse rather than reinstall over the config");
  check(/already exists/.test(r.stdout + r.stderr), "the refusal should name the reason");
}

// ---- 4. the gates work FROM THE INSTALLED LOCATION ----------------------------
for (const [label, cmd, args] of [
  ["evidence gate", "python3", [".ai-qa/scripts/evd_check.py", "--selftest"]],
  ["write guard", "python3", [".ai-qa/scripts/db_verify.py", "--selftest"]],
  ["api recorder", "node", [".ai-qa/scripts/api_check.mjs", "--selftest"]],
]) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", timeout: 120_000 });
  check(r.status === 0, `${label} failed from the installed tree:\n${r.stdout}${r.stderr}`);
}

// The installed Python reader must see what the CLI wrote.
{
  const r = spawnSync("python3", [".ai-qa/scripts/lib/ctx.py", "project.key"],
    { cwd: repo, encoding: "utf8" });
  check(r.stdout.trim() === "SHOP", `installed ctx.py read project.key as ${JSON.stringify(r.stdout.trim())}`);
}
// app_check must SKIP (not crash) when the app is simply not running.
{
  const r = spawnSync("bash", [".ai-qa/scripts/app_check.sh"], { cwd: repo, encoding: "utf8", timeout: 60_000 });
  check(/APP: (UP|DOWN)/.test(r.stdout), `app_check said: ${r.stdout.trim()}`);
  check(/unblock:/.test(r.stdout) || /APP: UP/.test(r.stdout),
    "a DOWN app must print an unblock path");
}

// ---- 5. doctor ----------------------------------------------------------------
{
  const r = run(repo, ["doctor"]);
  check(r.status === 0, `doctor went red on a fresh install:\n${r.stdout}`);
  check(/doctor: (GREEN|AMBER)/.test(r.stdout), `doctor printed no verdict:\n${r.stdout}`);
  check(/Node and Python read the same config/.test(r.stdout), "doctor did not compare the two config parsers");
}

// ---- 6. --dry-run must write nothing ------------------------------------------
{
  const snapshot = () => {
    const out = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else out[path.relative(repo, abs)] = hashFile(abs);
      }
    };
    walk(repo);
    return out;
  };
  const before = snapshot();
  const r = run(repo, ["update", "--dry-run"]);
  check(r.status === 0, `update --dry-run exited ${r.status}: ${r.stderr}`);
  check(/nothing was written/i.test(r.stdout), "dry run did not say it wrote nothing");
  const after = snapshot();
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  check(changed.length === 0, `--dry-run modified ${changed.length} file(s): ${changed.slice(0, 5).join(", ")}`);
  check(added.length === 0, `--dry-run created ${added.length} file(s): ${added.slice(0, 5).join(", ")}`);
  check(removed.length === 0, `--dry-run deleted ${removed.length} file(s): ${removed.slice(0, 5).join(", ")}`);
}

// ---- 7. update protects an edited file ----------------------------------------
{
  const edited = path.join(repo, ".ai-qa/scripts/evd_check.py");
  const mine = "# MY LOCAL EDIT — this must survive an update\n" + fs.readFileSync(edited, "utf8");
  fs.writeFileSync(edited, mine);

  const r = run(repo, ["update"]);
  check(r.status === 0, `update exited ${r.status}: ${r.stderr}`);
  check(fs.readFileSync(edited, "utf8") === mine,
    "update CLOBBERED a file the user had edited — the central promise of the manifest");
  check(/left alone/.test(r.stdout), "update did not report the file it skipped");
  check(/evd_check\.py/.test(r.stdout), "update did not name the skipped file");
}

// ---- 8. update restores a deleted file ----------------------------------------
{
  const gone = path.join(repo, ".ai-qa/scripts/annotate.py");
  fs.rmSync(gone);
  const r = run(repo, ["update"]);
  check(r.status === 0, `update exited ${r.status}`);
  check(fs.existsSync(gone), "update did not restore a deleted gate");
}

// ---- 9. update never reverts a hand-edited config ------------------------------
{
  const cfgPath = path.join(repo, "aiqa.config.yaml");
  const edited = fs.readFileSync(cfgPath, "utf8").replace("level: assisted", "level: full");
  fs.writeFileSync(cfgPath, edited);
  run(repo, ["update"]);
  check(fs.readFileSync(cfgPath, "utf8").includes("level: full"),
    "update reverted a hand-edited config — the one file the user is meant to own");
}

// ---- 10. doctor detects a broken install ---------------------------------------
{
  fs.rmSync(path.join(repo, ".ai-qa/scripts/lib/ctx.py"));
  const r = run(repo, ["doctor"]);
  check(r.status !== 0, "doctor stayed green with a gate library missing");
  check(/RED/.test(r.stdout), "doctor did not print a RED verdict for a broken install");
  run(repo, ["update"]); // put it back
}

// ---- 11. an evidence folder that is missing things goes red --------------------
{
  const evd = path.join(repo, "evd", "SHOP-1", "TC_1");
  fs.mkdirSync(evd, { recursive: true });
  fs.writeFileSync(path.join(evd, "manifest.md"), "RESULT: PASS\n");
  const r = spawnSync("python3", [".ai-qa/scripts/evd_check.py", "--evd", "evd/SHOP-1", "--expect-tcs", "3"],
    { cwd: repo, encoding: "utf8" });
  check(r.status === 1, `a half-finished evidence folder should exit 1, got ${r.status}`);
  check(/EVIDENCE: RED/.test(r.stdout), "the gate did not report RED");
  check(/planned 3/.test(r.stdout), "the gate did not catch 'planned 3, ran 1'");
  fs.rmSync(path.join(repo, "evd"), { recursive: true, force: true });
}

// ---- 12. install into a repo with NOTHING detectable ---------------------------
{
  const bare = path.join(tmp, "bare");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, "README.md"), "# nothing here\n");
  spawnSync("git", ["init"], { cwd: bare, encoding: "utf8" });
  const r = run(bare, ["init", "--yes", "--key", "X"]);
  check(r.status === 0, `init failed on a bare repo:\n${r.stdout}${r.stderr}`);
  const cfg = fs.readFileSync(path.join(bare, "aiqa.config.yaml"), "utf8");
  check(/start: ''/.test(cfg), "an undetectable start command must be recorded as EMPTY, not guessed");
  check(/url: ''/.test(cfg), "an undetectable URL must be recorded as EMPTY, not guessed");
  const skill = fs.readFileSync(path.join(bare, ".claude/skills/qa/SKILL.md"), "utf8");
  check(skill.includes("Environment: NOT CONFIGURED"),
    "with no app configured the workflow must render the not-configured branch");
  check(/BLOCKED, not skipped/.test(skill),
    "the not-configured branch must say cases get BLOCKED, not silently skipped");
}

// ---- report --------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
if (fails.length) {
  console.error(`e2e: ${fails.length} FAILED of ${checks} checks\n`);
  for (const f of fails) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`e2e: ${checks} checks passed`);
