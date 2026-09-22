// conformance.mjs — the contracts that hold the pieces together.
//
// These are the failures that do not announce themselves: a workflow renders
// but the tool never discovers it; the two config parsers drift apart and the
// gates read different values than the CLI wrote; an adapter forgets the
// no-subagent note and the challenger pass silently stops happening.
//
//   node tests/conformance.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pkgRoot, parseFrontmatter, render } from "../src/cli/util.mjs";
import { parseConfig, get } from "../src/cli/config.mjs";
import { TOOLS, renderTool } from "../src/cli/adapters.mjs";
import { renderConfig } from "../src/cli/init.mjs";

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
let checks = 0;
const check = (cond, msg) => { checks++; ok(cond, msg); };

// ---- workflows ---------------------------------------------------------------
const wfDir = path.join(pkgRoot, "core", "workflows");
const wfFiles = fs.readdirSync(wfDir).filter((f) => f.endsWith(".md"));
check(wfFiles.length >= 4, `expected at least 4 workflows, found ${wfFiles.length}`);

const wfNames = [];
for (const f of wfFiles) {
  const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(wfDir, f), "utf8"));
  const base = f.replace(/\.md$/, "");
  check(meta.name === base, `${f}: frontmatter name ${JSON.stringify(meta.name)} must match the filename`);
  check((meta.description || "").length > 80,
    `${f}: description is too short to route on — it is what the tool matches against`);
  check(body.includes("## Definition of Done"),
    `${f}: no "Definition of Done" — a workflow with no finish line never finishes`);
  check(!/\{[a-z_]+\.[a-z_.]+\}/.test(meta.description || ""),
    `${f}: description carries an unsubstituted {placeholder}`);
  wfNames.push(base);
}
for (const required of ["onboard", "qa", "triage", "regress"]) {
  check(wfNames.includes(required), `missing the ${required} workflow`);
}

// ---- adapters ----------------------------------------------------------------
const cfg = {
  project: { name: "Demo", key: "SHOP", language: "en" },
  app: { url: "http://localhost:3000", start: "npm run dev" },
  surfaces: ["web", "api"],
  tracker: { provider: "markdown" },
  autonomy: { level: "assisted" },
};

for (const tool of TOOLS) {
  const mod = await import(path.join(pkgRoot, "adapters", `${tool}.mjs`));
  check(mod.id === tool, `${tool}: exported id is ${JSON.stringify(mod.id)}`);
  check(typeof mod.marker === "string" && mod.marker.length > 0, `${tool}: no marker path`);
  check(typeof mod.render === "function", `${tool}: no render()`);

  // Keyed by workflow name, not by a substring of the path: "aiqa-onboard.mdc"
  // contains "qa", and a loose match here silently tests the wrong file.
  const written = [];
  const byName = {};
  let renderedName = null;
  await renderTool(tool, "/tmp/aiqa-conformance-never-written", cfg,
    (rel, text) => { written.push({ rel, text }); byName[renderedName] = { rel, text }; },
    { dryRun: true, onWorkflow: (n) => { renderedName = n; } });

  check(written.length === wfFiles.length,
    `${tool}: rendered ${written.length} files for ${wfFiles.length} workflows`);
  check(written.some((w) => w.rel === mod.marker),
    `${tool}: marker ${mod.marker} is not among the rendered paths — update would never re-render this tool`);

  for (const { rel, text } of written) {
    check(!rel.startsWith("/") && !rel.includes(".."), `${tool}: unsafe output path ${rel}`);
    check(text.length > 500, `${tool}: ${rel} rendered suspiciously short`);
    check(!/\{project\.[a-z_]+\}|\{app\.[a-z_]+\}/.test(text),
      `${tool}: ${rel} still contains an unsubstituted {placeholder}`);
    check(text.includes("Active surfaces:"), `${tool}: ${rel} lost the surface block`);
    check(text.includes("Working language:"), `${tool}: ${rel} lost the working-language block`);
  }

  // Tools without subagents must carry the note, or the challenger pass quietly stops.
  const qaFile = byName.qa;
  if (tool !== "claude-code") {
    check(qaFile.text.includes("cannot spawn subagents"),
      `${tool}: the qa workflow is missing the no-subagent note`);
  }
  // The Environment block belongs on the lanes that run the product, not on onboard.
  const onboardFile = byName.onboard;
  check(!onboardFile.text.includes("**Bring-up:**"),
    `${tool}: onboard should not carry the Environment block`);
  check(qaFile.text.includes("**Bring-up:**"),
    `${tool}: the qa workflow lost the Environment block`);
}

// An unconfigured app must render the "not configured" BRANCH, never a literal.
{
  let qa = { text: "" };
  let name = null;
  await renderTool("claude-code", "/tmp/x", { ...cfg, app: { url: "", start: "" } },
    (_rel, text) => { if (name === "qa") qa = { text }; },
    { dryRun: true, onWorkflow: (n) => { name = n; } });
  check(qa.text.includes("Environment: NOT CONFIGURED"),
    "an empty app: section must render the not-configured branch");
  check(!qa.text.includes("<unset>"), "the not-configured branch should not print <unset> placeholders");
}

// The working language changes what the workflow tells the agent to do — and
// what it must NOT change: the machine-read keys the gates parse.
{
  const renderFor = async (language) => {
    let qa = { text: "" };
    let name = null;
    await renderTool("claude-code", "/tmp/x", { ...cfg, project: { ...cfg.project, language } },
      (_rel, text) => { if (name === "qa") qa = { text }; },
      { dryRun: true, onWorkflow: (n) => { name = n; } });
    return qa.text;
  };
  const en = await renderFor("en");
  const vi = await renderFor("vi");
  check(en.includes("Working language: English"), "an en install does not name English as the working language");
  check(vi.includes("Working language: Tiếng Việt"), "a vi install does not name Tiếng Việt as the working language");
  check(!en.includes("Tiếng Việt"), "an en install should not carry the Vietnamese example");
  check(vi.includes('EXPECTED: "Tổng cộng" hiển thị 450.000'),
    "a vi install lost the worked example — an English key with a Vietnamese value");
  for (const [label, text] of [["en", en], ["vi", vi]]) {
    check(text.includes("`RESULT:`") && text.includes("`ENVIRONMENT:`") && text.includes("Blocker/Critical/"),
      `${label}: the language block does not list the machine-read keys that stay English`);
  }
}

// Declared environments must reach the rendered workflow: their names, the
// default, and prod's write-forbidden rule — the same coordinates the gates read.
{
  let qa = { text: "" };
  let name = null;
  const envCfg = {
    ...cfg,
    environments: {
      default: "local",
      local: { url: "", writes: "allowed" },
      stg: { url: "https://stg.example.com" },
      prod: { url: "https://www.example.com" },   // writes unset — must render forbidden
    },
  };
  await renderTool("claude-code", "/tmp/x", envCfg,
    (_rel, text) => { if (name === "qa") qa = { text }; },
    { dryRun: true, onWorkflow: (n) => { name = n; } });
  check(qa.text.includes("**Environments:**"), "the qa workflow lost the environments list");
  check(qa.text.includes("`local` (default)"), "the default environment is not marked in the workflow");
  check(qa.text.includes("https://stg.example.com"), "a declared environment url did not reach the workflow");
  check(/`prod`[^\n]*writes forbidden/.test(qa.text),
    "prod with no writes: value must render as forbidden — the fail-closed default");
  check(qa.text.includes("ENVIRONMENT: <name — url>"),
    "the environments bullet does not say the report must record the environment");
}

