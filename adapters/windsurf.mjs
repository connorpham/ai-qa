// Windsurf: workflows live at .windsurf/workflows/<name>.md and are invoked as
// /<name>. Repo-wide conventions are read from .windsurfrules, so that is where
// the pointer goes — a workflow nobody invokes governs nothing.
import path from "node:path";
import { pointerSection, mergeSection } from "../src/cli/pointer.mjs";

export const id = "windsurf";
export const marker = ".windsurf/workflows/qa.md";
// Where the pointer lands. Declared, not just written, so the installer can
// promise the file count before it touches anything.
export const pointerTarget = ".windsurfrules";

export function render(wf, ctx) {
  const front = [
    "---",
    `description: ${JSON.stringify(wf.description)}`,
    "---",
    "",
  ].join("\n");
  return { path: `.windsurf/workflows/${wf.name}.md`, text: front + ctx.noSubagentNote + wf.body };
}

export function pointers(root, cfg) {
  mergeSection(path.join(root, pointerTarget), pointerSection(cfg));
  return [pointerTarget];
}
