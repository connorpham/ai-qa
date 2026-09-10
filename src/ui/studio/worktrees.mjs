// worktrees.mjs — verify a branch without disturbing the checkout someone is
// working in.
//
// This is not a convenience. `/qa` V0 already says it: when the change under
// test is not merged, you check the branch out and SAY so, and the verdict
// binds to that commit. Doing that in the main checkout means asking a
// developer to stop working, or verifying whatever happened to be checked out.
// A worktree is the honest way to hold both.
//
// The layout follows Orca's (`.orca/worktrees/<name>`), adapted to this
// product: `.ai-qa/worktrees/<name>`, inside the project, so `git worktree
// list` in the project shows them and nothing lands in someone's home folder.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const WORKTREE_SUBDIR = path.join(".ai-qa", "worktrees");
export const NAME_RE = /^[a-z0-9][a-z0-9._\/-]{0,63}$/;

function git(cwd, args, timeout = 120_000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

/** Every worktree git knows about for this project, with the one the studio
 *  would treat as "the checkout" marked. Parsed from the porcelain form so a
 *  branch name with a space in it does not shift the columns. */
export function list(projectPath) {
  const r = git(projectPath, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return { ok: false, error: r.out, worktrees: [] };
  const out = [];
  let cur = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9).trim(), branch: null, head: null, detached: false, locked: false, prunable: false };
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim().slice(0, 8);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line.trim() === "detached") cur.detached = true;
    else if (line.startsWith("locked")) cur.locked = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  if (cur) out.push(cur);
  const root = path.resolve(projectPath);
  for (const w of out) {
    w.isMain = path.resolve(w.path) === root;
    w.managed = path.resolve(w.path).startsWith(path.join(root, WORKTREE_SUBDIR) + path.sep);
    w.name = w.managed ? path.relative(path.join(root, WORKTREE_SUBDIR), w.path) : path.basename(w.path);
    w.hasLane = fs.existsSync(path.join(w.path, "aiqa.config.yaml"));
    w.exists = fs.existsSync(w.path);
  }
  return { ok: true, worktrees: out };
}

/** Create `.ai-qa/worktrees/<name>`.
 *
 *  `base` decides what is being verified, and the two answers are different
 *  jobs, so the caller must pick one rather than inherit a default:
 *    · an existing branch (a PR under test) — checked out as it is
 *    · a new branch from a ref (a clean room)  — branched and named
 */
export function create(projectPath, { name, base = null, newBranch = false }) {
  if (!NAME_RE.test(String(name || ""))) {
    return { ok: false, error: "name: lowercase letters, digits, . _ - / (up to 64 characters)" };
  }
  const dir = path.join(projectPath, WORKTREE_SUBDIR, name);
  if (fs.existsSync(dir)) return { ok: false, error: `${path.relative(projectPath, dir)} already exists` };

  const args = ["worktree", "add"];
  if (newBranch) {
    args.push("-b", name, dir);
    if (base) args.push(base);
  } else {
    if (!base) return { ok: false, error: "which branch or commit should this worktree check out?" };
    args.push(dir, base);
  }
  const r = git(projectPath, args, 300_000);
  if (!r.ok) return { ok: false, error: r.out };

  // .ai-qa/ is ignored in an installed project, so a worktree under it is
  // invisible to git status — say so rather than letting someone wonder.
  const info = list(projectPath);
  const made = info.worktrees.find((w) => path.resolve(w.path) === path.resolve(dir));
  return { ok: true, worktree: made || { path: dir, name }, out: r.out };
}

/** Remove one, and refuse to do it silently when it would lose work. */
export function remove(projectPath, name, { force = false } = {}) {
  const dir = path.join(projectPath, WORKTREE_SUBDIR, name);
  if (!fs.existsSync(dir)) return { ok: false, error: `no worktree at ${path.relative(projectPath, dir)}` };
  const dirty = git(dir, ["status", "--porcelain"]);
  if (dirty.ok && dirty.out && !force) {
    return { ok: false, needsForce: true,
      error: `${name} has uncommitted changes:\n${dirty.out.split("\n").slice(0, 8).join("\n")}\n\nCommit them, or remove it again with force.` };
  }
  const r = git(projectPath, ["worktree", "remove", ...(force ? ["--force"] : []), dir], 120_000);
  if (!r.ok) return { ok: false, error: r.out };
  return { ok: true, out: r.out || `removed ${name}` };
}

/** Branches worth offering in the create form: local ones, and remote ones that
 *  have no local counterpart yet (which is what a PR looks like before you
 *  check it out). */
export function branches(projectPath) {
  const local = git(projectPath, ["for-each-ref", "--sort=-committerdate", "--count=60",
    "--format=%(refname:short)", "refs/heads"]);
  const remote = git(projectPath, ["for-each-ref", "--sort=-committerdate", "--count=60",
    "--format=%(refname:short)", "refs/remotes/origin"]);
  const l = local.ok ? local.out.split("\n").filter(Boolean) : [];
  const seen = new Set(l);
  const r = remote.ok
    ? remote.out.split("\n").filter(Boolean)
        .map((b) => b.replace(/^origin\//, ""))
        .filter((b) => b && b !== "HEAD" && !seen.has(b))
    : [];
  const head = git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { local: l, remoteOnly: r, current: head.ok ? head.out : null };
}
