// inventory.mjs — what this project actually consists of.
//
// The Steps tab asks you to name a click path, a role, an endpoint, a table
// and a citation. Every one of those is an answer the project already holds
// and the studio never showed you, so the first thing a newcomer had to do was
// go and read the codebase in another window. This reads them here.
//
// THREE KINDS OF ANSWER, AND THEY ARE NOT THE SAME THING
//
//   curated    a person wrote it down in docs/qa/onboarding.md — a list of
//              places a user can be, which is what a tester needs
//   from-code  read out of the repository — routes, models, contract paths.
//              Useful, and NOT the same thing: it is a file listing, and the
//              dossier template says so in as many words. Labelled, never
//              promoted to "curated".
//   missing    nobody has written it and nothing in the repo says. Named, with
//              the command that fixes it. This is a real answer.
//
// Nothing here infers. If the contract has no paths, the answer is "the
// contract declares none", not a guess assembled from route files that happen
// to look like endpoints.
import fs from "node:fs";
import path from "node:path";

const READ_CAP = 400_000;
const MAX_ITEMS = 200;

function read(abs) {
  try {
    if (fs.statSync(abs).size > READ_CAP) return "";
    return fs.readFileSync(abs, "utf8");
  } catch { return ""; }
}

const section = (state, items, source, next) => ({ state, items: items.slice(0, MAX_ITEMS), source, next, truncated: items.length > MAX_ITEMS });

// ---------------------------------------------------------------------------
// the dossier
// ---------------------------------------------------------------------------
/** Rows of the first markdown table under a heading matching `re`.
 *
 * The installed template ships those tables with one blank row, which is the
 * normal state of a project where nobody has run /onboard yet. A row whose
 * cells are all empty is not data, and counting it as data would turn "nobody
 * has filled this in" into "here is your inventory". */
export function dossierTable(text, re) {
  const lines = String(text || "").split(/\r?\n/);
  let i = lines.findIndex((l) => re.test(l));
  if (i === -1) return null;
  const rows = [];
  let header = null;
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) break;                       // next heading
    if (!/^\s*\|/.test(l)) { if (rows.length || header) continue; else continue; }
    const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) { if (!header) continue; continue; }
    if (!header) { header = cells; continue; }
    if (cells.some((c) => c)) rows.push(cells);
  }
  return header ? { header, rows } : null;
}

