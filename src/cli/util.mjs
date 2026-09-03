// util.mjs — the small shared floor every command stands on: terminal input
// that behaves on a real TTY AND in CI, path resolution, template rendering,
// and writes that create their parent directories.
//
// Deliberately zero dependencies. A QA tool that cannot run because an install
// failed is a QA tool nobody runs.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- colour ------------------------------------------------------------------
// Honours NO_COLOR (informal standard) and never paints a non-TTY: piped output
// full of escape codes is a log nobody can grep.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

// ---- repo ---------------------------------------------------------------------
/** The git top level, or "" when this is not a repository. */
export function gitRoot(cwd = process.cwd()) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? String(r.stdout).trim() : "";
}

/** git top level when there is one, else the cwd — `scan` must grade a plain
 * directory too, because the repo it is pointed at may not be a repo yet. */
export function repoRoot(cwd = process.cwd()) {
  return gitRoot(cwd) || path.resolve(cwd);
}

// ---- prompts ------------------------------------------------------------------
/** A free-text question with a default. Enter alone takes the default. */
export function ask(question, def = "") {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const hint = def ? c.gray(` (${def})`) : "";
    rl.question(`  ${c.cyan("?")} ${question}${hint} ${c.gray("›")} `, (answer) => {
      rl.close();
      resolve(String(answer).trim() || def);
    });
  });
}

export async function askYesNo(question, def = true) {
  const a = await ask(`${question} ${c.gray(def ? "[Y/n]" : "[y/N]")}`, def ? "y" : "n");
  return /^y/i.test(a);
}

/** Single-select. Arrow keys on a raw-capable TTY; a numbered list everywhere
 * else (tmux without raw mode, some CI shells) — the question always gets
 * asked, the mechanism just degrades. */
export function askChoice(question, options, def = options[0]) {
  const defIdx = Math.max(0, options.indexOf(def));
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return askNumbered(question, options, defIdx);
  }
  return new Promise((resolve) => {
    let idx = defIdx;
    const draw = (first) => {
      if (!first) process.stdout.write(`\x1b[${options.length + 1}A`);
      process.stdout.write(`  ${c.cyan("?")} ${question}\x1b[K\n`);
      options.forEach((opt, i) => {
        const line = i === idx
          ? `  ${c.cyan("❯")} ${c.cyan(opt)}`
          : `    ${c.gray(opt)}`;
        process.stdout.write(`${line}\x1b[K\n`);
      });
    };
    draw(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") { idx = (idx - 1 + options.length) % options.length; draw(false); }
      else if (key.name === "down" || key.name === "j") { idx = (idx + 1) % options.length; draw(false); }
      else if (key.name === "return" || key.name === "enter") { finish(options[idx]); }
      else if (key.ctrl && key.name === "c") { finish(null); }
    };
    const finish = (value) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (value === null) { process.stdout.write("\n"); process.exit(130); }
      resolve(value);
    };
    process.stdin.on("keypress", onKey);
  });
}

async function askNumbered(question, options, defIdx) {
  console.log(`  ${c.cyan("?")} ${question}`);
  options.forEach((o, i) => console.log(`    ${c.gray(`${i + 1})`)} ${o}`));
  const a = await ask(`choose 1-${options.length}`, String(defIdx + 1));
  const n = Number.parseInt(a, 10);
  return options[Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : defIdx];
}

/** Multi-select, comma-separated. Returns [] only if the user really cleared it. */
export async function askMulti(question, options, def = []) {
  console.log(`  ${c.cyan("?")} ${question}`);
  options.forEach((o, i) => console.log(`    ${c.gray(`${i + 1})`)} ${o}`));
  const defStr = def.map((d) => options.indexOf(d) + 1).filter((n) => n > 0).join(",");
  const a = await ask("comma-separated numbers", defStr);
  const picked = String(a).split(",").map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
    .map((n) => options[n - 1]);
  return [...new Set(picked)];
}

// ---- output -------------------------------------------------------------------
export const say = {
  step: (n, total, title) => console.log(`\n${c.bold(`  ${title}`)}  ${c.gray(`· step ${n}/${total}`)}\n`),
  ok: (m) => console.log(`  ${c.green("✓")} ${m}`),
  warn: (m) => console.log(`  ${c.yellow("⚠")} ${m}`),
  err: (m) => console.error(`  ${c.red("✗")} ${m}`),
  info: (m) => console.log(`  ${c.gray("·")} ${m}`),
  head: (m) => console.log(`\n${c.bold(m)}`),
};

export function fail(cmd, msg) {
  console.error(`${c.red(`ai-qa ${cmd}:`)} ${msg}`);
  process.exit(1);
}

// ---- files --------------------------------------------------------------------
export function writeFile(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

/** Write only when absent — used for anything a human is expected to edit, so
 * a re-run never eats their words. */
export function writeIfAbsent(abs, text) {
  if (fs.existsSync(abs)) return false;
  writeFile(abs, text);
  return true;
}

export function readIfExists(abs, cap = 1_000_000) {
  try {
    if (fs.statSync(abs).size > cap) return "";
    return fs.readFileSync(abs, "utf8");
  } catch { return ""; }
}

// ---- templates ----------------------------------------------------------------
/** `{a.b.c}` → cfg.a.b.c. An unresolved key is left VERBATIM, never blanked:
 * a literal `{app.url}` in a rendered file is a loud bug; an empty string is a
 * silent one. */
export function render(text, cfg) {
  return String(text).replace(/\{([a-z0-9_]+(?:\.[a-z0-9_]+)*)\}/gi, (whole, keyPath) => {
    let cur = cfg;
    for (const k of keyPath.split(".")) {
      if (cur && typeof cur === "object" && k in cur) cur = cur[k];
      else return whole;
    }
    return cur === null || cur === undefined ? whole : String(cur);
  });
}

/** Minimal YAML frontmatter split — key: value pairs only, which is all a
 * workflow header ever holds. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Flags: --key value | --key=value | --flag | positional. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { flags, positional };
}
