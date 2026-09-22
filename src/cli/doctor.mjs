// doctor.mjs — `ai-qa doctor`: green doctor is the definition of installed.
//
// Three questions, in order:
//   1. Is the config there and readable by BOTH parsers? (Node and Python must
//      agree, or a gate reads a different config than the CLI wrote.)
//   2. Are the installed files intact? (manifest hashes — missing is broken,
//      drifted is yours and we say so without touching it.)
//   3. Can every gate still FAIL? Each one runs its own --selftest. A gate
//      trusted rather than tested is a gate that has quietly stopped working.
//
// Preflight checks (is the app up, is there a browser) are reported but never
// fatal: a laptop with the app switched off is not a broken installation.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitRoot, repoRoot, readIfExists, c, say } from "./util.mjs";
import { CONFIG_NAME, loadConfig, get } from "./config.mjs";
import { verify } from "./manifest.mjs";
import { pointerTargets } from "./adapters.mjs";
import { installedTools } from "./update.mjs";
import { pointerSection, SECTION_START } from "./pointer.mjs";

function runCmd(root, cmd, env = {}) {
  const r = spawnSync(cmd, {
    cwd: root, shell: true, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return {
    ok: r.status === 0,
    out: `${r.stdout || ""}${r.stderr || ""}`.trim(),
    status: r.status,
    timedOut: r.error && r.error.code === "ETIMEDOUT",
  };
}

/** Very small YAML-list reader for a profile's gates.yaml — enough for the
 * `- id:` blocks it contains, and nothing more. */
function readGates(text) {
  const sections = { preflight: [], selftest: [] };
  let current = null;
  let entry = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^preflight:/.test(line)) { current = "preflight"; entry = null; continue; }
    if (/^selftest:/.test(line)) { current = "selftest"; entry = null; continue; }
    if (/^[a-z_]+:/.test(line)) { current = null; entry = null; continue; }
    if (!current) continue;
    const item = /^\s*-\s+id:\s*(.+)$/.exec(line);
    if (item) {
      entry = { id: item[1].trim().replace(/^['"]|['"]$/g, "") };
      sections[current].push(entry);
      continue;
    }
    const kv = /^\s+([a-z_]+):\s*(.*)$/.exec(line);
    if (kv && entry) entry[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return sections;
}

export async function doctor(flags) {
  const root = gitRoot() || repoRoot();
  const results = { checks: [], root };
  let red = 0;
  let amber = 0;

  const record = (level, name, detail) => {
    results.checks.push({ level, name, detail });
    if (level === "red") red++;
    if (level === "amber") amber++;
    const mark = level === "green" ? c.green("✓") : level === "amber" ? c.yellow("~") : c.red("✗");
    console.log(`  ${mark} ${name}`);
    if (detail && level !== "green") {
      for (const line of String(detail).split("\n").slice(0, 6)) {
        console.log(`      ${c.gray(line)}`);
      }
    }
  };

  say.head("  Install");

  // ---- 1. config ------------------------------------------------------------
  const cfgFile = path.join(root, CONFIG_NAME);
  if (!fs.existsSync(cfgFile)) {
    record("red", `${CONFIG_NAME} present`, `not found in ${root} — run: ai-qa init`);
    console.log(`\n  ${c.red("doctor: RED")} — ai-qa is not installed here.\n`);
    process.exit(1);
  }
  const cfg = loadConfig(root);
  const name = get(cfg, "project.name", "");
  const surfaces = get(cfg, "surfaces", []);
  record(name ? "green" : "red", `${CONFIG_NAME} parses`, name ? "" : "project.name is empty — the config did not parse as expected");

  // Both parsers must agree, or a gate is reading a different config than the CLI wrote.
  const pyCtx = path.join(root, ".ai-qa", "scripts", "lib", "ctx.py");
  if (fs.existsSync(pyCtx)) {
    const r = runCmd(root, `python3 ${JSON.stringify(pyCtx)} project.name`);
    const pyName = r.out.trim();
    record(pyName === String(name) ? "green" : "red",
      "Node and Python read the same config",
      pyName === String(name) ? "" : `node says ${JSON.stringify(String(name))}, python says ${JSON.stringify(pyName)} — the gates and the CLI would disagree`);
  } else {
    record("red", "Python config reader installed", `missing ${path.relative(root, pyCtx)}`);
  }

  // ---- 1b. the oracle -------------------------------------------------------
  // Declared and missing is the worst of the three states: the gate resolves
  // citations against this list, so a deleted spec turns every honest citation
  // into a red nobody can explain from the case record alone.
  const specs = [].concat(get(cfg, "oracle.specs", []) || []).map(String).filter(Boolean);
  const citing = get(cfg, "evidence.require_citation", true) !== false;
  if (!specs.length) {
    record(citing ? "red" : "amber", "an oracle is declared",
      "oracle.specs is empty — every case that reaches a verdict will red the evidence gate.\n"
      + (citing
        ? "list the documents that decide what 'correct' means, or set evidence.require_citation: false"
        : "require_citation is off, so this is only recorded, not enforced"));
  } else {
    const gone = specs.filter((p) => !fs.existsSync(path.join(root, p)));
    record(gone.length ? "red" : "green", `oracle declared (${specs.join(", ")})`,
      gone.length ? `declared but not on disk: ${gone.join(", ")}\n`
        + "a citation pointing here cannot be opened, and the gate will refuse it" : "");
  }

  // ---- 1c. does each tool KNOW about the lane? ------------------------------
  // A workflow only fires when its name is typed. The common way this lane gets
  // bypassed is not defiance, it is ignorance: "test SHOP-142", the agent has
  // never heard of /qa, and it improvises a verdict out of the source code.
  const tools = await installedTools(root);
  const targets = await pointerTargets(tools);
  const current = pointerSection(cfg);
  const missing = [];
  const stale = [];
  for (const rel of targets) {
    const text = readIfExists(path.join(root, rel));
    if (!text.includes(SECTION_START)) missing.push(rel);
    else if (!text.includes(current)) stale.push(rel);
  }
  if (missing.length) {
    record("red", `every tool is told the lane exists (${tools.join(", ")})`,
      `no ai-qa section in: ${missing.join(", ")}\n`
      + "that tool will improvise when nobody types a slash command — run: ai-qa update");
  } else if (stale.length) {
    record("amber", `every tool is told the lane exists (${tools.join(", ")})`,
      `written by an older version: ${stale.join(", ")}\nrun: ai-qa update`);
  } else if (targets.length) {
    record("green", `every tool is told the lane exists (${tools.join(", ")})`, "");
  }

  // ---- 2. integrity ---------------------------------------------------------
  const man = verify(root);
  if (!man.total) {
    record("red", "manifest", man.reason);
  } else {
    record(man.missing.length ? "red" : "green",
      `installed files intact (${man.total} tracked)`,
      man.missing.length ? `missing:\n${man.missing.slice(0, 5).map((f) => `  ${f}`).join("\n")}\nrun: ai-qa update` : "");
    // A gate script you edited is a different fact from a document you edited,
    // and lumping them together is how a gate that can no longer fail gets
    // reported as a tidy personal preference.
    const driftedGates = man.drifted.filter((f) => f.startsWith(".ai-qa/scripts/"));
    const driftedDocs = man.drifted.filter((f) => !f.startsWith(".ai-qa/scripts/"));
    if (driftedDocs.length) {
      record("amber", `${driftedDocs.length} file(s) edited by you`,
        `${driftedDocs.slice(0, 5).join(", ")}\nupdate will leave these alone — that is deliberate`);
    }
    if (driftedGates.length) {
      record("amber", `${driftedGates.length} gate script(s) edited by you`,
        `${driftedGates.slice(0, 5).join(", ")}\na gate proves itself with its own --selftest, so a gate you have changed\n` +
        "cannot certify itself: the rows below are marked UNPROVEN, not green.\n" +
        "to take ours back: delete the file and run ai-qa update");
    }
  }

  // ---- 3. runtimes ----------------------------------------------------------
  say.head("  Runtimes");
  const py = runCmd(root, "python3 --version");
  record(py.ok ? "green" : "red", "python3", py.ok ? "" : "not found — the evidence, annotation and database gates all need it");
  const pil = runCmd(root, "python3 -c \"import PIL\"");
  record(pil.ok ? "green" : "amber", "Pillow (image annotation)", pil.ok ? "" : "pip install pillow — without it, screenshots cannot be boxed or captioned");
  const pw = runCmd(root, "node .ai-qa/scripts/browser.mjs check");
  const wantsBrowser = Array.isArray(surfaces) && surfaces.includes("web");
  // Not needed is a fine answer; "✓ Playwright (browser runs)" next to a
  // machine that has no Playwright is not. The row says which it is.
  record(pw.ok ? "green" : wantsBrowser ? "amber" : "green",
    pw.ok ? "Playwright (browser runs)"
      : "Playwright not installed" + (wantsBrowser ? " — the web surface needs it" : " (not needed: no web surface)"),
    pw.ok ? "" : "npm install --no-save playwright && npx playwright install chromium");

  // ---- 4. the gates must be able to fail ------------------------------------
  say.head("  Gates — can each one still go red?");
  // A gate certifies itself with its own --selftest, which is exactly why an
  // edited gate cannot: neutering the check also neuters the proof. So a gate
  // whose script has drifted from what we shipped is reported UNPROVEN rather
  // than green. Amber, not red: editing an installed gate is a supported thing
  // to do, and a supported choice should not break anyone's build — it should
  // just stop being counted as evidence.
  const driftedNow = new Set(man.drifted || []);
  const editedScriptsIn = (cmd) => [...String(cmd).matchAll(/\.ai-qa\/scripts\/[A-Za-z0-9_./-]+/g)]
    .map((m) => m[0]).filter((f) => driftedNow.has(f));
  const recordGate = (id, proves, r, cmd) => {
    const edited = editedScriptsIn(cmd);
    if (!r.ok) {
      record("red", `${id} — ${proves}`,
        r.timedOut ? "timed out after 120s" : r.out.split("\n").slice(0, 6).join("\n"));
    } else if (edited.length) {
      record("amber", `${id} — UNPROVEN: you have edited ${edited.join(", ")}`,
        "its selftest passed, but a gate you changed cannot vouch for itself.\n" +
        "to take ours back: delete the file and re-run ai-qa update");
    } else {
      record("green", `${id} — ${proves}`, "");
    }
  };
  const seen = new Set();
  const list = Array.isArray(surfaces) ? surfaces : [surfaces].filter(Boolean);
  for (const s of list.length ? list : ["web"]) {
    const gfile = path.join(root, ".ai-qa", "profiles", String(s), "gates.yaml");
    const text = readIfExists(gfile);
    if (!text) { record("amber", `profile ${s}`, `no gates.yaml installed for this surface`); continue; }
    const { selftest } = readGates(text);
    for (const g of selftest) {
      if (!g.run || seen.has(g.run)) continue;
      seen.add(g.run);
      const r = runCmd(root, g.run);
      recordGate(g.id, g.proves || "selftest", r, g.run);
    }
  }
  // These are not surface-specific — every install reads tickets, indexes its
  // evidence and may be handed a spec in a binary file — so they are checked
  // here rather than repeated in four profiles. They used to be checked
  // NOWHERE: three scripts shipped a --selftest that nothing ever ran, which is
  // exactly the failure this section exists to catch, wearing a tidier shirt.
  // Written out in full rather than built from a variable, so that `grep
  // "<script> --selftest"` answers "is this gate ever proven?" — which is the
  // question the conformance guard asks on every run.
  for (const [id, proves, cmd] of [
    ["tracker", "reads Jira/Backlog, and never writes a secret",
     "python3 .ai-qa/scripts/tracker.py --selftest"],
    ["evd-index", "the folder can introduce itself, and a stale index goes red",
     "python3 .ai-qa/scripts/evd_index.py --selftest"],
    ["specs-ingest", "a spec in a binary file becomes one that can be cited and diffed",
     "python3 .ai-qa/scripts/specs_ingest.py --selftest"],
  ]) {
    const script = /scripts\/(\S+)/.exec(cmd)[1];
    if (!fs.existsSync(path.join(root, ".ai-qa", "scripts", script))) continue;
    const r = runCmd(root, cmd);
    seen.add(id);
    recordGate(id, proves, r, cmd);
  }

  if (!seen.size) record("red", "gate selftests", "no gate ran a selftest — nothing here is proven to work");

  // ---- 5. preflight (informational) -----------------------------------------
  if (!flags.quiet) {
    say.head("  Preflight  " + c.gray("(environment, not installation — never fatal)"));
    // Surfaces share probes: web and api both want to know the app is up.
    // Running the same command once per surface doubled the wall clock for a
    // check whose whole job is to be quick.
    const ranPreflight = new Set();
    {
      // Credentials are per-machine. Missing ones are worth SAYING, never worth
      // failing an install over: a laptop with no Jira token is not broken.
      const r = runCmd(root, "python3 .ai-qa/scripts/tracker.py check");
      const lines = r.out.split("\n").filter(Boolean);
      const verdict = lines.find((l) => /^TRACKER: (OK|DOWN|BLOCKED)/.test(l)) || lines[0] || "";
      console.log(`  ${r.ok ? c.green("✓") : c.gray("·")} ${"tracker".padEnd(10)} ${c.gray(verdict.slice(0, 96))}`);
      if (!r.ok) {
        for (const l of lines.filter((x) => /MISSING|missing environment|base_url|project/.test(x)).slice(0, 4)) {
          console.log(`      ${c.gray(l.trim())}`);
        }
      }
    }
    for (const s of list.length ? list : ["web"]) {
      const text = readIfExists(path.join(root, ".ai-qa", "profiles", String(s), "gates.yaml"));
      if (!text) continue;
      for (const g of readGates(text).preflight) {
        if (!g.run || ranPreflight.has(g.run)) continue;
        ranPreflight.add(g.run);
        const r = runCmd(root, g.run, { AIQA_PROBE_ONLY: "1" });
        const first = r.out.split("\n")[0] || "";
        console.log(`  ${r.ok ? c.green("✓") : c.gray("·")} ${g.id.padEnd(10)} ${c.gray(first.slice(0, 140))}`);
        if (!r.ok && g.unblock) console.log(`      ${c.gray(`unblock: ${g.unblock}`)}`);
      }
    }
  }

  // ---- verdict --------------------------------------------------------------
  const verdict = red ? "RED" : amber ? "AMBER" : "GREEN";
  const paint = red ? c.red : amber ? c.yellow : c.green;
  console.log(`\n  ${paint(c.bold(`doctor: ${verdict}`))}  ${c.gray(`${results.checks.filter((k) => k.level === "green").length} green · ${amber} amber · ${red} red`)}`);
  if (red) console.log(`  ${c.gray("A red doctor means a gate cannot be trusted. Fix it before relying on a verdict.")}`);
  console.log();

  if (flags.json) {
    const out = path.join(root, ".ai-qa", "doctor.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({ ...results, verdict, red, amber, at: new Date().toISOString() }, null, 2)}\n`);
    console.log(`  ${c.gray(`wrote ${path.relative(root, out)}`)}\n`);
  }
  process.exit(red ? 1 : 0);
}
