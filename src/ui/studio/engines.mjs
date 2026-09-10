// engines.mjs — the LLM behind the studio's chat, behind one small interface.
//
//   engine.chat({ message, sessionId, cwd, env, onEvent, signal }) → { sessionId, cost }
//
// onEvent receives, in order: { type: "status" | "text" | "tool" | "tool_result" |
// "done" | "error", ... }. The page renders those and nothing else, so an engine
// can be swapped without the page knowing.
//
// Two engines ship:
//
//   claude-code  spawns `claude -p … --output-format stream-json` in the target
//                repo. It reuses the person's existing Claude Code login, the
//                four skills ai-qa installed there, and every gate — with an
//                allow-list that grants exactly the lane's tools: the gate
//                scripts, reading, and writing under evd/ and docs/qa/. "No
//                product code is changed" stops being a rule the agent is asked
//                to follow and becomes a thing it cannot do.
//
//   anthropic    calls the Messages API directly with ANTHROPIC_API_KEY, running
//                a small tool loop of its own over the same allow-list. It is
//                here so a machine without Claude Code is not a machine without
//                the studio; it is not as capable as the skills-aware engine and
//                says so in its label.
//
// Neither engine can start the app, run arbitrary shell, or edit source: the
// allow-lists below are the whole of what the model may do.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** Claude Code tool patterns: the lane's toolset and nothing else. */
export const ALLOWED_TOOLS = [
  "Read", "Glob", "Grep", "Agent",
  "Bash(python3 .ai-qa/scripts/*)",
  "Bash(node .ai-qa/scripts/*)",
  "Bash(bash .ai-qa/scripts/*)",
  "Bash(node evd/*)",
  "Bash(bash evd/*)",
  "Bash(mkdir -p evd/*)",
  "Bash(curl *)",
  "Bash(git log*)", "Bash(git rev-parse*)", "Bash(git status*)", "Bash(git diff*)", "Bash(git branch*)",
  "Write(evd/**)", "Edit(evd/**)",
  "Write(docs/qa/**)", "Edit(docs/qa/**)",
];
export const DISALLOWED_TOOLS = ["Read(.env)", "Read(./.env)", "Read(**/.env)", "Read(**/.env.*)", "WebFetch", "WebSearch"];

/** The same allow-list, for the engine that runs its own tool loop. A command is
 * an argv array; it is accepted only if its first two elements match. */
export const ARGV_ALLOW = [
  [/^python3$/, /^\.ai-qa\/scripts\/[a-z_]+\.py$/],
  [/^node$/, /^\.ai-qa\/scripts\/[a-z_]+\.mjs$/],
  [/^bash$/, /^\.ai-qa\/scripts\/[a-z_]+\.sh$/],
  [/^node$/, /^evd\/[^\s]+\.mjs$/],
  [/^bash$/, /^evd\/[^\s]+\.sh$/],
  [/^git$/, /^(log|rev-parse|status|diff|branch)$/],
  [/^curl$/, /^-?[^\s]*$/],
];

export function argvAllowed(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return false;
  return ARGV_ALLOW.some(([a, b]) => a.test(String(argv[0])) && b.test(String(argv[1])));
}

/** Paths the engines may read or write, relative to the repo root. */
export function safeRel(root, rel, { write = false } = {}) {
  const abs = path.resolve(root, String(rel || ""));
  const relNorm = path.relative(root, abs);
  if (!relNorm || relNorm.startsWith("..") || path.isAbsolute(relNorm)) return null;
  if (/(^|\/)\.env(\.|$)/.test(relNorm)) return null;
  if (relNorm.startsWith(".git/") || relNorm === ".git") return null;
  if (write && !/^(evd|docs\/qa)(\/|$)/.test(relNorm)) return null;
  return abs;
}

// ---------------------------------------------------------------------------
// claude-code
// ---------------------------------------------------------------------------
export class ClaudeCodeEngine {
  id = "claude-code";
  label = "Claude Code (uses the skills installed here)";
  constructor({ bin = process.env.AIQA_CLAUDE_BIN || "claude" } = {}) { this.bin = bin; }

