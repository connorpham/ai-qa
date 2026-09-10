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
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { pkgRoot } from "../src/cli/util.mjs";
import { hashFile } from "../src/cli/manifest.mjs";
import { clientFrame, decodeFrames } from "../src/ui/studio/terminal.mjs";

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

// The two numbers init prints must agree with each other AND with the repo.
// They used to disagree three ways: the summary counted the plan and the seeds
// but not the rendered workflows, the result counted the plan and the workflows
// but not the seeds, and neither counted the ignore rules or the manifest — so
// "23 files" then "22 files written" described an install that created 30.
{
  const planned = /^\s+(\d+) files —/m.exec(initRes.stdout);
  const written = /(\d+) files written/.exec(initRes.stdout);
  check(!!planned, "the install summary did not say how many files it would write");
  check(!!written, "init did not report how many files it wrote");
  const st = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" });
  const touched = st.stdout.split("\n").filter((l) => l.trim()).length;
  check(!!written && Number(written[1]) === touched,
    `init reported ${written && written[1]} files written; the repo shows ${touched} created or modified`);
  check(!!planned && !!written && planned[1] === written[1],
    `the summary promised ${planned && planned[1]} files and the install reported ${written && written[1]}`);
}

const exists = (rel) => fs.existsSync(path.join(repo, rel));
for (const rel of [
  "aiqa.config.yaml",
  ".ai-qa/manifest.json",
  ".ai-qa/scripts/evd_check.py",
  ".ai-qa/scripts/evd_index.py",
  ".ai-qa/scripts/db_verify.py",
  ".ai-qa/scripts/browser.mjs",
  ".ai-qa/scripts/lib/ctx.py",
  ".ai-qa/scripts/tracker.py",
  ".ai-qa/scripts/lib/trackers.py",
  ".ai-qa/profiles/web/gates.yaml",
  ".ai-qa/profiles/database/gates.yaml",
  "docs/qa/onboarding.md",
  "docs/qa/known-issues.md",
  "docs/qa/method/roles-qa.md",
  "docs/qa/method/severity.md",
  "docs/qa/method/user-mindset.md",
  "docs/qa/method/heuristics.md",
  "docs/qa/method/hostile-inputs.md",
  "docs/qa/method/requirement-smells.md",
  "docs/qa/method/checklists.md",
  "docs/qa/method/case-writing.md",
  "docs/qa/method/report-writing.md",
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
// …and the environments the install wrote resolve from the installed tree:
// local by default, inheriting app.url — and an environment nobody declared
// resolves to NOTHING, so a run blocks instead of testing localhost as "stg".
{
  const env = { ...process.env };
  delete env.AIQA_ENV;
  const q = (key, name) => spawnSync("python3", [".ai-qa/scripts/lib/ctx.py", key],
    { cwd: repo, encoding: "utf8", env: name ? { ...env, AIQA_ENV: name } : env }).stdout.trim();
  check(q("env.name") === "local", `installed default environment is ${JSON.stringify(q("env.name"))}`);
  check(q("env.url") === q("app.url") || (q("env.url") === "" && q("app.url") === ""),
    `local must inherit app.url from the installed config: env.url=${q("env.url")} app.url=${q("app.url")}`);
  check(q("env.url", "stg") === "", "an undeclared stg resolved to a url — a run could lie about where it ran");
  const skip = spawnSync("bash", [".ai-qa/scripts/app_check.sh"],
    { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...env, AIQA_ENV: "stg" } });
  check(/APP: SKIP\s+environment 'stg' has no url/.test(skip.stdout),
    `app_check on an undeclared environment must SKIP naming it:\n${skip.stdout.trim()}`);
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
  check(skill.includes("Working language: English"),
    "the installed workflow does not carry the working-language block");
}

// ---- 12b. a Vietnamese install works in Vietnamese, end to end -----------------
{
  const viRepo = path.join(tmp, "vi");
  fs.mkdirSync(viRepo, { recursive: true });
  fs.writeFileSync(path.join(viRepo, "README.md"), "# demo\n");
  spawnSync("git", ["init"], { cwd: viRepo, encoding: "utf8" });
  const r = run(viRepo, ["init", "--yes", "--key", "VN", "--language", "vi"]);
  check(r.status === 0, `init --language vi failed:\n${r.stdout}${r.stderr}`);
  const skill = fs.readFileSync(path.join(viRepo, ".claude/skills/qa/SKILL.md"), "utf8");
  check(skill.includes("Working language: Tiếng Việt"),
    "a vi install must name Tiếng Việt as the working language");
  check(skill.includes('EXPECTED: "Tổng cộng" hiển thị 450.000'),
    "a vi install lost the worked example — an English key with a Vietnamese value");
}


// ---- 13. a credentialled tracker: coordinates in the config, secrets in env ----
{
  const tracked = path.join(tmp, "tracked");
  fs.mkdirSync(tracked, { recursive: true });
  fs.writeFileSync(path.join(tracked, "README.md"), "# tracked\n");
  fs.writeFileSync(path.join(tracked, ".env.example"), "APP_PORT=3000\n");
  spawnSync("git", ["init"], { cwd: tracked, encoding: "utf8" });

  const r = run(tracked, ["init", "--yes", "--key", "SHOP", "--tracker", "backlog",
    "--tracker-url", "https://acme.backlog.com", "--tracker-project", "SHOP"]);
  check(r.status === 0, `init with a backlog tracker failed:\n${r.stdout}${r.stderr}`);

  const cfg = fs.readFileSync(path.join(tracked, "aiqa.config.yaml"), "utf8");
  check(/provider: backlog/.test(cfg), "the tracker provider was not written");
  check(/base_url: 'https:\/\/acme\.backlog\.com'/.test(cfg), `base_url not written: ${cfg.match(/base_url:.*/)}`);
  check(/project: 'SHOP'/.test(cfg), "tracker project not written");
  check(!/BACKLOG_API_KEY\s*[:=]\s*\S/.test(cfg),
    "a credential VALUE reached the config — the config is committed, this would be a leak");

  // .env.example gets the NAME, appended, with the existing content intact.
  const envEx = fs.readFileSync(path.join(tracked, ".env.example"), "utf8");
  check(envEx.startsWith("APP_PORT=3000"), "init overwrote .env.example instead of appending");
  check(/^BACKLOG_API_KEY=$/m.test(envEx),
    `init did not add the credential NAME to .env.example:\n${envEx}`);

  // With no credential in the environment: BLOCKED (exit 2), and it must name
  // the variable. Exit 1 would mean "no such ticket", which is a different story.
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.BACKLOG_API_KEY;
  const chk = spawnSync("python3", [".ai-qa/scripts/tracker.py", "check"],
    { cwd: tracked, encoding: "utf8", env, timeout: 60_000 });
  check(chk.status === 2, `a missing credential should exit 2 (BLOCKED), got ${chk.status}:\n${chk.stdout}`);
  check(/BACKLOG_API_KEY/.test(chk.stdout), `the block did not name the variable:\n${chk.stdout}`);
  check(/MISSING/.test(chk.stdout), "the check did not mark the variable as missing");
  check(/acme\.backlog\.com/.test(chk.stdout), "the check did not echo the configured space URL");

  const st = spawnSync("python3", [".ai-qa/scripts/tracker.py", "--selftest"],
    { cwd: tracked, encoding: "utf8", timeout: 120_000 });
  check(st.status === 0, `tracker selftest failed from the installed tree:\n${st.stdout}${st.stderr}`);
}

// ---- 14. the markdown tracker reads a ticket and judges its testability -------
{
  const md = path.join(tmp, "mdtracker");
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(path.join(md, "README.md"), "# md\n");
  spawnSync("git", ["init"], { cwd: md, encoding: "utf8" });
  check(run(md, ["init", "--yes", "--key", "SHOP", "--tracker", "markdown"]).status === 0,
    "init with the markdown tracker failed");

  const tdir = path.join(md, "docs", "qa", "tickets");
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "SHOP-1.md"),
    "# Order total does not recalculate\nStatus: In Review\nAssignee: Mai\n\n" +
    "Acceptance criteria\n- AC1 the total updates after changing quantity\n");

  const out = path.join(md, "evd", "SHOP-1", "ticket.md");
  const g = spawnSync("python3", [".ai-qa/scripts/tracker.py", "get", "SHOP-1", "--out", "evd/SHOP-1/ticket.md"],
    { cwd: md, encoding: "utf8", timeout: 60_000 });
  check(g.status === 0, `markdown get failed:\n${g.stdout}${g.stderr}`);
  check(fs.existsSync(out), "the rendered ticket was not written");
  const text = fs.readFileSync(out, "utf8");
  check(text.includes("Order total does not recalculate"), "the title is missing from the rendered ticket");
  check(text.includes("DATA, not the oracle"),
    "the rendered ticket lost the banner that stops it being treated as the specification");
  check(text.includes("In Review"), "the status is missing");
  check(/Acceptance criteria are present/.test(text),
    "a ticket WITH criteria was not recognised as such");
  check(/ready to verify/.test(text), "a deliverable status was not recognised");

  // A ticket that is only prose must be told so, and an undelivered one too.
  fs.writeFileSync(path.join(tdir, "SHOP-2.md"),
    "# Make the button nicer\nStatus: In Progress\n\nplease fix the orders page\n");
  const g2 = spawnSync("python3", [".ai-qa/scripts/tracker.py", "get", "SHOP-2"],
    { cwd: md, encoding: "utf8", timeout: 60_000 });
  check(/No acceptance criteria found/.test(g2.stdout),
    "prose with no criteria was not flagged in the rendered ticket");
  check(/BLOCKED \(not delivered\)/.test(g2.stdout),
    "an In Progress ticket was not flagged as undelivered");

  // A ticket that does not exist is exit 1 (not found), never exit 2 (blocked).
  const g3 = spawnSync("python3", [".ai-qa/scripts/tracker.py", "get", "SHOP-404"],
    { cwd: md, encoding: "utf8", timeout: 60_000 });
  check(g3.status === 1, `a missing ticket should exit 1, got ${g3.status}: ${g3.stdout}`);
  check(/NOT FOUND/.test(g3.stdout), "a missing ticket did not say NOT FOUND");
}


