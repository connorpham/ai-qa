// GitHub Copilot: prompt files are discovered at .github/prompts/<name>.prompt.md
// and repo-wide conventions at .github/copilot-instructions.md.
import path from "node:path";
import { pointerSection, mergeSection } from "../src/cli/pointer.mjs";

export const id = "copilot";
export const marker = ".github/prompts/qa.prompt.md";
// Where the pointer lands. Declared, not just written, so the installer can
// promise the file count before it touches anything.
export const pointerTarget = path.posix.join(".github", "copilot-instructions.md");

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

export function pointers(root, cfg) {
  mergeSection(path.join(root, ".github", "copilot-instructions.md"), pointerSection(cfg));
  return [pointerTarget];
}
