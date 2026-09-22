// Claude Code: skills are discovered at .claude/skills/<name>/SKILL.md and
// invoked as /<name>. It can spawn subagents, so the challenger pass runs for
// real rather than as a fresh chat.
//
// The skill only loads when someone types /qa. CLAUDE.md is read every session,
// which is why the pointer goes there: it is what stands between "test this
// ticket" and an agent improvising a verdict out of the source code.
import path from "node:path";
import { pointerSection, mergeSection } from "../src/cli/pointer.mjs";

export const id = "claude-code";
export const marker = ".claude/skills/qa/SKILL.md";
// Where the pointer lands. Declared, not just written, so the installer can
// promise the file count before it touches anything.
export const pointerTarget = "CLAUDE.md";

export function render(wf) {
  const front = [
    "---",
    `name: ${wf.name}`,
    `description: ${JSON.stringify(wf.description)}`,
    wf.args ? `argument-hint: ${JSON.stringify(wf.args)}` : "",
    "---",
    "",
  ].filter(Boolean).join("\n");
  return { path: `.claude/skills/${wf.name}/SKILL.md`, text: front + wf.body };
}

export function pointers(root, cfg) {
  mergeSection(path.join(root, pointerTarget), pointerSection(cfg));
  return [pointerTarget];
}
