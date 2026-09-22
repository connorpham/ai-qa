// init.mjs — `ai-qa init`: install the QA lane into this repo.
//
// Two rules shape this file:
//
//  1. ASK ONLY WHAT THE REPO CANNOT ANSWER. `scan` runs first and pre-fills
//     every field it can observe, so the wizard is short and its defaults are
//     already right. A setup that interrogates you about facts sitting in your
//     package.json is not friendly, it is lazy.
//  2. NOTHING IS WRITTEN UNTIL THE SUMMARY IS APPROVED. Every value is
//     validated against the constrained-YAML grammar BEFORE the first byte
//     hits disk, so a config this tool cannot read never gets created.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  pkgRoot, gitRoot, ask, askChoice, askMulti, askYesNo, writeFile, writeIfAbsent,
  readIfExists, say, c, fail,
} from "./util.mjs";
import { CONFIG_NAME, configPath } from "./config.mjs";
import { ManifestGuard, walkFiles, MANIFEST_REL } from "./manifest.mjs";
import { TOOLS, planWorkflows, applyPointers } from "./adapters.mjs";
import { grade } from "./scan.mjs";
import {
  detectDefaults, detectBranch, detectStart, detectUrl, detectContract, detectSchema, detectDbEnv,
  detectSpecDirs,
} from "./defaults.mjs";

export const SURFACES = ["web", "api", "mobile", "database"];
export const TRACKERS = ["markdown", "github", "jira", "backlog"];

/** Which environment variables each tracker needs, mirroring the ENV lists in
 * core/scripts/lib/trackers.py. Duplicated in two languages on purpose — the
 * wizard must name them without shelling out to Python — and conformance
 * asserts the two copies still agree, because a drifted name here sends the
 * user hunting for a variable that is spelled differently in the gate. */
export const TRACKER_ENV = {
  markdown: [],
  jira: ["JIRA_EMAIL", "JIRA_API_TOKEN"],
  backlog: ["BACKLOG_API_KEY"],
  github: ["GITHUB_TOKEN"],
};

/** What tracker.base_url / tracker.project mean for each provider — they are
 * different enough that one generic prompt would get both wrong. */
export const TRACKER_COORDS = {
  jira: { base: "Jira site URL", baseEg: "https://acme.atlassian.net",
          proj: "Project key", projEg: "SHOP" },
  backlog: { base: "Backlog space URL", baseEg: "https://acme.backlog.com",
             proj: "Project key", projEg: "SHOP" },
  github: { base: "", baseEg: "",
            proj: "Repository (owner/repo)", projEg: "acme/shop" },
};
export const AUTONOMY = ["off", "assisted", "full"];
export const LANGUAGES = ["en", "vi"];
const VALUE_FLAGS = ["name", "key", "language", "surfaces", "tracker", "tools", "autonomy",
  "url", "start", "tracker-url", "tracker-project"];

// ---- value validation ---------------------------------------------------------
/** A user string as a YAML scalar that round-trips through BOTH parsers
 * (config.mjs and lib/ctx.py). Rejected here means never written. */
