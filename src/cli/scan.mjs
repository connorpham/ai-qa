// scan.mjs — `ai-qa scan`: grade ANY repo on ONE question.
//
//   "If a QA engineer joined this project tomorrow, could they test it —
//    and would their verdicts mean anything?"
//
// This is the zero-commitment mirror. It runs in repos WITHOUT ai-qa installed
// (that is the point), reads only the local filesystem and git, opens no
// network connection, writes nothing unless asked with --json, and always
// exits 0. A mirror is not a gate.
//
// RUBRIC — every point is a concrete offline observation. The weights encode a
// claim about testing: knowing what "correct" means (ORACLE) matters more than
// having tests, because tests written against nothing verify nothing.
//
//   RUN       20  a start command is discoverable (8) · environment is
//                 reproducible — compose/Dockerfile/.env.example (6) ·
//                 a health or base URL is written down somewhere (6)
//   ACCESS    15  env template names the auth/credential vars (5) · seed or
//                 fixture data exists as code (6) · test accounts documented (4)
//   ORACLE    25  requirement/spec documents exist as files (10) · acceptance
//                 criteria are structured, not prose (5) · an API contract —
//                 OpenAPI/GraphQL/proto (5) · a schema file for the data (5)
//   SURFACE   15  screens/routes are enumerable (6) · roles/permissions are
//                 discoverable (4) · a changelog says what recently moved (5)
//   COVERAGE  15  a test entrypoint exists (5) · end-to-end/browser tests
//                 exist (5) · CI actually runs them (5)
//   PROCESS   10  issue/bug intake is templated (4) · review trail —
//                 CODEOWNERS/PR template (3) · a known-issues registry (3)
//
// Grades: A ≥85 · B ≥70 · C ≥55 · D ≥35 · F <35.
// Calibration: an empty repo lands at 0. A well-run OSS project with no
// specs lands mid — that is correct, not a bug: it is exactly the situation
// where a new QA cannot tell a feature from a defect.
//
// Selftest:  node src/cli/scan.mjs --selftest
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot, readIfExists, c, parseArgs } from "./util.mjs";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "vendor", ".venv", "venv",
  "__pycache__", ".next", ".nuxt", "target", "coverage", ".cache", ".turbo",
  "Pods", ".gradle", ".idea", "obj", "evd",
]);
// NOT skipped: `bin/`. It is .NET build output in one ecosystem and the CLI
// entrypoint in several others — and "how do I start this?" is worth 8 points.
// The .NET binaries under it match no extension filter here, so they cost
// nothing but a directory listing.

// Files that never help and sometimes hurt: credential stores. We only ever
// need to know an env TEMPLATE exists, never what a real one contains — and a
// sandbox or secret-scanner may make reading one block rather than fail.
const NEVER_READ = /(^|\/)(\.env(\.local|\.production)?|.*\.pem|.*\.key|.*\.p12|.*\.keystore|id_rsa.*|.*credentials.*\.json)$/i;

const MAX_FILES = 20000;   // a grader must stay instant on a monorepo
const READ_CAP = 200_000;  // bytes — never slurp a bundle to grep one word
const GREP_BUDGET_MS = 4000; // total wall clock across all content greps

