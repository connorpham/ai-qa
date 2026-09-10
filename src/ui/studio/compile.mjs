// compile.mjs — a flow drawn on the studio canvas → the files the lane already reads.
//
// The canvas is a graph: a person drags steps onto it and wires them. A test
// case is a sequence: AS → PRECONDITION → ENTRY → STEPS → EXPECTED → AFTER →
// BACK, and the evidence gate reads exactly that. This module is the bridge,
// and it bends in one direction only: the graph is walked in topological order,
// and a node with several children is read as ONE step with several checks
// hanging off it (a screenshot, an expected value, a read-back). There is no
// if/else. A test case that branches on what it finds is not a test case, it is
// an exploration — and the lane has a separate word for that.
//
// Three outputs, all into evd/<TICKET>/TC_<n>_<slug>/:
//
//   manifest.md   the case as the gate reads it — RESULT: BLOCKED until a run
//                 has happened, because a compiled plan is not evidence
//   run.sh        the same steps as a shell script a human or CI can re-run
//   journey.mjs   the browser steps, driving .ai-qa/scripts/browser.mjs
//
// plus flow.json, so the drawing that produced the case travels with it.
//
// Every value a person typed into a node is treated as data: JSON-encoded into
// JavaScript, single-quoted into shell, passed as its own argv element to the
// gates. Nothing typed on the canvas is ever interpolated into a command line.
import path from "node:path";

export const KINDS = ["acceptance", "boundary", "whole-screen", "write-readback", "exploratory"];

/** The palette. `fields` drives both the inspector form and validation; the
 * UI renders from this so the two never disagree about what a node holds. */
