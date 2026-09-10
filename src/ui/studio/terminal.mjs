// terminal.mjs — a real terminal for the agent, the way Orca does it.
//
// The first studio talked to Claude Code through `--print --output-format
// stream-json` and drew the answer itself. That is a fence — the engine can
// only reach the tools the lane allows — but it is also a translation, and a
// person who already knows Claude Code recognised nothing in it. Orca's
// answer is the honest one: give the agent a pseudo-terminal, put a terminal
// emulator in the page, and let the agent be itself. Every CLI agent becomes
// usable at once, with its own permission prompts, its own slash commands,
// its own colours — and `/qa SHOP-142` is typed into the real thing.
//
// Two pieces, no dependencies:
//   the pty      pty_bridge.py — Python's standard library, POSIX only
//   the socket   a WebSocket server small enough to read in one sitting
//                (RFC 6455: handshake, masked frames, fragments, ping, close)
import crypto from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE = path.join(HERE, "pty_bridge.py");

/** Python's pty module is POSIX-only. Said once, here, rather than failing
 *  later with a traceback. */
export function availability() {
  if (process.platform === "win32") return { available: false, reason: "the embedded terminal needs a POSIX pseudo-terminal (Python's pty module) — on Windows use the Chat mode, or run the agent in your own terminal" };
  return { available: true, reason: "" };
}

const frame = (type, payload) => {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
};

/** One agent, in one pty, for one flow. Output is kept (bounded) so a page
 *  that reattaches sees what happened while it was away — the session lives
 *  in the studio process, not in the browser tab. */