// Surfaces must actually change what the workflow says.
{
  const only = async (surfaces) => {
    let qa = "";
    let name = null;
    await renderTool("claude-code", "/tmp/x", { ...cfg, surfaces },
      (_rel, text) => { if (name === "qa") qa = text; },
      { dryRun: true, onWorkflow: (n) => { name = n; } });
    return qa;
  };
  const web = await only(["web"]);
  const db = await only(["database"]);
  check(web.includes("browser.mjs") && !web.includes("db_verify.py"),
    "a web-only install should not describe database tooling");
  check(db.includes("db_verify.py") && !db.includes("browser.mjs check"),
    "a database-only install should not describe the browser preflight");
}

// ---- config: both parsers must agree ----------------------------------------
const answers = {
  name: "Demo Shop", key: "SHOP", language: "vi", surfaces: ["web", "database"],
  start: "npm run dev", url: "http://localhost:3000", health: "/api/health",
  apiBase: "", contract: "openapi.yaml", mobilePlatform: "", mobileDriver: "",
  dbUrlEnv: "DATABASE_URL", schema: "prisma/schema.prisma",
  tracker: "github", branch: "main", autonomy: "assisted",
};
const yaml = renderConfig(answers);
const parsed = parseConfig(yaml);

check(get(parsed, "project.name") === "Demo Shop", `node parser: project.name = ${get(parsed, "project.name")}`);
check(get(parsed, "project.key") === "SHOP", "node parser: project.key");
check(get(parsed, "project.language") === "vi", "node parser: project.language");
check(get(parsed, "app.url") === "http://localhost:3000", `node parser: app.url = ${get(parsed, "app.url")}`);
check(Array.isArray(get(parsed, "surfaces")) && get(parsed, "surfaces").join(",") === "web,database",
  `node parser: surfaces = ${JSON.stringify(get(parsed, "surfaces"))}`);
check(get(parsed, "evidence.require_boundary") === true, "node parser: booleans");
check(get(parsed, "evidence.max_test_cases") === 5, "node parser: numbers");
check(Array.isArray(get(parsed, "autonomy.exemptions")) && get(parsed, "autonomy.exemptions").includes("real-money"),
  `node parser: block list = ${JSON.stringify(get(parsed, "autonomy.exemptions"))}`);
check(Array.isArray(get(parsed, "oracle.specs")) && get(parsed, "oracle.specs").length === 0,
  "node parser: an empty inline list must stay an empty list, not become a map");

// A URL contains '#'-free text but the comment rule is " #": prove a value with
// a '#' in it survives, because colour codes and fragments are real.
check(get(parseConfig("a:\n  b: '#ff0000'\n"), "a.b") === "#ff0000", "node parser: '#' inside a quoted scalar");
check(get(parseConfig("a:\n  b: keep # dropped\n"), "a.b") === "keep", "node parser: ' #' starts a comment");