  availability() {
    const r = spawnSync(this.bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
    if (r.error || r.status !== 0) return { available: false, reason: `\`${this.bin}\` not found on PATH — install Claude Code, or set AIQA_CLAUDE_BIN` };
    return { available: true, reason: String(r.stdout || "").trim() };
  }

  chat({ message, sessionId, cwd, env = {}, onEvent, signal, model, systemPrompt }) {
    return new Promise((resolve) => {
      const args = ["-p", message, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--allowedTools", ...ALLOWED_TOOLS, "--disallowedTools", ...DISALLOWED_TOOLS];
      if (sessionId) args.push("--resume", sessionId);
      if (model) args.push("--model", model);
      if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
      const child = spawn(this.bin, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      let sid = sessionId || null;
      let cost = null;
      let streamedText = new Set();       // message ids for which deltas arrived
      let finalText = "";
      const finish = (err) => {
        if (err) onEvent({ type: "error", message: err });
        onEvent({ type: "done", sessionId: sid, cost, text: finalText });
        resolve({ sessionId: sid, cost });
      };
      const onLine = (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.session_id) sid = ev.session_id;
        switch (ev.type) {
          case "system":
            if (ev.subtype === "init") onEvent({ type: "status", text: `session ${String(sid).slice(0, 8)} · ${ev.model || ""}`.trim() });
            break;
          case "stream_event": {
            const e = ev.event || {};
            if (e.type === "message_start" && e.message?.id) streamedText.add("live:" + e.message.id);
            if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
              streamedText.add("any");
              finalText += e.delta.text;
              onEvent({ type: "text", text: e.delta.text });
            }
            break;
          }
          case "assistant": {
            const blocks = ev.message?.content || [];
            for (const b of blocks) {
              if (b.type === "tool_use") onEvent({ type: "tool", name: b.name, input: summarizeInput(b.input) });
              else if (b.type === "text" && !streamedText.has("any")) { finalText += b.text; onEvent({ type: "text", text: b.text }); }
            }
            break;
          }
          case "user": {
            const blocks = ev.message?.content || [];
            for (const b of Array.isArray(blocks) ? blocks : []) {
              if (b.type === "tool_result") {
                const text = Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("\n") : String(b.content || "");
                onEvent({ type: "tool_result", text: text.slice(0, 2000), error: !!b.is_error });
              }
            }
            break;
          }
          case "result":
            cost = ev.total_cost_usd ?? null;
            if (ev.is_error) onEvent({ type: "error", message: String(ev.result || ev.error || "the run ended in an error") });
            if (!finalText && typeof ev.result === "string") { finalText = ev.result; onEvent({ type: "text", text: ev.result }); }
            break;
          default:
            break;
        }
      };
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
      });
      let stderr = "";
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("error", (e) => finish(`could not start ${this.bin}: ${e.message}`));
      child.on("close", (code) => {
        if (buf.trim()) onLine(buf.trim());
        if (code !== 0 && !cost) finish(stderr.trim().split("\n").slice(-3).join(" ") || `claude exited with ${code}`);
        else finish(null);
      });
      if (signal) signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, { once: true });
    });
  }
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command.slice(0, 300);
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.prompt === "string") return input.prompt.slice(0, 200);
  return JSON.stringify(input).slice(0, 300);
}

