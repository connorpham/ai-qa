// pointer.mjs — the paragraph every agent tool reads before it is asked anything.
//
// A workflow only fires when someone types its name. The most common way this
// lane gets bypassed is not defiance, it is ignorance: a user types "test ticket
// SHOP-142", the agent has never heard of `/qa`, and it improvises — reads the
// code, decides the code looks right, and reports a PASS nobody can check.
//
// So every tool gets the same short section merged into the file IT reads for
// repo-wide conventions. One text, five destinations: five agents that disagree
// about the rules are worse than one agent with no rules, because the
// disagreement is invisible until two verdicts contradict each other.
import fs from "node:fs";
import path from "node:path";

export const SECTION_START = "<!-- ai-qa:start -->";
export const SECTION_END = "<!-- ai-qa:end -->";

/** The declared oracle, named concretely, because "the spec" is not an
 * instruction — `docs/specs/` is. */
function oracleLine(cfg) {
  const specs = [].concat((cfg && cfg.oracle && cfg.oracle.specs) || []).filter(Boolean);
  return specs.length
    ? `\`${specs.join("`, `")}\``
    : "**nothing is declared yet** (`oracle.specs` is empty) — say so, and BLOCK rather than guess";
}

/**
 * The shared section. Short on purpose: a pointer that runs to three pages is a
 * pointer nobody reads, and the workflows carry the detail.
 */
export function pointerSection(cfg) {
  return [
    SECTION_START,
    "## QA lane (ai-qa)",
    "",
    "This repo has a QA lane. It governs **any** request to test, verify, check,",
    "reproduce or sign off on something — whether or not a slash command is typed.",
    "",
    "| When the ask is | Run |",
    "|---|---|",
    "| verify a ticket that is claimed done | `/qa <TICKET>` |",
    "| what is this project, where do I start | `/onboard` |",
    "| a bug report needs reproducing | `/triage` |",
    "| build or refresh the regression suite | `/regress` |",
    "",
    "**Six rules. None of them bend.**",
    "",
    `1. **The spec is the oracle** — ${oracleLine(cfg)}. Not the ticket prose,`,
    "   not the code. Every expected value cites the document and section it was",
    "   read out of (`REQUIREMENT: docs/specs/orders.md 3.2 R1`). Nothing written",
    "   about it → the case is **BLOCKED**. You never invent an expected value.",
    "2. **A verdict needs a run that happened**, this session, against the running",
    "   product. Not an HTTP status, not reading the code, not a previous run, not",
    "   the developer's demo. A step you could not run is BLOCKED, with the reason.",
    "3. **Checklists are mandatory** — if `docs/qa/checklists.md` exists, you MUST audit",
    "   every applicable item in `index.md` (`CHECKLIST:`). Silently ignoring checklist",
    "   items fails the gate.",
    "4. **UI Fidelity requires measured numbers** — measure computed styles and WCAG AA",
    "   criteria (contrast >= 4.5:1, target size >= 24x24px) with real DOM values.",
    "5. **Evidence or it did not happen.** Everything lands in `evd/<TICKET>/`, and",
    "   it is not a verdict until this exits 0 — run it, and paste what it printed:",
    "",
    "   ```bash",
    "   python3 .ai-qa/scripts/evd_check.py --evd evd/<TICKET> --expect-tcs <N>",
    "   ```",
    "",
    "   A green you did not run is a lie with a tick next to it.",
    "6. **The QA lane never changes product code.** It reports defects; it does not",
    "   fix them.",
    "",
    "Start at `aiqa.config.yaml` and `docs/qa/onboarding.md`.",
    SECTION_END,
  ].join("\n");
}

/**
 * Merge the section into a file a human may also own.
 *
 * Replaces the marked block if it is there, appends if it is not, and never
 * touches a line outside the markers — these files carry the team's own
 * instructions, and a tool that overwrites them is a tool that gets uninstalled.
 *
 * `head` is written only when the file does not exist yet, for a tool that
 * needs frontmatter to load the file at all.
 */
export function mergeSection(file, section, head = "") {
  let text = "";
  let existed = true;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    existed = false;
  }
  const next = text.includes(SECTION_START)
    ? text.replace(new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}`), () => section)
    : `${(existed ? text : head).replace(/\s*$/, "")}\n\n${section}\n`.replace(/^\n+/, "");
  // Unchanged means untouched. These are files a human owns; rewriting one with
  // its own bytes on every update makes ai-qa show up in their git status for
  // nothing, and a tool that does that gets uninstalled.
  if (next === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}