export class TerminalSession extends EventEmitter {
  constructor({ id, argv, cwd, env = {}, cols = 120, rows = 36, scrollback = 512 * 1024 }) {
    super();
    Object.assign(this, { id, argv, cwd, env, cols, rows, scrollback });
    this.chunks = []; this.size = 0;
    this.running = false; this.exitCode = null; this.startedAt = null; this.clients = new Set();
    this.setMaxListeners(50);
  }
  start() {
    this.running = true; this.startedAt = new Date().toISOString();
    // This terminal is the person's own session, not a child of whatever
    // launched the studio. If the studio itself was started from inside a
    // Claude Code session, the nesting markers would make the agent believe it
    // is a subprocess (and, for one, switch transcript saving off).
    const env = { ...process.env, ...this.env };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_CHILD_SESSION;
    this.child = spawn("python3", [BRIDGE, "--cols", String(this.cols), "--rows", String(this.rows), "--", ...this.argv],
      { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const onData = (chunk) => { this.chunks.push(chunk); this.size += chunk.length; while (this.size > this.scrollback && this.chunks.length > 1) this.size -= this.chunks.shift().length; this.emit("data", chunk); };
    this.child.stdout.on("data", onData);
    this.child.stderr.on("data", onData);
    this.child.on("error", (e) => { onData(Buffer.from(`\r\ncould not start python3 for the terminal: ${e.message}\r\n`)); });
    this.child.on("close", (code) => { this.running = false; this.exitCode = code; this.emit("exit", code); });
    return this;
  }
  write(data) { if (this.running) this.child.stdin.write(frame(0, data)); }
  resize(cols, rows) {
    cols = Math.max(20, Math.min(500, Number(cols) || 120)); rows = Math.max(5, Math.min(200, Number(rows) || 36));
    this.cols = cols; this.rows = rows;
    if (this.running) this.child.stdin.write(frame(1, `${cols} ${rows}`));
  }
  kill() {
    if (!this.running) return;
    try { this.child.kill("SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { if (this.running) { try { this.child.kill("SIGKILL"); } catch { /* gone */ } } }, 2000).unref();
  }
  replay() { return Buffer.concat(this.chunks); }
  status() { return { id: this.id, running: this.running, exitCode: this.exitCode, argv: this.argv, cwd: this.cwd, startedAt: this.startedAt, clients: this.clients.size, cols: this.cols, rows: this.rows }; }
}

/** The argv that starts an agent interactively. Claude Code gets the studio's
 *  note and the project's model; an agent the studio has no adapter for is
 *  simply run as itself — a terminal needs no adapter, that is the point.
 *  The custom command still wins when a project set one (extra flags, a
 *  different binary), minus any `{prompt}` it carried for the chat mode. */
export function commandFor(resolved, project, { note = "" } = {}) {
  if (!resolved || !resolved.id) return { ok: false, reason: "no agent is chosen for this flow" };
  if (!resolved.installed) return { ok: false, reason: resolved.reason || `${resolved.label || resolved.id} is not installed` };
  if (!resolved.cmd) return { ok: false, reason: `${resolved.label || resolved.id} has no command-line program — use the Chat mode for it` };
  if (project?.customCommand && resolved.id === project.agent) {
    const argv = splitCommand(project.customCommand).filter((a) => !/\{prompt\}/.test(a));
    if (argv.length) return { ok: true, argv };
  }
  if (resolved.id === "claude") {
    const argv = ["claude"];
    if (project?.model) argv.push("--model", project.model);
    if (note) argv.push("--append-system-prompt", note);
    return { ok: true, argv };
  }
  return { ok: true, argv: [resolved.cmd] };
}

/** Shell-like word splitting with quotes, no expansion, no shell. */
export function splitCommand(s) {
  const out = []; let cur = ""; let q = null; let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ""; has = false; } continue; }
    if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket, RFC 6455 — the parts a local terminal needs
// ---------------------------------------------------------------------------
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let head;
  if (b.length < 126) { head = Buffer.alloc(2); head[1] = b.length; }
  else if (b.length < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(b.length, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(b.length), 2); }
  head[0] = 0x80 | (opcode & 0x0f);       // FIN + opcode; a server never masks
  return Buffer.concat([head, b]);
}

/** Parse as many complete frames as `buf` holds. Returns them and the
 *  unconsumed remainder. Masked or not — a client must mask, a test may not. */
export function decodeFrames(buf) {
  const frames = []; let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f; let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; const big = buf.readBigUInt64BE(p); if (big > BigInt(64 * 1024 * 1024)) throw new Error("frame too large"); len = Number(big); p += 8; }
    let mask = null;
    if (masked) { if (buf.length - p < 4) break; mask = buf.subarray(p, p + 4); p += 4; }
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Complete the upgrade and return an emitter: `message` (payload, isBinary),
 *  `close`; with `send(string|Buffer)` and `close(code)`. */
export function acceptWebSocket(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
  socket.setNoDelay(true);
  const ws = new EventEmitter();
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let frag = null; let open = true;
  ws.send = (data) => { if (!open) return false; try { socket.write(encodeFrame(Buffer.isBuffer(data) ? 2 : 1, data)); return true; } catch { return false; } };
  ws.close = (code = 1000) => { if (!open) return; open = false; const b = Buffer.alloc(2); b.writeUInt16BE(code); try { socket.write(encodeFrame(8, b)); } catch { /* gone */ } socket.end(); };
  const onChunk = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let parsed;
    try { parsed = decodeFrames(buf); } catch { ws.close(1009); return; }
    buf = Buffer.from(parsed.rest);
    for (const f of parsed.frames) {
      if (f.opcode === 8) { ws.close(1000); return; }
      if (f.opcode === 9) { try { socket.write(encodeFrame(10, f.payload)); } catch { /* gone */ } continue; }
      if (f.opcode === 10) continue;
      if (f.opcode === 0) { if (!frag) continue; frag.parts.push(f.payload); if (f.fin) { const m = frag; frag = null; ws.emit("message", Buffer.concat(m.parts), m.binary); } continue; }
      if (f.opcode === 1 || f.opcode === 2) {
        if (!f.fin) { frag = { binary: f.opcode === 2, parts: [f.payload] }; continue; }
        ws.emit("message", f.payload, f.opcode === 2);
      }
    }
  };
  socket.on("data", onChunk);
  socket.on("close", () => { open = false; ws.emit("close"); });
  socket.on("error", () => { open = false; ws.emit("close"); });
  if (buf.length) onChunk(Buffer.alloc(0));
  return ws;
}

/** A client-side frame, for tests: masked, as browsers send them. */
export function clientFrame(opcode, payload = Buffer.alloc(0)) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const mask = crypto.randomBytes(4);
  let head;
  if (b.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | b.length; }
  else if (b.length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(b.length, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(b.length), 2); }
  head[0] = 0x80 | (opcode & 0x0f);
  const masked = Buffer.from(b); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}
