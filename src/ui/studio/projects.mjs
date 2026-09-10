// projects.mjs — the studio works across projects, not just the folder it was
// started in, and each project chooses its own agent.
//
// The shape follows Orca's, because Orca solved this first and its vocabulary
// is the one the user already has: a PROJECT is a git repository you register
// once; a WORKTREE is an isolated checkout of it you work in; an AGENT is a
// coding-agent CLI, discovered by looking for its command on PATH.
//
// The registry lives in ~/.ai-qa/studio.json — outside any repository, because
// it is a fact about this machine, not about a codebase. It holds paths and
// choices only: never a token, never a credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const REGISTRY_DIR = path.join(os.homedir(), ".ai-qa");
export const REGISTRY_FILE = path.join(REGISTRY_DIR, "studio.json");

/** The agent CLIs the studio knows about, with the command that proves each one
 *  is installed. The list and the detect commands are Orca's (src/shared/
 *  tui-agent-config.ts) so a machine set up for Orca reports the same agents
 *  here — but `drive` is ours, and it is the honest part:
 *
 *    "stream"  the studio can run it non-interactively and read its output
 *    "custom"  detected, but the studio has no adapter: usable only if you
 *              give the exact command yourself in the project's settings
 *
 *  Claiming to drive an agent whose flags we have not implemented would be the
 *  same class of lie the gates exist to refuse, so the UI shows this column. */
export const AGENTS = [
  { id: "claude", label: "Claude Code", cmd: "claude", drive: "stream",
    note: "run with --print --output-format stream-json; uses the skills ai-qa installed in the project" },
  { id: "codex", label: "OpenAI Codex", cmd: "codex", drive: "custom", note: "e.g. codex exec {prompt}" },
  { id: "cursor", label: "Cursor CLI", cmd: "cursor-agent", drive: "custom" },
  { id: "copilot", label: "GitHub Copilot CLI", cmd: "copilot", drive: "custom" },
  { id: "gemini", label: "Gemini CLI", cmd: "gemini", drive: "custom", note: "e.g. gemini -p {prompt}" },
  { id: "opencode", label: "OpenCode", cmd: "opencode", drive: "custom" },
  { id: "aider", label: "Aider", cmd: "aider", drive: "custom" },
  { id: "amp", label: "Amp", cmd: "amp", drive: "custom" },
  { id: "grok", label: "xAI Grok CLI", cmd: "grok", drive: "custom" },
  { id: "droid", label: "Factory Droid", cmd: "droid", drive: "custom" },
  { id: "goose", label: "Goose", cmd: "goose", drive: "custom" },
  { id: "crush", label: "Charm Crush", cmd: "crush", drive: "custom" },
  { id: "qwen-code", label: "Qwen Code", cmd: "qwen", drive: "custom" },
  { id: "kimi", label: "Kimi", cmd: "kimi", drive: "custom" },
  { id: "anthropic", label: "Anthropic API", cmd: null, drive: "stream",
    note: "no CLI — needs ANTHROPIC_API_KEY; the method is inlined because there are no skills to load" },
];

function which(cmd) {
  if (!cmd) return null;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return null;
  return String(r.stdout).split("\n")[0].trim() || null;
}

let detectCache = null;
/** Which agents exist on this machine. Cached for a minute: `which` is cheap
 *  but the settings dialog asks on every open. */
export function detectAgents({ fresh = false } = {}) {
  if (!fresh && detectCache && Date.now() - detectCache.at < 60_000) return detectCache.list;
  const list = AGENTS.map((a) => {
    if (a.id === "anthropic") {
      return { ...a, installed: !!process.env.ANTHROPIC_API_KEY, where: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY is set" : null };
    }
    const where = which(a.cmd);
    return { ...a, installed: !!where, where };
  });
  detectCache = { at: Date.now(), list };
  return list;
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------
const BLANK = { version: 1, projects: [], activeProjectId: null };

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    return {
      version: 1,
      projects: Array.isArray(raw.projects) ? raw.projects.filter((p) => p && p.id && p.path) : [],
      activeProjectId: raw.activeProjectId || null,
    };
  } catch {
    return { ...BLANK, projects: [] };
  }
}