function yamlStr(s, what) {
  const v = String(s);
  if (/[\r\n]/.test(v)) fail("init", `${what} must be a single line`);
  if (/\s#/.test(v)) fail("init", `${what} cannot contain ' #' — both config parsers read it as a comment`);
  if (v.includes("'") && v.includes('"')) fail("init", `${what} cannot mix single and double quotes`);
  if (/^\s|\s$/.test(v)) fail("init", `${what} cannot start or end with whitespace`);
  return v.includes("'") ? `"${v}"` : `'${v}'`;
}

// ---- the config file ----------------------------------------------------------
export function renderConfig(a) {
  const today = new Date().toISOString().slice(0, 10);
  const list = (arr) => `[${arr.join(", ")}]`;
  return `# ai-qa — the contract between this repo and the QA lane.
# Every field here is something the QA agent would otherwise have to guess.
# A field left empty is not a default: it is a DECLARED UNKNOWN, and the lane
# reports it as a blocker instead of inventing a value.
version: 1

project:
  name: ${yamlStr(a.name, "project name")}
  key: ${a.key}
  # The WORKING language (en | vi) — not only the report: the lane narrates,
  # asks the team, summarises, files bugs and writes the dossier in it. Field
  # keys, verdict words, severities and gate lines stay in English because the
  # gates read them; field values and screen labels follow the product.
  language: ${a.language}
  adopted: ${today}

paths:
  specs: docs/specs
  qa: docs/qa
  evidence: evd
  onboarding: docs/qa/onboarding.md
  known_issues: docs/qa/known-issues.md
  lessons: docs/qa/lessons.md

# Which surfaces this product presents. Each one activates its gates and its
# branch of the /qa workflow — a migration is not verified the way a screen is.
surfaces: ${list(a.surfaces)}

app:
  # How a human starts this thing, and where it answers. app_check.sh probes
  # these; it NEVER starts a server — a gate that boots your app is a gate that
  # can hide a broken boot.
  start: ${yamlStr(a.start, "start command")}
  url: ${yamlStr(a.url, "app url")}
  health: ${yamlStr(a.health, "health path")}
  # auto: a real browser window you can watch · never: unattended shifts
  # (drops the visibility, NEVER a screenshot)
  headed: auto
  # How fast a headed run moves. Headed is not the same as watchable: at full
  # speed the click and its result land in the same frame, and nobody can tell
  # what was clicked. human: follow it live · brisk: you have seen this journey
  # before · demo: someone is watching over your shoulder · or a number of ms.
  # Ignored when headless. One-off: AIQA_PACE=demo node journey.mjs
  pace: human

# Where a verification may run. Every run resolves exactly ONE of these — the
# env= argument, else $AIQA_ENV, else \`default:\` — and the report's
# ENVIRONMENT: line records which (the evidence gate refuses a report without
# one), because a bug found on staging is not evidence about production.
# An empty url falls back to app.url above. A CHOSEN environment with no block
# here is a declared unknown: the run BLOCKS rather than quietly testing
# localhost under a nicer name.
environments:
  default: local
  local:
    url: ''          # empty = app.url above
    writes: allowed
  # Uncomment what exists. writes: forbidden = the lane creates NO test data
  # there and any case that would change state is BLOCKED, not attempted. An
  # environment named prod/production is writes: forbidden unless it says
  # otherwise — and it should not say otherwise.
  # dev:
  #   url: 'https://dev.example.com'
  #   api_base: ''     # empty = this url, then api.base_url
  #   db_url_env: ''   # empty = database.url_env — the NAME of the var, never the value
  #   writes: allowed
  # stg:
  #   url: 'https://stg.example.com'
  #   writes: allowed
  # prod:
  #   url: 'https://www.example.com'
  #   writes: forbidden

api:
  base_url: ${yamlStr(a.apiBase, "api base url")}
  # OpenAPI/GraphQL/proto file. Empty = no contract, and contract tests say so
  # out loud rather than asserting whatever the server happens to return today.
  contract: ${yamlStr(a.contract, "api contract path")}

mobile:
  platform: ${yamlStr(a.mobilePlatform, "mobile platform")}   # ios | android | flutter | ''
  driver: ${yamlStr(a.mobileDriver, "mobile driver")}     # appium | maestro | ''

database:
  # The NAME of the env var holding the connection string — never the value.
  # ai-qa reads databases to VERIFY writes; it never writes through them.
  url_env: ${yamlStr(a.dbUrlEnv, "database url env var")}
  schema: ${yamlStr(a.schema, "schema path")}

oracle:
  # The source of truth for "correct", and the most important list in this file.
  #
  # The evidence gate resolves every citation against it: a case that claims
  # PASS must name a document from here (or the schema, or a named floor rule),
  # the document must exist, and a section number on its own is not a citation.
  # Empty, and /qa cannot derive an expected value — it BLOCKS the case rather
  # than guess, which is the single most important promise this tool makes.
  #
  # A folder counts: declaring the shelf stays right as documents are added.
  specs: ${list(a.specs || [])}
  # Design source for UI comparison, if any (a Figma link or a folder of frames)
  design: ''

accounts:
  # WHERE credentials come from — never the credentials themselves.
  source: '.env'
  # One line per role you can sign in as, e.g.
  #   - 'admin: ADMIN_EMAIL / ADMIN_PASSWORD in .env'
  roles: []

tracker:
  provider: ${a.tracker}
  # Non-secret coordinates live here. CREDENTIALS DO NOT: they come from the
  # environment (${(a.trackerEnv || []).join(", ") || "none needed"}),
  # so this file stays safe to commit. tracker.py check names any that are missing.
  base_url: ${yamlStr(a.trackerBaseUrl, "tracker base url")}
  project: ${yamlStr(a.trackerProject, "tracker project")}
  # Statuses this project treats as delivered/closed. /qa reads them to tell
  # "not delivered yet" from "claimed done" — a difference that changes the verdict.
  done_statuses: [Done, Closed, Resolved]
  review_status: 'In Review'

git:
  protected_branch: ${yamlStr(a.branch, "protected branch")}

autonomy:
  level: ${a.autonomy}
  # How the lane behaves when it must CREATE test data on a shared environment:
  #   ask           — stop and ask before every write (default; correct with a human present)
  #   minutes-first — record the intended write, then proceed (scheduled runs)
  write_gate: ask
  # Never automated, at any level, whatever the config says.
  exemptions:
    - real-money
    - credentials
    - data-deletion
    - production-data

evidence:
  # The test-case budget per ticket. Small on purpose: 2-5 well-chosen cases
  # beat 30 shallow ones, and a budget forces the choice to be by RISK.
  min_test_cases: 2
  max_test_cases: 5
  # Each of these can make the evidence gate go red.
  require_boundary: true        # one case must probe the adjacent input that behaves the OTHER way
  require_whole_screen: true    # one case must check the rest of the screen still works
  require_reload_check: true    # a save that dies on refresh is not a save
  require_annotation: true      # a screenshot with no box and no caption explains nothing
  require_db_verify: true       # a write is verified by reading the row back
  # Every claim names the document it was read out of. Turning this off does not
  # make the verdicts better founded, only quieter about it — stage the adoption
  # with it false if you must, and put it back the week the specs land.
  require_citation: true
`;
}

// ---- the wizard ---------------------------------------------------------------
export async function gather(root, scanRes, flags) {
  const f = scanRes.facts;
  const yes = !!flags.yes;
  const interactive = process.stdin.isTTY && !yes;

  // Precedence, in this order and no other: an explicit flag · --yes taking the
  // detected default · a question. Only a session that is neither flagged nor
  // interactive has nothing to fall back on, and that is the one that fails.
  const resolve = async (flag, def, askFn) => {
    if (flags[flag] !== undefined) return String(flags[flag]);
    if (yes) return def;
    if (!process.stdin.isTTY) {
      fail("init", `non-interactive session and no --yes: pass --${flag} (or --yes to accept the detected defaults)`);
    }
    return askFn();
  };
  const get = (flag, q, def) => resolve(flag, def, () => ask(q, def));
  const getChoice = (flag, q, opts, def) => resolve(flag, def, () => askChoice(q, opts, def));

  const total = 6;
  const a = {};

  // ── 1. identity ──────────────────────────────────────────────────────────────
  if (interactive) say.step(1, total, "The project");
  a.name = await get("name", "Project name", path.basename(root));
  a.key = (await get("key", "Ticket key prefix (e.g. SHOP → SHOP-142)", "QA")).toUpperCase();
  a.language = await getChoice("language", "Working language — reports, questions, everything the team reads", LANGUAGES, "en");

  // ── 2. surfaces ──────────────────────────────────────────────────────────────
  if (interactive) {
    say.step(2, total, "What can be tested here");
    say.info(`detected: ${c.cyan(f.surfaces.join(", "))} ${c.gray(`(${f.stack.join(", ") || "stack unknown"})`)}`);
  }
  a.surfaces = flags.surfaces
    ? String(flags.surfaces).split(",").map((s) => s.trim()).filter(Boolean)
    : interactive ? await askMulti("Surfaces to verify", SURFACES, f.surfaces) : f.surfaces;
  if (!a.surfaces.length) a.surfaces = ["web"];
  for (const s of a.surfaces) {
    if (!SURFACES.includes(s)) fail("init", `unknown surface ${JSON.stringify(s)} — valid: ${SURFACES.join(", ")}`);
  }

  // ── 3. how to run it ─────────────────────────────────────────────────────────
  const wantsApp = a.surfaces.includes("web") || a.surfaces.includes("api");
  if (interactive && wantsApp) say.step(3, total, "How to run it");
  a.start = wantsApp ? await get("start", "Command that starts the app", detectStart(root, f)) : "";
  a.url = wantsApp ? await get("url", "URL it answers on", detectUrl(root, f)) : "";
  a.health = wantsApp && a.url && interactive
    ? await ask("Health path that proves it is up (blank = probe the URL itself)", "")
    : "";
  a.apiBase = a.surfaces.includes("api")
    ? (interactive ? await ask("API base URL (blank = same as the app URL)", "") : "")
    : "";
  a.contract = a.surfaces.includes("api") ? detectContract(root) : "";

  a.mobilePlatform = "";
  a.mobileDriver = "";
  if (a.surfaces.includes("mobile")) {
    a.mobilePlatform = interactive ? await askChoice("Mobile platform", ["ios", "android", "flutter"], "android") : "android";
    a.mobileDriver = interactive ? await askChoice("Mobile driver", ["appium", "maestro"], "maestro") : "maestro";
  }
  a.dbUrlEnv = a.surfaces.includes("database") ? detectDbEnv(root) : "";
  a.schema = a.surfaces.includes("database") ? detectSchema(root) : "";

  // ── 4. the oracle ────────────────────────────────────────────────────────────
  // The one field in this file that decides whether a verdict is a fact or an
  // opinion. It is asked, never inferred: detection can find documents, but
  // only a human can say which of them the team agrees to be judged against.
  // An oracle chosen after the result is known is not an oracle.
  const foundDirs = detectSpecDirs(scanRes);
  if (interactive) {
    say.step(4, total, "What decides \"correct\"");
    say.info(foundDirs.length
      ? `found documents in: ${c.cyan(foundDirs.join(", "))}`
      : c.gray("no spec-shaped documents found in this repo"));
    say.info(c.gray("every expected value /qa writes must cite one of these — leave it blank and"));
    say.info(c.gray("the evidence gate will refuse to let a verdict call itself a PASS"));
  }
  a.specs = (await get("specs",
    "Folders or files that decide what is correct (comma-separated, blank = none yet)",
    foundDirs.join(", "))).split(",").map((x) => x.trim()).filter(Boolean);

  // ── 5. workflow ──────────────────────────────────────────────────────────────
  if (interactive) say.step(5, total, "How work reaches you");
  a.tracker = await getChoice("tracker", "Where tickets live", TRACKERS, "markdown");
  a.trackerEnv = TRACKER_ENV[a.tracker] || [];
  const coords = TRACKER_COORDS[a.tracker];
  a.trackerBaseUrl = "";
  a.trackerProject = "";
  if (coords) {
    if (coords.base) {
      a.trackerBaseUrl = await get("tracker-url", `${coords.base} (e.g. ${coords.baseEg})`, "");
    }
    a.trackerProject = await get("tracker-project", `${coords.proj} (e.g. ${coords.projEg})`, a.key);
    if (interactive && a.trackerEnv.length) {
      say.info(`credentials come from the environment: ${c.cyan(a.trackerEnv.join(", "))}`);
      say.info(c.gray("they are never written into the config — ai-qa adds the NAMES to .env.example"));
    }
  }
  a.branch = detectBranch(root);
  a.autonomy = await getChoice("autonomy", "Autonomy (evidence rules never relax — this only moves who presses go)", AUTONOMY, "assisted");

  // ── 5. agent tools ───────────────────────────────────────────────────────────
  if (interactive) say.step(6, total, "Which agent tools to install for");
  a.tools = flags.tools
    ? String(flags.tools).split(",").map((s) => s.trim()).filter(Boolean)
    : interactive ? await askMulti("Agent tools", TOOLS, ["claude-code"]) : ["claude-code"];
  if (!a.tools.length) a.tools = ["claude-code"];
  for (const t of a.tools) {
    if (!TOOLS.includes(t)) fail("init", `unknown tool ${JSON.stringify(t)} — valid: ${TOOLS.join(", ")}`);
  }

  // ---- validate everything before anything is written ------------------------
  if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(a.key)) {
    fail("init", `ticket key must be 1-10 letters/digits starting with a letter (got ${JSON.stringify(a.key)})`);
  }
  if (!LANGUAGES.includes(a.language)) fail("init", `unsupported language ${JSON.stringify(a.language)} — valid: ${LANGUAGES.join(", ")}`);
  if (!TRACKERS.includes(a.tracker)) fail("init", `unknown tracker ${JSON.stringify(a.tracker)} — valid: ${TRACKERS.join(", ")}`);
  if (!AUTONOMY.includes(a.autonomy)) fail("init", `unknown autonomy ${JSON.stringify(a.autonomy)} — valid: ${AUTONOMY.join(", ")}`);
  if (a.url && !/^https?:\/\//.test(a.url)) fail("init", `app URL must start with http:// or https:// (got ${JSON.stringify(a.url)})`);
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string") yamlStr(v, k); // throws before any write
  }
  return a;
}

