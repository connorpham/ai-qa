// Codex: custom prompts are discovered at .codex/prompts/<name>.md and invoked
// as /<name>. AGENTS.md is where Codex looks for repo conventions, so that is
// where the pointer goes.
import path from "node:path";
import { pointerSection, mergeSection } from "../src/cli/pointer.mjs";

export const id = "codex";
export const marker = ".codex/prompts/qa.md";
// Where the pointer lands. Declared, not just written, so the installer can
// promise the file count before it touches anything.
export const pointerTarget = "AGENTS.md";

export function render(wf, ctx) {
  const head = `# /${wf.name}${wf.args ? ` — ${wf.args}` : ""}\n\n${wf.description}\n\n`;
  return { path: `.codex/prompts/${wf.name}.md`, text: head + ctx.noSubagentNote + wf.body };
}

export function pointers(root, cfg) {
  mergeSection(path.join(root, pointerTarget), pointerSection(cfg));
  return [pointerTarget];
}
