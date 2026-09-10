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
import { spawn, spawnSync } from "node:child_process";

// AIQA_HOME exists so a test can point the studio at a throwaway home instead
// of writing its fixture repositories into the registry on the developer's
// machine — which the first version of the e2e suite did, silently.
export const REGISTRY_DIR = process.env.AIQA_HOME || path.join(os.homedir(), ".ai-qa");
export const REGISTRY_FILE = path.join(REGISTRY_DIR, "studio.json");
/** Where `clone from a URL` puts repositories unless told otherwise. */
export const CLONES_DIR = path.join(REGISTRY_DIR, "projects");

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
 *  agent" was whatever happened to be installed.
 *
 *  `override` is a flow's own choice: a flow is created with an agent, and
 *  that wins over the project's default for everything that flow runs. */
export function resolveAgent(project, detected = detectAgents(), override = null) {
  const byId = new Map(detected.map((d) => [d.id, d]));
  const want = override || project?.agent || null;
  // Two ways to run an agent, said separately:
  //   terminal  any installed CLI, in a real pty — no adapter needed
  //   chat      the fenced stream: needs an adapter (claude, the API), or the
  //             project's own command for anything else
  const shape = (d, extra) => ({ ...d,
    terminal: !!(d.installed && d.cmd),
    chat: !!(d.installed && (d.drive === "stream" || (project?.customCommand && project?.agent === d.id))),
    ...extra });
  if (want) {
    const d = byId.get(want);
    if (!d) return { id: want, chosen: true, installed: false, terminal: false, chat: false, reason: `${want} is not an agent the studio knows` };
    if (!d.installed) return shape(d, { chosen: true, reason: d.id === "anthropic" ? "ANTHROPIC_API_KEY is not set in the studio's shell" : `\`${d.cmd}\` is not on PATH` });
    return shape(d, { chosen: true, reason: null });
  }
  const fallback = detected.find((d) => d.installed && d.cmd) || detected.find((d) => d.installed);
  if (!fallback) return { id: null, chosen: false, installed: false, terminal: false, chat: false, reason: "no agent is installed on this machine" };
  return shape(fallback, { chosen: false, reason: "no agent chosen for this project — using the first one installed" });
}

/** Which chat engine runs a resolved agent: the two the studio has adapters
 *  for by their own id, everything else through the custom-command engine. */
export function engineFor(resolved) {
  if (!resolved || !resolved.id) return null;
  return resolved.drive === "stream" ? resolved.id : "custom";
}

// ---------------------------------------------------------------------------
// choosing a project: a folder on this machine, or a URL to clone
// ---------------------------------------------------------------------------

/** One level of the file system, for the folder picker. Directories only, and
 *  for each whether it is a git repository (a `.git` entry — cheap, no spawn)
 *  and whether the lane is installed in it. Hidden folders are skipped except
 *  when the user is already inside one. */
export function browse(rawPath) {
  const abs = path.resolve(String(rawPath || "~").replace(/^~(?=$|\/)/, os.homedir()));
  const out = { path: abs, parent: path.dirname(abs) === abs ? null : path.dirname(abs), home: os.homedir(), entries: [], isRepo: false, hasLane: false, error: null };
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) { out.error = e.code === "ENOENT" ? "no such folder" : e.code === "EACCES" ? "no permission to read this folder" : e.message; return out; }
  out.isRepo = fs.existsSync(path.join(abs, ".git"));
  out.hasLane = fs.existsSync(path.join(abs, "aiqa.config.yaml"));
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith(".")) continue;
    const full = path.join(abs, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; } }
    if (!isDir) continue;
    out.entries.push({ name: e.name, path: full, isRepo: fs.existsSync(path.join(full, ".git")), hasLane: fs.existsSync(path.join(full, "aiqa.config.yaml")) });
    if (out.entries.length >= 400) break;
  }
  out.entries.sort((a, b) => (b.isRepo - a.isRepo) || a.name.localeCompare(b.name));
  return out;
}

/** The URL shapes git itself accepts as a remote. `file://` is here for local
 *  mirrors and for the test suite, which must not reach the network. */
export const CLONE_URL_RE = /^(https?:\/\/[^\s]+|ssh:\/\/[^\s]+|git:\/\/[^\s]+|file:\/\/\/[^\s]+|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+)$/;

export function repoNameFromUrl(url) {
  const tail = String(url).replace(/[\/:]+$/, "").split(/[\/:]/).pop() || "repo";
  return tail.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "repo";
}

/** `git clone --progress <url> <dest>` by argv, never through a shell. Progress
 *  lines go to `onLine` as git writes them; the promise resolves with the
 *  destination or an error message a person can act on. Refuses a destination
 *  that already has anything in it: cloning over someone's folder is not ours
 *  to decide. */
export function clone(url, rawDest, { onLine = () => {}, signal = null, timeout = 600_000 } = {}) {
  return new Promise((resolve) => {
    const u = String(url || "").trim();
    if (!CLONE_URL_RE.test(u)) { resolve({ ok: false, error: "that is not a git URL the studio recognises — https://…, ssh://…, git@host:path or file:///…" }); return; }
    const dest = path.resolve(String(rawDest || path.join(CLONES_DIR, repoNameFromUrl(u))).replace(/^~(?=$|\/)/, os.homedir()));
    try {
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) { resolve({ ok: false, error: `${dest} already exists and is not empty — pick another folder, or add it as a project if it is the same repository` }); return; }
    } catch (e) { resolve({ ok: false, error: e.message }); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const child = spawn("git", ["clone", "--progress", "--", u, dest], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const feed = (chunk) => {
      for (const line of String(chunk).split(/\r|\n/)) { if (line.trim()) { tail = line.trim(); onLine(tail); } }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, timeout);
    if (signal) signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, { once: true });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: `could not start git: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve({ ok: true, dest }); return; }
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* partial clone left behind; git says so */ }
      resolve({ ok: false, error: tail ? `git clone failed: ${tail}` : `git clone exited with ${code}` });
    });
  });
}