export const NODE_TYPES = {
  actor: {
    label: "As (who)", group: "who", color: "#0F766E",
    hint: "Which account, which role. A verdict with no actor cannot be reproduced.",
    fields: [
      { key: "role", label: "Role", placeholder: "customer (gold tier)", required: true },
      { key: "account", label: "Account / how to sign in", placeholder: "zztest.anh@demo — password in .env" },
    ],
  },
  precondition: {
    label: "Precondition", group: "who", color: "#0F766E",
    hint: "What must already be true, resolved read-only right now — never trusted from the ticket.",
    fields: [
      { key: "text", label: "What must be true", placeholder: "customer 1 exists and is tier gold", required: true },
      { key: "check", label: "Check it how", kind: "select", options: ["none", "api", "db"], default: "none" },
      { key: "method", label: "Method", kind: "select", options: ["GET"], default: "GET", when: { check: "api" } },
      { key: "path", label: "Path", placeholder: "/customers/1", when: { check: "api" } },
      { key: "sql", label: "Read-only SQL", placeholder: "SELECT tier FROM customers WHERE id = 1", kind: "textarea", when: { check: "db" } },
    ],
  },
  open: {
    label: "Open (click path)", group: "web", color: "#1D4ED8",
    hint: "Where the user starts and what they click to arrive. A typed URL proves the URL, not the product.",
    fields: [
      { key: "path", label: "Click path, one label per line", kind: "textarea", placeholder: "Orders\nNew order", required: true },
      { key: "url", label: "Deep link (secondary, optional)", placeholder: "/orders/new" },
    ],
  },
  click: {
    label: "Click", group: "web", color: "#1D4ED8",
    fields: [
      { key: "selector", label: "What to click (selector or text=…)", placeholder: "button:has-text('Place order')", required: true },
      { key: "why", label: "Why (shown in the log)", placeholder: "place the order" },
    ],
  },
  type: {
    label: "Type into", group: "web", color: "#1D4ED8",
    fields: [
      { key: "selector", label: "Field (selector)", placeholder: "#amount", required: true },
      { key: "value", label: "Value", placeholder: "500000", required: true },
      { key: "why", label: "Why", placeholder: "an order exactly at the threshold" },
    ],
  },
  expect: {
    label: "Expect (cite the spec)", group: "check", color: "#B45309",
    hint: "The whole verification. Without a citation this reports a difference, never a defect.",
    fields: [
      { key: "what", label: "What is read", placeholder: "the Discount line", required: true },
      { key: "selector", label: "Where on screen (selector)", placeholder: "#discount", required: true },
      { key: "value", label: "Must read", placeholder: "50,000", required: true },
      { key: "cite", label: "Cited from", placeholder: "spec §3.2 R1", required: false },
    ],
  },
  screenshot: {
    label: "Screenshot", group: "check", color: "#B45309",
    fields: [{ key: "what", label: "What it shows (becomes the filename)", placeholder: "order_priced_at_threshold", required: true }],
  },
  api: {
    label: "API call", group: "api", color: "#7C3AED",
    hint: "Request and response are recorded as files; the body is checked, not just the status.",
    fields: [
      { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
      { key: "path", label: "Path", placeholder: "/orders", required: true },
      { key: "body", label: "JSON body (optional; {{last.id}} = a field from the previous response)", kind: "textarea", placeholder: '{ "customer_id": 1, "items": [...] }' },
      { key: "status", label: "Expected status", placeholder: "201" },
      { key: "expects", label: "Expected fields — one per line: path = value | cite", kind: "textarea", placeholder: "discount = 50000 | spec §3.2 R1\ntotal = 450000 | spec §3.3" },
      { key: "auth_env", label: "Bearer token env var (NAME only)", placeholder: "AUTH_TOKEN" },
    ],
  },
  db: {
    label: "DB read-back", group: "check", color: "#B45309",
    hint: "Read-only. The interface saying 'saved' is a claim about the interface, not about the data.",
    fields: [
      { key: "name", label: "What this proves", placeholder: "the stored discount", required: true },
      { key: "sql", label: "Read-only SQL", kind: "textarea", placeholder: "SELECT discount FROM orders WHERE note LIKE 'ZZTEST%'", required: true },
      { key: "cite", label: "Cited from", placeholder: "spec §3.4" },
    ],
  },
  reload: {
    label: "Reload check (AFTER)", group: "web", color: "#1D4ED8",
    hint: "A save that dies on refresh is not a save.",
    fields: [{ key: "what", label: "What must survive a reload", placeholder: "the Discount line still reads 50,000", required: true }],
  },
  back: {
    label: "Back / Cancel (BACK)", group: "web", color: "#1D4ED8",
    hint: "Where 'it works' usually stops working.",
    fields: [{ key: "what", label: "What Back or Cancel must do", placeholder: "Back returns to Orders with the filter intact", required: true }],
  },
  cleanup: {
    label: "Clean up (reverse flow)", group: "api", color: "#7C3AED",
    hint: "Test data leaves the way a user removes it. No reverse flow → the case is BLOCKED, nothing is written.",
    fields: [
      { key: "how", label: "How the product removes it", placeholder: "withdraw the order", required: true },
      { key: "method", label: "Method", kind: "select", options: ["", "DELETE", "POST", "PUT"], default: "" },
      { key: "path", label: "Path ({{last.id}} allowed)", placeholder: "/orders/{{last.id}}" },
    ],
  },
};

const WEB_TYPES = new Set(["open", "click", "type", "expect", "screenshot", "reload", "back"]);
const VAGUE = /^\W*(?:it\s+|this\s+)?(?:should\s+|must\s+)?(?:be\s+|is\s+|was\s+)?(?:works?|working|correct(?:ly)?|ok(?:ay)?|fine|good|as expected|properly|success(?:ful(?:ly)?)?|displayed|shown|pass(?:es|ed)?)\W*$/i;

export function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

export function humanize(slug) {
  return String(slug || "").replace(/[_-]+/g, " ").trim();
}

export function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

export const TICKET_RE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

// ---------------------------------------------------------------------------
// graph → sequence
// ---------------------------------------------------------------------------
/** Topological order that keeps a node's checks next to it: depth-first from
 * the top-most root, children visited top-to-bottom then left-to-right. Nodes
 * with no edges at all fall in by position, so a canvas that was never wired
 * still reads the way it looks. */
export function toposort(flow) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seenEdge = new Set();
  const edges = [];
  for (const e of Array.isArray(flow?.edges) ? flow.edges : []) {
    const k = `${e.from}>${e.to}`;
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to) || seenEdge.has(k)) continue;
    seenEdge.add(k);
    edges.push(e);
  }
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const kids = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) { kids.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  const byPos = (a, b) => (byId.get(a).y - byId.get(b).y) || (byId.get(a).x - byId.get(b).x);

  const order = [];
  const seen = new Set();
  const stack = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort(byPos).reverse();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(byId.get(id));
    const ready = [];
    for (const k of kids.get(id).slice().sort(byPos)) {
      indeg.set(k, indeg.get(k) - 1);
      if (indeg.get(k) === 0) ready.push(k);
    }
    for (const k of ready.reverse()) stack.push(k);
  }
  const cycle = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  return { order, cycle, edges };
}

