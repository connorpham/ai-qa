// studio.mjs — `ai-qa studio`: the lane for people who do not live in a terminal.
//
// A local web app on 127.0.0.1 behind a random path token, like the setup
// wizard, and with the same rules: no dependencies, no build step, nothing
// leaves the machine. It adds three things a QA or a product owner can use
// without ever typing a command:
//
//   chat      talk to the agent that has the four workflows installed here
//   canvas    draw a test flow — drag steps, wire them, cite the spec — then
//             compile it into the case files the gate already reads, and run it
//   evidence  open evd/, read the report, see the gate go green or red
//
// What it will not do is the same list the CLI will not do. The chat engine is
// fenced to the lane's own tools; the canvas compiles into evd/ and nowhere
// else; the runner spawns the gates by argv, never a shell; the evidence viewer
// serves evd/ and refuses everything outside it.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { c, gitRoot, readIfExists } from "../cli/util.mjs";
import { CONFIG_NAME, configPath, loadConfig, get } from "../cli/config.mjs";
import { compile, validate, NODE_TYPES, KINDS, NAME_RE, TICKET_RE } from "./studio/compile.mjs";
import { makeEngines, describeEngines } from "./studio/engines.mjs";
import * as projects from "./studio/projects.mjs";
import * as worktrees from "./studio/worktrees.mjs";
import * as terminal from "./studio/terminal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, "studio");
const MAX_BODY = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// project facts the page needs
// ---------------------------------------------------------------------------
function projectState(root, cfg, activeEnv) {
  const envs = get(cfg, "environments", null);
  const names = envs && typeof envs === "object" ? Object.keys(envs).filter((k) => k !== "default") : [];
  const chosen = activeEnv || get(cfg, "environments.default", "") || names[0] || "";
  const envUrl = (chosen && String(get(cfg, `environments.${chosen}.url`, "") || "")) || String(get(cfg, "app.url", "") || "");
  const tracker = String(get(cfg, "tracker.provider", "markdown") || "markdown");
  const qaDir = String(get(cfg, "paths.qa", "docs/qa") || "docs/qa");
  let tickets = [];
  if (tracker === "markdown") {
    const dir = path.join(root, qaDir, "tickets");
    try { tickets = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort(); } catch { tickets = []; }
  }
  const evdDir = path.join(root, String(get(cfg, "paths.evidence", "evd") || "evd"));
  let evd = [];
  try { evd = fs.readdirSync(evdDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { evd = []; }
  return {
    root,
    project: {
      name: String(get(cfg, "project.name", path.basename(root)) || ""),
      key: String(get(cfg, "project.key", "QA") || "QA"),
      language: String(get(cfg, "project.language", "en") || "en"),
      surfaces: get(cfg, "surfaces", []),
      appUrl: String(get(cfg, "app.url", "") || ""),
      apiBase: String(get(cfg, "api.base_url", "") || ""),
      oracleSpecs: get(cfg, "oracle.specs", []) || [],
      tracker,
      writeGate: String(get(cfg, "autonomy.write_gate", "ask") || "ask"),
      autonomy: String(get(cfg, "autonomy.level", "assisted") || "assisted"),
      accounts: get(cfg, "accounts.roles", []) || [],
    },
    environments: { names, active: chosen, url: envUrl, writes: chosen ? String(get(cfg, `environments.${chosen}.writes`, "allowed") || "allowed") : "allowed" },
    tickets, evd,
    flowsDir: path.posix.join(qaDir, "flows"),
  };
}

function envFor(root, cfg, envName) {
  const out = {};
  if (envName) out.AIQA_ENV = envName;
  return out;
}

function ctxFor(state) {
  return { appUrl: state.project.appUrl, apiBase: state.project.apiBase, envName: state.environments.active, envUrl: state.environments.url };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > MAX_BODY) { req.destroy(); reject(new Error("body too large")); } });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function sseStart(res) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": studio\n\n");
  return (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".http": "text/plain; charset=utf-8", ".sql": "text/plain; charset=utf-8",
  ".mjs": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

/** Resolve a repo-relative path and refuse anything outside `within`. */
function inside(root, within, rel) {
  const abs = path.resolve(root, String(rel || ""));
  const base = path.resolve(root, within);
  const r = path.relative(base, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) return null;
  if (/(^|\/)\.env(\.|$)/.test(r)) return null;
  return abs;
}

function runSync(root, argv, env = {}, timeout = 300_000) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

function tree(dir, rel = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push({ name: e.name, path: r, dir: true, children: tree(path.join(dir, e.name), r) });
    else { let size = 0; try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* gone */ } out.push({ name: e.name, path: r, size }); }
  }
  return out;
}

/** evd/<T>/manifest.md: seed one that says what it does not yet know. */
function seedRootManifest(root, ticket) {
  const dir = path.join(root, "evd", ticket);
  const file = path.join(dir, "manifest.md");
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    `# ${ticket} — what was checked`,
    "",
    "Cases below were drawn in ai-qa studio and compiled into this folder. A case",
    "is evidence only once it has run; until then its RESULT is BLOCKED and says so.",
    "",
    "COVERAGE:",
    "- security: (decide — the TC_n that covered it, or \"n/a — <why it does not apply here>\")",
    "- accessibility: (decide — the TC_n that covered it, or \"n/a — <why it does not apply here>\")",
    "",
    "<!-- ai-qa:index -->",
    "<!-- /ai-qa:index -->",
    "",
  ].join("\n"));
  return true;
}

function refreshIndex(root, ticket, env) {
  if (!fs.existsSync(path.join(root, ".ai-qa/scripts/evd_index.py"))) return;
  runSync(root, ["python3", ".ai-qa/scripts/evd_index.py", "--evd", path.posix.join("evd", ticket)], env, 60_000);
}