// ---------------------------------------------------------------------------
// anthropic — Messages API, streaming, with the lane's tools
// ---------------------------------------------------------------------------
const TOOLS = [
  { name: "run_gate", description: "Run one of the lane's own scripts (.ai-qa/scripts/*, a journey or run.sh under evd/, read-only git, curl). argv is a list; the first two elements must match the allow-list. Returns stdout+stderr and the exit code (0 ok, 1 finding, 2 BLOCKED).",
    input_schema: { type: "object", properties: { argv: { type: "array", items: { type: "string" } } }, required: ["argv"] } },
  { name: "read_file", description: "Read a file inside the repository (never .env). Returns up to 60k characters.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "list_dir", description: "List a directory inside the repository.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_evidence", description: "Write a text file under evd/ or docs/qa/ — evidence, sheets, reports, lessons. Product code cannot be written.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];

export class AnthropicEngine {
  id = "anthropic";
  label = "Anthropic API (ANTHROPIC_API_KEY; no skills — the method is inlined)";
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
                model = process.env.AIQA_STUDIO_MODEL || "claude-opus-5", fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/$/, ""); this.model = model; this.fetch = fetchImpl;
    this.sessions = new Map();
  }

  availability() {
    if (!this.apiKey) return { available: false, reason: "ANTHROPIC_API_KEY is not set in this shell" };
    return { available: true, reason: `${this.model} via ${this.baseUrl}` };
  }

  async chat({ message, sessionId, cwd, env = {}, onEvent, signal, systemPrompt, model }) {
    const sid = sessionId && this.sessions.has(sessionId) ? sessionId : crypto.randomUUID();
    const history = this.sessions.get(sid) || [];
    this.sessions.set(sid, history);
    history.push({ role: "user", content: message });
    onEvent({ type: "status", text: `session ${sid.slice(0, 8)} · ${model || this.model}` });
    let usage = { input: 0, output: 0 };
    let finalText = "";
    try {
      for (let round = 0; round < 12; round++) {
        const { content, stopReason, u } = await this.#stream({ history, systemPrompt, model: model || this.model, onEvent, signal });
        usage.input += u.input; usage.output += u.output;
        history.push({ role: "assistant", content });
        finalText += content.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (stopReason !== "tool_use") break;
        const results = [];
        for (const b of content.filter((b) => b.type === "tool_use")) {
          onEvent({ type: "tool", name: b.name, input: summarizeInput(b.input) });
          const out = await runTool(b, { cwd, env });
          onEvent({ type: "tool_result", text: String(out.text).slice(0, 2000), error: !!out.error });
          results.push({ type: "tool_result", tool_use_id: b.id, content: String(out.text).slice(0, 60_000), is_error: !!out.error });
        }
        history.push({ role: "user", content: results });
      }
    } catch (e) {
      onEvent({ type: "error", message: e.message });
    }
    const cost = null;   // list prices vary by model and plan; the token counts are what we can state truthfully
    onEvent({ type: "done", sessionId: sid, cost, usage, text: finalText });
    return { sessionId: sid, cost, usage };
  }

  async #stream({ history, systemPrompt, model, onEvent, signal }) {
    const res = await this.fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 8192, stream: true, tools: TOOLS,
        system: [{ type: "text", text: systemPrompt || "You are ai-qa studio's assistant.", cache_control: { type: "ephemeral" } }],
        messages: history,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const blocks = [];
    const partialJson = new Map();
    let stopReason = "end_turn";
    const u = { input: 0, output: 0 };
    for await (const ev of sse(res.body)) {
      if (ev.type === "message_start") u.input += ev.message?.usage?.input_tokens || 0;
      else if (ev.type === "content_block_start") { blocks[ev.index] = ev.content_block.type === "tool_use" ? { ...ev.content_block, input: {} } : { ...ev.content_block }; if (ev.content_block.type === "tool_use") partialJson.set(ev.index, ""); }
      else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") { blocks[ev.index].text = (blocks[ev.index].text || "") + ev.delta.text; onEvent({ type: "text", text: ev.delta.text }); }
        else if (ev.delta.type === "input_json_delta") partialJson.set(ev.index, (partialJson.get(ev.index) || "") + ev.delta.partial_json);
      } else if (ev.type === "content_block_stop") {
        if (partialJson.has(ev.index)) { try { blocks[ev.index].input = JSON.parse(partialJson.get(ev.index) || "{}"); } catch { blocks[ev.index].input = {}; } }
      } else if (ev.type === "message_delta") { stopReason = ev.delta?.stop_reason || stopReason; u.output += ev.usage?.output_tokens || 0; }
    }
    return { content: blocks.filter(Boolean), stopReason, u };
  }
}

/** Server-sent events → parsed JSON objects. */
async function* sse(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch { /* keep-alive or partial */ }
    }
  }
}