// ---------------------------------------------------------------------------
// validation — the gate's rules, said before the run instead of after
// ---------------------------------------------------------------------------
export function validate(flow) {
  const errors = [];
  const warnings = [];
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const of = (t) => nodes.filter((n) => n.type === t);
  const d = (n) => (n && typeof n.data === "object" && n.data) || {};

  if (!NAME_RE.test(String(flow?.name || ""))) errors.push("name: use lowercase letters, digits, _ or - (e.g. boundary_exactly_500000)");
  if (!TICKET_RE.test(String(flow?.ticket || ""))) errors.push("ticket: a key like SHOP-142");
  if (!KINDS.includes(flow?.kind)) errors.push(`kind: one of ${KINDS.join(", ")}`);
  if (!nodes.length) { errors.push("the canvas is empty"); return { errors, warnings }; }

  for (const n of nodes) {
    const spec = NODE_TYPES[n.type];
    if (!spec) { errors.push(`${n.id}: unknown node type ${JSON.stringify(n.type)}`); continue; }
    for (const f of spec.fields) {
      if (!f.required) continue;
      if (f.when && Object.entries(f.when).some(([k, v]) => d(n)[k] !== v)) continue;
      if (!String(d(n)[f.key] ?? "").trim()) errors.push(`${spec.label}: "${f.label}" is empty`);
    }
  }

  const { cycle } = toposort(flow);
  if (cycle.length) errors.push(`the wiring has a loop through ${cycle.join(", ")} — a test case runs forward only`);

  const actors = of("actor");
  if (!actors.length) errors.push("no AS node — a verdict with no actor cannot be reproduced");
  if (actors.length > 1) warnings.push("more than one AS node — one case, one actor; the first is used");

  const isWeb = nodes.some((n) => WEB_TYPES.has(n.type));
  const apis = of("api");
  const dbs = of("db");
  const expects = of("expect");

  if (isWeb) {
    const opens = of("open");
    if (!opens.length) errors.push("web steps with no Open node — where does the user start, and what do they click?");
    for (const o of opens) {
      const labels = String(d(o).path || "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (!labels.length) errors.push("Open: the click path is empty — a URL alone proves the address, not the product");
    }
    if (!expects.length && !of("screenshot").length) errors.push("web steps with nothing to look at — add an Expect or a Screenshot");
    if (!of("reload").length) errors.push("no Reload check — a save that dies on refresh is not a save (AFTER)");
    if (!of("back").length) errors.push("no Back/Cancel check — where 'it works' usually stops working (BACK)");
  } else if (expects.length) {
    errors.push("an Expect node reads the screen, and this flow has no screen — put the expected fields on the API node instead");
  }

  if (!isWeb && !apis.length && !dbs.length) errors.push("nothing runs: no web step, no API call, no read-back");

  for (const e of expects) {
    if (!String(d(e).cite || "").trim()) warnings.push(`Expect "${d(e).what || "?"}": no citation — this reports a difference, not a defect`);
    if (VAGUE.test(String(d(e).value || ""))) errors.push(`Expect "${d(e).what || "?"}": "${d(e).value}" is a judgement, not a value — write what the screen shows`);
  }
  for (const a of apis) {
    const rows = parseExpects(d(a).expects);
    if (!rows.length && !String(d(a).status || "").trim()) warnings.push(`API ${d(a).method || "GET"} ${d(a).path || ""}: nothing asserted — it records the exchange but cannot support a verdict`);
    for (const r of rows) {
      if (!r.cite) warnings.push(`API expect "${r.path} = ${r.value}": no citation — this reports a difference, not a defect`);
      if (VAGUE.test(r.value)) errors.push(`API expect "${r.path}": "${r.value}" is a judgement, not a value`);
    }
    if (d(a).body) {
      try { JSON.parse(String(d(a).body).replace(/\{\{[^}]+\}\}/g, "0")); }
      catch { errors.push(`API ${d(a).method || ""} ${d(a).path || ""}: the body is not valid JSON`); }
    }
  }
  for (const b of dbs) {
    const head = String(d(b).sql || "").trim().split(/\s+/)[0]?.toLowerCase();
    if (head && !["select", "with", "explain", "show", "describe", "desc", "table", "values"].includes(head)) {
      errors.push(`DB read-back "${d(b).name || "?"}": starts with ${head.toUpperCase()} — only reads are allowed here`);
    }
    if (!String(d(b).cite || "").trim()) warnings.push(`DB read-back "${d(b).name || "?"}": no citation`);
  }
  if (flow?.kind === "write-readback" && !dbs.length) errors.push("KIND write-readback with no DB read-back node — the interface saying 'Saved' is a claim about the interface");
  if (of("cleanup").length === 0 && apis.some((a) => /^(POST|PUT|PATCH|DELETE)$/i.test(d(a).method || ""))) {
    warnings.push("this flow writes (POST/PUT/PATCH) and has no Clean up node — test data must leave through the product's reverse flow");
  }
  if (nodes.length > 1 && !(Array.isArray(flow.edges) && flow.edges.length)) warnings.push("nothing is wired — steps run top-to-bottom, left-to-right as drawn");
  return { errors, warnings };
}

