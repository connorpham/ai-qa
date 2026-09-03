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

function runCmd(root, cmd) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", timeout: 120_000 });
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

  // ---- 2. integrity ---------------------------------------------------------
  const man = verify(root);
  if (!man.total) {
    record("red", "manifest", man.reason);
  } else {
    record(man.missing.length ? "red" : "green",
      `installed files intact (${man.total} tracked)`,
      man.missing.length ? `missing:\n${man.missing.slice(0, 5).map((f) => `  ${f}`).join("\n")}\nrun: ai-qa update` : "");
    if (man.drifted.length) {
      record("amber", `${man.drifted.length} file(s) edited by you`,
        `${man.drifted.slice(0, 5).join(", ")}\nupdate will leave these alone — that is deliberate`);
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
  record(pw.ok ? "green" : wantsBrowser ? "amber" : "green", "Playwright (browser runs)",
    pw.ok ? "" : "npm install --no-save playwright && npx playwright install chromium");

  // ---- 4. the gates must be able to fail ------------------------------------
  say.head("  Gates — can each one still go red?");
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
      record(r.ok ? "green" : "red", `${g.id} — ${g.proves || "selftest"}`,
        r.ok ? "" : (r.timedOut ? "timed out after 120s" : r.out.split("\n").slice(0, 5).join("\n")));
    }
  }
  if (!seen.size) record("red", "gate selftests", "no gate ran a selftest — nothing here is proven to work");

  // ---- 5. preflight (informational) -----------------------------------------
  if (!flags.quiet) {
    say.head("  Preflight  " + c.gray("(environment, not installation — never fatal)"));
    for (const s of list.length ? list : ["web"]) {
      const text = readIfExists(path.join(root, ".ai-qa", "profiles", String(s), "gates.yaml"));
      if (!text) continue;
      for (const g of readGates(text).preflight) {
        if (!g.run) continue;
        const r = runCmd(root, g.run);
        const first = r.out.split("\n")[0] || "";
        console.log(`  ${r.ok ? c.green("✓") : c.gray("·")} ${g.id.padEnd(10)} ${c.gray(first.slice(0, 96))}`);
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
