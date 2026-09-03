// Codex: custom prompts are discovered at .codex/prompts/<name>.md and invoked
// as /<name>. AGENTS.md is where Codex looks for repo conventions, so that is
// where the pointer goes.
import fs from "node:fs";
import path from "node:path";

export const id = "codex";
export const marker = ".codex/prompts/qa.md";

export function render(wf, ctx) {
  const head = `# /${wf.name}${wf.args ? ` — ${wf.args}` : ""}\n\n${wf.description}\n\n`;
  return { path: `.codex/prompts/${wf.name}.md`, text: head + ctx.noSubagentNote + wf.body };
}

const SECTION_START = "<!-- ai-qa:start -->";
const SECTION_END = "<!-- ai-qa:end -->";

export function pointers(root) {
  const file = path.join(root, "AGENTS.md");
  const section = [
    SECTION_START,
    "## QA lane (ai-qa)",
    "",
    "Before verifying anything in this repo, read `aiqa.config.yaml` and",
    "`docs/qa/onboarding.md` — the second one is what a new QA reads to find out",
    "what this project is and what counts as correct.",
    "",
    "| Prompt | Use it when |",
    "|---|---|",
    "| `/onboard` | You are new here, or the dossier is stale. It works out what it can and ASKS for the rest. |",
    "| `/qa` | A ticket is claimed done and needs verifying against the spec, with evidence. |",
    "| `/triage` | A bug report arrived and needs reproducing, isolating, and filing properly. |",
    "| `/regress` | The regression suite needs building or refreshing from what has actually broken. |",
    "",
    "Rules that do not bend: the spec is the oracle, never the ticket prose and",
    "never the code. Nothing is verified without a run that actually happened.",
    "No product code is ever changed by the QA lane.",
    SECTION_END,
  ].join("\n");

  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  const next = text.includes(SECTION_START)
    ? text.replace(new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}`), section)
    : `${text.replace(/\s*$/, "")}\n\n${section}\n`.replace(/^\n+/, "");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return ["AGENTS.md"];
}
