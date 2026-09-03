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
  ]) {
    check(py(key) === expected,
      `python parser disagrees on ${key}: got ${JSON.stringify(py(key))}, expected ${JSON.stringify(expected)}`);
  }
  const pySurfaces = py("surfaces");
  check(pySurfaces.includes("web") && pySurfaces.includes("database"),
    `python parser: surfaces = ${pySurfaces}`);
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
}

// ---- the gates really do prove themselves ------------------------------------
for (const [label, cmd, args] of [
  ["evidence gate", "python3", [path.join(pkgRoot, "core/scripts/evd_check.py"), "--selftest"]],
  ["database write guard", "python3", [path.join(pkgRoot, "core/scripts/db_verify.py"), "--selftest"]],
  ["api recorder", "node", [path.join(pkgRoot, "core/scripts/api_check.mjs"), "--selftest"]],
  ["readiness grader", "node", [path.join(pkgRoot, "src/cli/scan.mjs"), "--selftest"]],
]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  check(r.status === 0, `${label} selftest failed:\n${(r.stdout || "") + (r.stderr || "")}`);
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

// ---- report -------------------------------------------------------------------
if (fails.length) {
  console.error(`conformance: ${fails.length} FAILED of ${checks} checks\n`);
  for (const f of fails) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`conformance: ${checks} checks passed`);
