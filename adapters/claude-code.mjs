// Claude Code: skills are discovered at .claude/skills/<name>/SKILL.md and
// invoked as /<name>. It can spawn subagents, so the challenger pass runs for
// real rather than as a fresh chat.
export const id = "claude-code";
export const marker = ".claude/skills/qa/SKILL.md";

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