/** Which files besides the plan and the seeds an install touches: the ignore
 * rules, the credential example, and the manifest. Listed here so the summary
 * can count them instead of the count being a guess that install then
 * contradicts. Mirrors the conditions in appendRules() exactly. */
export function sideFiles(root, a) {
  const out = [];
  const envVars = a.trackerEnv || TRACKER_ENV[a.tracker] || [];
  if (envVars.length) {
    const cur = readIfExists(path.join(root, ".env.example"));
    if (envVars.some((v) => !new RegExp(`^${v}=`, "m").test(cur))) out.push(".env.example");
  }
  for (const file of [".gitignore", ".gitattributes"]) {
    if (!readIfExists(path.join(root, file)).includes("# ai-qa:")) out.push(file);
  }
  out.push(MANIFEST_REL);
  return out;
}

/** Every file this install will create or replace — the one number the summary
 * and the "written" line both come from. A count that omits the workflows (as
 * the summary used to) or the seeds (as the result line used to) is a number
 * nobody can check against the repo afterwards. */
export function plannedFiles(root, a, plan, seeds) {
  const absentSeeds = seeds.filter((s) => !fs.existsSync(path.join(root, s.rel))).map((s) => s.rel);
  return [...plan.map((p) => p.rel), ...absentSeeds, ...sideFiles(root, a)];
}