/** A `- **Label:** value` bullet, when the dossier uses one instead of a table. */
function dossierBullets(text, re) {
  const lines = String(text || "").split(/\r?\n/);
  let i = lines.findIndex((l) => re.test(l));
  if (i === -1) return [];
  const out = [];
  for (i++; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    const m = /^\s*[-*]\s+\*\*([^*]+)\*\*[:：]?\s*(.*)$/.exec(lines[i]);
    if (m && m[2] && !/_?\[UNKNOWN\]_?/i.test(m[2])) out.push(`${m[1].replace(/[:：]\s*$/, "")}: ${m[2]}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the contract
// ---------------------------------------------------------------------------
/** Method + path pairs out of an OpenAPI document.
 *
 * JSON is parsed. YAML is read structurally rather than fully parsed — the
 * `paths:` block, its `/…:` keys and the method keys under them, by
 * indentation. That is enough for a list you pick from, and a shallow read
 * that says it is shallow beats a YAML parser nobody reviewed. */
export function openapiPaths(text, file) {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  const out = [];
  const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

  if (/^\s*[{[]/.test(raw)) {
    try {
      const doc = JSON.parse(raw);
      for (const [p, ops] of Object.entries(doc.paths || {})) {
        for (const m of Object.keys(ops || {})) {
          if (METHODS.includes(m.toLowerCase())) {
            out.push({ method: m.toUpperCase(), path: p, summary: String(ops[m]?.summary || "") });
          }
        }
      }
    } catch { /* not the JSON we hoped for */ }
    return out;
  }

  const lines = raw.split(/\r?\n/);
  let inPaths = false, pathsIndent = 0, curPath = null, curIndent = 0;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (/^paths:\s*$/.test(body)) { inPaths = true; pathsIndent = indent; curPath = null; continue; }
    if (!inPaths) continue;
    if (indent <= pathsIndent && !/^paths:/.test(body)) { inPaths = false; continue; }
    const pathKey = /^(\/[^\s:]*)\s*:\s*$/.exec(body);
    if (pathKey) { curPath = pathKey[1]; curIndent = indent; continue; }
    if (!curPath || indent <= curIndent) continue;
    const method = /^([a-z]+)\s*:\s*$/.exec(body);
    if (method && METHODS.includes(method[1])) out.push({ method: method[1].toUpperCase(), path: curPath, summary: "" });
  }
  void file;
  return out;
}

// ---------------------------------------------------------------------------
// the data model
// ---------------------------------------------------------------------------
/** Prisma models and their scalar field names. */
export function prismaModels(text) {
  const out = [];
  const re = /^\s*model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\s*\}/gm;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const fields = m[2].split(/\r?\n/)
      .map((l) => /^\s*([A-Za-z0-9_]+)\s+\S/.exec(l))
      .filter(Boolean).map((x) => x[1])
      .filter((f) => f !== "@@id" && !f.startsWith("@"));
    out.push({ name: m[1], fields });
  }
  return out;
}

/** CREATE TABLE names out of .sql migrations. */
export function sqlTables(text) {
  const out = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`[]?([A-Za-z0-9_.]+)["`\]]?/gi;
  let m;
  while ((m = re.exec(String(text || "")))) out.push({ name: m[1], fields: [] });
  return out;
}

// ---------------------------------------------------------------------------
// routes, straight off the file system
// ---------------------------------------------------------------------------
const ROUTE_DIRS = /(^|\/)(pages|app|routes|screens|views|controllers)$/;
const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "evd", ".ai-qa", "__pycache__"]);

/** Files that look like a route, with the directory they came from. A file
 *  listing — labelled as one, never as the surface inventory. */
export function codeRoutes(root, cap = 400) {
  const hits = [];
  const walk = (dir, rel, depth) => {
    if (depth > 6 || hits.length >= cap) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ROUTE_DIRS.test(childRel)) collect(path.join(dir, e.name), childRel, 0);
        else walk(path.join(dir, e.name), childRel, depth + 1);
      }
    }
  };
  const collect = (dir, rel, depth) => {
    if (depth > 5 || hits.length >= cap) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) collect(path.join(dir, e.name), childRel, depth + 1);
      else if (/\.(tsx?|jsx?|vue|svelte|py|rb|go|php)$/.test(e.name) && !/\.(test|spec|d)\./.test(e.name)) {
        hits.push(childRel);
        if (hits.length >= cap) return;
      }
    }
  };
  walk(root, "", 0);
  return hits.sort();
}

