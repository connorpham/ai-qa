// adapters.mjs — one workflow, five agent tools.
//
// The workflows in core/workflows/ are tool-NEUTRAL. An adapter is a thin
// renderer that turns each one into the file format its tool natively
// discovers, and it may add exactly three things: frontmatter, a preamble, and
// discovery pointers. It never edits a workflow's semantics. A rule that needs
// tool-specific behaviour belongs in core behind a capability switch, not in an
// adapter fork — otherwise five copies of the QA method drift apart and the
// verdicts stop meaning the same thing.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pkgRoot, render, parseFrontmatter, writeFile } from "./util.mjs";

export const TOOLS = ["claude-code", "cursor", "windsurf", "codex", "copilot"];

/** Tools that cannot spawn a subagent still owe the same challenger pass —
 * they just run it as a fresh chat. The requirement does not soften. */
const NO_SUBAGENT_NOTE = `> **Adapter note — this tool cannot spawn subagents.** Where the workflow says
> "spawn a fresh challenger", open a NEW conversation with only the brief's file
> paths, run the pass there, and paste the returned card into the dossier. The
> card is still required; a challenger you skipped is a verdict nobody checked.

`;

async function loadAdapter(tool) {
  if (!TOOLS.includes(tool)) throw new Error(`unknown tool ${tool}`);
  // file:// URL, not a bare path — a plain C:\… specifier crashes Node's ESM
  // loader on Windows.
  return import(pathToFileURL(path.join(pkgRoot, "adapters", `${tool}.mjs`)).href);
}

export async function adapterMarker(tool) {
  return (await loadAdapter(tool)).marker;
}

/** The Environment block: the app's resolved coordinates and the ONE mechanism
 * for each active surface, so "run it headed" names commands instead of a vibe.
 * Built in JS rather than as a template group on purpose — an unconfigured
 * `app:` must render the "not configured" BRANCH, never a literal `{app.url}`. */
