// agents.mjs — what each agent needs from the terminal, per agent.
//
// The Agent tab opens the person's own shell and types the agent's command
// into it. That is deliberately plain. But "plain" is not the same as
// "identical": three things genuinely differ between Claude Code, Codex and
// Gemini, and treating them the same way is how a terminal opens in a state
// its agent did not expect.
//
//   1. SESSION MARKERS. An agent launched from inside another agent's session
//      inherits variables that say "you are a child process". The child then
//      behaves differently — one of them switches transcript saving off, and
//      the messaging socket and token point at the PARENT session, which is
//      not a session this terminal has anything to do with. A fresh terminal
//      must look like a fresh terminal.
//
//   2. CONFIG AND CREDENTIALS ARE NOT SESSION MARKERS. `CODEX_HOME` looks like
//      it belongs to the same family and is the opposite: it points at the
//      person's own configuration. Clearing it would break their setup to fix
//      a problem they did not have. Every profile therefore has a `keep` list
//      that wins over `clear`, and the tests assert it wins.
//
//   3. THE LANE. ai-qa installs its workflows per agent tool, and not every
//      agent has an adapter. Claude Code gets `.claude/skills/`, Codex gets
//      `.codex/prompts/` — and Gemini gets nothing, because no adapter exists.
//      The terminal will still open Gemini happily; it just will not have the
//      workflows, and saying so is cheaper than letting someone find out by
//      typing `/qa` and getting nothing.
//
// WHAT IS VERIFIED, AND WHAT IS NOT
//
// Claude Code's list was read off a live session's environment. Codex's and
// Gemini's were not — neither CLI was installed on the machine where this was
// written, and inventing variable names for them would be the same class of
// lie the gates exist to refuse. So their `clear` lists are EMPTY and
// `verified` is false, and the UI says which is which. An empty list that
// admits it is empty is worth more than a plausible one.
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} AgentProfile
 * @property {string[]} clear     env names to delete: session/nesting markers
 * @property {string[]} keep      env names that survive `clear` — config, credentials
 * @property {boolean}  verified  was `clear` read off a real session of this agent?
 * @property {string}   note      what the person should know, in one line
 * @property {string|null} lane   the ai-qa marker file this agent's workflows land at
 */

/** The marker each ai-qa adapter writes, keyed by the agent id used here.
 *  Kept in step with adapters/<tool>.mjs by a conformance test — if an adapter
 *  moves its output, this map is wrong and the test says so. */
export const LANE_MARKERS = {
  claude: ".claude/skills/qa/SKILL.md",
  codex: ".codex/prompts/qa.md",
  cursor: ".cursor/rules/aiqa-qa.mdc",
  copilot: ".github/prompts/qa.prompt.md",
};

/** @type {Record<string, AgentProfile>} */
export const PROFILES = {
  claude: {
    // Read off a live Claude Code session. The messaging socket and token are
    // the ones that matter most: inherited, they address the PARENT session.
    clear: [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_PID",
      "CLAUDE_EFFORT",
    ],
    // A telemetry preference is the person's setting, not this session's state.
    keep: ["CLAUDE_CODE_ENABLE_TELEMETRY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
    verified: true,
    note: "opens your own Claude Code session; the lane's /onboard, /qa, /triage and /regress are installed as skills",
    lane: LANE_MARKERS.claude,
  },

  codex: {
    // Not verified: Codex was not installed on the machine where this was
    // written, so no session markers are claimed. If a nested Codex misbehaves,
    // the variable that caused it belongs in this list — say which and it goes in.
    clear: [],
    // CODEX_HOME points at the person's own config directory. It is not a
    // session marker and must survive.
    keep: ["CODEX_HOME", "OPENAI_API_KEY"],
    verified: false,
    note: "opens Codex; the lane is installed as prompts in .codex/prompts/",
    lane: LANE_MARKERS.codex,
  },

  gemini: {
    clear: [],
    keep: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_HOME"],
    verified: false,
    note: "opens Gemini — but ai-qa has no adapter for it, so the lane's workflows are NOT installed for this agent",
    lane: null,
  },

  cursor: {
    clear: [], keep: ["CURSOR_API_KEY"], verified: false,
    note: "opens the Cursor CLI; the lane is installed as rules in .cursor/rules/",
    lane: LANE_MARKERS.cursor,
  },
  copilot: {
    clear: [], keep: ["GITHUB_TOKEN", "GH_TOKEN"], verified: false,
    note: "opens the Copilot CLI; the lane is installed as prompts in .github/prompts/",
    lane: LANE_MARKERS.copilot,
  },
};

/** Everything else: opened, nothing claimed about it. */
export const DEFAULT_PROFILE = {
  clear: [], keep: [], verified: false,
  note: "opened as you would open it yourself; ai-qa has no adapter for this agent, so the lane's workflows are not installed for it",
  lane: null,
};

export function profileFor(agentId) {
  return PROFILES[String(agentId || "")] || DEFAULT_PROFILE;
}

/**
 * The environment a fresh terminal for `agentId` should start with.
 *
 * `keep` wins over `clear` — a name in both survives. That ordering is the
 * whole point of having two lists: it lets a profile clear a prefix-shaped
 * family while protecting the one member that is configuration.
 *
 * @returns {{env: Object, cleared: string[]}} cleared is what was actually
 *   removed (present AND in clear AND not kept), so the UI can report it
 *   rather than claim it.
 */
export function terminalEnv(agentId, base = process.env, extra = {}) {
  const p = profileFor(agentId);
  const keep = new Set(p.keep);
  const env = { ...base, ...extra };
  const cleared = [];
  for (const name of p.clear) {
    if (keep.has(name)) continue;
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      delete env[name];
      cleared.push(name);
    }
  }
  return { env, cleared };
}

/**
 * Is the lane actually installed for this agent, in this checkout?
 *
 * Three answers, and they are different problems with different fixes:
 *   none      ai-qa has no adapter for this agent — nothing to install
 *   missing   there is an adapter, but this project was not initialised for it
 *   present   the marker file is there
 */
export function laneStatus(agentId, projectRoot) {
  const p = profileFor(agentId);
  if (!p.lane) {
    return { state: "none", marker: null,
      text: "ai-qa has no adapter for this agent — the terminal opens it, but the lane's workflows are not installed for it" };
  }
  const abs = path.join(String(projectRoot || ""), p.lane);
  let present = false;
  try { present = fs.statSync(abs).isFile(); } catch { present = false; }
  return present
    ? { state: "present", marker: p.lane, text: `the lane's workflows are installed for this agent (${p.lane})` }
    : { state: "missing", marker: p.lane,
        text: `the lane is not installed for this agent in this project — run \`ai-qa init\` (or \`ai-qa update\`) with this tool selected; expected ${p.lane}` };
}

/** One line for the status bar: what was done to the environment, honestly. */
export function hygieneText(agentId, cleared) {
  const p = profileFor(agentId);
  if (cleared.length) {
    return `a fresh session: cleared ${cleared.length} inherited marker${cleared.length > 1 ? "s" : ""} (${cleared.join(", ")})`;
  }
  if (p.clear.length) return "nothing inherited to clear — this shell was not started from inside that agent";
  return p.verified
    ? "no session markers to clear for this agent"
    : "session markers for this agent are not documented here — if a nested run misbehaves, name the variable and it goes in the profile";
}