// ---- filesystem index --------------------------------------------------------
/** One bounded walk; every check below reads this index instead of re-walking. */
function indexRepo(root) {
  const files = [];
  const dirs = new Set();
  const stack = [""];
  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { dirs.add(childRel); stack.push(childRel); }
      else if (e.isFile()) {
        files.push(childRel);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return { files, dirs, lower: files.map((f) => f.toLowerCase()) };
}

const has = (ix, re) => ix.lower.some((f) => re.test(f));
const find = (ix, re) => ix.files.filter((f) => re.test(f.toLowerCase()));
const hasDir = (ix, re) => [...ix.dirs].some((d) => re.test(d.toLowerCase()));

/** Grep the first `limit` matching files for a pattern; returns the first hit's
 * path, or "". Bounded on THREE axes — file count, file size, and a shared wall
 * clock — because a grader that hangs is worse than one that under-reports. A
 * budget that runs out lowers the score rather than raising it, so the failure
 * mode is "ai-qa asks you a question it could have answered itself", never a
 * point awarded for evidence it never actually read.
 *
 * `budget` is per-scan state, reset by grade(). */
let grepDeadline = Infinity;
function grepIn(root, paths, re, limit = 40) {
  for (const p of paths.slice(0, limit)) {
    if (Date.now() > grepDeadline) return "";
    if (NEVER_READ.test(p)) continue;
    const text = readIfExists(path.join(root, p), READ_CAP);
    if (text && re.test(text)) return p;
  }
  return "";
}

function sh(root, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? String(r.stdout).trim() : "";
}

function readJSON(root, rel) {
  try { return JSON.parse(readIfExists(path.join(root, rel), READ_CAP) || "null"); }
  catch { return null; }
}

// ---- rubric ------------------------------------------------------------------
// Each check returns { id, label, max, got, evidence, gap }.
//   evidence — the observation that earned the points (a path, a command)
//   gap      — the QUESTION a human must answer when the points were not earned.
//              This is what turns a score into an onboarding interview.

function dimRun(root, ix) {
  const checks = [];
  const pkg = readJSON(root, "package.json");
  const scripts = (pkg && pkg.scripts) || {};
  const startScript = ["dev", "start", "serve", "develop"].find((k) => scripts[k]);
  const compose = find(ix, /^(docker-)?compose(\.\w+)?\.ya?ml$/)[0]
    || find(ix, /docker-compose.*\.ya?ml$/)[0];
  const makefile = ix.files.find((f) => f === "Makefile");
  const procfile = ix.files.find((f) => f === "Procfile");
  const pyEntry = has(ix, /^(manage\.py|main\.py|app\.py|wsgi\.py|asgi\.py)$/);
  const goEntry = has(ix, /^(main\.go|cmd\/[^/]+\/main\.go)$/);
  const gradle = has(ix, /^(build\.gradle(\.kts)?|pom\.xml)$/);
  const startEvidence = startScript ? `package.json scripts.${startScript}`
    : compose ? compose
    : makefile ? "Makefile"
    : procfile ? "Procfile"
    : pyEntry ? "python entrypoint"
    : goEntry ? "go entrypoint"
    : gradle ? "gradle/maven build file"
    : "";
  checks.push({
    id: "run.start", label: "a start command is discoverable", max: 8,
    got: startEvidence ? 8 : 0, evidence: startEvidence,
    gap: "How do I start this application locally? Exact command, and what it listens on.",
  });

  const dockerfile = find(ix, /^dockerfile$|\/dockerfile$/)[0];
  const envExample = find(ix, /^\.env\.(example|sample|template)$|^env\.example$|\.env\.dist$/)[0];
  const reproEvidence = compose || dockerfile || envExample || "";
  checks.push({
    id: "run.repro", label: "the environment is reproducible (compose / Dockerfile / .env template)", max: 6,
    got: compose ? 6 : (dockerfile || envExample) ? 4 : 0,
    evidence: reproEvidence,
    gap: "What does a fresh machine need before the app runs — services, versions, env vars? Is there a template I can copy?",
  });

  const docs = find(ix, /^(readme|contributing|docs\/.*)\.(md|mdx|rst|txt)$/);
  const urlDoc = grepIn(root, docs, /localhost:\d{2,5}|127\.0\.0\.1:\d{2,5}|https?:\/\/[\w.-]*(staging|dev|test|qa)[\w.-]*\//i);
  const healthRoute = grepIn(root, find(ix, /\.(js|ts|jsx|tsx|py|go|rb|java|cs|php)$/), /["'`/](health|healthz|readyz|ping|status)["'`/]/, 200);
  checks.push({
    id: "run.url", label: "a base URL or health endpoint is written down", max: 6,
    got: urlDoc ? 6 : healthRoute ? 3 : 0,
    evidence: urlDoc || healthRoute,
    gap: "Which URL do I test against — local, dev, or staging? Is there a health endpoint that proves it is up?",
  });
  return { id: "RUN", title: "Can I start it?", checks };
}

function dimAccess(root, ix) {
  const checks = [];
  const envFiles = find(ix, /^\.env\.(example|sample|template)$|^env\.example$|\.env\.dist$/);
  const authVar = grepIn(root, envFiles, /(AUTH|JWT|SECRET|TOKEN|PASSWORD|CLIENT_ID|OAUTH|SESSION|API_KEY)/i);
  checks.push({
    id: "access.env", label: "an env template names the auth/credential variables", max: 5,
    got: authVar ? 5 : envFiles.length ? 2 : 0,
    evidence: authVar || envFiles[0] || "",
    gap: "Which credentials and env vars do I need, and who gives them to me?",
  });

  const seedFiles = find(ix, /(^|\/)(seed|seeds|seeders|fixtures|factories)(\/|\.|$)/)
    .concat(find(ix, /seed\.(ts|js|py|rb|go|sql)$/));
  const pkg = readJSON(root, "package.json");
  const seedScript = pkg && pkg.scripts && Object.keys(pkg.scripts).find((k) => /seed|fixture/i.test(k));
  checks.push({
    id: "access.seed", label: "seed or fixture data exists as code", max: 6,
    got: seedFiles.length ? 6 : seedScript ? 4 : 0,
    evidence: seedFiles[0] || (seedScript ? `package.json scripts.${seedScript}` : ""),
    gap: "Is there seed data, or do I create my own? If I create it — through which screen, and how do I clean it up?",
  });

  const accountDoc = grepIn(root, find(ix, /\.(md|mdx|txt|rst)$/), /test\s*account|demo\s*(user|account)|t[àa]i\s*kho[ảa]n\s*test|admin@|user@example/i, 120);
  checks.push({
    id: "access.accounts", label: "test accounts are documented", max: 4,
    got: accountDoc ? 4 : 0, evidence: accountDoc,
    gap: "Which test accounts exist, one per role? A verdict with no actor is untraceable — half of all UI bugs are role-shaped.",
  });
  return { id: "ACCESS", title: "Can I get in?", checks };
}

function dimOracle(root, ix) {
  const checks = [];
  const specFiles = find(ix, /(^|\/)(docs?|specs?|requirements?|prd|rfc|design)\/.*\.(md|mdx|rst|adoc|pdf|docx)$/)
    .filter((f) => !/\/(node_modules|CHANGELOG)/i.test(f));
  const specLike = specFiles.filter((f) => !/readme|contributing|license|code_of_conduct/i.test(f));
  checks.push({
    id: "oracle.specs", label: "requirement/spec documents exist as files", max: 10,
    got: specLike.length >= 3 ? 10 : specLike.length >= 1 ? 6 : 0,
    evidence: specLike.slice(0, 3).join(", "),
    gap: "Where is the written description of correct behaviour? Without it every verdict is my opinion against the developer's — and I will not guess an expected value.",
  });

  const acFile = grepIn(root, specLike.concat(find(ix, /\.(md|mdx|feature)$/)), /given\s+.*\n?\s*when\s+|acceptance criteria|\bAC\d|scenario:/i, 120);
  checks.push({
    id: "oracle.ac", label: "acceptance criteria are structured, not prose", max: 5,
    got: acFile ? 5 : 0, evidence: acFile,
    gap: "Do tickets carry acceptance criteria I can turn into test cases, or only a title?",
  });

  const contract = find(ix, /(openapi|swagger)[^/]*\.(ya?ml|json)$|\.proto$|schema\.graphql$|\.graphqls$/)[0]
    || (grepIn(root, find(ix, /\.(ya?ml|json)$/).slice(0, 300), /"?openapi"?\s*:?\s*["']?3\./) || "");
  checks.push({
    id: "oracle.contract", label: "an API contract exists (OpenAPI / GraphQL / proto)", max: 5,
    got: contract ? 5 : 0, evidence: contract,
    gap: "Is there an API contract? Without one I cannot tell a breaking response from an intended one.",
  });

  const schema = find(ix, /schema\.prisma$|(^|\/)migrations?\/.*\.(sql|py|js|ts)$|(^|\/)models?\.(py|rb|go|ts)$|schema\.rb$/)[0];
  checks.push({
    id: "oracle.schema", label: "the data model is readable as a file", max: 5,
    got: schema ? 5 : 0, evidence: schema,
    gap: "Where is the data model? Write operations get verified by reading the row back — I need to know which table and which column.",
  });
  return { id: "ORACLE", title: "Do I know what 'correct' means?", checks };
}

function dimSurface(root, ix) {
  const checks = [];
  const routeish = hasDir(ix, /(^|\/)(pages|app|routes|screens|views|controllers)$/)
    || find(ix, /(router|routes)\.(js|ts|jsx|tsx|py|go|rb)$|urls\.py$/)[0];
  const routeEvidence = typeof routeish === "string" ? routeish
    : [...ix.dirs].find((d) => /(^|\/)(pages|app|routes|screens|views|controllers)$/.test(d)) || "";
  checks.push({
    id: "surface.routes", label: "screens/routes are enumerable from the code", max: 6,
    got: routeEvidence ? 6 : 0, evidence: routeEvidence,
    gap: "What are the screens, and which one does this change touch? I test whole screens, not single fields.",
  });

  const roles = grepIn(root, find(ix, /\.(js|ts|jsx|tsx|py|go|rb|java|cs|prisma|sql|md)$/), /\b(ROLE_|UserRole|role\s*[:=]\s*["'](admin|user|staff|manager)|permissions?\s*[:=]|@PreAuthorize|can\(|ability)/i, 250);
  checks.push({
    id: "surface.roles", label: "user roles / permissions are discoverable", max: 4,
    got: roles ? 4 : 0, evidence: roles,
    gap: "Which user roles exist, and what may each of them do? I sign in as the role that owns the task, not as an admin who can do everything.",
  });

  const changelog = find(ix, /^changelog\.md$|^changes\.md$|(^|\/)release[-_]notes/)[0];
  const recent = sh(root, "git", ["log", "--oneline", "-15"]);
  checks.push({
    id: "surface.change", label: "recent change history is readable", max: 5,
    got: changelog ? 5 : recent ? 3 : 0,
    evidence: changelog || (recent ? `git log (${recent.split("\n").length} recent commits)` : ""),
    gap: "What changed recently? Defects cluster around recent change — that is where I look first.",
  });
  return { id: "SURFACE", title: "Do I know what to test?", checks };
}

function dimCoverage(root, ix) {
  const checks = [];
  const pkg = readJSON(root, "package.json");
  const testScript = pkg && pkg.scripts && pkg.scripts.test && !/no test specified/i.test(pkg.scripts.test);
  const testFiles = find(ix, /\.(test|spec)\.(js|ts|jsx|tsx|mjs)$|(^|\/)tests?\/.*\.(py|go|rb|java|cs)$|_test\.go$|test_.*\.py$/);
  checks.push({
    id: "cov.entry", label: "a test entrypoint exists", max: 5,
    got: testScript && testFiles.length ? 5 : (testScript || testFiles.length) ? 3 : 0,
    evidence: testScript ? "package.json scripts.test" : testFiles[0] || "",
    gap: "How do I run the existing tests, and do they pass on a clean checkout right now?",
  });

  const e2e = find(ix, /(playwright|cypress|selenium|puppeteer|appium|maestro|detox)/)[0]
    || (hasDir(ix, /(^|\/)(e2e|cypress|integration)$/) ? [...ix.dirs].find((d) => /(^|\/)(e2e|cypress|integration)$/.test(d)) : "");
  checks.push({
    id: "cov.e2e", label: "end-to-end / browser tests exist", max: 5,
    got: e2e ? 5 : 0, evidence: e2e || "",
    gap: "Is there an end-to-end suite? If not, my verification runs the browser by hand — slower, and nothing is inherited between rounds.",
  });

  const ci = find(ix, /^\.github\/workflows\/.*\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\/config\.yml$|^azure-pipelines\.yml$|^jenkinsfile$|^\.travis\.yml$/);
  const ciRunsTests = ci.length ? grepIn(root, ci, /\b(test|pytest|jest|vitest|go test|mvn|gradle|playwright|cypress)\b/i) : "";
  checks.push({
    id: "cov.ci", label: "CI actually runs the tests", max: 5,
    got: ciRunsTests ? 5 : ci.length ? 2 : 0,
    evidence: ciRunsTests || ci[0] || "",
    gap: "Does CI run the suite on every change, or is green on a laptop the only evidence?",
  });
  return { id: "COVERAGE", title: "What is already covered?", checks };
}

function dimProcess(root, ix) {
  const checks = [];
  const issueTpl = find(ix, /^\.github\/issue_template|^\.github\/ISSUE_TEMPLATE\/|^\.gitlab\/issue_templates\//i)[0];
  checks.push({
    id: "proc.intake", label: "bug intake is templated", max: 4,
    got: issueTpl ? 4 : 0, evidence: issueTpl || "",
    gap: "Where do bugs get filed, and what must a bug report contain here to be actionable?",
  });

  const review = find(ix, /^\.github\/pull_request_template|^codeowners$|^\.github\/codeowners$|^docs\/.*review/i)[0];
  checks.push({
    id: "proc.review", label: "a review trail is defined (CODEOWNERS / PR template)", max: 3,
    got: review ? 3 : 0, evidence: review || "",
    gap: "Who reviews, who approves, and what does 'done' mean before it reaches me?",
  });

  const known = find(ix, /known[-_]issues|troubleshooting|faq\.md$/i)[0];
  checks.push({
    id: "proc.known", label: "a known-issues registry exists", max: 3,
    got: known ? 3 : 0, evidence: known || "",
    gap: "Which failures are already known? Re-reporting a known issue dilutes signal and wastes the team's time.",
  });
  return { id: "PROCESS", title: "How does work arrive and leave?", checks };
}

// ---- facts (for the onboarding workflow, not scored) --------------------------
function facts(root, ix) {
  const pkg = readJSON(root, "package.json");
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const dep = (re) => Object.keys(deps).find((d) => re.test(d)) || "";
  const stack = [];
  if (dep(/^next$/)) stack.push("next.js");
  if (dep(/^react$/)) stack.push("react");
  if (dep(/^vue$/)) stack.push("vue");
  if (dep(/^@angular\/core$/)) stack.push("angular");
  if (dep(/^svelte$/)) stack.push("svelte");
  if (dep(/^express$|^fastify$|^@nestjs\/core$/)) stack.push("node-api");
  if (has(ix, /^requirements\.txt$|^pyproject\.toml$/)) stack.push("python");
  if (has(ix, /^go\.mod$/)) stack.push("go");
  if (has(ix, /^gemfile$/)) stack.push("ruby");
  if (has(ix, /^pom\.xml$|^build\.gradle/)) stack.push("jvm");
  if (has(ix, /\.csproj$|\.sln$/)) stack.push("dotnet");
  if (has(ix, /^pubspec\.yaml$/)) stack.push("flutter");
  if (has(ix, /^ios\/podfile$|\.xcodeproj\//)) stack.push("ios");
  if (has(ix, /^android\/build\.gradle/)) stack.push("android");

  const pm = has(ix, /^pnpm-lock\.yaml$/) ? "pnpm"
    : has(ix, /^yarn\.lock$/) ? "yarn"
    : has(ix, /^bun\.lockb?$/) ? "bun"
    : has(ix, /^package-lock\.json$/) ? "npm"
    : has(ix, /^poetry\.lock$/) ? "poetry"
    : has(ix, /^requirements\.txt$/) ? "pip"
    : has(ix, /^go\.sum$/) ? "go"
    : "unknown";

  // Which surfaces does this repo actually present? Drives the default profiles.
  const surfaces = [];
  if (stack.some((s) => /next|react|vue|angular|svelte/.test(s)) || hasDir(ix, /(^|\/)(pages|views|screens)$/)) surfaces.push("web");
  if (dep(/^express$|^fastify$|^@nestjs\/core$/) || has(ix, /(openapi|swagger)[^/]*\.(ya?ml|json)$/) || hasDir(ix, /(^|\/)(controllers|api)$/)) surfaces.push("api");
  if (stack.some((s) => /flutter|ios|android/.test(s))) surfaces.push("mobile");
  if (has(ix, /schema\.prisma$/) || hasDir(ix, /(^|\/)migrations?$/)) surfaces.push("database");

  return {
    stack, package_manager: pm, surfaces: surfaces.length ? surfaces : ["web"],
    file_count: ix.files.length,
    truncated: ix.files.length >= MAX_FILES,
    git_head: sh(root, "git", ["rev-parse", "--short", "HEAD"]),
    git_branch: sh(root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    start_hint: (pkg?.scripts?.dev && "dev") || (pkg?.scripts?.start && "start") || "",
    spec_dirs: [...ix.dirs].filter((d) => /^(docs?|specs?|requirements?)($|\/)/i.test(d)).slice(0, 12),
  };
}

const GRADE = (s) => (s >= 85 ? "A" : s >= 70 ? "B" : s >= 55 ? "C" : s >= 35 ? "D" : "F");

export function grade(root) {
  grepDeadline = Date.now() + GREP_BUDGET_MS;
  const ix = indexRepo(root);
  const dims = [dimRun(root, ix), dimAccess(root, ix), dimOracle(root, ix),
                dimSurface(root, ix), dimCoverage(root, ix), dimProcess(root, ix)];
  for (const d of dims) {
    d.got = d.checks.reduce((a, k) => a + k.got, 0);
    d.max = d.checks.reduce((a, k) => a + k.max, 0);
  }
  const score = dims.reduce((a, d) => a + d.got, 0);
  const budgetExhausted = Date.now() > grepDeadline;
  return {
    root, score, grade: GRADE(score), dimensions: dims,
    budget_exhausted: budgetExhausted,
    gaps: dims.flatMap((d) => d.checks.filter((k) => k.got < k.max)
      .map((k) => ({ dimension: d.id, id: k.id, lost: k.max - k.got, question: k.gap, label: k.label }))),
    facts: facts(root, ix),
    scanned_at: new Date().toISOString(),
  };
}

// ---- rendering ----------------------------------------------------------------
function bar(got, max, width = 18) {
  const filled = max ? Math.round((got / max) * width) : 0;
  const paint = got === max ? c.green : got >= max * 0.5 ? c.yellow : c.red;
  return paint("█".repeat(filled)) + c.gray("░".repeat(width - filled));
}

export function report(res, { verbose = false } = {}) {
  const gradeColor = res.score >= 70 ? c.green : res.score >= 45 ? c.yellow : c.red;
  console.log(`\n  ${c.bold("QA readiness")}  ${c.gray(res.root)}`);
  console.log(`  ${gradeColor(c.bold(`${res.score}/100`))}  ${gradeColor(`grade ${res.grade}`)}   ${c.gray(`${res.facts.stack.join(", ") || "stack unknown"} · ${res.facts.surfaces.join("+")}`)}\n`);

  for (const d of res.dimensions) {
    const pad = d.id.padEnd(9);
    console.log(`  ${c.bold(pad)} ${bar(d.got, d.max)} ${String(d.got).padStart(2)}/${d.max}  ${c.gray(d.title)}`);
    if (verbose) {
      for (const k of d.checks) {
        const mark = k.got === k.max ? c.green("✓") : k.got > 0 ? c.yellow("~") : c.red("✗");
        console.log(`      ${mark} ${k.label} ${c.gray(`(${k.got}/${k.max})`)}`);
        if (k.evidence) console.log(`        ${c.gray(`→ ${k.evidence}`)}`);
      }
    }
  }

  const blocking = res.gaps.filter((g) => g.lost >= 4).sort((a, b) => b.lost - a.lost);
  if (blocking.length) {
    console.log(`\n  ${c.bold("What I would have to ask a human before I could test this")}`);
    console.log(`  ${c.gray("— these are the questions /onboard puts to the team, one at a time —")}\n`);
    for (const g of blocking.slice(0, 8)) {
      console.log(`  ${c.yellow("?")} ${c.gray(`[${g.dimension}]`)} ${g.question}`);
    }
    if (blocking.length > 8) console.log(`  ${c.gray(`… and ${blocking.length - 8} more (--verbose)`)}`);
  } else {
    console.log(`\n  ${c.green("✓")} Nothing blocking — a QA could start here today.`);
  }

  if (res.budget_exhausted) {
    console.log(`\n  ${c.yellow("⚠")} content search hit its time budget — some evidence went unread, so this`);
    console.log(`    score is a FLOOR, not a ceiling. Re-run with ${c.cyan("--verbose")} to see what was found.`);
  }
  if (res.facts.truncated) {
    console.log(`\n  ${c.yellow("⚠")} the file walk stopped at its cap — this is a large repo; point ${c.cyan("--path")} at a package.`);
  }

  console.log(`\n  ${c.gray("Next:")} ${c.cyan("npx ai-qa init")} ${c.gray("installs the QA lane · a scan is read-only and changes nothing")}\n`);
}

// ---- command ------------------------------------------------------------------
export async function scan(flags) {
  const root = flags.path ? path.resolve(String(flags.path)) : repoRoot();
  if (!fs.existsSync(root)) {
    console.error(`ai-qa scan: no such directory: ${root}`);
    process.exit(1);
  }
  const res = grade(root);
  if (flags.json) {
    const out = typeof flags.json === "string" ? path.resolve(flags.json) : path.join(root, ".ai-qa", "discovery.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(res, null, 2)}\n`);
    // Whichever reads shorter: a relative path that climbs out of the tree with
    // six ../ is less legible than the absolute one it was built from.
    const rel = path.relative(process.cwd(), out);
    console.log(`ai-qa scan: wrote ${rel && rel.length < out.length ? rel : out}`);
    if (!flags.quiet) report(res, { verbose: !!flags.verbose });
    return;
  }
  report(res, { verbose: !!flags.verbose });
}

// ---- selftest -----------------------------------------------------------------
// A grader that has never been red does not exist. This builds three fixture
// repos, asserts the ordering holds, and then MUTATES the good one — deleting
// its specs must cost ORACLE points. If that mutation does not move the score,
// the check is decorative and the selftest fails.
async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiqa-scan-"));
  const mk = (name, files) => {
    const dir = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return dir;
  };
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };

  const bare = mk("bare", { "README.md": "# a thing\n" });
  const mid = mk("mid", {
    "package.json": JSON.stringify({ scripts: { dev: "vite", test: "vitest" }, dependencies: { react: "18" } }),
    "src/App.test.tsx": "test('x', () => {})",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: npm test\n",
    "README.md": "run at http://localhost:3000\n",
  });
  const full = mk("full", {
    "package.json": JSON.stringify({ scripts: { dev: "next dev", test: "vitest", seed: "tsx seed.ts" }, dependencies: { next: "14", react: "18" } }),
    "docker-compose.yml": "services:\n  db:\n    image: postgres\n",
    ".env.example": "DATABASE_URL=\nJWT_SECRET=\n",
    "prisma/schema.prisma": "model User { id Int @id\n role String }\n",
    "prisma/seed.ts": "// seed",
    "docs/specs/checkout.md": "## AC1\nGiven a cart\nWhen I pay\nThen the order is created\n",
    "docs/specs/orders.md": "spec\n",
    "docs/specs/auth.md": "Test account: admin@example.com\n",
    "openapi.yaml": "openapi: 3.0.0\n",
    "app/page.tsx": "export default function P(){}",
    "e2e/checkout.spec.ts": "import { test } from '@playwright/test'",
    "CHANGELOG.md": "## 1.0\n",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: npx playwright test\n",
    ".github/ISSUE_TEMPLATE/bug.md": "## Steps\n",
    ".github/pull_request_template.md": "## What\n",
    "docs/known-issues.md": "# KI-001\n",
    "README.md": "Dev server: http://localhost:3000 — test account admin@example.com\n",
  });

  const rBare = grade(bare), rMid = grade(mid), rFull = grade(full);
  check(rBare.score < rMid.score, `ordering: bare(${rBare.score}) should score below mid(${rMid.score})`);
  check(rMid.score < rFull.score, `ordering: mid(${rMid.score}) should score below full(${rFull.score})`);
  check(rBare.score <= 25, `a near-empty repo should land low, got ${rBare.score}`);
  check(rFull.score >= 70, `a fully-documented repo should reach B, got ${rFull.score}`);
  check(rBare.dimensions.some((d) => d.got === 0), "a near-empty repo must have at least one fully-red dimension");
  check(rBare.gaps.length > rFull.gaps.length, "a bare repo must produce more onboarding questions than a documented one");

  // MUTATION 1 — remove the specs: ORACLE must drop.
  const oracleBefore = rFull.dimensions.find((d) => d.id === "ORACLE").got;
  fs.rmSync(path.join(full, "docs", "specs"), { recursive: true, force: true });
  fs.rmSync(path.join(full, "openapi.yaml"), { force: true });
  const mutated = grade(full);
  const oracleAfter = mutated.dimensions.find((d) => d.id === "ORACLE").got;
  check(oracleAfter < oracleBefore, `mutation: deleting specs must cost ORACLE points (${oracleBefore} → ${oracleAfter})`);
  check(mutated.score < rFull.score, `mutation: deleting specs must lower the score (${rFull.score} → ${mutated.score})`);

  // MUTATION 2 — the facts must follow reality, not a guess.
  check(rFull.facts.stack.includes("next.js"), `facts: next.js not detected in the full fixture (got ${JSON.stringify(rFull.facts.stack)})`);
  check(rFull.facts.surfaces.includes("database"), "facts: a prisma schema must mark the database surface");
  check(rFull.budget_exhausted === false, "a fixture this small must not exhaust the grep budget — the budget is for monorepos, not for hiding slow checks");

  // MUTATION 3 — a real .env must never be read. It is dropped in with a value
  // that WOULD score if it were grepped; the score must not move.
  const envRepo = mk("envleak", {
    "package.json": JSON.stringify({ scripts: { dev: "x" } }),
    ".env": "ADMIN_PASSWORD=hunter2\ntest account: admin@example.com\n",
  });
  const before = grade(envRepo).score;
  fs.writeFileSync(path.join(envRepo, ".env"), "JWT_SECRET=x\ntest account: admin@example.com\n".repeat(50));
  check(grade(envRepo).score === before, "a real .env must never be read for evidence — its contents moved the score");

  fs.rmSync(tmp, { recursive: true, force: true });
  if (fails.length) {
    console.error(`${c.red("scan --selftest FAILED")}\n${fails.map((f) => `  ✗ ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${c.green("✓")} scan --selftest passed  ${c.gray(`(bare ${rBare.score} < mid ${rMid.score} < full ${rFull.score}; specs-deleted mutation went red)`)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.selftest) await selftest();
  else await scan(flags);
}