function envBlock(cfg) {
  const app = (cfg && typeof cfg.app === "object") ? cfg.app : {};
  const start = String(app.start ?? "").trim();
  const url = String(app.url ?? "").trim();
  const surfaces = Array.isArray(cfg?.surfaces) ? cfg.surfaces : ["web"];
  const out = [];

  if (!start && !url) {
    out.push(
      "> **Environment: NOT CONFIGURED.** `app.start` and `app.url` are both empty in",
      "> aiqa.config.yaml, so `app_check.sh` prints `APP: SKIP` and every test case that",
      "> needs a running app is **BLOCKED, not skipped** — you report the blocker and the",
      "> unblock path, you do not quietly verify less. Ask the owner for the start command",
      "> and URL, then set them in aiqa.config.yaml.",
    );
  } else {
    out.push(
      `> **Environment** — start: \`${start || "<unset>"}\` · url: ${url || "<unset>"}`,
      "> - **Bring-up:** run `app.start` in a BACKGROUND terminal. A gate never starts a",
      ">   server; it probes one. Then `bash .ai-qa/scripts/app_check.sh --wait 60` and",
      ">   QUOTE its `APP: UP` line into the verify sheet — that line IS your bring-up proof.",
      ">   `APP: DOWN` is a BLOCKED run with the printed unblock path, never a guess.",
    );
  }

  // The named environments, when the config declares them. Rendered from the
  // same config the gates read, so the workflow and the tools name the same
  // coordinates.
  const envs = (cfg && typeof cfg.environments === "object") ? cfg.environments : null;
  const envNames = envs
    ? Object.keys(envs).filter((k) => k !== "default" && envs[k] && typeof envs[k] === "object")
    : [];
  if (envNames.length) {
    const def = String(envs.default ?? "").trim();
    const listed = envNames.map((n) => {
      const u = String(envs[n].url ?? "").trim();
      const w = String(envs[n].writes ?? "").trim()
        || (/^prod(uction)?$/i.test(n) ? "forbidden" : "allowed");
      return `\`${n}\`${n === def ? " (default)" : ""} — ${u || "app.url"} · writes ${w}`;
    }).join(" · ");
    out.push(
      `> - **Environments:** ${listed}. Resolve ONE name before bring-up — the \`env=\``,
      ">   argument, else `$AIQA_ENV`, else the default — and export `AIQA_ENV=<name>` so",
      ">   every gate on every surface reads the same coordinates. The report's",
      ">   `ENVIRONMENT: <name — url>` line records it, and the evidence gate refuses a",
      ">   report without one. A name the config does not declare is a BLOCKED run — never",
      ">   a silent fall-back to localhost. On `writes: forbidden` (the default when the",
      ">   environment is named prod) no test data is created and any case that would",
      ">   change state is BLOCKED, not attempted; read-only journeys still run.",
    );
  }

  if (surfaces.includes("web")) {
    out.push(
      "> - **Web = a real browser window someone could watch.** Drive journeys with",
      ">   `launch`/`shot`/`click`/`typeIn` from `.ai-qa/scripts/browser.mjs`",
      ">   (Playwright, headed Chrome). It runs at `app.pace` — a beat between actions,",
      ">   key-by-key typing, and a settle before each shutter — so the run is one a",
      ">   human could actually follow. `AIQA_PACE=demo` slows it further for an audience.",
      ">   Preflight once: `node .ai-qa/scripts/browser.mjs check` — a missing Playwright",
      ">   is a loud BLOCKED with the install command, never a silent headless run.",
    );
  }
  if (surfaces.includes("api")) {
    out.push(
      "> - **API:** `node .ai-qa/scripts/api_check.mjs <method> <path> [--body f.json]`",
      ">   records the real request and the real response as an evidence pair. A status",
      ">   code is not a verdict: the BODY is checked against the contract.",
    );
  }
  if (surfaces.includes("database")) {
    out.push(
      "> - **Database: READ-ONLY.** `python3 .ai-qa/scripts/db_verify.py --sql <file>` runs",
      ">   SELECTs to confirm what the UI/API claims it wrote. Writing test data through",
      ">   SQL is forbidden — data is created the way a user creates it, or the case BLOCKS.",
    );
  }
  if (surfaces.includes("mobile")) {
    out.push(
      "> - **Mobile:** the device or emulator must be up before the run;",
      ">   `bash .ai-qa/scripts/device_check.sh` proves it and prints the unblock path.",
      ">   Screenshots come off the device, never from a simulator screenshot of a mock.",
    );
  }
  return `${out.join("\n")}\n\n`;
}

/** Every workflow gets the same header stating the tool's own limits, so the
 * agent never has to infer what it is allowed to do. */
function surfaceBlock(cfg) {
  const surfaces = Array.isArray(cfg?.surfaces) ? cfg.surfaces : ["web"];
  return `> **Active surfaces:** ${surfaces.join(" · ")} — a test case outside these has no gate\n` +
    `> behind it; say so rather than pretending it was verified.\n\n`;
}

/** The working-language block, on every workflow. The lane does not only WRITE
 * its report in the project's language — it WORKS in it: narration, questions,
 * summaries, the dossier, ticket comments. The machine-read contract stays in
 * English, and the list of what that covers lives here, once, so no workflow
 * re-decides it and no gate goes hunting for a translated key. */