export function save(reg) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
  return REGISTRY_FILE;
}

/** What a path IS, before we let anyone register it. Each answer is a fact the
 *  UI shows rather than a guess it acts on: a folder that is not a repository,
 *  or a repository with no lane installed, is reported with the exact command
 *  that would fix it. The studio never runs `init` on its own — that writes 30
 *  files into someone's project. */
export function inspect(abs) {
  const out = { path: abs, exists: false, isDir: false, isRepo: false, hasLane: false, name: path.basename(abs), branch: null, defaultBranch: null };
  try {
    const st = fs.statSync(abs);
    out.exists = true;
    out.isDir = st.isDirectory();
  } catch { return out; }
  if (!out.isDir) return out;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: abs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (top.status === 0) {
    out.isRepo = true;
    out.root = String(top.stdout).trim();
    out.name = path.basename(out.root);
    const br = spawnSync("git", ["branch", "--show-current"], { cwd: abs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    out.branch = br.status === 0 ? String(br.stdout).trim() : null;
    const def = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: abs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    out.defaultBranch = def.status === 0 ? String(def.stdout).trim().replace(/^origin\//, "") : null;
  }
  out.hasLane = fs.existsSync(path.join(out.root || abs, "aiqa.config.yaml"));
  return out;
}

export function add(reg, rawPath, { agent = null } = {}) {
  const abs = path.resolve(String(rawPath || "").replace(/^~(?=$|\/)/, os.homedir()));
  const info = inspect(abs);
  if (!info.exists) throw new Error(`no such folder: ${abs}`);
  if (!info.isDir) throw new Error(`not a folder: ${abs}`);
  if (!info.isRepo) throw new Error(`not a git repository: ${abs} — run \`git init\` there first`);
  const root = info.root;
  const already = reg.projects.find((p) => p.path === root);
  if (already) { reg.activeProjectId = already.id; return { project: already, info, added: false }; }
  const project = {
    id: crypto.randomBytes(6).toString("hex"),
    path: root,
    name: info.name,
    agent: agent || null,          // null = ask, or fall back to the first drivable one
    model: null,
    customCommand: null,           // for agents the studio has no adapter for
    addedAt: new Date().toISOString(),
  };
  reg.projects.push(project);
  reg.activeProjectId = project.id;
  return { project, info, added: true };
}

export function remove(reg, id) {
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.id !== id);
  if (reg.activeProjectId === id) reg.activeProjectId = reg.projects[0]?.id || null;
  return before !== reg.projects.length;
}

export function active(reg) {
  return reg.projects.find((p) => p.id === reg.activeProjectId) || reg.projects[0] || null;
}

export function update(reg, id, patch) {
  const p = reg.projects.find((x) => x.id === id);
  if (!p) return null;
  for (const k of ["name", "agent", "model", "customCommand"]) {
    if (k in patch) p[k] = patch[k] === "" ? null : patch[k];
  }
  return p;
}

/** The agent a project will actually use, and whether that is a real choice or
 *  a fallback. Said out loud so nobody discovers later that "the project's
 *  agent" was whatever happened to be installed. */
export function resolveAgent(project, detected = detectAgents()) {
  const byId = new Map(detected.map((d) => [d.id, d]));
  if (project?.agent) {
    const d = byId.get(project.agent);
    if (!d) return { id: project.agent, chosen: true, installed: false, reason: `${project.agent} is not an agent the studio knows` };
    if (!d.installed) return { ...d, chosen: true, reason: d.id === "anthropic" ? "ANTHROPIC_API_KEY is not set in the studio's shell" : `\`${d.cmd}\` is not on PATH` };
    if (d.drive === "custom" && !project.customCommand) {
      return { ...d, chosen: true, reason: "the studio has no adapter for this agent — give the exact command in the project's settings" };
    }
    return { ...d, chosen: true, reason: null };
  }
  const fallback = detected.find((d) => d.installed && d.drive === "stream");
  if (!fallback) return { id: null, chosen: false, installed: false, reason: "no agent is installed that the studio can drive" };
  return { ...fallback, chosen: false, reason: "no agent chosen for this project — using the first one the studio can drive" };
}