function gate(root, ticket, env) {
  const r = runSync(root, ["python3", ".ai-qa/scripts/evd_check.py", "--evd", path.posix.join("evd", ticket)], env, 120_000);
  return { ok: r.status === 0, text: r.out };
}

/** Rewrite the RESULT/ACTUAL block of a compiled case manifest after a run. */
function recordRun(root, caseDir, outcome) {
  const file = path.join(root, caseDir, "manifest.md");
  if (!fs.existsSync(file)) return;
  let lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => !/^(REASON|UNBLOCK|RAN-AT):/.test(l));
  const set = (key, value) => {
    const i = lines.findIndex((l) => l.startsWith(key + ":"));
    if (i >= 0) lines[i] = `${key}: ${value}`; else lines.splice(1, 0, `${key}: ${value}`);
  };
  set("RESULT", outcome.result);
  set("ACTUAL", outcome.actual || "(no output recorded)");
  const ri = lines.findIndex((l) => l.startsWith("RESULT:"));
  const extra = [`RAN-AT: ${new Date().toISOString()}${outcome.env ? ` · env ${outcome.env}` : ""}`];
  if (outcome.result === "BLOCKED") extra.push(`REASON: ${outcome.reason || "a step could not start"}`, `UNBLOCK: ${outcome.unblock || "bring the environment up and run again"}`);
  lines.splice(ri + 1, 0, ...extra);
  fs.writeFileSync(file, lines.join("\n"));
}

const PLACEHOLDER = /\{\{\s*last\.([A-Za-z0-9_]+)\s*\}\}/g;
function fillPlaceholders(str, last) {
  return String(str).replace(PLACEHOLDER, (_, f) => (last && last[f] !== undefined ? String(last[f]) : ""));
}

/** Run compiled steps one by one, streaming output; FAIL continues (evidence
 * and clean-up still happen), BLOCKED stops. */
async function runSteps(root, plan, env, send, signal) {
  const outcomes = [];
  let last = null;
  let blocked = false;
  for (const step of plan.steps) {
    if (signal.aborted) break;
    if (blocked && step.kind !== "cleanup") { outcomes.push({ id: step.id, kind: step.kind, label: step.label, status: "skipped" }); continue; }
    let argv = step.argv.slice();
    if (step.placeholders) {
      argv = argv.map((a) => fillPlaceholders(a, last));
      if (step.bodyFile) {
        const abs = path.join(root, step.bodyFile);
        try { fs.writeFileSync(abs, fillPlaceholders(fs.readFileSync(abs, "utf8"), last)); } catch { /* keep the template */ }
      }
    }
    send({ type: "step", id: step.id, label: step.label, status: "start", argv });
    const code = await new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: root, env: { ...process.env, ...env, ...(step.env || {}) }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      const onData = (chunk) => { const s = String(chunk); text += s; send({ type: "out", id: step.id, text: s }); };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (e) => { send({ type: "out", id: step.id, text: `could not start: ${e.message}\n` }); resolve({ code: 2, text }); });
      child.on("close", (code) => resolve({ code, text }));
      signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, { once: true });
    });
    const status = code.code === 0 ? "ok" : code.code === 2 ? "blocked" : "fail";
    outcomes.push({ id: step.id, kind: step.kind, label: step.label, status, code: code.code, text: code.text });
    send({ type: "step", id: step.id, label: step.label, status, code: code.code });
    if ((step.kind === "api" || step.kind === "cleanup") && step.outDir) {
      try { const r = JSON.parse(fs.readFileSync(path.join(root, step.outDir, "response.json"), "utf8")); if (r && r.body && typeof r.body === "object") last = r.body; } catch { /* no body */ }
    }
    if (status === "blocked") { blocked = true; if (step.kind === "preflight") break; }
  }
  const failed = outcomes.some((o) => o.status === "fail");
  const anyBlocked = outcomes.some((o) => o.status === "blocked");
  const result = anyBlocked && !failed ? "BLOCKED" : failed ? "FAIL" : signal.aborted ? "BLOCKED" : "PASS";
  const actual = outcomes.filter((o) => o.text).map((o) => {
    const keep = o.text.split("\n").filter((l) => /^(API:|DB:|APP:|EVIDENCE:|EXPECT:|\s+x |BROWSER:|TRACKER:)/.test(l)).map((l) => l.trim());
    return `${o.label}: ${keep.join(" · ") || (o.status === "ok" ? "ok" : o.status)}`;
  }).join(" | ");
  const blockedStep = outcomes.find((o) => o.status === "blocked");
  return { result, actual: actual.slice(0, 1800), outcomes,
    reason: blockedStep ? `${blockedStep.label} — ${blockedStep.text.split("\n").find((l) => l.trim()) || "could not start"}`.slice(0, 300) : (signal.aborted ? "the run was stopped from the studio" : ""),
    unblock: blockedStep && blockedStep.kind === "preflight" ? "start the app (app.start) or correct app.url, then run again" : "fix the environment named in REASON and run again" };
}

// ---------------------------------------------------------------------------
// prompts for the engines
// ---------------------------------------------------------------------------
function studioSystemNote(state) {
  return [
    "You are running inside ai-qa studio, a local web page. The person talking to you may be a QA engineer or a product owner who does not read code.",
    `Project: ${state.project.name} (${state.project.key}-nnn). Surfaces: ${[].concat(state.project.surfaces).join(", ")}. Environment: ${state.environments.active || "(default)"} → ${state.environments.url || "(app.url unset)"}. Working language: ${state.project.language}.`,
    "Use the installed workflows (/onboard, /qa, /triage, /regress) exactly as written. Your tools are the lane's gates under .ai-qa/scripts, reading the repo, and writing under evd/ and docs/qa/ — nothing else, by design. Never change product code. Never print a secret.",
    "Answer in the working language, plainly, and say what you ran. When a step could not run, say BLOCKED and why.",
  ].join("\n");
}