{
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "aiqa-conf-"));
  fs.writeFileSync(path.join(tmp, "aiqa.config.yaml"), yaml);
  const ctxPy = path.join(pkgRoot, "core", "scripts", "lib", "ctx.py");
  const py = (key) => {
    const r = spawnSync("python3", [ctxPy, key], { cwd: tmp, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : `<python failed: ${r.stderr.trim()}>`;
  };
  for (const [key, expected] of [
    ["project.name", "Demo Shop"],
    ["project.key", "SHOP"],
    ["app.url", "http://localhost:3000"],
    ["app.health", "/api/health"],
    ["database.url_env", "DATABASE_URL"],
    ["tracker.provider", "github"],
    ["autonomy.level", "assisted"],
    ["evidence.max_test_cases", "5"],
    ["evidence.require_boundary", "True"],
    ["app.pace", "human"],
  ]) {
    check(py(key) === expected,
      `python parser disagrees on ${key}: got ${JSON.stringify(py(key))}, expected ${JSON.stringify(expected)}`);
  }
  const pySurfaces = py("surfaces");
  check(pySurfaces.includes("web") && pySurfaces.includes("database"),
    `python parser: surfaces = ${pySurfaces}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- environments: one resolver, and it never guesses -------------------------
// Every gate resolves the environment through lib/ctx.py, so the contract lives
// there: the default is named, an empty url inherits app.url, a CHOSEN name the
// config does not declare resolves to NOTHING (a run must block rather than
// test localhost while its report says stg), and prod is write-forbidden unless
// it explicitly says otherwise.
{
  check(get(parsed, "environments.default") === "local",
    `the rendered config names no default environment: ${get(parsed, "environments.default")}`);
  check(get(parsed, "environments.local.writes") === "allowed",
    "the rendered local environment does not declare writes: allowed");

  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "aiqa-conf-env-"));
  fs.writeFileSync(path.join(tmp, "aiqa.config.yaml"), yaml);
  const ctxPy = path.join(pkgRoot, "core", "scripts", "lib", "ctx.py");
  const py = (key, envName) => {
    const env = { ...process.env };
    delete env.AIQA_ENV;
    if (envName) env.AIQA_ENV = envName;
    const r = spawnSync("python3", [ctxPy, key], { cwd: tmp, encoding: "utf8", env });
    return r.status === 0 ? r.stdout.trim() : `<python failed: ${r.stderr.trim()}>`;
  };
  check(py("env.name") === "local", `env.name should default to local: ${py("env.name")}`);
  check(py("env.url") === "http://localhost:3000",
    `local's empty url must inherit app.url: ${py("env.url")}`);
  check(py("env.writes") === "allowed", `local must allow writes: ${py("env.writes")}`);
  check(py("env.url", "stg") === "",
    `an UNDECLARED environment must resolve to no url at all, got: ${JSON.stringify(py("env.url", "stg"))}`);
  check(py("env.name", "stg") === "stg", "AIQA_ENV must win over environments.default");
  check(py("env.writes", "prod") === "forbidden",
    `an environment named prod must be write-forbidden by default: ${py("env.writes", "prod")}`);

  // A declared block: its url wins, its api_base falls back to its url — never
  // to the legacy api.base_url of a different environment.
  const yamlStg = yaml.replace("  local:", "  stg:\n    url: 'https://stg.example.com'\n  local:");
  fs.writeFileSync(path.join(tmp, "aiqa.config.yaml"), yamlStg);
  check(py("env.url", "stg") === "https://stg.example.com",
    `a declared stg url was not resolved: ${py("env.url", "stg")}`);
  check(py("env.api_base", "stg") === "https://stg.example.com",
    `stg's api_base must fall back to stg's url, not to another environment's: ${py("env.api_base", "stg")}`);
  check(py("env.db_url_env", "stg") === "DATABASE_URL",
    `a stg block with no db_url_env must fall back to database.url_env: ${py("env.db_url_env", "stg")}`);

  // Legacy: a config with NO environments section keeps the old app.url story.
  const legacy = yaml.split("\n").filter((l, i, all) => {
    const start = all.findIndex((x) => x.startsWith("environments:"));
    const end = all.findIndex((x, j) => j > start && /^[a-z]/.test(x));
    return i < start || i >= end;
  }).join("\n");
  fs.writeFileSync(path.join(tmp, "aiqa.config.yaml"), legacy);
  check(!legacy.includes("environments:"), "the legacy fixture still carries an environments block");
  check(py("env.name") === "", `with no environments section there is no active name: ${py("env.name")}`);
  check(py("env.url") === "http://localhost:3000",
    `with no environments section env.url must be app.url: ${py("env.url")}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- render() leaves unknown keys VERBATIM ----------------------------------
check(render("{project.name} and {nope.missing}", cfg) === "Demo and {nope.missing}",
  "render() must leave an unresolved key visible, never blank it silently");

// ---- profiles ----------------------------------------------------------------
for (const s of ["web", "api", "mobile", "database"]) {
  const f = path.join(pkgRoot, "profiles", s, "gates.yaml");
  check(fs.existsSync(f), `missing profile: ${s}`);
  const text = fs.readFileSync(f, "utf8");
  check(/^surface:\s*\S/m.test(text), `${s}: gates.yaml has no surface:`);
  check(text.includes("selftest:"), `${s}: gates.yaml declares no selftest — nothing would be proven`);
  check(/evd_check\.py --selftest/.test(text), `${s}: the evidence gate selftest is not wired in`);
  check(/xlsx_export\.py --selftest/.test(text),
    `${s}: the spreadsheet export selftest is not wired in — doctor would never prove it`);
}

// ---- the gates really do prove themselves ------------------------------------
for (const [label, cmd, args] of [
  ["evidence gate", "python3", [path.join(pkgRoot, "core/scripts/evd_check.py"), "--selftest"]],
  ["spreadsheet export", "python3", [path.join(pkgRoot, "core/scripts/xlsx_export.py"), "--selftest"]],
  ["database write guard", "python3", [path.join(pkgRoot, "core/scripts/db_verify.py"), "--selftest"]],
  ["api recorder", "node", [path.join(pkgRoot, "core/scripts/api_check.mjs"), "--selftest"]],
  ["readiness grader", "node", [path.join(pkgRoot, "src/cli/scan.mjs"), "--selftest"]],
]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  check(r.status === 0, `${label} selftest failed:\n${(r.stdout || "") + (r.stderr || "")}`);
}

// ---- the tools and the gate must agree ---------------------------------------
// `doctor` already checks that the Node and Python config readers agree. This
// is the same class of failure one step further out: a case built ONLY from
// what the lane's own recorder writes must satisfy the lane's own evidence
// gate. It did not — the gate wanted a file api_check.mjs never produced — and
// nothing in the suite could see it, because each side passed its own selftest.
{
  const http = await import("node:http");
  const { spawn } = await import("node:child_process");
  // spawnSync would deadlock here: it blocks THIS process's event loop, so the
  // fixture server below could never answer the request the child makes.
  const run = (cmd, args) => new Promise((resolve) => {
    const p = spawn(cmd, args, { encoding: "utf8" });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (status) => resolve({ status, out }));
  });
  const server = http.createServer((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 7, subtotal: 500000, discount: 50000, total: 450000 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const evd = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "aiqa-conf-evd-"));
  try {
    const CASE = (kind) => [
      "RESULT: PASS", `KIND: ${kind}`, "TYPE: NON-UI",
      "AS: customer 1 (tier gold)",
      "PRECONDITION: customer 1 exists, resolved read-only before the call",
      "ENTRY: the ordering call a customer's checkout makes",
      "STEPS: 1. place an order of 500,000  2. read the priced order back",
      "EXPECTED: discount 50,000 (spec 3.2 R1)",
      "ACTUAL: discount 50,000", "",
    ].join("\n");
    const TC1 = "TC_1_a_gold_order_is_priced_with_the_discount";
    const TC2 = "TC_2_an_order_below_the_threshold_is_not_discounted";
    const TC3 = "TC_3_the_priced_order_reads_back_whole";
    for (const [dir, kind] of [[TC1, "acceptance"], [TC2, "boundary"], [TC3, "whole-screen"]]) {
      const caseDir = path.join(evd, dir);
      fs.mkdirSync(caseDir, { recursive: true });
      fs.writeFileSync(path.join(caseDir, "case.md"), CASE(kind));
      // The ONLY evidence in this case is whatever api_check.mjs decides to write.
      const r2 = await run("node", [path.join(pkgRoot, "core/scripts/api_check.mjs"),
        "POST", "/orders", "--base", base, "--out", caseDir,
        "--expect-status", "201", "--expect", "discount=50000"]);
      check(r2.status === 0, `api_check failed while building the pack: ${r2.out}`);
    }
    fs.writeFileSync(path.join(evd, "index.md"), "# SHOP-1\nWhat was checked, in plain language.\n\n"
      + "COVERAGE:\n- security: n/a — backend-only recorder pack, no auth or session surface\n"
      + "- accessibility: n/a — no UI in this change\n");
    // The index describes the folder, so it is rewritten whenever the folder
    // changes — exactly what the gate insists on downstream.
    const reindex = () => run("python3", [path.join(pkgRoot, "core/scripts/evd_index.py"), "--evd", evd]);
    fs.writeFileSync(path.join(evd, "verifysheet.md"), "EXPECTED per spec 3.2 R1\n");
    fs.writeFileSync(path.join(evd, "debate.md"), "my card\nchallenger card\nresolution\n");
    fs.writeFileSync(path.join(evd, "REPORT.md"), [
      "# SHOP-1 — PASS", "COMMIT: abc1234", "VERIFIED-AT: 2026-09-04T00:00:00Z",
      "ENVIRONMENT: local — http://127.0.0.1:4319",
      "ORACLE: docs/spec/discounts.md 3.2", "", "## 4. Conclusion", "The requirement is met.", "",
    ].join("\n"));

    const gateCmd = [path.join(pkgRoot, "core/scripts/evd_check.py"), "--evd", evd, "--expect-tcs", "3"];
    await reindex();
    const gate = await run("python3", gateCmd);
    check(gate.status === 0,
      "the evidence gate rejects a pack built only from what api_check.mjs writes — " +
      `the recorder and the gate disagree:\n${gate.out}`);

    // Now take away the command record and leave ONLY the recorded exchange.
    // This is the half of the contract that belongs to the gate: an API case is
    // evidenced by its request and its response, whoever wrote them. Without
    // this line the check above would pass on api_check.mjs's new file alone
    // and prove nothing about the gate.
    fs.rmSync(path.join(evd, TC2, "cmd_verify.md"));
    await reindex();
    const pairOnly = await run("python3", gateCmd);
    check(pairOnly.status === 0,
      "a NON-UI case evidenced by request.http + response.json alone was rejected — " +
      `the gate is asking for a file no recorder has to produce:\n${pairOnly.out}`);

    // …and the rule must still be able to go red: half a pair is not a pair.
    fs.rmSync(path.join(evd, TC2, "response.json"));
    await reindex();
    const halfPair = await run("python3", gateCmd);
    check(halfPair.status !== 0,
      "a request with no recorded response was accepted as a verification");
    for (const f of ["request.http", "response.json", "cmd_verify.md"]) {
      check(fs.existsSync(path.join(evd, TC1, f)), `api_check.mjs did not write ${f}`);
    }
    const rec = fs.readFileSync(path.join(evd, TC1, "cmd_verify.md"), "utf8");
    check(rec.includes("api_check.mjs POST /orders"),
      "the command record does not name the command that produced the evidence");
  } finally {
    server.close();
    fs.rmSync(evd, { recursive: true, force: true });
  }
}


// ---- the browser wizard renders without a browser ----------------------------
// The page is a string builder, so it can be checked here rather than only by
// someone clicking it. The escaping check matters: a project name comes from a
// directory name, and directory names can contain anything.
{
  const { renderPage } = await import("../src/ui/server.mjs");
  const scanRes = {
    score: 42, grade: "D", facts: { stack: ["next.js"], surfaces: ["web"] },
    gaps: [{ dimension: "ORACLE", id: "oracle.specs", lost: 10, question: "Where is the spec?" }],
  };
  const defaults = {
    name: `Ac<me> "Shop" & Co`, key: "SHOP", language: "vi", surfaces: ["web", "database"],
    start: "npm run dev", url: "http://localhost:3000", dbUrlEnv: "DATABASE_URL",
    tracker: "github", autonomy: "assisted",
  };
  const html = renderPage({ defaults, scan: scanRes, token: "abc123" });

  check(html.startsWith("<!doctype html>"), "the wizard page is not a document");
  check(!html.includes(`Ac<me>`), "the project name was not HTML-escaped — a directory name is untrusted input");
  check(html.includes("Ac&lt;me&gt;"), "escaping did not produce entities");
  check(html.includes("&quot;Shop&quot;") && html.includes("&amp; Co"), "quotes and ampersands were not escaped");
  check(html.includes('action="/submit/abc123"'), "the form does not post to the tokenised path");
  for (const field of ["name", "key", "language", "surfaces", "start", "url", "tracker", "autonomy", "tools"]) {
    check(new RegExp(`name="${field}"`).test(html), `the wizard has no ${field} field`);
  }
  check(html.includes("42<span"), "the readiness score is not shown");
  check(html.includes("Where is the spec?"), "the scan's gap questions are not shown");
  check((html.match(/value="web"/g) || []).length >= 1 && html.includes('value="mobile"'),
    "not every surface is offered");
  check(html.includes('value="web" checked'), "a detected surface was not pre-selected");
  check(!html.includes('value="mobile" checked'), "an undetected surface was pre-selected");
  check(html.includes("prefers-color-scheme"), "the wizard ignores the user's colour scheme");
}


// ---- tracker: the two copies of the env-var names must agree ------------------
// init.mjs names the variables in the wizard; trackers.py enforces them at
// runtime. A drift here sends the user hunting for a variable spelled
// differently in the gate that rejects them.
{
  const { TRACKER_ENV, TRACKERS: TRACKER_LIST } = await import("../src/cli/init.mjs");
  const py = fs.readFileSync(path.join(pkgRoot, "core/scripts/lib/trackers.py"), "utf8");

  const fromPython = {};
  for (const chunk of py.split(/^class\s+\w+\(Tracker\):/m).slice(1)) {
    const idm = /^\s+id\s*=\s*"([a-z]+)"/m.exec(chunk);
    if (!idm) continue;
    const envBlock = /ENV(?::[^=]*)?\s*=\s*\[([\s\S]*?)\]/m.exec(chunk);
    const vars = envBlock ? [...envBlock[1].matchAll(/\(\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]) : [];
    fromPython[idm[1]] = vars;
  }

  check(Object.keys(fromPython).length === 4,
    `expected 4 tracker providers in trackers.py, parsed ${Object.keys(fromPython).length}`);
  for (const provider of TRACKER_LIST) {
    check(provider in fromPython, `init.mjs offers tracker ${provider} with no provider in trackers.py`);
    const js = (TRACKER_ENV[provider] || []).join(",");
    const python = (fromPython[provider] || []).join(",");
    check(js === python,
      `tracker ${provider}: init.mjs says [${js}], trackers.py says [${python}] — these must match`);
  }
  for (const provider of Object.keys(fromPython)) {
    check(TRACKER_LIST.includes(provider), `trackers.py implements ${provider} but init.mjs never offers it`);
  }

  // Every credential variable must look like a credential, so the wizard never
  // asks someone to put a URL in a slot the gate treats as a secret.
  for (const [provider, vars] of Object.entries(TRACKER_ENV)) {
    for (const v of vars) {
      check(/TOKEN|KEY|SECRET|PASSWORD|EMAIL/.test(v),
        `${provider}: ${v} does not read as a credential name`);
    }
  }
}

// ---- tracker gate proves itself ----------------------------------------------
{
  const r = spawnSync("python3", [path.join(pkgRoot, "core/scripts/tracker.py"), "--selftest"],
    { encoding: "utf8", timeout: 120_000 });
  check(r.status === 0, `tracker selftest failed:\n${(r.stdout || "") + (r.stderr || "")}`);
}

// ---- a config with tracker coordinates round-trips through both parsers -------
{
  const yamlB = renderConfig({
    ...answers, tracker: "backlog", trackerEnv: ["BACKLOG_API_KEY"],
    trackerBaseUrl: "https://acme.backlog.com", trackerProject: "SHOP",
  });
  const p2 = parseConfig(yamlB);
  check(get(p2, "tracker.provider") === "backlog", "tracker.provider did not round-trip");
  check(get(p2, "tracker.base_url") === "https://acme.backlog.com",
    `tracker.base_url did not round-trip: ${get(p2, "tracker.base_url")}`);
  check(get(p2, "tracker.project") === "SHOP", "tracker.project did not round-trip");
  check(!/BACKLOG_API_KEY=/.test(yamlB), "the config must never contain a credential assignment");

  const tmp2 = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "aiqa-conf-tr-"));
  fs.writeFileSync(path.join(tmp2, "aiqa.config.yaml"), yamlB);
  const ctxPy = path.join(pkgRoot, "core", "scripts", "lib", "ctx.py");
  for (const [key, expected] of [["tracker.provider", "backlog"],
                                 ["tracker.base_url", "https://acme.backlog.com"],
                                 ["tracker.project", "SHOP"]]) {
    const r = spawnSync("python3", [ctxPy, key], { cwd: tmp2, encoding: "utf8" });
    check(r.stdout.trim() === expected,
      `python parser disagrees on ${key}: ${JSON.stringify(r.stdout.trim())}`);
  }
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// ---- the evidence-pack vocabulary has exactly one definition ----------------
// evd_check.py ENFORCES the vocabulary and evdpack.py (behind xlsx_export.py)
// PRINTS it. When these drift, the gate accepts a value the report renders as
// unrecognised — or worse, the other way round, and a real severity silently
// becomes NOT DECLARED in front of a manager.
{
  const readPy = (rel) => fs.readFileSync(path.join(pkgRoot, "core/scripts", rel), "utf8");
  const gate = readPy("evd_check.py");
  const pack = readPy("lib/evdpack.py");
  const tuple = (text, name) => {
    const m = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\)`, "m").exec(text);
    return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : null;
  };

  for (const name of ["VERDICTS", "CASE_RESULTS", "KINDS", "REQUIRED_FIELDS", "UI_ONLY_FIELDS"]) {
    const a = tuple(gate, name);
    const b = tuple(pack, name);
    check(a && a.length, `evd_check.py: could not parse ${name}`);
    check(b && b.length, `lib/evdpack.py: could not parse ${name}`);
    check(a && b && a.join(",") === b.join(","),
      `${name} has drifted: evd_check.py says [${a}], evdpack.py says [${b}]`);
  }

  // The severity ladder and the origins live in the doctrine the report cites.
  // A workbook legend that contradicts docs/qa/method/severity.md is worse than
  // no legend: the reader checks the definition and finds a different one.
  const doctrine = fs.readFileSync(path.join(pkgRoot, "core/doctrine/severity.md"), "utf8");
  const bolded = (from) => [...from.matchAll(/^\|\s*\*\*([A-Za-z]+)\*\*\s*\|/gm)].map((m) => m[1]);
  const [sevTable, originTable] = doctrine.split(/^##\s+Origin/m);
  const docSeverities = bolded(sevTable);
  const docOrigins = bolded(originTable || "");
  const codeSeverities = tuple(pack, "SEVERITIES");
  const codeOrigins = tuple(pack, "ORIGINS");
  check(docSeverities.length === 4, `parsed ${docSeverities.length} severities from severity.md`);
  check(codeSeverities.join(",") === docSeverities.join(","),
    `the severity ladder drifted from the doctrine: code [${codeSeverities}], severity.md [${docSeverities}]`);
  check(docOrigins.length === 2, `parsed ${docOrigins.length} origins from severity.md`);
  check(codeOrigins.join(",") === docOrigins.join(","),
    `the origins drifted from the doctrine: code [${codeOrigins}], severity.md [${docOrigins}]`);

  // Every level and origin must carry the meaning the workbook's legend prints.
  for (const level of codeSeverities) {
    check(new RegExp(`"${level}":`).test(pack), `SEVERITY_MEANING has no entry for ${level}`);
  }
  for (const kind of tuple(pack, "KINDS")) {
    check(pack.includes(`"${kind}":`), `KIND_MEANING has no entry for ${kind}`);
  }

  // The /qa workflow asks for these fields by name; the reader reads them by
  // name. A field documented but never read is a field nobody fills in twice.
  const qaWorkflow = fs.readFileSync(path.join(pkgRoot, "core/workflows/qa.md"), "utf8");
  for (const field of ["TITLE", "KIND", "REQUIREMENT", "SEVERITY", "ORIGIN", "FINDING",
                       "RECOMMENDATION"]) {
    check(new RegExp(`\\*\\*${field}\\*\\*`).test(qaWorkflow),
      `the qa workflow never asks for ${field}, but the report is built from it`);
    check(new RegExp(`get\\("${field}"|"${field}"`).test(pack),
      `evdpack.py never reads ${field}, but the qa workflow asks for it`);
  }
  check(/xlsx_export\.py --evd/.test(qaWorkflow),
    "the qa workflow never runs the export — the spreadsheet would only exist if someone remembered");
}

// ---- the evidence folder has to introduce itself ------------------------------
{
  const qa = fs.readFileSync(path.join(wfDir, "qa.md"), "utf8");
  check(qa.includes("TC_<n>_<what_it_proves>"),
    "qa.md still tells the verifier to make bare TC_<n> folders — the reader would have to open a file to learn what case 2 was");
  check(qa.indexOf("evd_index.py") > 0 && qa.indexOf("evd_index.py") < qa.indexOf("evd_check.py --evd"),
    "qa.md must generate the index BEFORE running the gate, or the gate reds on a folder the verifier just finished");
  const gate = fs.readFileSync(path.join(pkgRoot, "core/scripts/evd_check.py"), "utf8");
  check(/CASE_DIR = re\.compile/.test(gate) && /TC\(\\d\+\)_/.test(gate),
    "the evidence gate no longer knows about case-numbered filenames");
}

// ---- pace: a headed run has to be one a human can follow ----------------------
// The bug this catches is silent by construction: the run still passes, the
// screenshots still land, and the only thing lost is the reason headed exists.
{
  const { resolvePace } = await import(path.join(pkgRoot, "core", "scripts", "browser.mjs"));
  // "" rather than undefined: it means "nothing was asked for" without letting
  // an installed aiqa.config.yaml on this machine decide the test's answer.
  const dflt = resolvePace("", true);
  check(dflt.name === "human", `default pace is ${dflt.name}, expected human`);
  check(dflt.step >= 300,
    `default pace is ${dflt.step}ms per action — too fast for a watcher to follow the click`);
  check(dflt.key > 0 && dflt.settle > 0, "the human pace must also slow typing and let the screen settle");
  check(resolvePace("demo", true).step > resolvePace("brisk", true).step,
    "demo must be slower than brisk, or the names mean nothing");
  check(resolvePace("demo", false).step === 0 && resolvePace("2000", false).step === 0,
    "a headless run must never pay the pace cost — nobody is watching it");
  const num = resolvePace("1200", true);
  check(num.step === 1200, `a numeric pace was not honoured: ${JSON.stringify(num)}`);
  check(num.key <= 120, `keystroke delay ${num.key}ms derived from a big step is unusably slow`);
  check(resolvePace("nonsense", true).name === "human",
    "an unknown pace name must fall back to human, not to full speed");
}

// ---- the tester's mind is wired in, not just shipped --------------------------
// A doctrine file no workflow opens is a file nobody reads. Each of these exists
// to change what the verifier DOES at a named phase, so the workflow has to name
// it, the playbook (the one file /qa always reads first) has to index it, and
// the order has to be right — a question about the ticket asked after the cases
// are designed arrives as an argument, not as a question.
{
  const doctrineDir = path.join(pkgRoot, "core", "doctrine");
  const readDoc = (f) => fs.readFileSync(path.join(doctrineDir, f), "utf8");
  const wf = (n) => fs.readFileSync(path.join(wfDir, `${n}.md`), "utf8");
  const qa = wf("qa");
  const triage = wf("triage");
  const onboard = wf("onboard");
  const regress = wf("regress");
  const playbook = readDoc("roles-qa.md");

  const MIND = ["user-mindset.md", "heuristics.md", "hostile-inputs.md", "requirement-smells.md", "checklists.md"];
  for (const f of MIND) {
    const exists = fs.existsSync(path.join(doctrineDir, f));
    check(exists, `doctrine ${f} is missing`);
    if (!exists) continue;
    check(readDoc(f).split("\n").length > 60, `${f} is too thin to change how anyone tests`);
    check(qa.includes(f), `qa.md never opens ${f} — a doctrine no workflow reads is a file nobody reads`);
  }
  // The playbook is the index: every doctrine file is in its toolbox table.
  for (const f of fs.readdirSync(doctrineDir).filter((x) => x.endsWith(".md") && x !== "roles-qa.md")) {
    check(playbook.includes(`\`${f}\``), `roles-qa.md's toolbox does not list ${f}`);
  }

  // Order inside /qa: smells → sheet → case design.
  const iSmells = qa.indexOf("requirement-smells.md");
  const iSheet = qa.indexOf("Write `evd/<TICKET>/verifysheet.md`");
  const iV2 = qa.indexOf("## V2 — DESIGN THE VERIFICATION");
  check(iSmells > 0 && iSheet > 0 && iV2 > 0 && iSmells < iSheet && iSheet < iV2,
    "qa.md must read the ticket for smells BEFORE writing the sheet and BEFORE designing cases");
  // …and the ask happens before V2, in so many words.
  check(/[Aa]sk the requirement\s+owner now[\s\S]{0,80}before V2/.test(qa),
    "qa.md must tell the verifier to ask the requirement owner BEFORE V2");

  // The exploratory KIND the gate accepts has to be explained, or it is a
  // vocabulary word nobody uses. Same for the persona and the observations.
  const gate = fs.readFileSync(path.join(pkgRoot, "core/scripts/evd_check.py"), "utf8");
  const kinds = [...(/^KINDS\s*=\s*\(([\s\S]*?)\)/m.exec(gate) || [, ""])[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  check(kinds.includes("exploratory"), "the gate no longer accepts an exploratory case");
  check(readDoc("test-design.md").includes("KIND: exploratory") && qa.includes("KIND: exploratory"),
    "the exploratory KIND is accepted by the gate but never explained — nobody will write one");
  for (const k of ["PERSONA", "HEURISTIC", "OBSERVATIONS"]) {
    check(/^[A-Z][A-Z_-]{1,20}$/.test(k), `${k} would not parse as a manifest field`);
    check(qa.includes(`**${k}**`), `qa.md never asks for ${k}`);
    check(readDoc("evidence.md").includes(k), `evidence.md does not document ${k}`);
  }
  // A real-user move is demanded of EVERY case, not delegated to a case of its own.
  check(/At least one step is a thing a real user does/.test(qa),
    "qa.md no longer requires a real-user move in every case's STEPS");

  // HICCUPPS is the answer to "no spec, so I can say nothing" — all eight, and
  // without softening the oracle rule.
  const heur = readDoc("heuristics.md");
  for (const o of ["History", "Image", "Comparable products", "Claims", "User expectations", "Product", "Purpose", "Statutes"]) {
    check(new RegExp(`\\*\\*${o}\\b`).test(heur), `heuristics.md lost the "${o}" consistency oracle`);
  }
  check(/never tells you what\s+the correct answer is/.test(heur), "heuristics.md softened the oracle rule");
  check(/oracle rule still applies/.test(readDoc("hostile-inputs.md")), "hostile-inputs.md softened the oracle rule");
  check(/does not cross|line you do not cross/i.test(readDoc("user-mindset.md")) && /never tells you what\s+the value should be/.test(readDoc("user-mindset.md")),
    "user-mindset.md must say a persona never decides what is correct");

  // Biases have a table; triage has a title and one-defect-one-report; onboard
  // asks who the people are; regress ranks with RCRCRC and harvests observations.
  const flags = readDoc("red-flags.md");
  check(flags.includes("## The traps in your own head") && flags.includes("Confirmation bias"),
    "red-flags.md has no bias table");
  check(triage.includes("[Title]") && triage.includes("One defect, one report"),
    "triage.md lost the title craft or the one-defect-one-report rule");
  check(triage.includes("user-mindset.md") && triage.includes("hostile-inputs.md"),
    "triage.md does not reproduce as the person, with the hostile inputs");
  check(/^People\s+·/m.test(onboard), "onboard.md's interview never asks who the people are");
  check(fs.readFileSync(path.join(pkgRoot, "core/templates/docs/onboarding.md"), "utf8").includes("Who the people are"),
    "the dossier template has nowhere to record who the people are");
  check(fs.readFileSync(path.join(pkgRoot, "core/templates/docs/charters.md"), "utf8").includes("HEURISTIC"),
    "the charter template has no HEURISTIC line");
  check(regress.includes("RCRCRC") && regress.includes("OBSERVATIONS"),
    "regress.md neither ranks with RCRCRC nor harvests observations");

  // The report template has an Observations section AFTER the conclusion — and
  // the export, which reads the Conclusion, must not swallow it.
  const iConc = qa.indexOf("## 4. Conclusion");
  const iObs = qa.search(/^## 6\. Observations/m);
  const iApp = qa.indexOf("## Appendix");
  check(iConc > 0 && iObs > iConc && iApp > iObs,
    "the report template needs an Observations section between the Conclusion and the Appendix");

  // Now prove it against the real gate and the real export: a green pack whose
  // manifests carry PERSONA / HEURISTIC / OBSERVATIONS and whose report carries
  // the Observations section still passes, and the Observations stay out of the
  // Conclusion the spreadsheet prints.
  const evd = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "aiqa-conf-mind-"));
  try {
    const built = spawnSync("python3", ["-c",
      `import sys; sys.path.insert(0, ${JSON.stringify(path.join(pkgRoot, "core/scripts"))}); ` +
      `import evd_check; evd_check._green_fixture(${JSON.stringify(evd)})`], { encoding: "utf8" });
    check(built.status === 0, `could not build the gate's own green fixture: ${built.stderr}`);
    for (const d of fs.readdirSync(evd).filter((x) => /^TC_\d+/.test(x))) {
      const mf = path.join(evd, d, "case.md");
      fs.appendFileSync(mf, [
        "PERSONA: the interrupted one — leaves after step 1, returns after the session expired",
        "HEURISTIC: interruptions — refresh between Save and the confirmation",
        "OBSERVATIONS: the Pending badge kept the old count until a manual refresh",
        "",
      ].join("\n"));
    }
    const reportPath = path.join(evd, "REPORT.md");
    fs.appendFileSync(reportPath, "\n## 6. Observations — seen, not judged\nThe Pending badge kept the old count until a manual refresh.\n");
    spawnSync("python3", [path.join(pkgRoot, "core/scripts/evd_index.py"), "--evd", evd], { encoding: "utf8" });
    const g = spawnSync("python3", [path.join(pkgRoot, "core/scripts/evd_check.py"), "--evd", evd, "--expect-tcs", "3"],
      { encoding: "utf8" });
    check(g.status === 0, `a pack carrying PERSONA/HEURISTIC/OBSERVATIONS and an Observations section is rejected by the gate:\n${g.stdout}${g.stderr}`);
    const x = spawnSync("python3", [path.join(pkgRoot, "core/scripts/xlsx_export.py"), "--evd", evd], { encoding: "utf8" });
    check(x.status === 0, `the export choked on the Observations section:\n${x.stdout}${x.stderr}`);
    const conc = spawnSync("python3", ["-c",
      `import sys; sys.path.insert(0, ${JSON.stringify(path.join(pkgRoot, "core/scripts/lib"))}); ` +
      `import evdpack; print(evdpack._report_section(open(${JSON.stringify(reportPath)}, encoding='utf-8').read(), 'Conclusion'))`],
      { encoding: "utf8" });
    check(conc.status === 0 && conc.stdout.trim().length > 0, "the export could not read the Conclusion");
    check(!/Pending badge/.test(conc.stdout),
      "the Observations leaked into the Conclusion the spreadsheet prints — an observation would be read as a verdict");
  } finally {
    fs.rmSync(evd, { recursive: true, force: true });
  }
}

// ---- the tester's pen: a case and a report a stranger reads at first sight -----
// The writing doctrine is enforced at three points — the workflow that has to
// open it, the gate that refuses a value written as a judgement, and the export
// that has to read the new report shape — so all three are checked here against
// the real files, not against a description of them.
{
  const doctrineDir = path.join(pkgRoot, "core", "doctrine");
  const readDoc = (f) => fs.readFileSync(path.join(doctrineDir, f), "utf8");
  const qa = fs.readFileSync(path.join(wfDir, "qa.md"), "utf8");
  const triage = fs.readFileSync(path.join(wfDir, "triage.md"), "utf8");

  for (const f of ["case-writing.md", "report-writing.md"]) {
    check(fs.existsSync(path.join(doctrineDir, f)), `doctrine ${f} is missing`);
    check(readDoc(f).split("\n").length > 60, `${f} is too thin to teach anyone to write`);
    check(qa.includes(f), `qa.md never opens ${f}`);
    check(triage.includes(f), `triage.md never opens ${f} — a bug report is a case record with a different heading`);
  }
  // Opened at the right moment: case-writing while the cases are designed,
  // report-writing before the report is written.
  const between = (text, from, to, needle) => {
    const a = text.indexOf(from); const b = text.indexOf(to, a + 1);
    return a > 0 && b > a && text.slice(a, b).includes(needle);
  };
  check(between(qa, "## V2 — DESIGN THE VERIFICATION", "## V2b", "case-writing.md"),
    "qa.md must open case-writing.md inside V2, where the case records are written");
  check(between(qa, "## V5b — WRITE THE REPORT", "## V6", "report-writing.md"),
    "qa.md must open report-writing.md inside V5b, before the report is written");

  // The report template: the five lines first, then the section shapes the
  // gate and the export depend on.
  const tmplStart = qa.indexOf("## V5b — WRITE THE REPORT");
  const tmpl = qa.slice(tmplStart, qa.indexOf("## V6", tmplStart));
  const iOne = tmpl.indexOf("## 1. What was asked for");
  for (const line of ["**Verdict:**", "**What it means:**", "**Next step:**"]) {
    const i = tmpl.indexOf(line);
    check(i > 0 && i < iOne, `the report template must carry ${line} BEFORE section 1 — it is the part everyone reads`);
  }
  const iEnv = tmpl.indexOf("ENVIRONMENT:");
  check(iEnv > 0 && iEnv < iOne,
    "the report template must carry an ENVIRONMENT: line in its header — the gate refuses a report without one");
  check(/## 2\. What I checked[\s\S]*the case title/.test(tmpl),
    "the report's table must be labelled by case title, never by TC_n");
  check(/## 3\. What I found/.test(tmpl) && /Who it hurts/.test(tmpl),
    "the report template has no findings section that says who it hurts");
  check(between(tmpl, "## 4. Conclusion", "## 5.", "**Recommendation:**"),
    "the bold Recommendation: line must sit inside the Conclusion — the export reads it from there");
  check(/## 5\. What I could not check/.test(tmpl) && /"Nothing"/.test(tmpl),
    "the report template must keep 'What I could not check', present even when it says Nothing");

  // The banned words the doctrine names are the ones the gate refuses, and the
  // gate and the export refuse the same list.
  const gateSrc = fs.readFileSync(path.join(pkgRoot, "core/scripts/evd_check.py"), "utf8");
  const packSrc = fs.readFileSync(path.join(pkgRoot, "core/scripts/lib/evdpack.py"), "utf8");
  const tuple = (text, name) => {
    const m = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\)`, "m").exec(text);
    return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : null;
  };
  const gateVague = tuple(gateSrc, "_VAGUE_PHRASES");
  const packVague = tuple(packSrc, "_VAGUE_PHRASES");
  check(gateVague && gateVague.length > 20, "evd_check.py has no _VAGUE_PHRASES list");
  check(gateVague && packVague && gateVague.join("|") === packVague.join("|"),
    "the vague-phrase list drifted between evd_check.py and evdpack.py");
  const caseDoc = readDoc("case-writing.md");
  for (const w of ["works as expected", "correctly", "properly", "successfully", "no errors", "as expected"]) {
    check(caseDoc.toLowerCase().includes(w), `case-writing.md's banned list lost "${w}"`);
    check(gateVague && gateVague.includes(w), `the gate does not refuse "${w}" although case-writing.md bans it`);
  }
  check(/fifteen-second/i.test(caseDoc) && /Before —/.test(caseDoc) && /After —/.test(caseDoc),
    "case-writing.md lost the fifteen-second test or its before/after record");
  const repDoc = readDoc("report-writing.md");
  check(/\| the oracle \|/.test(repDoc) && /DEV \/ SPEC/.test(repDoc),
    "report-writing.md lost the jargon-to-plain table");
  for (const v of ["PASS", "FAIL", "PARTIAL", "NEW-BUG", "BLOCKED", "UNCLEAR"]) {
    check(new RegExp(`\\*\\*${v}\\*\\*`).test(repDoc), `report-writing.md does not explain ${v} in the reader's terms`);
  }
  check(repDoc.includes("**Recommendation:**"), "report-writing.md must name the one bold label the export reads");

  // Against the real gate: a judgement in EXPECTED or ACTUAL goes red; the
  // concrete value the green fixture carries stays green (proven by the
  // fixture itself). Then the new report shape, filled in, passes the gate and
  // is read correctly by the export.
  const py = (code) => spawnSync("python3", ["-c", code], { encoding: "utf8" });
  const fixture = (dir) => py(
    `import sys; sys.path.insert(0, ${JSON.stringify(path.join(pkgRoot, "core/scripts"))}); ` +
    `import evd_check; evd_check._green_fixture(${JSON.stringify(dir)})`);
  const reindex = (dir) => spawnSync("python3", [path.join(pkgRoot, "core/scripts/evd_index.py"), "--evd", dir], { encoding: "utf8" });
  const gateRun = (dir) => spawnSync("python3", [path.join(pkgRoot, "core/scripts/evd_check.py"), "--evd", dir, "--expect-tcs", "3"], { encoding: "utf8" });
  const caseDirs = (dir) => fs.readdirSync(dir).filter((x) => /^TC_\d+/.test(x));
  const setField = (mf, key, value) => fs.writeFileSync(mf,
    fs.readFileSync(mf, "utf8").replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`));

  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "aiqa-conf-pen-"));
  try {
    for (const [key, value] of [["EXPECTED", "works as expected"], ["EXPECTED", "It should work correctly."],
                                ["ACTUAL", "failed"], ["ACTUAL", "OK"], ["EXPECTED", "no errors"]]) {
      const d = path.join(root, `vague_${key}_${value.replace(/\W+/g, "_")}`);
      check(fixture(d).status === 0, "could not build the green fixture");
      setField(path.join(d, caseDirs(d)[0], "case.md"), key, value);
      reindex(d);
      const g = gateRun(d);
      check(g.status !== 0, `the gate accepted ${key}: ${JSON.stringify(value)} — a judgement, not a value`);
      check(/judgement, not a value/.test(g.stdout + g.stderr), `the gate red for ${key}=${JSON.stringify(value)} but not for the writing rule`);
    }
    // …and a value that merely CONTAINS a judgement word is not flagged.
    {
      const d = path.join(root, "contains_word");
      fixture(d);
      setField(path.join(d, caseDirs(d)[0], "case.md"), "EXPECTED", "the total reads 450,000 (spec 3.2) and the screen works offline");
      reindex(d);
      check(gateRun(d).status === 0, "a concrete EXPECTED was refused because it contained the word 'works'");
    }

    // The new report shape, concrete, FAIL verdict, one failed case.
    const d = path.join(root, "report_shape");
    fixture(d);
    const dirs = caseDirs(d).sort();
    const c2 = path.join(d, dirs[1], "case.md");
    fs.writeFileSync(c2, fs.readFileSync(c2, "utf8").replace("RESULT: PASS", "RESULT: FAIL") +
      "TITLE: A quantity of 0 is refused with a message naming the minimum\n" +
      "SEVERITY: Critical\nORIGIN: DEV\nFINDING: [Order edit] Quantity 0 is saved — when Save is pressed with Enter\n");
    fs.writeFileSync(path.join(d, "REPORT.md"), [
      "# SHOP-142 — FAIL",
      "COMMIT: abc1234",
      "VERIFIED-AT: 2026-09-04T10:41:00+07:00",
      "ENVIRONMENT: local — http://localhost:3000",
      "ORACLE: docs/specs/orders.md 3.2",
      "",
      "**Verdict:** A quantity of 0 is accepted and saved — the order ends up with an empty line.",
      "**What it means:** Warehouse staff receive orders with nothing to pick; every such order is a phone call.",
      "**Next step:** Back to the developer with defect 1 (Critical). Release should wait.",
      "",
      "## 1. What was asked for",
      "On the order screen, when staff change a quantity and press Save, the total must recalculate and a quantity below 1 must be refused.",
      "",
      "## 2. What I checked",
      "| What I checked (the case title) | As whom | Expected | Actual | Result |",
      "|---|---|---|---|---|",
      "| Changing a quantity and pressing Save recalculates the total | staff | Total reads 450,000 | Total reads 450,000 | ✅ |",
      "| A quantity of 0 is refused with a message naming the minimum | staff | field turns red, nothing saved | row saved with quantity 0 | ❌ |",
      "",
      "## 3. What I found",
      "**[Order edit] Quantity 0 is saved — when Save is pressed with Enter.**",
      "When staff type 0 and press Enter, the row is saved with quantity 0. It should be refused with the message naming the minimum (the orders rule, §3.4). The warehouse receives an order with nothing to pick.",
      "Severity: Critical · Origin: the code · Evidence: A quantity of 0 is refused — 03_row_saved_boxed.png",
      "",
      "## 4. Conclusion",
      "The total recalculates as specified, but the minimum-quantity rule is not enforced when Enter is used instead of the button. The screen is otherwise intact.",
      "**Recommendation:** send it back for the quantity rule; release should wait, because every order edited by keyboard can end up empty.",
      "",
      "## 5. What I could not check",
      "Nothing",
      "",
      "## 6. Observations — seen, not judged",
      "none",
      "",
      "## Appendix",
      "verifysheet.md · debate.md",
      "",
    ].join("\n"));
    reindex(d);
    const g = gateRun(d);
    check(g.status === 0, `the new report shape is rejected by the gate:\n${g.stdout}${g.stderr}`);
    const x = spawnSync("python3", [path.join(pkgRoot, "core/scripts/xlsx_export.py"), "--evd", d, "--strict"], { encoding: "utf8" });
    check(x.status === 0, `the export refuses a complete pack in the new report shape:\n${x.stdout}${x.stderr}`);
    const read = py(
      `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(pkgRoot, "core/scripts/lib"))}); ` +
      `import evdpack; p = evdpack.read_pack(${JSON.stringify(d)}); ` +
      `print(json.dumps({"verdict": p.verdict, "rec": p.recommendation, "conc": p.conclusion, ` +
      `"sev": p.report_severities, "defects": [[q.severity, q.summary] for q in p.defects], "gaps": p.gaps}))`);
    let parsed = {};
    try { parsed = JSON.parse(read.stdout.trim().split("\n").pop()); } catch { /* checked below */ }
    check(parsed.verdict === "FAIL", `the export read the verdict as ${JSON.stringify(parsed.verdict)}`);
    check(typeof parsed.rec === "string" && parsed.rec.startsWith("send it back") && parsed.rec.endsWith("empty."),
      `the export did not read the whole Recommendation line: ${JSON.stringify(parsed.rec)}`);
    check(typeof parsed.conc === "string" && parsed.conc.includes("minimum-quantity rule") &&
      !parsed.conc.includes("Recommendation") && !parsed.conc.includes("Verdict:"),
      `the Conclusion the spreadsheet prints is wrong: ${JSON.stringify(parsed.conc)}`);
    check(Array.isArray(parsed.defects) && parsed.defects.length === 1 && parsed.defects[0][0] === "Critical"
      && /Quantity 0 is saved/.test(parsed.defects[0][1]),
      `the defect row was not built from the failed case's FINDING/SEVERITY: ${JSON.stringify(parsed.defects)}`);
    check(Array.isArray(parsed.gaps) && parsed.gaps.length === 0,
      `a complete pack in the new report shape declared gaps: ${JSON.stringify(parsed.gaps)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // The README's mutation counts are the selftests' counts, or the README is
  // making a claim the code no longer backs.
  const readme = fs.readFileSync(path.join(pkgRoot, "README.md"), "utf8");
  const gateSelf = spawnSync("python3", [path.join(pkgRoot, "core/scripts/evd_check.py"), "--selftest"], { encoding: "utf8" });
  const xlsxSelf = spawnSync("python3", [path.join(pkgRoot, "core/scripts/xlsx_export.py"), "--selftest"], { encoding: "utf8" });
  const gateN = /\((\d+) mutations/.exec(gateSelf.stdout);
  const xlsxN = /\((\d+) honesty mutations/.exec(xlsxSelf.stdout);
  const readmeGate = /\*\*(\d+) mutations, each proven to go red/.exec(readme);
  const readmeXlsx = /\*\*(\d+) honesty mutations/.exec(readme);
  check(gateN && readmeGate && gateN[1] === readmeGate[1],
    `README says the evidence gate has ${readmeGate && readmeGate[1]} mutations; the selftest ran ${gateN && gateN[1]}`);
  check(xlsxN && readmeXlsx && xlsxN[1] === readmeXlsx[1],
    `README says the export has ${readmeXlsx && readmeXlsx[1]} honesty mutations; the selftest ran ${xlsxN && xlsxN[1]}`);
}


// ---- an image that explains itself -------------------------------------------
// "evd thiếu khoanh vùng chỗ kiểm thử · nhìn vào hình ảnh không biết đang làm
// gì cả." The gate's rule was on the FILENAME: anything ending in `_boxed.png`
// counted, including a plain screenshot somebody renamed. So the requirement
// moved to the picture, and the picture now declares itself.
{
  const browser = await import("../core/scripts/browser.mjs");
  check(typeof browser.shotAnnotated === "function", "browser.mjs no longer exports shotAnnotated");

  // Both arguments are REFUSED rather than defaulted, because both of them are
  // the complaint this exists to answer.
  const refuses = async (opts, why) => {
    try { await browser.shotAnnotated(null, "/tmp", 1, "x", opts); check(false, `NOT REFUSED — ${why}`); }
    catch (e) { check(/required/.test(e.message), `${why}: threw the wrong error — ${e.message.slice(0, 80)}`); }
  };
  await refuses({}, "no selector");
  await refuses({ proves: "something" }, "no selector, only prose");
  await refuses({ selector: "#x" }, "a selector but nothing saying what it proves");

  const src = fs.readFileSync(path.join(pkgRoot, "core/scripts/browser.mjs"), "utf8");

  // The box is drawn from the selector the check already reads. Picking
  // coordinates by hand is how you box the wrong element.
  check(/getBoundingClientRect/.test(src), "the overlay does not measure the element — it is boxing something else");
  check(/shots\.json/.test(src), "shotAnnotated does not write the sidecar the gate reads");
  check(/annotated: !overlayError/.test(src),
    "the sidecar does not record whether the overlay actually drew — which is how a bare screenshot once passed as annotated");

  // A swallowed overlay failure produced the worst artefact this tool can make:
  // a bare image named _boxed, with a sidecar swearing the element was found.
  check(!/catch \{ \/\* a page mid-navigation/.test(src),
    "the overlay failure is swallowed silently again — that is what produced a lying artefact");
  check(/could not draw the overlay/.test(src), "an overlay failure is not reported to the person running it");

  // `what` was passed to the page but never destructured inside it, so the
  // header threw ReferenceError whenever no explicit title was given — which
  // is every hand-written journey. Latent for as long as only the generator
  // called it.
  const evalArgs = /page\.evaluate\(\(\{([^}]*)\}\)/.exec(src);
  check(!!evalArgs, "could not find the overlay's page.evaluate signature");
  if (evalArgs) {
    const destructured = evalArgs[1].split(",").map((x) => x.trim());
    for (const name of ["selector", "title", "caption", "verdict", "cite", "what"]) {
      check(destructured.includes(name),
        `the overlay uses \`${name}\` but does not destructure it — it will throw inside the page`);
    }
  }
}

// ---- the gate reads what the image claims ------------------------------------
{
  const gate = fs.readFileSync(path.join(pkgRoot, "core/scripts/evd_check.py"), "utf8");
  check(/def read_shots\(/.test(gate), "evd_check no longer reads shots.json");
  check(/is not declared in shots\.json/.test(gate), "a boxed image nobody declared is accepted again");
  check(/declares no `proves`/.test(gate), "an image that says nothing about itself is accepted again");
  check(/the overlay failed to draw/.test(gate), "an image admitting it was never annotated is accepted again");
  check(/no shots\.json beside the images/.test(gate),
    "a hand-annotated folder is not even warned about");

  // The hand-annotation path stays legitimate — it just cannot say what it
  // drew, so it warns rather than fails.
  const handDrawn = gate.split("no shots.json beside the images")[0].slice(-400);
  check(/res\.warn/.test(handDrawn), "a missing sidecar FAILS rather than warns — annotate.py is still a valid path");
}

// ---- report -------------------------------------------------------------------
if (fails.length) {
  console.error(`conformance: ${fails.length} FAILED of ${checks} checks\n`);
  for (const f of fails) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`conformance: ${checks} checks passed`);