// ---------------------------------------------------------------------------
export function inventory(root, cfg, get) {
  const qaDir = String(get(cfg, "paths.qa", "docs/qa") || "docs/qa");
  const dossierRel = String(get(cfg, "paths.onboarding", `${qaDir}/onboarding.md`) || `${qaDir}/onboarding.md`);
  const dossierAbs = path.join(root, dossierRel);
  const dossierText = read(dossierAbs);
  const hasDossier = !!dossierText;
  const ONBOARD = "run /onboard in the agent — it reads what exists, asks the team what it cannot find, and writes this down";

  // ---- who you can be ------------------------------------------------------
  const cfgRoles = (get(cfg, "accounts.roles", []) || []).map(String).filter(Boolean);
  const accessTable = hasDossier ? dossierTable(dossierText, /^##\s*3\.\s/i) : null;
  const dossierRoles = (accessTable?.rows || []).map((r) => ({
    role: r[0] || "", can: r[1] || "", account: r[2] || "", credentials: r[3] || "",
  })).filter((r) => r.role);
  const roles = dossierRoles.length
    ? section("curated", dossierRoles, dossierRel, "")
    : cfgRoles.length
      ? section("config", cfgRoles.map((r) => ({ role: r, can: "", account: "", credentials: "" })), "aiqa.config.yaml · accounts.roles", "")
      : section("missing", [], hasDossier ? `${dossierRel} §3 is still the blank template` : "no dossier yet", ONBOARD);

  // ---- what a user can reach ----------------------------------------------
  const surfaceTable = hasDossier ? dossierTable(dossierText, /^##\s*5\.\s/i) : null;
  const curatedScreens = (surfaceTable?.rows || []).map((r) => ({
    name: r[0] || "", purpose: r[1] || "", role: r[2] || "", rules: r[3] || "",
  })).filter((s) => s.name);
  const screens = curatedScreens.length
    ? section("curated", curatedScreens, dossierRel, "")
    : (() => {
        const files = codeRoutes(root);
        return files.length
          ? section("from-code", files.map((f) => ({ name: f, purpose: "", role: "", rules: "" })),
              "route files in the repository",
              `this is a FILE LISTING, not the surface inventory — ${ONBOARD}`)
          : section("missing", [], hasDossier ? `${dossierRel} §5 is still the blank template` : "no dossier yet", ONBOARD);
      })();

  // ---- the API -------------------------------------------------------------
  const contractRel = String(get(cfg, "api.contract", "") || "");
  let api;
  if (!contractRel) {
    api = section("missing", [], "api.contract is empty in aiqa.config.yaml",
      "point api.contract at an OpenAPI/GraphQL file, or accept that a response can only be called different, never wrong");
  } else {
    const abs = path.join(root, contractRel);
    if (!fs.existsSync(abs)) {
      api = section("missing", [], `${contractRel} — configured but not on disk`, "correct api.contract in aiqa.config.yaml");
    } else {
      const ops = openapiPaths(read(abs), contractRel);
      api = ops.length
        ? section("curated", ops, contractRel, "")
        : section("empty", [], contractRel, "the contract parsed but declares no paths — nothing is inferred from elsewhere");
    }
  }

  // ---- the data ------------------------------------------------------------
  const schemaRel = String(get(cfg, "database.schema", "") || "");
  let data;
  if (!schemaRel) {
    data = section("missing", [], "database.schema is empty in aiqa.config.yaml",
      "point database.schema at your schema or migrations folder — a write is verified by reading the row back, and that needs a table name");
  } else {
    const abs = path.join(root, schemaRel);
    if (!fs.existsSync(abs)) {
      data = section("missing", [], `${schemaRel} — configured but not on disk`, "correct database.schema in aiqa.config.yaml");
    } else {
      const st = fs.statSync(abs);
      let models = [];
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(abs).filter((x) => x.endsWith(".sql")).slice(0, 40)) {
          models.push(...sqlTables(read(path.join(abs, f))));
        }
        const seen = new Set();
        models = models.filter((m) => (seen.has(m.name) ? false : seen.add(m.name)));
      } else if (/\.prisma$/.test(schemaRel)) models = prismaModels(read(abs));
      else if (/\.sql$/.test(schemaRel)) models = sqlTables(read(abs));
      data = models.length
        ? section("curated", models, schemaRel, "")
        : section("empty", [], schemaRel, "the schema was read but declares no models — nothing is guessed from table-shaped names elsewhere");
    }
  }

  // ---- where "correct" is written -----------------------------------------
  const specs = (get(cfg, "oracle.specs", []) || []).map(String).filter(Boolean);
  const specItems = specs.map((rel) => ({ path: rel, exists: fs.existsSync(path.join(root, rel)) }));
  const oracle = specItems.length
    ? section(specItems.every((s) => s.exists) ? "curated" : "partial", specItems, "aiqa.config.yaml · oracle.specs",
        specItems.every((s) => s.exists) ? "" : "a listed spec is not on disk — a citation pointing at nothing is worse than no citation")
    : section("missing", [], "oracle.specs is empty in aiqa.config.yaml",
        "without a written oracle every verdict is an opinion, and the report has to say so in its first line");

  return {
    dossier: { path: dossierRel, exists: hasDossier },
    roles, screens, api, data, oracle,
  };
}