// ---- 15. the probe reports a real status, and doctor probes once ---------------
// Both bugs here came from the first install into a real repo, which is where
// they were always going to come from: a monorepo declaring web AND api ran the
// same 60-second app probe twice, and reported the result as "HTTP 000000".
{
  const probed = path.join(tmp, "probed");
  fs.mkdirSync(probed, { recursive: true });
  fs.writeFileSync(path.join(probed, "README.md"), "# probed\n");
  spawnSync("git", ["init"], { cwd: probed, encoding: "utf8" });
  check(run(probed, ["init", "--yes", "--key", "P", "--surfaces", "web,api",
    "--start", "npm run dev", "--url", "http://127.0.0.1:1"]).status === 0,
    "init for the probe test failed");

  // A host that refuses the connection: curl prints 000, and the script must not
  // concatenate its own fallback onto it.
  const dead = spawnSync("bash", [".ai-qa/scripts/app_check.sh", "--url", "http://127.0.0.1:1"],
    { cwd: probed, encoding: "utf8", timeout: 60_000 });
  check(/APP: DOWN/.test(dead.stdout), `an unreachable app should be DOWN: ${dead.stdout.trim()}`);
  check(!/000000/.test(dead.stdout), `malformed status code in: ${dead.stdout.trim()}`);
  check(/no answer|HTTP 000\b/.test(dead.stdout), `the status should read as 000: ${dead.stdout.trim()}`);
  check(/unblock:/.test(dead.stdout), "a DOWN probe must print an unblock path");

  // --wait is for a lane waiting on a boot. A health check caps it, or every
  // doctor run on a laptop with the app off costs a minute per surface.
  const t0 = Date.now();
  spawnSync("bash", [".ai-qa/scripts/app_check.sh", "--url", "http://127.0.0.1:1", "--wait", "60"],
    { cwd: probed, encoding: "utf8", timeout: 90_000, env: { ...process.env, AIQA_PROBE_ONLY: "1" } });
  const capped = Date.now() - t0;
  check(capped < 25_000, `AIQA_PROBE_ONLY did not cap a --wait 60 probe (took ${Math.round(capped / 1000)}s)`);

  // web and api both declare the app probe; doctor must run it once.
  const doc = run(probed, ["doctor"]);
  const appLines = (doc.stdout.match(/^\s*[·✓]\s+app\s/gm) || []).length;
  check(appLines === 1, `doctor ran the app preflight ${appLines} times; it should dedupe to 1`);
  check(/doctor: (GREEN|AMBER)/.test(doc.stdout), `doctor verdict missing:\n${doc.stdout.slice(-400)}`);
}