function langBlock(cfg) {
  const lang = String(cfg?.project?.language ?? "en").trim() || "en";
  const name = lang === "vi" ? "Tiếng Việt" : "English";
  const out = [
    `> **Working language: ${name}** (\`project.language: ${lang}\`). Everything a person`,
    "> reads or is asked is written in it — the `▶` phase narration, questions to the",
    "> team, chat summaries, the report, bug reports, the dossier, ticket comments.",
    "> Write naturally in that language from the start; never draft in English and",
    "> translate word by word. What stays in English is the machine-read contract,",
    "> exactly as the gates expect it: field keys (`RESULT:`, `EXPECTED:` …), report",
    "> header keys (`COMMIT:` / `VERIFIED-AT:` / `ENVIRONMENT:` / `ORACLE:`), the verdict",
    "> word (PASS/FAIL/PARTIAL/NEW-BUG/BLOCKED/UNCLEAR), severity (Blocker/Critical/",
    "> Major/Minor), ORIGIN (DEV/SPEC), KIND values, `TC_<n>_snake_case` folder names,",
    "> and gate lines (`APP: UP`, `API: BLOCKED`, `DB: OK`). Field VALUES are in the",
    "> working language, and a screen label is quoted exactly as the product displays",
    "> it — the localised text on the button, not its translation.",
  ];
  if (lang === "vi") {
    out.push(
      "> Ví dụ một dòng đúng chuẩn — khoá tiếng Anh, giá trị tiếng Việt, nhãn màn hình",
      '> nguyên văn: `EXPECTED: "Tổng cộng" hiển thị 450.000 ₫ (spec §3.2)`.',
    );
  }
  return `${out.join("\n")}\n\n`;
}

/** Surface-conditional blocks:
 *
 *   <!-- surface:api,mobile -->  …only rendered when one is active…  <!-- /surface -->
 *
 * A web-only install should not be told to run the database tooling. Beyond
 * noise, an instruction for a surface nobody declared invites a case that no
 * gate is watching — and the workflow already promises the opposite. */
export function filterSurfaces(body, surfaces) {
  return body.replace(
    /[ \t]*<!-- surface:([a-z,\s]+) -->\r?\n([\s\S]*?)[ \t]*<!-- \/surface -->\r?\n?/g,
    (_whole, list, inner) =>
      list.split(",").map((s) => s.trim()).some((s) => surfaces.includes(s)) ? inner : "");
}

function workflows() {
  const dir = path.join(pkgRoot, "core", "workflows");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), "utf8"));
    return { meta, body };
  });
}

/** Render every workflow for one tool WITHOUT writing anything, as
 * `{ rel, text }` entries. Pure by design: init and update fold these into the
 * same file plan as the gates, so the count they promise is the count they
 * write, and a `--dry-run` can preview them without touching the disk. */
export async function planWorkflows(tool, root, cfg) {
  const adapter = await loadAdapter(tool);
  const ctx = { root, cfg, noSubagentNote: NO_SUBAGENT_NOTE };
  const out = [];
  for (const raw of workflows()) {
    const name = raw.meta.name;
    const needsEnv = name === "qa" || name === "regress" || name === "triage";
    const wf = {
      name,
      description: render(raw.meta.description || "", cfg),
      args: render(raw.meta["argument-hint"] || "", cfg),
      body: surfaceBlock(cfg) + langBlock(cfg) + (needsEnv ? envBlock(cfg) : "") +
            filterSurfaces(render(raw.body, cfg), Array.isArray(cfg?.surfaces) ? cfg.surfaces : ["web"]),
    };
    const rendered = adapter.render(wf, ctx);
    out.push({ name, rel: rendered.path, text: rendered.text });
  }
  return out;
}

/** Discovery pointers — they MERGE into files a human also owns (AGENTS.md and
 * friends), so they are applied separately from the planned files and skipped
 * entirely on a dry run rather than trusted to behave. */
export async function applyPointers(tool, root, cfg) {
  const adapter = await loadAdapter(tool);
  if (!adapter.pointers) return [];
  return adapter.pointers(root, cfg) || [];
}

/** Render every workflow for one tool into the target repo. `write(rel, text)`
 * lets init/update route output through the manifest guard. */
export async function renderTool(tool, root, cfg, write = (rel, text) => writeFile(path.join(root, rel), text), opts = {}) {
  const written = [];
  // onWorkflow fires immediately before that workflow's write, so a caller can
  // key the output by workflow name — conformance relies on the interleaving.
  for (const { name, rel, text } of await planWorkflows(tool, root, cfg)) {
    if (opts.onWorkflow) opts.onWorkflow(name);
    write(rel, text);
    written.push(rel);
  }
  if (!opts.dryRun) written.push(...await applyPointers(tool, root, cfg));
  return written;
}
