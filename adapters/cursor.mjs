// Cursor: rules live at .cursor/rules/*.mdc. They are not slash commands, so
// each file states its own trigger sentence in the description — that is what
// Cursor matches on.
//
// Semantic matching is the whole problem. A workflow rule loads only when the
// user's wording happens to resemble its description, so a short prompt — "check
// SHOP-142" — loads nothing and the agent improvises. One small rule with
// alwaysApply: true fixes that: it is in context every turn, and it names the
// others. The big workflow rules stay match-on-demand, because four workflows in
// every context window is how the real instruction gets buried.
import path from "node:path";
import { pointerSection, mergeSection } from "../src/cli/pointer.mjs";

export const id = "cursor";
export const marker = ".cursor/rules/aiqa-qa.mdc";
// Where the pointer lands. Declared, not just written, so the installer can
// promise the file count before it touches anything.
export const pointerTarget = path.posix.join(".cursor", "rules", "aiqa-always.mdc");

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

export function pointers(root, cfg) {
  const head = [
    "---",
    'description: "The QA lane: how this repo verifies anything, and the rules that do not bend."',
    "globs:",
    "alwaysApply: true",
    "---",
    "",
  ].join("\n");
  mergeSection(path.join(root, ".cursor", "rules", "aiqa-always.mdc"), pointerSection(cfg), head);
  return [pointerTarget];
}