// ---- the summary the user approves --------------------------------------------
function printSummary(a, scanRes, plan, seeds, root) {
  console.log(`\n${c.bold("  About to install")}\n`);
  const row = (k, v) => console.log(`    ${c.gray(k.padEnd(14))} ${v}`);
  row("project", `${a.name} (${a.key}-nnn, works in ${a.language === "vi" ? "Tiếng Việt" : "English"})`);
  row("surfaces", a.surfaces.join(", "));
  if (a.start) row("start", a.start);
  if (a.url) row("url", a.url);
  if (a.dbUrlEnv) row("database", `read-only via $${a.dbUrlEnv}`);
  row("tracker", a.tracker + (a.trackerProject ? ` · ${a.trackerProject}` : "") +
    (a.trackerBaseUrl ? ` · ${a.trackerBaseUrl}` : ""));
  if ((a.trackerEnv || []).length) {
    const unset = a.trackerEnv.filter((v) => !process.env[v]);
    row("credentials", `$${a.trackerEnv.join(", $")}` +
      (unset.length ? c.yellow(`  (${unset.join(", ")} not set in this shell)`) : c.green("  (set)")));
  }
  row("autonomy", a.autonomy);
  row("tools", a.tools.join(", "));
  console.log(`\n${c.bold("  Files")}\n`);
  console.log(`    ${c.gray(`${plannedFiles(root, a, plan, seeds).length} files`)} — ${CONFIG_NAME}, .ai-qa/ (gates + manifest), docs/qa/ (dossier skeleton), ${a.tools.join(" + ")} workflows`);

  const unknowns = [];
  if (!a.start) unknowns.push("no start command — the lane cannot bring the app up on its own");
  if (!a.url && (a.surfaces.includes("web") || a.surfaces.includes("api"))) unknowns.push("no app URL — every browser/API case will BLOCK until one is set");
  // `gaps` holds every check scoring below full marks, so a repo with one or
  // two spec files lands here WITH its specs found. Saying "none" then would be
  // false in the one section whose whole claim is that it does not guess — and
  // it is the field that most changes what /qa is allowed to do.
  const oracleCheck = (scanRes.dimensions || [])
    .flatMap((d) => d.checks || []).find((k) => k.id === "oracle.specs");
  const foundSpecs = oracleCheck && oracleCheck.got > 0 ? String(oracleCheck.evidence || "") : "";
  if (foundSpecs) {
    unknowns.push(`oracle.specs is empty, but the repo has spec-shaped documents — ${foundSpecs}` +
      "\n  confirm which of them /qa should treat as the oracle, then list it in aiqa.config.yaml");
  } else if (scanRes.gaps.some((g) => g.id === "oracle.specs")) {
    unknowns.push("no spec documents found — /qa will refuse to invent expected values, and say so");
  }
  if (unknowns.length) {
    console.log(`\n${c.bold("  Declared unknowns")} ${c.gray("— recorded, not guessed")}\n`);
    for (const u of unknowns) {
      const [first, ...rest] = String(u).split("\n");
      console.log(`    ${c.yellow("·")} ${first}`);
      for (const line of rest) console.log(`      ${c.gray(line.trim())}`);
    }
    console.log(`\n    ${c.gray("/onboard turns each of these into a question for the team.")}`);
  }
  console.log();
}