function fullSystemPrompt(root, state) {
  const parts = [studioSystemNote(state), "", "## aiqa.config.yaml", "", readIfExists(path.join(root, CONFIG_NAME)).slice(0, 12_000)];
  for (const wf of ["qa", "onboard", "triage", "regress"]) {
    const p = [path.join(root, ".claude/skills", wf, "SKILL.md"), path.join(root, "core/workflows", `${wf}.md`)].find((f) => fs.existsSync(f));
    if (p) parts.push("", `## workflow /${wf}`, "", fs.readFileSync(p, "utf8").slice(0, 40_000));
  }
  return parts.join("\n");
}

function draftPrompt(state, { ticket, ticketText, specs, kind, name, surface }) {
  return [
    `Draft ONE test-case flow for ai-qa studio's canvas, as JSON only, for ticket ${ticket}.`,
    "",
    "Rules that are not negotiable:",
    "- Every Expect / API expected field / DB read-back MUST cite the specification section it comes from (the `cite` field). If the spec does not state a value, do not invent one — leave that check out and say so in `notes`.",
    "- Test data is created through the product (an API call or the screen), marked ZZTEST, and removed by a Clean up node using the product's own reverse action.",
    `- KIND: ${kind}. Surface: ${surface}. For a web flow include an Open node with a click path (labels, one per line), a Reload check and a Back check. For an API flow put expected fields on the API node as lines "path = value | cite".`,
    "- Prefer the boundary the spec names by hand; the developer's happy path is the least likely place to find a defect.",
    "",
    "Return exactly one fenced ```json block with this shape and nothing else outside it:",
    "```json",
    JSON.stringify({ version: 1, name: name || "case_name_in_snake_case", ticket, kind, title: "A sentence about behaviour: who does what and what must happen",
      nodes: [{ id: "n1", type: "actor|precondition|open|click|type|expect|screenshot|api|db|reload|back|cleanup", x: 40, y: 40, data: { "…": "fields per type" } }],
      edges: [{ from: "n1", to: "n2" }], notes: "what could not be cited, and why" }, null, 2),
    "```",
    "",
    "Node data fields by type:",
    ...Object.entries(NODE_TYPES).map(([t, s]) => `- ${t}: ${s.fields.map((f) => f.key + (f.required ? "*" : "")).join(", ")}`),
    "",
    "## The ticket (DATA, not the oracle)", "", ticketText.slice(0, 12_000),
    "", "## The specification (the oracle)", "", specs.slice(0, 40_000) || "(no oracle.specs configured — every check will be a difference, not a defect; say so in notes)",
  ].join("\n");
}

