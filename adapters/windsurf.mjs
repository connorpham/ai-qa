// Windsurf: workflows live at .windsurf/workflows/<name>.md and are invoked as
// /<name>.
export const id = "windsurf";
export const marker = ".windsurf/workflows/qa.md";

export function render(wf, ctx) {
  const front = [
    "---",
    `description: ${JSON.stringify(wf.description)}`,
    "---",
    "",
  ].join("\n");
  return { path: `.windsurf/workflows/${wf.name}.md`, text: front + ctx.noSubagentNote + wf.body };
}
