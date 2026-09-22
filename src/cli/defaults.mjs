// defaults.mjs — everything the wizard should NOT have to ask.
//
// Both wizards (terminal and browser) pre-fill from here. A setup that
// interrogates you about facts sitting in your own package.json is not
// friendly, it is lazy — and every question removed here is one the user still
// has patience for when a question that matters arrives.
//
// Detection never guesses silently: when nothing is found the field comes back
// EMPTY, which the config records as a declared unknown rather than a default.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readIfExists } from "./util.mjs";
import { walkFiles } from "./manifest.mjs";

export function detectBranch(root) {
  try {
    const b = execSync("git symbolic-ref --short HEAD",
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return b || "main";
  } catch { return "main"; }
}

export function detectStart(root, facts) {
  if (facts.start_hint) {
    const pm = facts.package_manager === "unknown" ? "npm" : facts.package_manager;
    return pm === "npm" ? `npm run ${facts.start_hint}` : `${pm} ${facts.start_hint}`;
  }
  if (fs.existsSync(path.join(root, "docker-compose.yml")) ||
      fs.existsSync(path.join(root, "compose.yml"))) return "docker compose up";
  if (fs.existsSync(path.join(root, "manage.py"))) return "python manage.py runserver";
  if (fs.existsSync(path.join(root, "Makefile"))) return "make dev";
  return "";
}

/** A port written down in the repo beats a guess about the framework. */
export function detectUrl(root, facts) {
  for (const f of ["README.md", "readme.md", ".env.example", "docker-compose.yml", "compose.yml"]) {
    const m = /https?:\/\/(localhost|127\.0\.0\.1):(\d{2,5})/.exec(readIfExists(path.join(root, f), 200_000));
    if (m) return `http://localhost:${m[2]}`;
  }
  if (facts.stack.includes("next.js")) return "http://localhost:3000";
  if (facts.stack.includes("python")) return "http://localhost:8000";
  return "";
}

function firstMatch(root, re) {
  const hits = walkFiles(root).filter((f) => re.test(f) && !f.includes("node_modules"));
  return hits[0] ? hits[0].split(path.sep).join("/") : "";
}

export const detectContract = (root) =>
  firstMatch(root, /(openapi|swagger)[^/\\]*\.(ya?ml|json)$|schema\.graphql$|\.proto$/i);

export const detectSchema = (root) =>
  firstMatch(root, /schema\.prisma$|schema\.rb$|(^|[/\\])models?\.(py|rb|ts)$/i);

/** The NAME of the connection env var — never its value. */
export function detectDbEnv(root) {
  const env = readIfExists(path.join(root, ".env.example"), 100_000)
    || readIfExists(path.join(root, ".env.sample"), 100_000);
  const m = /^([A-Z0-9_]*(DATABASE|DB|POSTGRES|MYSQL|MONGO)[A-Z0-9_]*)=/m.exec(env);
  return m ? m[1] : (env ? "" : "DATABASE_URL");
}

/** The folders that look like they hold the written requirements.
 *
 * A SUGGESTION, never a decision: the answer set carries it so a wizard can
 * offer it, and both wizards make a human confirm. An oracle the tool picked
 * on its own is the thing the whole doctrine exists to refuse.
 */
export function detectSpecDirs(scan) {
  const check = (scan.dimensions || []).flatMap((d) => d.checks || [])
    .find((k) => k.id === "oracle.specs");
  return ((check && check.dirs) || [])
    .filter((d) => !d.startsWith(".") && !/(^|\/)(node_modules|vendor|dist|build)(\/|$)/.test(d));
}

/** One pre-filled answer set, shared by both wizards. Flags win over detection,
 * detection wins over a blank field, and a blank field stays blank. */
export function detectDefaults(root, scan, flags = {}) {
  const f = scan.facts;
  const surfaces = flags.surfaces
    ? String(flags.surfaces).split(",").map((s) => s.trim()).filter(Boolean)
    : f.surfaces;
  return {
    name: flags.name ? String(flags.name) : path.basename(root),
    key: (flags.key ? String(flags.key) : "QA").toUpperCase(),
    language: flags.language ? String(flags.language) : "en",
    surfaces: surfaces.length ? surfaces : ["web"],
    start: flags.start ? String(flags.start) : detectStart(root, f),
    url: flags.url ? String(flags.url) : detectUrl(root, f),
    health: "",
    apiBase: "",
    specs: flags.specs ? String(flags.specs).split(",").map((x) => x.trim()).filter(Boolean)
                       : detectSpecDirs(scan),
    contract: detectContract(root),
    schema: detectSchema(root),
    dbUrlEnv: detectDbEnv(root),
    mobilePlatform: "",
    mobileDriver: "",
    tracker: flags.tracker ? String(flags.tracker) : "markdown",
    branch: detectBranch(root),
    autonomy: flags.autonomy ? String(flags.autonomy) : "assisted",
    tools: flags.tools ? String(flags.tools).split(",").map((s) => s.trim()).filter(Boolean) : ["claude-code"],
  };
}