// ---- install ------------------------------------------------------------------
/** The subset of the config the adapters render into a workflow. Built here so
 * init and update render from exactly the same shape — a divergence would make
 * `update` want to rewrite files it had just written. */
export function renderCfg(a) {
  return {
    project: { name: a.name, key: a.key, language: a.language },
    app: { url: a.url, start: a.start },
    surfaces: a.surfaces,
    tracker: { provider: a.tracker },
    autonomy: { level: a.autonomy },
    // update passes the user's edited environments through; init renders the
    // block it is about to write, so the workflows describe the same config.
    environments: a.environments || { default: "local", local: { url: "", writes: "allowed" } },
  };
}

/** Build the full file plan. Pure — nothing is written here, so the summary can
 * be accurate and a --dry-run is real.
 *
 * The rendered agent workflows are part of the plan, not a separate pass. They
 * are hash-tracked like everything else, and leaving them out is how the
 * summary came to promise a different number of files than the install wrote. */
export async function buildPlan(root, a, version, tools = a.tools || ["claude-code"]) {
  const plan = [];             // { rel, text }  — owned by ai-qa, hash-tracked
  const seeds = [];            // { rel, text }  — written once, then yours

  plan.push({ rel: CONFIG_NAME, text: renderConfig(a) });

  // gates + libraries, copied verbatim from the package
  for (const rel of walkFiles(path.join(pkgRoot, "core", "scripts"))) {
    plan.push({
      rel: path.posix.join(".ai-qa/scripts", rel.split(path.sep).join("/")),
      text: fs.readFileSync(path.join(pkgRoot, "core", "scripts", rel), "utf8"),
    });
  }
  // only the profiles for the surfaces in play
  for (const s of a.surfaces) {
    const dir = path.join(pkgRoot, "profiles", s);
    if (!fs.existsSync(dir)) continue;
    for (const rel of walkFiles(dir)) {
      plan.push({
        rel: path.posix.join(".ai-qa/profiles", s, rel.split(path.sep).join("/")),
        text: fs.readFileSync(path.join(dir, rel), "utf8"),
      });
    }
  }
  // the doctrine the lane reads at runtime
  for (const rel of walkFiles(path.join(pkgRoot, "core", "doctrine"))) {
    plan.push({
      rel: path.posix.join("docs/qa/method", rel.split(path.sep).join("/")),
      text: fs.readFileSync(path.join(pkgRoot, "core", "doctrine", rel), "utf8"),
    });
  }

  // the workflows, rendered once per agent tool
  for (const tool of tools) {
    for (const entry of await planWorkflows(tool, root, renderCfg(a))) plan.push(entry);
  }

  // documents a human owns after this moment
  for (const rel of walkFiles(path.join(pkgRoot, "core", "templates", "docs"))) {
    seeds.push({
      rel: path.posix.join("docs/qa", rel.split(path.sep).join("/")),
      text: fs.readFileSync(path.join(pkgRoot, "core", "templates", "docs", rel), "utf8"),
    });
  }

  return { plan, seeds };
}