// ---- 12. the studio boots, is fenced by its token, and reads this repo --------
{
  // AIQA_HOME: the studio's registry goes into the fixture's temp dir, not
  // into ~/.ai-qa on whoever runs the suite. (It used to. Quietly.)
  const aiqaHome = path.join(tmp, "aiqa-home");
  // A fake agent CLI on PATH: the terminal must be provable without a real
  // agent, a network, or an account. `codex` is one of the names the studio
  // looks for; this one greets, echoes one line back, and exits 0.
  const fakeBin = path.join(tmp, "fakebin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "codex"), "#!/bin/sh\nprintf 'fake codex ready\\n'\nread line\nprintf 'you said: %s\\n' \"$line\"\nexit 0\n", { mode: 0o755 });
  const studio = spawn(process.execPath, [CLI, "studio", "--port", "0", "--no-open"],
    { cwd: repo, env: { ...process.env, NO_COLOR: "1", AIQA_NO_OPEN: "1", AIQA_HOME: aiqaHome, PATH: `${fakeBin}:${process.env.PATH}` } });
  let out = "";
  const url = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 25_000);
    studio.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/([a-f0-9]{16,})\//);
      if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${m[1]}`, token: m[2] }); }
    });
  });
  check(!!url, `studio did not print a URL within 25s:\n${out.slice(0, 400)}`);
  if (url) {
    const get = async (p) => { const r = await fetch(`${url.base}${p}`); return { status: r.status, text: await r.text() }; };
    check((await get("/api/state")).status === 404, "the studio answered a request with no token");
    check((await get(`/${"0".repeat(24)}/api/state`)).status === 404, "the studio answered a request with the wrong token");
    const page = await get(`/${url.token}/`);
    check(page.status === 200 && /window\.STUDIO = \{/.test(page.text), "the studio page did not render with its boot state");
    check(!/window\.STUDIO = .*<\/script>/s.test(page.text.split("window.STUDIO")[1]?.slice(0, 200) || ""), "the boot state was injected without escaping");
    const st = JSON.parse((await get(`/${url.token}/api/state`)).text);
    check(st.state.project.key === "SHOP", `studio read project.key as ${st.state.project.key}`);
    check(Array.isArray(st.engines) && st.engines.length >= 2, "the studio did not report its engines");
    check(st.engines.every((e) => typeof e.available === "boolean" && typeof e.reason === "string"),
      "an engine did not say whether it is available and why");
    const trav = await get(`/${url.token}/api/evd/file?path=${encodeURIComponent("../../aiqa.config.yaml")}`);
    check(trav.status === 404, "the evidence viewer served a file outside evd/");
    const bad = await fetch(`${url.base}/${url.token}/api/compile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flow: { name: "x", nodes: [] } }) });
    check(bad.status === 422, `an invalid flow compiled anyway (${bad.status})`);

    // -- the registry landed in AIQA_HOME, and the fixture registered itself as a project
    check(fs.existsSync(path.join(aiqaHome, "studio.json")), "the studio did not write its registry under AIQA_HOME");
    check(!fs.readFileSync(path.join(aiqaHome, "studio.json"), "utf8").includes(os.homedir() + "/.ai-qa"), "the registry under AIQA_HOME still points at the real home");
    check(st.state.projects.list.some((p) => p.path === fs.realpathSync(repo)), "the folder the studio started in was not registered as a project");

    // -- choosing a project: the folder picker lists one level, marks repositories
    const fsList = JSON.parse((await get(`/${url.token}/api/fs?path=${encodeURIComponent(tmp)}`)).text);
    const shopEntry = fsList.entries.find((e) => e.name === "shop");
    check(!!shopEntry && shopEntry.isRepo === true && shopEntry.hasLane === true, `the folder picker did not mark shop as a repository with the lane: ${JSON.stringify(shopEntry)}`);
    check(fsList.parent === path.dirname(tmp), "the folder picker did not report the parent folder");
    const fsBad = JSON.parse((await get(`/${url.token}/api/fs?path=${encodeURIComponent(path.join(tmp, "nope"))}`)).text);
    check(fsBad.error === "no such folder" && fsBad.entries.length === 0, `a missing folder was not reported as such: ${JSON.stringify(fsBad).slice(0, 120)}`);

    // -- choosing a project: clone from a URL, streamed. file:// keeps the suite off the network.
    const sse = async (p, body) => {
      const r = await fetch(`${url.base}/${url.token}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await r.text();
      const events = text.split("\n\n").filter((c) => c.startsWith("data:")).map((c) => JSON.parse(c.slice(5).trim()));
      return { status: r.status, events, done: events.find((e) => e.type === "done") };
    };
    const badClone = await sse("/api/clone", { url: "not a url at all" });
    check(badClone.done && badClone.done.ok === false && /not a git URL/.test(badClone.done.error), `a non-URL was accepted for cloning: ${JSON.stringify(badClone.done)}`);
    const cloneDest = path.join(tmp, "cloned-shop");
    const goodClone = await sse("/api/clone", { url: `file://${repo}`, into: cloneDest });
    check(goodClone.done && goodClone.done.ok === true, `cloning a local file:// repository failed: ${JSON.stringify(goodClone.done).slice(0, 300)}`);
    check(goodClone.events.some((e) => e.type === "progress"), "the clone streamed no progress lines");
    // the fixture committed before `init` ran, so the clone has package.json but no lane — and says so
    check(fs.existsSync(path.join(cloneDest, ".git")) && fs.existsSync(path.join(cloneDest, "package.json")), "the clone did not land where it was asked to");
    check(goodClone.done?.info?.hasLane === false, "the clone claimed a lane it does not have (aiqa.config.yaml was never committed)");
    check(goodClone.done?.state?.projects?.list?.some((p) => p.path === fs.realpathSync(cloneDest)), "the clone was not registered as a project");
    const twice = await sse("/api/clone", { url: `file://${repo}`, into: cloneDest });
    check(twice.done && twice.done.ok === false && /already exists/.test(twice.done.error), "cloning over a non-empty folder was allowed");
    // back to the fixture project for the rest
    const fixtureId = goodClone.done.state.projects.list.find((p) => p.path === fs.realpathSync(repo)).id;
    await fetch(`${url.base}/${url.token}/api/projects/active`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: fixtureId }) });

    // -- a flow carries its own agent; the studio refuses one it does not know
    const put = (name, flow) => fetch(`${url.base}/${url.token}/api/flows/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(flow) });
    const okFlow = await put("shop_1_acceptance", { version: 1, name: "shop_1_acceptance", ticket: "SHOP-1", kind: "acceptance", agent: "claude", worktree: null, nodes: [], edges: [] });
    check(okFlow.status === 200, `saving a flow with an agent failed (${okFlow.status})`);
    const badAgent = await put("shop_2_acceptance", { version: 1, name: "shop_2_acceptance", ticket: "SHOP-2", kind: "acceptance", agent: "hal9000", nodes: [], edges: [] });
    check(badAgent.status === 400, `a flow with an unknown agent was saved (${badAgent.status})`);
    const flows = JSON.parse((await get(`/${url.token}/api/flows`)).text).flows;
    const f1 = flows.find((f) => f.name === "shop_1_acceptance");
    check(!!f1 && f1.agent === "claude" && f1.ticket === "SHOP-1" && f1.result === null, `the flow list did not carry the flow's agent/ticket/result: ${JSON.stringify(f1)}`);
    const opened = await fetch(`${url.base}/${url.token}/api/flows/shop_1_acceptance/open`, { method: "POST" }).then((r) => r.json());
    check(opened.agent && opened.agent.id === "claude" && opened.agent.chosen === true, `opening the flow did not resolve its own agent: ${JSON.stringify(opened.agent)}`);
    check(opened.state.cwd === fs.realpathSync(repo), "opening a flow with no worktree moved the cwd somewhere else");

    // -- the agent's terminal: a real pty over a WebSocket, driving the fake agent on PATH
    check(st.state.agents.find((a) => a.id === "codex")?.installed === true, "the fake codex on PATH was not detected as installed");
    const putTerm = await put("shop_3_terminal", { version: 1, name: "shop_3_terminal", ticket: "SHOP-3", kind: "acceptance", agent: "codex", nodes: [], edges: [] });
    check(putTerm.status === 200, `could not save the terminal test flow (${putTerm.status})`);
    const port = Number(new URL(url.base).port);
    /** Open the socket by hand: the upgrade request, then frames. Resolves with the
     *  HTTP status line, every status message, and the bytes the pty printed. */
    const wsSession = (query, { onText = () => {}, until = () => false, timeout = 15000 } = {}) => new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      const statuses = []; let buf = Buffer.alloc(0); let httpLine = null; let text = ""; let sentHello = false;
      const finish = (why) => { clearTimeout(timer); try { sock.destroy(); } catch { /* closed */ } resolve({ httpLine, statuses, text, why }); };
      const timer = setTimeout(() => finish("timeout"), timeout);
      sock.on("connect", () => sock.write(`GET /${url.token}/api/term?${query} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (httpLine === null) {
          const i = buf.indexOf("\r\n\r\n"); if (i < 0) return;
          httpLine = buf.subarray(0, i).toString().split("\r\n")[0]; buf = buf.subarray(i + 4);
          if (!/ 101 /.test(httpLine)) { finish("not upgraded"); return; }
        }
        const { frames, rest } = decodeFrames(buf); buf = Buffer.from(rest);
        for (const f of frames) {
          if (f.opcode === 1) { try { statuses.push(JSON.parse(f.payload.toString())); } catch { /* not json */ } }
          else if (f.opcode === 2) text += f.payload.toString();
        }
        if (!sentHello && /fake codex ready/.test(text)) { sentHello = true; onText(sock); }
        if (until({ statuses, text })) finish("done");
      });
      sock.on("error", (e) => finish(`socket error: ${e.message}`));
      sock.on("close", () => finish("closed"));
    });
    const run1 = await wsSession("flow=shop_3_terminal&cols=80&rows=24", {
      onText: (sock) => sock.write(clientFrame(2, "hello\r")),
      until: ({ statuses, text }) => statuses.some((s) => s.state === "exited") && /you said: hello/.test(text),
    });
    check(run1.httpLine === "HTTP/1.1 101 Switching Protocols", `the terminal socket did not upgrade: ${run1.httpLine} (${run1.why})`);
    check(run1.statuses.some((s) => s.state === "running" && s.command === "codex"), `the terminal did not report the fake agent running: ${JSON.stringify(run1.statuses.map((s) => [s.state, s.command]))}`);
    check(/fake codex ready/.test(run1.text), `the agent's output did not reach the socket: ${JSON.stringify(run1.text.slice(0, 120))}`);
    check(/you said: hello/.test(run1.text), `keystrokes sent over the socket did not reach the agent's pty: ${JSON.stringify(run1.text.slice(0, 200))} (${run1.why})`);
    check(run1.statuses.some((s) => s.state === "exited" && s.exitCode === 0), `the agent's exit was not reported with its code: ${JSON.stringify(run1.statuses.map((s) => [s.state, s.exitCode]))}`);
    // reattaching to the finished session replays what it printed, and says it exited
    const run2 = await wsSession("flow=shop_3_terminal", { until: ({ statuses, text }) => statuses.length > 0 && /you said: hello/.test(text), timeout: 5000 });
    check(run2.statuses[0]?.state === "exited" && /fake codex ready/.test(run2.text) && /you said: hello/.test(run2.text), `reattaching did not replay the finished session: ${run2.why} ${JSON.stringify(run2.statuses[0])}`);
    // ?restart=1 starts the agent again
    const run3 = await wsSession("flow=shop_3_terminal&restart=1", { until: ({ statuses, text }) => statuses.some((s) => s.state === "running") && /fake codex ready/.test(text), timeout: 8000 });
    check(run3.statuses.some((s) => s.state === "running") && (run3.text.match(/fake codex ready/g) || []).length === 1, `restart did not start a fresh session: ${run3.why} ${JSON.stringify(run3.text.slice(0, 80))}`);
    const termList = JSON.parse((await get(`/${url.token}/api/term`)).text);
    check(termList.available === true && termList.sessions.some((s) => s.flow === "shop_3_terminal" && s.running === true), `the session list does not show the restarted terminal: ${JSON.stringify(termList).slice(0, 200)}`);
    const flowsAfter = JSON.parse((await get(`/${url.token}/api/flows`)).text).flows.find((f) => f.name === "shop_3_terminal");
    check(flowsAfter?.terminal?.running === true, "the flow list does not carry the terminal's state");
    const killed = await fetch(`${url.base}/${url.token}/api/term/shop_3_terminal`, { method: "DELETE" }).then((r) => r.json());
    check(killed.killed === true, "DELETE /api/term/<flow> did not stop the running agent");
    const noFlow = await wsSession("flow=does_not_exist", { timeout: 3000 });
    check(/ 404 /.test(noFlow.httpLine || ""), `a terminal for a flow that does not exist was opened: ${noFlow.httpLine}`);
  }
  studio.kill("SIGTERM");
}

// ---- report --------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
if (fails.length) {
  console.error(`e2e: ${fails.length} FAILED of ${checks} checks\n`);
  for (const f of fails) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`e2e: ${checks} checks passed`);
