// config.mjs — reader for aiqa.config.yaml.
//
// This is a CONSTRAINED YAML subset, not a YAML library, and that is a choice:
// the same file has to be read by Node (this file) and by Python (the gates in
// core/scripts/lib/ctx.py). Two independent parsers only agree if the grammar
// is small enough to hold in your head. So:
//
//   · 2-space indentation, no tabs
//   · key: value  ·  key: [a, b]  ·  key: {}  ·  nested maps  ·  "- item" lists
//   · quotes around a scalar are stripped
//   · " #" always starts a comment — INCLUDING inside quotes
//   · no anchors, no multi-line scalars, no escape sequences
//
// `init` validates every value it writes against exactly these rules before the
// first byte hits disk, so a config this parser cannot read never gets created.
import fs from "node:fs";
import path from "node:path";

export const CONFIG_NAME = "aiqa.config.yaml";

function scalar(raw) {
  let v = String(raw).trim();
  if (!v) return "";
  if (v.startsWith("[")) {
    const end = v.lastIndexOf("]");
    const inner = v.slice(1, end === -1 ? v.length : end).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => scalar(s));
  }
  if (v === "{}") return {};
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

/** Strip a trailing comment. " #" is the delimiter — a '#' with no space before
 * it stays put, so URLs with fragments and colour hex codes survive. */
function decomment(line) {
  const i = line.indexOf(" #");
  const body = i === -1 ? line : line.slice(0, i);
  return body.replace(/\s+$/, "");
}

export function parseConfig(text) {
  const lines = String(text).split(/\r?\n/);
  const root = {};
  // stack of {indent, container} — container is an object or an array
  const stack = [{ indent: -1, container: root }];

  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const line = decomment(raw);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (body.startsWith("- ") || body === "-") {
      if (!Array.isArray(top.container)) continue; // a stray dash: ignore, never crash
      top.container.push(scalar(body.slice(1)));
      continue;
    }

    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(body);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest === "") {
      // A block follows. Whether it is a map or a list is decided by the first
      // child line; start as a map and swap on the first "- ".
      const container = {};
      top.container[key] = container;
      stack.push({ indent, container, key, parent: top.container });
    } else {
      top.container[key] = scalar(rest);
    }
  }

  // Second pass fixes list-blocks: a map whose keys are all numeric-ish never
  // happens here, so instead we re-walk the raw text for "key:\n  - " shapes.
  return fixLists(root, text);
}

/** A `key:` whose first non-blank child starts with "- " is a LIST, not a map.
 * The single-pass parser above cannot know that until it sees the child, so
 * this walks the source once more and rebuilds those nodes. */
function fixLists(root, text) {
  const lines = String(text).split(/\r?\n/)
    .map((l) => decomment(l))
    .filter((l) => l.trim() && !/^\s*#/.test(l));
  const pathStack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (body.startsWith("- ")) continue;
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(body);
    if (!m) continue;
    while (pathStack.length && pathStack[pathStack.length - 1].indent >= indent) pathStack.pop();
    pathStack.push({ indent, key: m[1] });
    if (m[2] !== "") continue;

    // peek at the first child
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length) continue;
    const childIndent = lines[j].length - lines[j].trimStart().length;
    if (childIndent <= indent || !lines[j].trim().startsWith("- ")) continue;

    const items = [];
    for (let k = j; k < lines.length; k++) {
      const ind = lines[k].length - lines[k].trimStart().length;
      if (ind <= indent) break;
      const t = lines[k].trim();
      if (t.startsWith("- ")) items.push(scalar(t.slice(2)));
      else if (t === "-") items.push("");
    }
    let cur = root;
    for (let p = 0; p < pathStack.length - 1; p++) {
      cur = cur?.[pathStack[p].key];
      if (!cur || typeof cur !== "object") { cur = null; break; }
    }
    if (cur) cur[pathStack[pathStack.length - 1].key] = items;
  }
  return root;
}

export function configPath(root) {
  return path.join(root, CONFIG_NAME);
}

export function loadConfig(root) {
  const file = configPath(root);
  if (!fs.existsSync(file)) return null;
  return parseConfig(fs.readFileSync(file, "utf8"));
}

/** Dotted lookup with a default — `get(cfg, "app.url", "")`. */
export function get(cfg, dotted, def = undefined) {
  let cur = cfg;
  for (const k of String(dotted).split(".")) {
    if (cur && typeof cur === "object" && k in cur) cur = cur[k];
    else return def;
  }
  return cur === undefined || cur === null ? def : cur;
}