export async function init(flags) {
  const root = gitRoot();
  if (!root) fail("init", "not a git repository — run `git init` first, then `ai-qa init`.");
  if (fs.existsSync(configPath(root))) {
    console.log(`${CONFIG_NAME} already exists — use ${c.cyan("ai-qa update")} to refresh the install.`);
    process.exit(1);
  }
  for (const f of VALUE_FLAGS) {
    if (flags[f] === true) fail("init", `--${f} requires a value (e.g. --${f} <value>)`);
  }

  const { default: pkg } = await import("../../package.json", { with: { type: "json" } });

  // The scan is not optional: it is what makes the wizard short.
  console.log(`\n  ${c.gray("reading the repo…")}`);
  const scanRes = grade(root);
  console.log(`  ${c.gray(`QA readiness today: `)}${scanRes.score >= 70 ? c.green(`${scanRes.score}/100`) : scanRes.score >= 45 ? c.yellow(`${scanRes.score}/100`) : c.red(`${scanRes.score}/100`)} ${c.gray(`(grade ${scanRes.grade}) — ai-qa scan --verbose for the detail`)}`);

  if (flags.ui) {
    const { runWizard } = await import("../ui/server.mjs");
    const answers = await runWizard(root, scanRes, flags);
    if (!answers) { console.log("  cancelled — nothing was written."); return; }
    return install(root, answers, scanRes, pkg.version, flags);
  }

  const a = await gather(root, scanRes, flags);
  const { plan, seeds } = await buildPlan(root, a, pkg.version);
  printSummary(a, scanRes, plan, seeds, root);

  if (!flags.yes && process.stdin.isTTY) {
    const go = await askYesNo("Write these files?", true);
    if (!go) { console.log("  cancelled — nothing was written."); return; }
  }
  return install(root, a, scanRes, pkg.version, flags);
}