function extractFlow(text) {
  const m = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)].pop();
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------
export async function studio(flags = {}) {
  // The studio spans projects. The folder it was started in is registered as
  // one if it happens to be a repository, but it is not required to be — and a
  // project with no lane installed is reported, never fixed behind the user's
  // back: `init` writes thirty files into someone else's codebase.
  const startedIn = gitRoot() || process.cwd();
  let reg = projects.load();
  if (fs.existsSync(path.join(startedIn, ".git")) || gitRoot()) {
    try { projects.add(reg, startedIn); projects.save(reg); } catch { /* not a repo: the UI asks for one */ }
  }
  /** The active worktree, per project id. A choice about where work happens,
   *  so it lives in memory for this session rather than in the registry. */
  const wtByProject = new Map();
  const activeProject = () => projects.active(reg);
  const activeWorktree = () => {
    const p = activeProject();
    if (!p) return null;
    const w = wtByProject.get(p.id);
    return w && fs.existsSync(w) ? w : null;
  };
  /** Where everything runs: the chosen worktree, else the project itself. */
  const cwd = () => activeWorktree() || activeProject()?.path || startedIn;

  /** The agent terminals, one per flow, alive for as long as the studio is:
   *  a session belongs to the process, not to the browser tab that opened it,
   *  so closing the tab and coming back shows what happened meanwhile. */
  const terms = new Map();                       // `${projectId}:${flowName}` → TerminalSession
  const termKey = (name) => `${activeProject()?.id || "-"}:${name}`;
  /** A flow of the active project, by name: its document and the checkout it
   *  runs in — the worktree it asked for, or the project when that is gone. */
  const resolveFlow = (name) => {
    const p = activeProject();
    if (!p || !NAME_RE.test(String(name || ""))) return null;
    const st = projectState(p.path, config(p.path), activeEnv.name);
    const file = path.join(p.path, st.flowsDir, `${name}.json`);
    let flow;
    try { flow = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
    const at = flow.worktree ? path.join(p.path, worktrees.WORKTREE_SUBDIR, flow.worktree) : p.path;
    const exists = fs.existsSync(at);
    return { project: p, flow, cwd: exists ? at : p.path, worktreeMissing: !!flow.worktree && !exists };
  };

  // Re-read on every request rather than once at boot. aiqa.config.yaml is the
  // contract, it is a file a person edits while the studio is open — a new
  // environment, a spec they finally wrote down — and a page showing values the
  // file no longer holds is the same class of lie the gates exist to prevent.
  // It is a few kilobytes of local YAML; reading it per request costs nothing.
  const config = (root) => { try { return loadConfig(root); } catch { return {}; } };
  const token = crypto.randomBytes(12).toString("hex");
  const engines = makeEngines();
  const port = Number(flags.port || 0);
  const activeEnv = { name: process.env.AIQA_ENV || "" };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!url.pathname.startsWith(`/${token}`)) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
    const route = url.pathname.slice(token.length + 1) || "/";
    const root = cwd();                       // every route below is relative to this
    // Resolved inside state(), not captured from the handler's `root`: a route
    // that CHANGES the active worktree must report where work happens now, not
    // where it happened when the request arrived.
    const state = () => {
      const p = activeProject();
      const at = cwd();
      const st = projectState(at, config(at), activeEnv.name);
      const detected = projects.detectAgents();
      const wl = p ? worktrees.list(p.path) : { worktrees: [] };
      const here = activeWorktree();
      st.cwd = at;
      st.hasLane = fs.existsSync(configPath(at));
      st.home = os.homedir();
      st.clonesDir = projects.CLONES_DIR;
      st.terminal = terminal.availability();
      st.projects = {
        list: reg.projects.map((x) => ({ id: x.id, name: x.name, path: x.path, agent: x.agent })),
        activeId: p?.id || null,
        active: p ? { ...p, agentResolved: projects.resolveAgent(p, detected) } : null,
      };
      st.agents = detected;
      st.worktrees = {
        list: wl.worktrees || [],
        activePath: here,
        activeName: here ? (wl.worktrees.find((w) => path.resolve(w.path) === path.resolve(here))?.name || path.basename(here)) : null,
      };
      return st;
    };
    try {
      // ---- page + assets -----------------------------------------------------
      if (req.method === "GET" && (route === "/" || route === "")) {
        const html = fs.readFileSync(path.join(ASSETS, "index.html"), "utf8")
          .replace("__STUDIO_BOOT__", JSON.stringify({ token, state: state(), engines: describeEngines(engines), schema: { nodeTypes: NODE_TYPES, kinds: KINDS } }).replace(/</g, "\\u003c"));
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" }).end(html);
        return;
      }
      if (req.method === "GET" && route.startsWith("/assets/")) {
        // our own files flat, and the vendored terminal emulator one level down
        const rel = route.slice("/assets/".length);
        if (!/^(vendor\/)?[a-z0-9._-]+$/i.test(rel)) { res.writeHead(404).end(); return; }
        const abs = path.join(ASSETS, rel);
        if (!fs.existsSync(abs)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": MIME[path.extname(rel)] || "application/octet-stream", "cache-control": rel.startsWith("vendor/") ? "max-age=86400" : "no-store" }).end(fs.readFileSync(abs));
        return;
      }

      // ---- state -------------------------------------------------------------
      if (req.method === "GET" && route === "/api/state") { json(res, 200, { state: state(), engines: describeEngines(engines) }); return; }
      if (req.method === "POST" && route === "/api/env") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const st = state();
        if (body.name && !st.environments.names.includes(body.name)) { json(res, 400, { error: "unknown environment" }); return; }
        activeEnv.name = body.name || "";
        json(res, 200, { state: state() });
        return;
      }
      if (req.method === "GET" && route === "/api/ticket") {
        const key = String(url.searchParams.get("key") || "");
        if (!TICKET_RE.test(key)) { json(res, 400, { error: "ticket key like SHOP-142" }); return; }
        const r = runSync(root, ["python3", ".ai-qa/scripts/tracker.py", "get", key, "--json"], envFor(root, config(root), activeEnv.name), 60_000);
        let ticket = null;
        try { ticket = JSON.parse(r.out.slice(r.out.indexOf("{"))); } catch { /* not json */ }
        json(res, r.status === 0 ? 200 : r.status === 2 ? 424 : 404, { status: r.status, ticket, raw: r.out.slice(0, 4000) });
        return;
      }
      if (req.method === "GET" && route === "/api/spec") {
        const specs = [].concat(state().project.oracleSpecs || []).map((rel) => {
          const abs = inside(root, ".", rel);
          return { path: rel, text: abs && fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").slice(0, 60_000) : null };
        });
        json(res, 200, { specs });
        return;
      }

      // ---- flows -------------------------------------------------------------
      // A flow belongs to the PROJECT, not to whichever worktree happens to be
      // active: it is the unit a person creates ("verify SHOP-142 with Claude,
      // on a fresh checkout of main"), and it carries its own agent and its own
      // worktree. So the files live under the project checkout, and opening a
      // flow is what moves the studio into that flow's worktree.
      const projectRoot = activeProject()?.path || root;
      const flowsDir = path.join(projectRoot, state().flowsDir);
      const flowCwd = (flow) => (flow?.worktree ? path.join(projectRoot, worktrees.WORKTREE_SUBDIR, flow.worktree) : projectRoot);
      /** What the sidebar shows for a flow without opening it: its choices,
       *  and the RESULT of its compiled case if one has been run. */
      const flowSummary = (name) => {
        let flow;
        try { flow = JSON.parse(fs.readFileSync(path.join(flowsDir, `${name}.json`), "utf8")); } catch { return { name, broken: true }; }
        const at = flowCwd(flow);
        let result = null, ranAt = null;
        if (flow.ticket && NAME_RE.test(flow.name || "")) {
          const evd = path.join(at, "evd", flow.ticket);
          try {
            const dir = fs.readdirSync(evd).find((d) => new RegExp(`^TC_\\d+_${flow.name}$`).test(d));
            if (dir) {
              const m = fs.readFileSync(path.join(evd, dir, "manifest.md"), "utf8");
              result = (m.match(/^RESULT:\s*(\S+)/m) || [])[1] || null;
              ranAt = (m.match(/^RAN-AT:\s*(\S+)/m) || [])[1] || null;
            }
          } catch { /* not compiled yet */ }
        }
        let updated = null;
        try { updated = fs.statSync(path.join(flowsDir, `${name}.json`)).mtime.toISOString(); } catch { /* gone */ }
        const t = terms.get(termKey(name));
        return { name, ticket: flow.ticket || "", title: flow.title || "", kind: flow.kind || "acceptance", agent: flow.agent || null,
          worktree: flow.worktree || null, worktreeExists: !flow.worktree || fs.existsSync(at), steps: (flow.nodes || []).length, result, ranAt, updated,
          terminal: t ? { running: t.running, exitCode: t.exitCode, startedAt: t.startedAt } : null };
      };
      if (req.method === "GET" && route === "/api/flows") {
        let names = [];
        try { names = fs.readdirSync(flowsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort(); } catch { names = []; }
        json(res, 200, { flows: names.map(flowSummary), projectId: activeProject()?.id || null });
        return;
      }
      const fo = route.match(/^\/api\/flows\/([a-z0-9][a-z0-9_-]{0,59})\/open$/);
      if (fo && req.method === "POST") {
        const abs = path.join(flowsDir, `${fo[1]}.json`);
        if (!fs.existsSync(abs)) { json(res, 404, { error: "no such flow" }); return; }
        const flow = JSON.parse(fs.readFileSync(abs, "utf8"));
        const p = activeProject();
        let worktreeMissing = false;
        if (p) {
          if (flow.worktree && fs.existsSync(flowCwd(flow))) wtByProject.set(p.id, flowCwd(flow));
          else { wtByProject.delete(p.id); worktreeMissing = !!flow.worktree; }
        }
        const st = state();
        json(res, 200, { flow, state: st, worktreeMissing, shellOnly: flow.agent === "shell",
          agent: flow.agent === "shell" ? { id: null, chosen: true, installed: false, shellOnly: true, reason: null } : projects.resolveAgent(p, st.agents, flow.agent || null) });
        return;
      }
      const fm = route.match(/^\/api\/flows\/([a-z0-9][a-z0-9_-]{0,59})$/);
      if (fm) {
        const abs = path.join(flowsDir, `${fm[1]}.json`);
        if (req.method === "GET") { if (!fs.existsSync(abs)) { json(res, 404, { error: "no such flow" }); return; } json(res, 200, { flow: JSON.parse(fs.readFileSync(abs, "utf8")) }); return; }
        if (req.method === "PUT") {
          const flow = JSON.parse((await readBody(req)) || "{}");
          if (flow.name !== fm[1] || !NAME_RE.test(fm[1])) { json(res, 400, { error: "the flow's name must match the URL" }); return; }
          // "shell" is the explicit choice of no agent: the terminal opens, nothing is typed
          if (flow.agent && flow.agent !== "shell" && !projects.AGENTS.some((a) => a.id === flow.agent)) { json(res, 400, { error: `unknown agent: ${flow.agent}` }); return; }
          if (flow.worktree && !worktrees.NAME_RE.test(flow.worktree)) { json(res, 400, { error: "bad worktree name" }); return; }
          fs.mkdirSync(flowsDir, { recursive: true });
          fs.writeFileSync(abs, JSON.stringify(flow, null, 2) + "\n");
          json(res, 200, { saved: fm[1], validation: validate(flow), summary: flowSummary(fm[1]) });
          return;
        }
        if (req.method === "DELETE") { try { fs.unlinkSync(abs); } catch { /* gone */ } json(res, 200, { deleted: fm[1] }); return; }
      }
      if (req.method === "POST" && route === "/api/validate") {
        const flow = JSON.parse((await readBody(req)) || "{}");
        json(res, 200, validate(flow));
        return;
      }
      if (req.method === "POST" && route === "/api/compile") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const st = state();
        let out;
        try { out = compile(body.flow, { ...ctxFor(st), caseNo: body.caseNo }); }
        catch (e) { json(res, 422, { error: e.message, errors: e.errors || [], warnings: e.warnings || [] }); return; }
        for (const [rel, text] of Object.entries(out.files)) {
          const abs = inside(root, "evd", rel);
          if (!abs) continue;
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, text);
          if (rel.endsWith(".sh")) fs.chmodSync(abs, 0o755);
        }
        seedRootManifest(root, body.flow.ticket);
        refreshIndex(root, body.flow.ticket, envFor(root, config(root), activeEnv.name));
        json(res, 200, { caseDir: out.caseDir, files: out.files, steps: out.steps, surface: out.surface, warnings: out.warnings, gate: gate(root, body.flow.ticket, envFor(root, config(root), activeEnv.name)) });
        return;
      }
      if (req.method === "POST" && route === "/api/run") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const st = state();
        const send = sseStart(res);
        const ac = new AbortController();
        req.on("close", () => ac.abort());
        let out;
        try { out = compile(body.flow, { ...ctxFor(st), caseNo: body.caseNo }); }
        catch (e) { send({ type: "error", message: e.message }); send({ type: "done", result: "INVALID" }); res.end(); return; }
        for (const [rel, text] of Object.entries(out.files)) {
          const abs = inside(root, "evd", rel); if (!abs) continue;
          fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text);
          if (rel.endsWith(".sh")) fs.chmodSync(abs, 0o755);
        }
        seedRootManifest(root, body.flow.ticket);
        send({ type: "compiled", caseDir: out.caseDir, steps: out.steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label })), warnings: out.warnings });
        if (st.environments.writes === "forbidden" && out.steps.some((s) => s.kind === "api" && /^(POST|PUT|PATCH|DELETE)$/i.test(s.argv[2] || ""))) {
          send({ type: "error", message: `environment ${st.environments.active} is writes: forbidden — a flow that creates data is BLOCKED there, not attempted` });
          recordRun(root, out.caseDir, { result: "BLOCKED", actual: "not run", reason: `environment ${st.environments.active} forbids writes`, unblock: "run against an environment where test data may be created", env: st.environments.active });
          refreshIndex(root, body.flow.ticket, envFor(root, config(root), activeEnv.name));
          send({ type: "gate", ...gate(root, body.flow.ticket, envFor(root, config(root), activeEnv.name)) });
          send({ type: "done", result: "BLOCKED" }); res.end(); return;
        }
        const env = envFor(root, config(root), activeEnv.name);
        const outcome = await runSteps(root, out, env, send, ac.signal);
        recordRun(root, out.caseDir, { ...outcome, env: st.environments.active });
        refreshIndex(root, body.flow.ticket, env);
        send({ type: "gate", ...gate(root, body.flow.ticket, env) });
        send({ type: "done", result: outcome.result, caseDir: out.caseDir });
        res.end();
        return;
      }

      // ---- evidence ------------------------------------------------------------
      if (req.method === "GET" && route === "/api/evd") {
        json(res, 200, { tree: tree(path.join(root, "evd")) });
        return;
      }
      if (req.method === "GET" && route === "/api/evd/file") {
        const rel = String(url.searchParams.get("path") || "");
        const abs = inside(root, "evd", path.posix.join("evd", rel));
        if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404).end("not found"); return; }
        const ext = path.extname(abs).toLowerCase();
        const headers = { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" };
        if (ext === ".xlsx") headers["content-disposition"] = `attachment; filename="${path.basename(abs)}"`;
        res.writeHead(200, headers).end(fs.readFileSync(abs));
        return;
      }
      if (req.method === "POST" && route === "/api/gate") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!TICKET_RE.test(String(body.ticket || ""))) { json(res, 400, { error: "ticket key like SHOP-142" }); return; }
        json(res, 200, gate(root, body.ticket, envFor(root, config(root), activeEnv.name)));
        return;
      }
      if (req.method === "POST" && route === "/api/export") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!TICKET_RE.test(String(body.ticket || ""))) { json(res, 400, { error: "ticket key like SHOP-142" }); return; }
        const r = runSync(root, ["python3", ".ai-qa/scripts/xlsx_export.py", "--evd", path.posix.join("evd", body.ticket)], envFor(root, config(root), activeEnv.name), 120_000);
        const m = r.out.match(/(evd\/[^\s]+\.xlsx)/);
        json(res, r.status === 2 ? 424 : 200, { status: r.status, text: r.out, file: m ? m[1].replace(/^evd\//, "") : null });
        return;
      }

      // ---- chat ----------------------------------------------------------------
      if (req.method === "POST" && (route === "/api/chat" || route === "/api/draft")) {
        const body = JSON.parse((await readBody(req)) || "{}");
        const st = state();
        // the custom engine's command is a per-project setting, so refresh it
        const custom = engines.find((e) => e.id === "custom");
        if (custom) custom.template = activeProject()?.customCommand || null;
        // The flow's agent wins over the project's default; an explicit
        // `engine` in the body (the old top-bar selector, tests) wins over both.
        // /api/draft is a one-off, non-interactive call made on the person's
        // behalf — not their terminal — so it takes the first engine that can
        // answer: Claude Code --print, the Anthropic API, or the project's own
        // command. /api/chat, the fenced stream, follows the flow's agent.
        const resolved = projects.resolveAgent(activeProject(), st.agents, body.agent || null);
        let engine;
        if (route === "/api/draft") {
          engine = (body.engine && engines.find((e) => e.id === body.engine)) || engines.find((e) => e.availability().available) || engines[0];
        } else {
          const chosen = body.engine || projects.engineFor(resolved) || "claude-code";
          engine = engines.find((e) => e.id === chosen) || engines[0];
          if (!body.engine && !resolved.chat) { json(res, 424, { error: `${resolved.label || resolved.id}: ${resolved.reason || "the fenced chat has no adapter for this agent"}` }); return; }
        }
        const avail = engine.availability();
        if (!avail.available) { json(res, 424, { error: `${engine.label}: ${avail.reason}` }); return; }
        const send = sseStart(res);
        const ac = new AbortController();
        req.on("close", () => ac.abort());
        const env = envFor(root, config(root), activeEnv.name);
        let message = String(body.message || "");
        if (route === "/api/draft") {
          const key = String(body.ticket || "");
          if (!TICKET_RE.test(key)) { send({ type: "error", message: "ticket key like SHOP-142" }); send({ type: "done" }); res.end(); return; }
          const t = runSync(root, ["python3", ".ai-qa/scripts/tracker.py", "get", key], env, 60_000);
          const specs = [].concat(st.project.oracleSpecs || []).map((rel) => { const abs = inside(root, ".", rel); return abs && fs.existsSync(abs) ? `### ${rel}\n\n${fs.readFileSync(abs, "utf8")}` : ""; }).join("\n\n");
          message = draftPrompt(st, { ticket: key, ticketText: t.out, specs, kind: body.kind || "acceptance", name: body.name, surface: body.surface || (st.project.surfaces.includes("web") ? "web" : "api") });
        }
        const systemPrompt = engine.id === "anthropic" ? fullSystemPrompt(root, st) : studioSystemNote(st);
        let collected = "";
        const result = await engine.chat({
          message, sessionId: route === "/api/draft" ? null : (body.sessionId || null), cwd: root, env, signal: ac.signal, systemPrompt,
          onEvent: (ev) => { if (ev.type === "text") collected += ev.text; if (ev.type !== "done") send(ev); },
        });
        if (route === "/api/draft") {
          const flow = extractFlow(collected);
          if (flow) { flow.version = 1; flow.ticket = flow.ticket || body.ticket; flow.kind = KINDS.includes(flow.kind) ? flow.kind : (body.kind || "acceptance"); flow.name = NAME_RE.test(String(flow.name || "")) ? flow.name : (body.name || "drafted_case"); }
          send({ type: "flow", flow, validation: flow ? validate(flow) : null });
        }
        send({ type: "done", sessionId: result.sessionId, cost: result.cost, usage: result.usage || null });
        res.end();
        return;
      }

      // ---- projects ----------------------------------------------------------
      if (req.method === "GET" && route === "/api/projects") {
        json(res, 200, { projects: reg.projects, activeId: activeProject()?.id || null, agents: projects.detectAgents({ fresh: url.searchParams.get("fresh") === "1" }) });
        return;
      }
      if (req.method === "POST" && route === "/api/inspect") {
        const body = JSON.parse((await readBody(req)) || "{}");
        json(res, 200, projects.inspect(path.resolve(String(body.path || "").replace(/^~(?=$|\/)/, os.homedir()))));
        return;
      }
      // The folder picker. A browser page cannot ask the OS for a folder and
      // learn its absolute path, so the studio lists one level at a time and
      // the person clicks down to the repository they mean.
      if (req.method === "GET" && route === "/api/fs") {
        json(res, 200, projects.browse(url.searchParams.get("path") || "~"));
        return;
      }
      // Clone from a URL, streaming git's own progress lines; on success the
      // clone is registered as a project. Nothing here reads a credential —
      // git uses whatever the machine already has, and GIT_TERMINAL_PROMPT=0
      // means it fails rather than waits on a password nobody can type.
      if (req.method === "POST" && route === "/api/clone") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const send = sseStart(res);
        const ac = new AbortController();
        req.on("close", () => ac.abort());
        send({ type: "progress", text: `git clone ${String(body.url || "").trim()}` });
        const r = await projects.clone(body.url, body.into || null, { onLine: (text) => send({ type: "progress", text }), signal: ac.signal });
        if (!r.ok) { send({ type: "done", ok: false, error: r.error }); res.end(); return; }
        let project = null, info = null;
        try { ({ project, info } = projects.add(reg, r.dest, { agent: body.agent || null })); projects.save(reg); }
        catch (e) { send({ type: "done", ok: false, error: `cloned to ${r.dest}, but it could not be registered: ${e.message}` }); res.end(); return; }
        send({ type: "done", ok: true, dest: r.dest, project, info, state: state() });
        res.end();
        return;
      }
      if (req.method === "POST" && route === "/api/projects") {
        const body = JSON.parse((await readBody(req)) || "{}");
        try {
          const { project, info, added } = projects.add(reg, body.path, { agent: body.agent || null });
          projects.save(reg);
          json(res, 200, { project, info, added, state: state() });
        } catch (e) { json(res, 400, { error: e.message }); }
        return;
      }
      if (req.method === "POST" && route === "/api/projects/active") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!reg.projects.some((p) => p.id === body.id)) { json(res, 404, { error: "no such project" }); return; }
        reg.activeProjectId = body.id;
        projects.save(reg);
        json(res, 200, { state: state() });
        return;
      }
      {
        const m = route.match(/^\/api\/projects\/([0-9a-f]{6,24})$/);
        if (m && (req.method === "POST" || req.method === "PATCH")) {
          const body = JSON.parse((await readBody(req)) || "{}");
          const p = projects.update(reg, m[1], body);
          if (!p) { json(res, 404, { error: "no such project" }); return; }
          projects.save(reg);
          json(res, 200, { project: p, state: state() });
          return;
        }
        if (m && req.method === "DELETE") {
          const gone = projects.remove(reg, m[1]);
          projects.save(reg);
          json(res, gone ? 200 : 404, gone ? { removed: m[1], state: state() } : { error: "no such project" });
          return;
        }
      }

      // ---- worktrees ---------------------------------------------------------
      if (req.method === "GET" && route === "/api/worktrees") {
        const p = activeProject();
        if (!p) { json(res, 400, { error: "no project is active" }); return; }
        json(res, 200, { ...worktrees.list(p.path), branches: worktrees.branches(p.path), activePath: activeWorktree() });
        return;
      }
      if (req.method === "POST" && route === "/api/worktrees") {
        const p = activeProject();
        if (!p) { json(res, 400, { error: "no project is active" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = worktrees.create(p.path, { name: body.name, base: body.base || null, newBranch: !!body.newBranch });
        if (!r.ok) { json(res, 422, { error: r.error }); return; }
        if (body.activate !== false) wtByProject.set(p.id, r.worktree.path);
        json(res, 200, { worktree: r.worktree, state: state() });
        return;
      }
      if (req.method === "POST" && route === "/api/worktrees/active") {
        const p = activeProject();
        if (!p) { json(res, 400, { error: "no project is active" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.path) wtByProject.delete(p.id);
        else {
          const known = (worktrees.list(p.path).worktrees || []).some((w) => path.resolve(w.path) === path.resolve(body.path));
          if (!known) { json(res, 404, { error: "not a worktree of this project" }); return; }
          wtByProject.set(p.id, path.resolve(body.path));
        }
        json(res, 200, { state: state() });
        return;
      }
      {
        const m = route.match(/^\/api\/worktrees\/(.+)$/);
        if (m && req.method === "DELETE") {
          const p = activeProject();
          if (!p) { json(res, 400, { error: "no project is active" }); return; }
          const name = decodeURIComponent(m[1]);
          const r = worktrees.remove(p.path, name, { force: url.searchParams.get("force") === "1" });
          if (!r.ok) { json(res, r.needsForce ? 409 : 422, { error: r.error, needsForce: !!r.needsForce }); return; }
          const gone = path.resolve(path.join(p.path, worktrees.WORKTREE_SUBDIR, name));
          if (activeWorktree() && path.resolve(activeWorktree()) === gone) wtByProject.delete(p.id);
          json(res, 200, { removed: name, state: state() });
          return;
        }
      }

      // ---- terminals (the socket itself is on `upgrade`, below) ---------------
      if (req.method === "GET" && route === "/api/term") {
        const p = activeProject();
        json(res, 200, { ...terminal.availability(), shell: terminal.shellFor().name, sessions: [...terms.values()].filter((s) => !p || s.id.startsWith(`${p.id}:`))
          .map((s) => ({ flow: s.id.split(":").slice(1).join(":"), running: s.running, exitCode: s.exitCode, startedAt: s.startedAt, clients: s.clients.size, shell: s.shell, agent: s.agent, typed: s.typed, cwd: s.cwd })) });
        return;
      }
      {
        const m = route.match(/^\/api\/term\/([a-z0-9][a-z0-9_-]{0,59})$/);
        if (m && req.method === "DELETE") {
          const s = terms.get(termKey(m[1]));
          if (s) s.kill();
          json(res, 200, { killed: !!(s && s.running) });
          return;
        }
      }

      json(res, 404, { error: "no such route" });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else { try { res.end(); } catch { /* gone */ } }
    }
  });

  // The flow's terminal: one WebSocket per open page, one pty per flow. The
  // pty runs the person's own shell in the flow's checkout, and the flow's
  // agent command is typed into it — nothing added. Binary frames are
  // keystrokes and output; text frames are small JSON controls (resize, kill)
  // and status. `?restart=1` replaces the session.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const refuse = (code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ } socket.destroy(); };
    if (!url.pathname.startsWith(`/${token}`) || url.pathname.slice(token.length + 1) !== "/api/term") { refuse(404, "Not Found"); return; }
    const r = resolveFlow(url.searchParams.get("flow"));
    if (!r) { refuse(404, "Not Found"); return; }
    const ws = terminal.acceptWebSocket(req, socket, head);
    if (!ws) return;
    const say = (obj) => ws.send(JSON.stringify(obj));
    const avail = terminal.availability();
    if (!avail.available) { say({ type: "status", state: "unavailable", reason: avail.reason }); ws.close(); return; }
    const key = `${r.project.id}:${r.flow.name}`;
    let sess = terms.get(key);
    if (sess && url.searchParams.get("restart") === "1") { sess.kill(); terms.delete(key); sess = null; }
    if (!sess) {
      const shellOnly = r.flow.agent === "shell";
      const resolved = shellOnly ? null : projects.resolveAgent(r.project, projects.detectAgents(), r.flow.agent || null);
      const shell = terminal.shellFor();
      const cmd = shellOnly ? { ok: false, reason: null } : terminal.agentCommand(resolved, r.project);
      sess = new terminal.TerminalSession({ id: key, argv: shell.argv, cwd: r.cwd,
        env: { ...envFor(r.cwd, config(r.cwd), activeEnv.name), AIQA_STUDIO: "1" },
        cols: Number(url.searchParams.get("cols")) || 120, rows: Number(url.searchParams.get("rows")) || 36,
        type: cmd.ok ? `${cmd.command}\r` : null }).start();
      sess.shell = shell.name; sess.agent = cmd.ok ? resolved.id : null; sess.note = cmd.ok ? null : cmd.reason;
      terms.set(key, sess);
    }
    const status = (state) => ({ type: "status", state, flow: r.flow.name, shell: sess.shell, agent: sess.agent, typed: sess.typed || (sess.type ? sess.type.trim() : null), note: sess.note,
      cwd: sess.cwd, worktree: r.flow.worktree || null, worktreeMissing: r.worktreeMissing, exitCode: sess.exitCode, startedAt: sess.startedAt });
    sess.clients.add(ws);
    say(status(sess.running ? "running" : "exited"));
    const replay = sess.replay();
    if (replay.length) ws.send(replay);
    const onData = (chunk) => ws.send(chunk);
    const onExit = () => say(status("exited"));
    sess.on("data", onData); sess.on("exit", onExit);
    ws.on("message", (data, isBinary) => {
      if (isBinary) { sess.write(data); return; }
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === "resize") sess.resize(m.cols, m.rows);
      else if (m.type === "input") sess.write(String(m.data || ""));
      else if (m.type === "kill") sess.kill();
    });
    ws.on("close", () => { sess.clients.delete(ws); sess.off("data", onData); sess.off("exit", onExit); });
  });
  server.on("close", () => { for (const s of terms.values()) s.kill(); });

  await new Promise((resolve, reject) => { server.on("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}/${token}/`;
  if (!flags["no-open"] && !process.env.AIQA_NO_OPEN) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(cmd, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref(); } catch { /* the link still works */ }
  }
  const p0 = activeProject();
  const st = projectState(cwd(), config(cwd()), activeEnv.name);
  console.log(`\n  ${c.bold("ai-qa studio")}  ${c.gray(p0 ? `${p0.name} · ${p0.path}` : st.project.name)}`);
  if (p0) {
    const a = projects.resolveAgent(p0);
    console.log(`  ${a.reason ? c.yellow("~") : c.green("✓")} agent: ${a.id || "none"}${a.reason ? c.gray(`  — ${a.reason}`) : ""}`);
    if (!fs.existsSync(configPath(cwd()))) console.log(`  ${c.yellow("~")} no ${CONFIG_NAME} in this checkout ${c.gray("— run `ai-qa init` there; the studio will not do it for you")}`);
  }
  console.log(`  ${c.cyan(url)}`);
  console.log(`  ${c.gray("local only · the path token is the key · Ctrl+C to stop")}`);
  for (const e of describeEngines(engines)) console.log(`  ${e.available ? c.green("✓") : c.gray("·")} ${e.label}${e.available ? "" : c.gray(`  — ${e.reason}`)}`);
  const ta = terminal.availability();
  console.log(`  ${ta.available ? c.green("✓") : c.gray("·")} terminal${ta.available ? c.gray(`  — ${terminal.shellFor().name} in the flow's checkout, the agent's command typed into it`) : c.gray(`  — ${ta.reason}`)}`);
  console.log();
  if (flags.json) console.log(JSON.stringify({ url, port: server.address().port }));
  return { url, server, close: () => server.close() };
}
