// manifest.mjs — the reason `ai-qa update` is safe to run.
//
// Every file the installer OWNS gets its sha256 recorded in .ai-qa/manifest.json
// at write time. On update, a file whose hash still matches is ours to replace;
// a file whose hash has drifted was edited by a human, and we do not touch it —
// we report it and move on. Silently clobbering someone's edited gate is how a
// tool gets uninstalled.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MANIFEST_REL = ".ai-qa/manifest.json";

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function hashFile(abs) {
  try { return sha256(fs.readFileSync(abs)); } catch { return null; }
}

export class ManifestGuard {
  /**
   * @param root repo root
   * @param mode "init"   — first install: nothing is protected yet
   *             "update" — respect recorded hashes
   * @param opts.dryRun   decide everything, write nothing. `--dry-run` has to
   *                      be genuinely inert; a preview that modifies the repo
   *                      is worse than no preview, because it is trusted.
   */
  constructor(root, mode = "update", opts = {}) {
    this.root = root;
    this.mode = mode;
    this.dryRun = !!opts.dryRun;
    this.file = path.join(root, MANIFEST_REL);
    this.prev = { version: null, files: {} };
    if (mode === "update" && fs.existsSync(this.file)) {
      try { this.prev = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { /* corrupt: treat as empty */ }
    }
    this.next = {};
    this.written = [];
    this.skipped = [];   // user-modified, left alone
    this.unchanged = [];
  }

  /** Write `rel` unless a human has edited it since we last wrote it. */
  write(rel, text) {
    const abs = path.join(this.root, rel);
    const recorded = this.prev.files?.[rel];
    const onDisk = hashFile(abs);
    const nextHash = sha256(Buffer.from(text));

    if (this.mode === "update" && onDisk && recorded && onDisk !== recorded) {
      // drifted from what we shipped → theirs now
      this.skipped.push(rel);
      this.next[rel] = recorded; // keep the old record so a later revert re-adopts it
      return "skipped";
    }
    if (onDisk === nextHash) {
      this.next[rel] = nextHash;
      this.unchanged.push(rel);
      return "unchanged";
    }
    if (!this.dryRun) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    this.next[rel] = nextHash;
    this.written.push(rel);
    return "written";
  }

  /** Record a file we created but do not own the content of (docs skeletons the
   * human is meant to fill in) — tracked for `doctor`, never overwritten. */
  note(rel) {
    const h = hashFile(path.join(this.root, rel));
    if (h) this.next[rel] = h;
  }

  save(version) {
    if (this.dryRun) return this.file;
    const payload = {
      version,
      generated: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(this.next).sort(([a], [b]) => a.localeCompare(b))),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`);
    return this.file;
  }
}

/** Integrity check for `doctor`: which owned files are missing or drifted. */
export function verify(root) {
  const file = path.join(root, MANIFEST_REL);
  if (!fs.existsSync(file)) return { ok: false, reason: "no manifest — ai-qa is not installed here", missing: [], drifted: [], total: 0 };
  let m;
  try { m = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { ok: false, reason: "manifest.json is not valid JSON", missing: [], drifted: [], total: 0 }; }
  const missing = [];
  const drifted = [];
  for (const [rel, expected] of Object.entries(m.files || {})) {
    const actual = hashFile(path.join(root, rel));
    if (actual === null) missing.push(rel);
    else if (actual !== expected) drifted.push(rel);
  }
  return {
    ok: missing.length === 0,
    reason: missing.length ? `${missing.length} installed file(s) missing` : "",
    missing,
    drifted,
    total: Object.keys(m.files || {}).length,
    version: m.version,
  };
}

/** Walk a directory yielding repo-relative paths, skipping the usual noise. */
export function walkFiles(dir, base = dir, skip = new Set(["node_modules", ".git", "__pycache__"])) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs, base, skip));
    else if (e.isFile()) out.push(path.relative(base, abs));
  }
  return out;
}