async function install(root, a, scanRes, version, flags) {
  const { plan, seeds } = await buildPlan(root, a, version);
  const guard = new ManifestGuard(root, "init");
  const created = [];   // everything that really landed on disk, counted once

  for (const { rel, text } of plan) {
    if (guard.write(rel, text) === "written") created.push(rel);
  }
  for (const { rel, text } of seeds) {
    if (writeIfAbsent(path.join(root, rel), text)) { guard.note(rel); created.push(rel); }
  }

  // Discovery pointers merge into files a human owns, so they are applied
  // rather than planned — the workflows themselves are already in the plan.
  for (const tool of a.tools) await applyPointers(tool, root, renderCfg(a));

  created.push(...appendRules(root, guard, a.trackerEnv || TRACKER_ENV[a.tracker] || []));
  const manifestFile = guard.save(version);
  created.push(MANIFEST_REL);

  say.head("  Installed");
  say.ok(`${created.length} files written  ${c.gray(`· manifest: ${path.relative(root, manifestFile)}`)}`);
  if (guard.unchanged.length) say.info(`${guard.unchanged.length} already present with the same content`);
  if (guard.skipped.length) say.warn(`${guard.skipped.length} left alone (you had edited them)`);

  console.log(`\n${c.bold("  Next")}\n`);
  console.log(`    1. ${c.cyan("ai-qa doctor")}          ${c.gray("prove the install actually works")}`);
  console.log(`    2. ${c.cyan("/onboard")} ${c.gray("in your agent")}   ${c.gray("it walks the repo, asks what it cannot find, and")}`);
  console.log(`                             ${c.gray(`writes docs/qa/onboarding.md — the dossier a new QA reads`)}`);
  console.log(`    3. ${c.cyan(`/qa ${a.key}-1`)}              ${c.gray("verify a ticket against the spec, with evidence")}\n`);
}