/** The API engine's tools, each fenced the same way the CLI engine's are. */
export async function runTool(block, { cwd, env = {} }) {
  const input = block.input || {};
  try {
    switch (block.name) {
      case "run_gate": {
        if (!argvAllowed(input.argv)) return { error: true, text: `refused: ${JSON.stringify(input.argv)} is outside the lane's allow-list (gate scripts, evd/ journeys, read-only git, curl)` };
        const r = spawnSync(input.argv[0], input.argv.slice(1), { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
        return { error: false, text: `${r.stdout || ""}${r.stderr || ""}\n[exit ${r.status}]` };
      }
      case "read_file": {
        const abs = safeRel(cwd, input.path);
        if (!abs) return { error: true, text: "refused: outside the repository, or a secrets file" };
        if (!fs.existsSync(abs)) return { error: true, text: "no such file" };
        return { error: false, text: fs.readFileSync(abs, "utf8").slice(0, 60_000) };
      }
      case "list_dir": {
        const abs = safeRel(cwd, input.path || ".");
        if (!abs) return { error: true, text: "refused: outside the repository" };
        return { error: false, text: fs.readdirSync(abs, { withFileTypes: true }).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") };
      }
      case "write_evidence": {
        const abs = safeRel(cwd, input.path, { write: true });
        if (!abs) return { error: true, text: "refused: the studio writes only under evd/ and docs/qa/ — never product code" };
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(input.content ?? ""));
        return { error: false, text: `wrote ${path.relative(cwd, abs)}` };
      }
      default:
        return { error: true, text: `unknown tool ${block.name}` };
    }
  } catch (e) {
    return { error: true, text: e.message };
  }
}

// ---------------------------------------------------------------------------
// custom command — for the agents the studio has no adapter for
// ---------------------------------------------------------------------------
/** Runs a command the project's settings supply, with `{prompt}` substituted.
 *
 *  The prompt is passed as its own argv element, never interpolated into a
 *  shell string, so a ticket description with a backtick in it cannot become a
 *  command. There is no session: each message is one invocation, and the page
 *  says so rather than implying the agent remembers.
 *
 *  Everything the command prints is relayed as it arrives. Whether the agent
 *  respected the lane's rules is not something this engine can promise — only
 *  the gates can, and they still run. */
export class CustomCommandEngine {
  id = "custom";
  label = "Custom command (per project)";
  constructor({ template = null } = {}) { this.template = template; }

  availability() {
    if (!this.template) return { available: false, reason: "no command set — put one in the project's settings, using {prompt}" };
    if (!/\{prompt\}/.test(this.template)) return { available: false, reason: "the command must contain {prompt}" };
    const argv = splitCommand(this.template);
    if (!argv.length) return { available: false, reason: "the command is empty" };
    const bin = spawnSync(process.platform === "win32" ? "where" : "which", [argv[0]], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (bin.status !== 0) return { available: false, reason: `\`${argv[0]}\` is not on PATH` };
    return { available: true, reason: this.template };
  }

  chat({ message, cwd, env = {}, onEvent, signal }) {
    return new Promise((resolve) => {
      const argv = splitCommand(this.template).map((a) => a.replace("{prompt}", message));
      onEvent({ type: "status", text: `${argv[0]} · one invocation, no session` });
      onEvent({ type: "tool", name: argv[0], input: argv.slice(1).join(" ").slice(0, 300) });
      const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      const relay = (chunk) => { const t = String(chunk); text += t; onEvent({ type: "text", text: t }); };
      child.stdout.on("data", relay);
      child.stderr.on("data", relay);
      child.on("error", (e) => { onEvent({ type: "error", message: `could not start ${argv[0]}: ${e.message}` }); onEvent({ type: "done", text }); resolve({ sessionId: null }); });
      child.on("close", (code) => {
        if (code !== 0) onEvent({ type: "error", message: `${argv[0]} exited with ${code}` });
        onEvent({ type: "done", text, sessionId: null });
        resolve({ sessionId: null });
      });
      if (signal) signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, { once: true });
    });
  }
}

/** Split a command template into argv, honouring quotes. Deliberately small:
 *  no pipes, no redirection, no substitution — a template that needs a shell is
 *  a template that should be a script the person can read. */
export function splitCommand(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || "")))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function makeEngines(opts = {}) {
  return [
    new ClaudeCodeEngine(opts.claude || {}),
    new AnthropicEngine(opts.anthropic || {}),
    new CustomCommandEngine(opts.custom || {}),
  ];
}

export function describeEngines(engines) {
  return engines.map((e) => { const a = e.availability(); return { id: e.id, label: e.label, available: a.available, reason: a.reason }; });
}