/** "discount = 50000 | spec §3.2 R1" per line → [{path, value, cite}] */
export function parseExpects(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [lhs, cite = ""] = line.split("|").map((s) => s.trim());
    const i = lhs.indexOf("=");
    if (i < 1) continue;
    out.push({ path: lhs.slice(0, i).trim(), value: lhs.slice(i + 1).trim(), cite });
  }
  return out;
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------
/**
 * @param flow  the canvas JSON
 * @param ctx   { appUrl, apiBase, envName, envUrl, caseNo }
 * @returns { caseDir, files: {rel: text}, steps: [...], surface, manifest }
 */
export function compile(flow, ctx = {}) {
  const { errors, warnings } = validate(flow);
  if (errors.length) {
    const err = new Error("flow does not compile:\n  - " + errors.join("\n  - "));
    err.errors = errors;
    err.warnings = warnings;
    throw err;
  }
  const { order } = toposort(flow);
  const d = (n) => (n && typeof n.data === "object" && n.data) || {};
  const caseNo = Number(ctx.caseNo || flow.case || 1);
  const slug = slugify(flow.name);
  const caseDir = path.posix.join("evd", flow.ticket, `TC_${caseNo}_${slug}`);
  const toRoot = "../".repeat(caseDir.split("/").length);           // from the case dir back to the repo root
  const isWeb = order.some((n) => WEB_TYPES.has(n.type));
  const appUrl = String(ctx.envUrl || ctx.appUrl || "").replace(/\/$/, "");
  const files = {};
  const steps = [];
  let seq = 0;
  const sub = (name) => `${String(++seq).padStart(2, "0")}_${slugify(name) || "step"}`;

  // -- the sequence, in the gate's vocabulary --------------------------------
  const actor = order.find((n) => n.type === "actor");
  const pre = order.find((n) => n.type === "precondition");
  const opens = order.filter((n) => n.type === "open");
  const reload = order.find((n) => n.type === "reload");
  const back = order.find((n) => n.type === "back");
  const cleanup = order.find((n) => n.type === "cleanup");

  const stepsText = [];
  const expectedText = [];
  const webPlan = [];               // for journey.mjs
  const cleanupSteps = [];          // run last, always

  if (isWeb || order.some((n) => n.type === "api")) {
    steps.push({ id: "preflight", kind: "preflight", label: "app_check — is the app answering?",
      argv: ["bash", ".ai-qa/scripts/app_check.sh", "--wait", "30"], blocking: true });
  }

  if (pre && d(pre).check === "api" && d(pre).path) {
    const out = path.posix.join(caseDir, "00_precondition");
    steps.push({ id: "precondition", kind: "api", label: `precondition — GET ${d(pre).path}`, outDir: out,
      argv: ["node", ".ai-qa/scripts/api_check.mjs", "GET", d(pre).path, "--out", out, "--expect-status", "200"] });
  } else if (pre && d(pre).check === "db" && d(pre).sql) {
    const out = path.posix.join(caseDir, "00_precondition");
    steps.push({ id: "precondition", kind: "db", label: "precondition — read-only check", outDir: out,
      argv: ["python3", ".ai-qa/scripts/db_verify.py", "-e", d(pre).sql, "--out", path.posix.join(out, "db_verify.md")] });
  }

  let stepNo = 0;
  let lastExpect = null;
  for (const n of order) {
    const x = d(n);
    switch (n.type) {
      case "open": {
        const labels = String(x.path || "").split("\n").map((s) => s.trim()).filter(Boolean);
        stepsText.push(`${++stepNo}. open ${labels.join(" → ")}${x.url ? ` (also at ${x.url})` : ""}`);
        webPlan.push({ op: "goto", url: x.url || "/" });
        for (const l of labels) webPlan.push({ op: "click", selector: l.startsWith("text=") || /[#.\[]/.test(l) ? l : `text=${l}`, why: `open ${l}` });
        webPlan.push({ op: "shot", what: `${slugify(labels[labels.length - 1] || "opened")}_opened` });
        break;
      }
      case "click":
        stepsText.push(`${++stepNo}. click ${x.why || x.selector}`);
        webPlan.push({ op: "click", selector: x.selector, why: x.why || `click ${x.selector}` });
        break;
      case "type":
        stepsText.push(`${++stepNo}. type ${JSON.stringify(x.value)} into ${x.why || x.selector}`);
        webPlan.push({ op: "type", selector: x.selector, value: x.value, why: x.why || `type into ${x.selector}` });
        break;
      case "expect":
        expectedText.push(`${x.what} reads ${JSON.stringify(x.value)}${x.cite ? ` (${x.cite})` : " — NO CITATION: a difference, not a defect"}`);
        lastExpect = { what: x.what, selector: x.selector, value: x.value };
        webPlan.push({ op: "expect", ...lastExpect });
        webPlan.push({ op: "shot", what: slugify(x.what) || "expected_value" });
        break;
      case "screenshot":
        webPlan.push({ op: "shot", what: slugify(x.what) || "screen" });
        break;
      case "reload":
        stepsText.push(`${++stepNo}. reload the page`);
        webPlan.push({ op: "reload", recheck: lastExpect });
        webPlan.push({ op: "shot", what: "after_reload" });
        break;
      case "back":
        stepsText.push(`${++stepNo}. press Back`);
        webPlan.push({ op: "back" });
        webPlan.push({ op: "shot", what: "after_back" });
        break;
      case "api": {
        const method = String(x.method || "GET").toUpperCase();
        const out = path.posix.join(caseDir, sub(`${method}_${x.path}`));
        const argv = ["node", ".ai-qa/scripts/api_check.mjs", method, x.path, "--out", out];
        let bodyFile = null;
        if (x.body && String(x.body).trim()) {
          bodyFile = path.posix.join(out, "body.json");
          files[bodyFile] = String(x.body).trim() + "\n";
          argv.push("--body", bodyFile);
        }
        if (String(x.status || "").trim()) argv.push("--expect-status", String(x.status).trim());
        const rows = parseExpects(x.expects);
        for (const r of rows) argv.push("--expect", `${r.path}=${r.value}`);
        if (x.auth_env) argv.push("--auth-env", x.auth_env);
        stepsText.push(`${++stepNo}. ${method} ${x.path}${bodyFile ? " with the recorded body" : ""}`);
        for (const r of rows) expectedText.push(`${method} ${x.path} → ${r.path} = ${r.value}${r.cite ? ` (${r.cite})` : " — NO CITATION: a difference, not a defect"}`);
        if (String(x.status || "").trim() && !rows.length) expectedText.push(`${method} ${x.path} → HTTP ${String(x.status).trim()}`);
        steps.push({ id: n.id, kind: "api", label: `${method} ${x.path}`, outDir: out, argv, bodyFile,
          placeholders: /\{\{\s*last\.[a-zA-Z0-9_]+\s*\}\}/.test(`${x.path} ${x.body || ""}`) });
        break;
      }
      case "db": {
        const out = path.posix.join(caseDir, sub(`db_${x.name}`));
        stepsText.push(`${++stepNo}. read back: ${x.name}`);
        expectedText.push(`read-back "${x.name}": ${String(x.sql).replace(/\s+/g, " ").trim()}${x.cite ? ` (${x.cite})` : ""}`);
        steps.push({ id: n.id, kind: "db", label: `read-back — ${x.name}`, outDir: out,
          argv: ["python3", ".ai-qa/scripts/db_verify.py", "-e", x.sql, "--out", path.posix.join(out, "db_verify.md")] });
        break;
      }
      case "cleanup": {
        if (x.method && x.path) {
          const out = path.posix.join(caseDir, sub("cleanup"));
          cleanupSteps.push({ id: n.id, kind: "cleanup", label: `clean up — ${x.method} ${x.path}`, outDir: out,
            argv: ["node", ".ai-qa/scripts/api_check.mjs", String(x.method).toUpperCase(), x.path, "--out", out],
            placeholders: /\{\{\s*last\.[a-zA-Z0-9_]+\s*\}\}/.test(x.path) });
        }
        break;
      }
      default:
        break;
    }
  }

  if (isWeb) {
    files[path.posix.join(caseDir, "journey.mjs")] = renderJourney(webPlan, { toRoot, appUrl, flowName: flow.name });
    steps.push({ id: "journey", kind: "web", label: "journey.mjs — the browser run", outDir: caseDir,
      argv: ["node", path.posix.join(caseDir, "journey.mjs")], env: { APP_URL: appUrl } });
  }
  steps.push(...cleanupSteps);

  // -- the manifest, RESULT: BLOCKED until a run has happened -----------------
  const title = flow.title && String(flow.title).trim() ? String(flow.title).trim() : humanize(flow.name);
  const entry = isWeb
    ? opens.map((o) => String(d(o).path || "").split("\n").map((s) => s.trim()).filter(Boolean).join(" → ")).join("; ")
      + (opens.some((o) => d(o).url) ? ` (deep link kept as a second path: ${opens.map((o) => d(o).url).filter(Boolean).join(", ")})` : "")
    : (() => { const a = order.find((n) => n.type === "api"); return a ? `the call the product's client makes: ${String(d(a).method || "GET").toUpperCase()} ${d(a).path}` : "read-only verification against the database"; })();
  const afterText = isWeb
    ? (reload ? `after a reload: ${d(reload).what}` : "")
    : (order.some((n) => n.type === "db") ? "the stored row is read back read-only after the call (see the read-back files)" : "");
  const backText = isWeb
    ? (back ? d(back).what : "")
    : (cleanup ? `test data is withdrawn through the product: ${d(cleanup).how}` : "");

  const lines = [
    `TITLE: ${title}`,
    `RESULT: BLOCKED`,
    `REASON: compiled from the studio flow, not run yet — a plan is not evidence`,
    `UNBLOCK: run it from the studio, or: bash ${caseDir}/run.sh`,
    `KIND: ${flow.kind}`,
  ];
  if (!isWeb) lines.push("TYPE: NON-UI");
  if (ctx.envName) lines.push(`ENVIRONMENT: ${ctx.envName}${appUrl ? ` — ${appUrl}` : ""}`);
  lines.push(
    `AS: ${actor ? `${d(actor).role}${d(actor).account ? ` — ${d(actor).account}` : ""}` : "(none)"}`,
    `PRECONDITION: ${pre ? `${d(pre).text}${d(pre).check && d(pre).check !== "none" ? " (checked read-only at run time — see 00_precondition/)" : ""}` : "none declared"}`,
    `ENTRY: ${entry}`,
    `STEPS: ${stepsText.join("   ") || "(no steps)"}`,
    `EXPECTED: ${expectedText.join(" · ") || "NO EXPECTED VALUE DECLARED — this run can record what happened, not judge it"}`,
    `ACTUAL: not run yet`,
  );
  if (afterText) lines.push(`AFTER: ${afterText}`);
  if (backText) lines.push(`BACK: ${backText}`);
  lines.push("", "## Flow", "",
    `Drawn in ai-qa studio and saved as \`flow.json\` beside this file. Steps run in this order:`, "",
    ...order.map((n, i) => `${i + 1}. **${NODE_TYPES[n.type]?.label || n.type}** — ${summarize(n)}`), "");
  if (warnings.length) lines.push("## Warnings at compile time", "", ...warnings.map((w) => `- ${w}`), "");
  const manifest = lines.join("\n");
  files[path.posix.join(caseDir, "manifest.md")] = manifest;
  files[path.posix.join(caseDir, "flow.json")] = JSON.stringify(flow, null, 2) + "\n";
  files[path.posix.join(caseDir, "run.sh")] = renderRunSh(steps, { caseDir, toRoot, flowName: flow.name });

  return { caseDir, files, steps, surface: isWeb ? (steps.some((s) => s.kind === "api" || s.kind === "db") ? "mixed" : "web") : "api", manifest, warnings, title };
}

function summarize(n) {
  const x = (n && n.data) || {};
  switch (n.type) {
    case "actor": return `${x.role || ""}${x.account ? ` (${x.account})` : ""}`;
    case "precondition": return x.text || "";
    case "open": return String(x.path || "").split("\n").filter(Boolean).join(" → ");
    case "click": return x.why || x.selector || "";
    case "type": return `${JSON.stringify(x.value || "")} into ${x.selector || ""}`;
    case "expect": return `${x.what || ""} reads ${JSON.stringify(x.value || "")}${x.cite ? ` — ${x.cite}` : ""}`;
    case "screenshot": return x.what || "";
    case "api": return `${x.method || "GET"} ${x.path || ""}${x.status ? ` → ${x.status}` : ""}`;
    case "db": return x.name || "";
    case "reload": return x.what || "";
    case "back": return x.what || "";
    case "cleanup": return `${x.how || ""}${x.method && x.path ? ` (${x.method} ${x.path})` : ""}`;
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------
function renderJourney(plan, { toRoot, appUrl, flowName }) {
  const J = (v) => JSON.stringify(v);
  const out = [
    `// journey.mjs — generated by ai-qa studio from flow ${J(flowName)}. Re-runnable evidence:`,
    `// the next round runs this same journey against the new build instead of re-improvising it.`,
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `import { fileURLToPath } from "node:url";`,
    `import { launch, click, typeIn, beat, shot, close } from ${J(toRoot + ".ai-qa/scripts/browser.mjs")};`,
    ``,
    `const HERE = path.dirname(fileURLToPath(import.meta.url));`,
    `const APP_URL = (process.env.APP_URL || ${J(appUrl)}).replace(/\\/$/, "");`,
    `const checks = [];`,
    `function record(what, expected, actual) {`,
    `  const ok = String(actual ?? "").replace(/\\s+/g, " ").includes(String(expected));`,
    `  checks.push({ what, expected, actual, ok });`,
    `  console.log(\`\${ok ? "EXPECT: ok  " : "EXPECT: FAIL"} \${what} — expected \${JSON.stringify(expected)}, got \${JSON.stringify(actual)}\`);`,
    `}`,
    `async function read(page, selector) {`,
    `  try { return (await page.locator(selector).first().textContent({ timeout: 10_000 })) ?? ""; }`,
    `  catch (e) { return \`<not found: \${selector}>\`; }`,
    `}`,
    ``,
    `const h = await launch();`,
    `const page = h.page;`,
    `let n = 0;`,
    `try {`,
  ];
  for (const s of plan) {
    switch (s.op) {
      case "goto": out.push(`  await page.goto(APP_URL + ${J(s.url)});`, `  await beat(page, "let the page settle");`); break;
      case "click": out.push(`  await click(page, ${J(s.selector)}, ${J(s.why)});`); break;
      case "type": out.push(`  await typeIn(page, ${J(s.selector)}, ${J(s.value)}, ${J(s.why)});`); break;
      case "expect": out.push(`  record(${J(s.what)}, ${J(s.value)}, (await read(page, ${J(s.selector)})).trim());`); break;
      case "shot": out.push(`  await shot(page, HERE, ++n, ${J(s.what)});`); break;
      case "reload":
        out.push(`  await page.reload(); await beat(page, "reload — does it survive?");`);
        if (s.recheck) out.push(`  record(${J("after reload: " + s.recheck.what)}, ${J(s.recheck.value)}, (await read(page, ${J(s.recheck.selector)})).trim());`);
        break;
      case "back": out.push(`  await page.goBack(); await beat(page, "Back — where 'it works' usually stops");`); break;
      default: break;
    }
  }
  out.push(
    `} finally {`,
    `  fs.writeFileSync(path.join(HERE, "checks.json"), JSON.stringify(checks, null, 2) + "\\n");`,
    `  await close(h);`,
    `}`,
    `process.exit(checks.some((c) => !c.ok) ? 1 : 0);`,
    ``,
  );
  return out.join("\n");
}

/** The same steps as a shell script. A FAIL (exit 1) is remembered and the run
 * continues so the evidence and the clean-up still happen; a BLOCKED (exit 2)
 * stops it — nothing after a blocked step means anything. */
function renderRunSh(steps, { caseDir, toRoot, flowName }) {
  const out = [
    `#!/usr/bin/env bash`,
    `# run.sh — generated by ai-qa studio from flow ${JSON.stringify(flowName)}.`,
    `# Re-runs this case from the repository root. Exit 0 = every check held,`,
    `# 1 = a check failed (a finding), 2 = BLOCKED (the run could not start).`,
    `set -u`,
    `cd "$(dirname "$0")/${toRoot}"`,
    `status=0`,
    `step() { printf '\\n▶ %s\\n' "$1"; }`,
    `after() {  # $1 = exit code of the step that just ran`,
    `  if [ "$1" -eq 2 ]; then echo "BLOCKED — stopping here; nothing after a blocked step means anything"; exit 2; fi`,
    `  if [ "$1" -ne 0 ]; then status=1; fi`,
    `}`,
    ``,
  ];
  let prevOut = null;
  for (const s of steps) {
    out.push(`step ${shq(s.label)}`);
    let argv = s.argv;
    if (s.placeholders && prevOut) {
      // {{last.<field>}} — a field from the previous recorded response.
      const fields = new Set();
      for (const a of argv) for (const m of String(a).matchAll(/\{\{\s*last\.([a-zA-Z0-9_]+)\s*\}\}/g)) fields.add(m[1]);
      for (const f of fields) {
        out.push(`LAST_${f}="$(python3 -c 'import json,sys; b=json.load(open(sys.argv[1])).get("body") or {}; print(b.get(sys.argv[2], ""))' ${shq(prevOut + "/response.json")} ${shq(f)})"`);
      }
      argv = argv.map((a) => {
        if (!/\{\{\s*last\./.test(a)) return shq(a);
        return '"' + String(a).replace(/[\\"$`]/g, (ch) => "\\" + ch).replace(/\{\{\s*last\.([a-zA-Z0-9_]+)\s*\}\}/g, (_, f) => `\${LAST_${f}}`) + '"';
      });
      if (s.bodyFile) {
        // the body template holds placeholders too: render it beside the original
        const tmpl = s.bodyFile;
        out.push(`python3 -c 'import sys,re,json,os; t=open(sys.argv[1]).read(); b=json.load(open(sys.argv[2])).get("body") or {}; open(sys.argv[1],"w").write(re.sub(r"\\{\\{\\s*last\\.([A-Za-z0-9_]+)\\s*\\}\\}", lambda m: str(b.get(m.group(1),"")), t))' ${shq(tmpl)} ${shq(prevOut + "/response.json")}`);
      }
    } else {
      argv = argv.map(shq);
    }
    const env = s.env ? Object.entries(s.env).map(([k, v]) => `${k}=${shq(v)} `).join("") : "";
    out.push(`${env}${argv.join(" ")}; after $?`);
    if (s.kind === "api" || s.kind === "cleanup") prevOut = s.outDir;
    out.push("");
  }
  out.push(`exit $status`, ``);
  return out.join("\n");
}