/** .gitignore and .gitattributes rules — appended, never rewritten.
 * Returns the files it actually touched, so the install can report a count the
 * user can check against `git status`. */
function appendRules(root, guard, trackerEnv) {
  const touched = [];
  const IGNORE = [
    "",
    "# ai-qa: evidence text commits, binaries don't",
    "evd/**",
    "!evd/**/",
    "!evd/**/*.md",
    "!evd/**/*.json",
    "# ai-qa: journey scripts are re-runnable evidence — text, so they commit",
    "!evd/**/*.mjs",
    "# ai-qa: the .xlsx is generated from the text above in a second, and a",
    "# spreadsheet in a diff is a spreadsheet nobody can review",
    "# ai-qa: credentials live in .env — .env never commits",
    ".env",
    "# ai-qa: machine-local snapshots",
    ".ai-qa/discovery.json",
    ".ai-qa/doctor.json",
    ".ai-qa/**/__pycache__/",
  ];
  const ATTRS = [
    "",
    "# ai-qa: append-only logs — two people, zero conflicts",
    "docs/qa/lessons.md merge=union",
    "docs/qa/known-issues.md merge=union",
  ];
  // Credentials: only the NAMES, only into the example file, only if absent.
  // .env.example is committed, so a value here would be a leak by design.
  const envVars = trackerEnv || [];
  if (envVars.length) {
    const abs = path.join(root, ".env.example");
    const cur = readIfExists(abs);
    const missing = envVars.filter((v) => !new RegExp(`^${v}=`, "m").test(cur));
    if (missing.length) {
      writeFile(abs, `${cur.replace(/\s*$/, "")}\n\n# ai-qa: tracker credentials — fill these in .env (never here)\n${missing.map((v) => `${v}=`).join("\n")}\n`);
      guard.note(".env.example");
      touched.push(".env.example");
    }
  }

  for (const [file, lines, marker] of [[".gitignore", IGNORE, "# ai-qa:"], [".gitattributes", ATTRS, "# ai-qa:"]]) {
    const abs = path.join(root, file);
    const cur = readIfExists(abs);
    if (cur.includes(marker)) continue;               // already ours
    writeFile(abs, `${cur.replace(/\s*$/, "")}\n${lines.join("\n")}\n`);
    guard.note(file);
    touched.push(file);
  }
  return touched;
}
