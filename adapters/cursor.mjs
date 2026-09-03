// Cursor: rules live at .cursor/rules/*.mdc. They are not slash commands, so
// each file states its own trigger sentence in the description — that is what
// Cursor matches on.
export const id = "cursor";
export const marker = ".cursor/rules/aiqa-qa.mdc";

export function render(wf, ctx) {
  const front = [
    "---",
    `description: ${JSON.stringify(wf.description)}`,
    "globs:",
    "alwaysApply: false",
    "---",
    "",
    `# /${wf.name}${wf.args ? ` ${wf.args}` : ""}`,
    "",
  ].join("\n");
  return { path: `.cursor/rules/aiqa-${wf.name}.mdc`, text: front + ctx.noSubagentNote + wf.body };
}
