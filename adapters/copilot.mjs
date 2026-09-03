// GitHub Copilot: prompt files are discovered at .github/prompts/<name>.prompt.md
// and repo-wide conventions at .github/copilot-instructions.md.
import fs from "node:fs";
import path from "node:path";

export const id = "copilot";
export const marker = ".github/prompts/qa.prompt.md";

export function render(wf, ctx) {
  const front = [
    "---",
    "mode: agent",
    `description: ${JSON.stringify(wf.description)}`,
    "---",
    "",
  ].join("\n");
  return { path: `.github/prompts/${wf.name}.prompt.md`, text: front + ctx.noSubagentNote + wf.body };
}

const SECTION_START = "<!-- ai-qa:start -->";
const SECTION_END = "<!-- ai-qa:end -->";

export function pointers(root) {
  const file = path.join(root, ".github", "copilot-instructions.md");
  const section = [
    SECTION_START,
    "## QA lane (ai-qa)",
    "",
    "`docs/qa/onboarding.md` is the dossier a new QA reads first; `aiqa.config.yaml`",
    "holds the coordinates. Prompts: `/onboard`, `/qa`, `/triage`, `/regress`.",
    "",
    "The spec is the oracle — not the ticket prose, not the code. A verdict needs a",
    "run that actually happened. The QA lane never changes product code.",
    SECTION_END,
  ].join("\n");

  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  const next = text.includes(SECTION_START)
    ? text.replace(new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}`), section)
    : `${text.replace(/\s*$/, "")}\n\n${section}\n`.replace(/^\n+/, "");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return [".github/copilot-instructions.md"];
}
