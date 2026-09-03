// server.mjs — the browser setup wizard behind `ai-qa init --ui`.
//
// A local, single-use HTTP server on 127.0.0.1 with a random path token, so
// nothing else on the machine can post answers into your repo. It serves one
// page, collects one submission, and shuts down. No dependencies, no network,
// no build step — a setup tool that needs its own install is not a setup tool.
//
// The terminal wizard remains the default and does the same job; this exists
// because "which URL does it answer on, and who else uses that environment" is
// a much friendlier question inside a form that already shows you what the scan
// found.
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { c } from "../cli/util.mjs";
import { TOOLS } from "../cli/adapters.mjs";
import { SURFACES, TRACKERS, AUTONOMY, LANGUAGES } from "../cli/init.mjs";

function openBrowser(url) {
  // Headless machines, CI, and anyone who would rather click the link
  // themselves. The wizard still serves; only the auto-open is suppressed.
  if (process.env.AIQA_NO_OPEN) return false;
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
    return true;
  } catch { return false; }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

export function renderPage(state) {
  const { defaults, scan, token } = state;
  const gaps = scan.gaps.filter((g) => g.lost >= 4).slice(0, 6);

  const checkbox = (group, value, checked, label, note) => `
    <label class="opt${checked ? " on" : ""}">
      <input type="checkbox" name="${group}" value="${esc(value)}"${checked ? " checked" : ""}>
      <span class="box"></span>
      <span class="txt"><b>${esc(label)}</b>${note ? `<em>${esc(note)}</em>` : ""}</span>
    </label>`;

  const radio = (group, value, checked, label, note) => `
    <label class="opt${checked ? " on" : ""}">
      <input type="radio" name="${group}" value="${esc(value)}"${checked ? " checked" : ""}>
      <span class="box round"></span>
      <span class="txt"><b>${esc(label)}</b>${note ? `<em>${esc(note)}</em>` : ""}</span>
    </label>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-qa setup</title>
<style>
  :root{
    --bg:#fbfbfa; --panel:#fff; --ink:#1a1a19; --muted:#6b6b66; --line:#e4e4e0;
    --accent:#2f6f4f; --accent-soft:#eaf3ee; --warn:#8a6212; --warn-soft:#fdf6e6;
    --radius:10px;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#16171a; --panel:#1e1f23; --ink:#ececea; --muted:#9a9a96; --line:#31333a;
    --accent:#7fc4a0; --accent-soft:#1f2b25; --warn:#e0b455; --warn-soft:#2a2418;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:720px;margin:0 auto;padding:40px 20px 80px}
  header{margin-bottom:28px}
  h1{font-size:22px;margin:0 0 6px;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:14px}
  .score{display:flex;align-items:baseline;gap:10px;margin:18px 0 6px;
    padding:14px 16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius)}
  .score b{font-size:26px;letter-spacing:-.02em}
  .score .g{color:var(--muted);font-size:13px}
  .gaps{background:var(--warn-soft);border:1px solid var(--line);border-radius:var(--radius);
    padding:14px 16px;margin-bottom:26px}
  .gaps h3{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--warn)}
  .gaps li{font-size:13.5px;color:var(--muted);margin:5px 0}
  .gaps ul{margin:0;padding-left:18px}
  fieldset{border:1px solid var(--line);background:var(--panel);border-radius:var(--radius);
    padding:20px;margin:0 0 18px}
  legend{padding:0 8px;font-weight:640;font-size:14px}
  .hint{color:var(--muted);font-size:13px;margin:-4px 0 14px}
  label.field{display:block;margin:0 0 14px}
  label.field span{display:block;font-size:13px;font-weight:560;margin-bottom:5px}
  label.field em{font-weight:400;color:var(--muted);font-style:normal}
  input[type=text],select{width:100%;padding:9px 11px;font:inherit;font-size:14px;
    background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:7px}
  input[type=text]:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
  .opt{display:flex;gap:10px;align-items:flex-start;padding:9px 11px;margin:6px 0;
    border:1px solid var(--line);border-radius:8px;cursor:pointer;background:var(--bg)}
  .opt.on{border-color:var(--accent);background:var(--accent-soft)}
  .opt input{position:absolute;opacity:0;width:0;height:0}
  .box{flex:0 0 16px;height:16px;margin-top:3px;border:1.5px solid var(--muted);border-radius:4px}
  .box.round{border-radius:50%}
  .opt.on .box{border-color:var(--accent);background:var(--accent);
    box-shadow:inset 0 0 0 3px var(--accent-soft)}
  .txt b{display:block;font-weight:560;font-size:14px}
  .txt em{font-style:normal;color:var(--muted);font-size:13px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .actions{display:flex;gap:10px;align-items:center;margin-top:24px}
  button{font:inherit;font-size:14px;font-weight:560;padding:10px 18px;border-radius:8px;cursor:pointer;border:1px solid transparent}
  .primary{background:var(--accent);color:#fff}
  .ghost{background:transparent;color:var(--muted);border-color:var(--line)}
  .note{color:var(--muted);font-size:13px;margin-left:auto}
  .done{text-align:center;padding:60px 20px}
  .done h2{font-size:20px;margin:0 0 8px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
    background:var(--bg);border:1px solid var(--line);padding:1px 5px;border-radius:4px}
  [hidden]{display:none!important}
</style></head><body>
<div class="wrap">
<header>
  <h1>ai-qa setup</h1>
  <div class="sub">${esc(defaults.name)} · ${esc(scan.facts.stack.join(", ") || "stack not detected")}</div>
</header>

<div class="score">
  <b>${scan.score}<span class="g">/100</span></b>
  <span class="g">QA readiness today &mdash; grade ${esc(scan.grade)}. This is what a tester
  could work out on their own before anyone talks to them.</span>
</div>

${gaps.length ? `<div class="gaps">
  <h3>What I could not find</h3>
  <ul>${gaps.map((g) => `<li>${esc(g.question)}</li>`).join("")}</ul>
  <p class="sub" style="margin:10px 0 0">These are not setup questions &mdash; they are what
  <code>/onboard</code> will ask your team. Nothing below needs them.</p>
</div>` : ""}

<form id="f" method="POST" action="/submit/${token}">

<fieldset><legend>The project</legend>
  <label class="field"><span>Project name</span>
    <input type="text" name="name" value="${esc(defaults.name)}" required></label>
  <div class="row">
    <label class="field"><span>Ticket key <em>&mdash; e.g. SHOP &rarr; SHOP-142</em></span>
      <input type="text" name="key" value="${esc(defaults.key)}" pattern="[A-Za-z][A-Za-z0-9]{0,9}" required></label>
    <label class="field"><span>Report language</span>
      <select name="language">${LANGUAGES.map((l) =>
        `<option value="${l}"${l === defaults.language ? " selected" : ""}>${l === "vi" ? "Tiếng Việt" : "English"}</option>`).join("")}</select></label>
  </div>
</fieldset>

<fieldset><legend>What can be tested here</legend>
  <p class="hint">Each surface switches on its own gates and its own branch of the
  verification workflow &mdash; a migration is not checked the way a screen is.</p>
  ${checkbox("surfaces", "web", defaults.surfaces.includes("web"), "Web app", "real browser, screenshots, click-path journeys")}
  ${checkbox("surfaces", "api", defaults.surfaces.includes("api"), "API / backend", "request and response recorded as evidence")}
  ${checkbox("surfaces", "database", defaults.surfaces.includes("database"), "Database", "read-only checks that confirm what really got written")}
  ${checkbox("surfaces", "mobile", defaults.surfaces.includes("mobile"), "Mobile app", "device or emulator must be up; you supply the driver")}
</fieldset>

<fieldset id="appfs"><legend>How to run it</legend>
  <p class="hint">Left empty, every case that needs a running app is reported BLOCKED
  rather than quietly skipped.</p>
  <label class="field"><span>Start command</span>
    <input type="text" name="start" value="${esc(defaults.start)}" placeholder="npm run dev"></label>
  <div class="row">
    <label class="field"><span>URL it answers on</span>
      <input type="text" name="url" value="${esc(defaults.url)}" placeholder="http://localhost:3000"></label>
    <label class="field"><span>Health path <em>&mdash; optional</em></span>
      <input type="text" name="health" value="" placeholder="/api/health"></label>
  </div>
</fieldset>

<fieldset id="mobfs" hidden><legend>Mobile</legend>
  <div class="row">
    <label class="field"><span>Platform</span>
      <select name="mobilePlatform"><option value="android">Android</option>
        <option value="ios">iOS</option><option value="flutter">Flutter</option></select></label>
    <label class="field"><span>Driver</span>
      <select name="mobileDriver"><option value="maestro">Maestro</option>
        <option value="appium">Appium</option></select></label>
  </div>
</fieldset>

<fieldset id="dbfs" hidden><legend>Database</legend>
  <p class="hint">Only the NAME of the environment variable is stored. The connection
  string itself never enters the config, and the lane never writes through it.</p>
  <label class="field"><span>Env var holding the connection string</span>
    <input type="text" name="dbUrlEnv" value="${esc(defaults.dbUrlEnv || "DATABASE_URL")}"></label>
</fieldset>

<fieldset><legend>How work reaches you</legend>
  <label class="field"><span>Where tickets live</span>
    <select name="tracker">${TRACKERS.map((t) =>
      `<option value="${t}"${t === defaults.tracker ? " selected" : ""}>${t}</option>`).join("")}</select></label>
  <p class="hint" style="margin-top:16px">Autonomy moves who presses go. It never relaxes an
  evidence rule &mdash; those are the same at every level.</p>
  ${radio("autonomy", "off", defaults.autonomy === "off", "Off", "proposes everything, changes nothing")}
  ${radio("autonomy", "assisted", defaults.autonomy === "assisted", "Assisted", "runs the verification, asks before moving a ticket or writing data")}
  ${radio("autonomy", "full", defaults.autonomy === "full", "Full", "posts verdicts and moves tickets itself; still stops at money, credentials and deletions")}
</fieldset>

<fieldset><legend>Agent tools</legend>
  <p class="hint">The same method, rendered into whatever each tool discovers natively.</p>
  ${TOOLS.map((t) => checkbox("tools", t, t === "claude-code", t, "")).join("")}
</fieldset>

<div class="actions">
  <button class="primary" type="submit">Review and install</button>
  <button class="ghost" type="button" id="cancel">Cancel</button>
  <span class="note">Nothing is written until you confirm in the terminal.</span>
</div>
</form>

<div id="done" class="done" hidden>
  <h2>Sent to the terminal</h2>
  <p class="sub">You can close this tab &mdash; the summary and the confirmation are back where you started.</p>
</div>
</div>
<script>
  const $ = (s) => document.querySelector(s);
  const syncOpt = (el) => {
    const box = el.closest(".opt");
    if (!box) return;
    if (el.type === "radio") {
      document.querySelectorAll('input[name="' + el.name + '"]').forEach((r) =>
        r.closest(".opt").classList.toggle("on", r.checked));
    } else box.classList.toggle("on", el.checked);
  };
  const surfaces = () => [...document.querySelectorAll('input[name=surfaces]:checked')].map((i) => i.value);
  const refresh = () => {
    const s = surfaces();
    $("#appfs").hidden = !(s.includes("web") || s.includes("api"));
    $("#mobfs").hidden = !s.includes("mobile");
    $("#dbfs").hidden = !s.includes("database");
  };
  document.addEventListener("change", (e) => {
    if (e.target.matches("input[type=checkbox],input[type=radio]")) { syncOpt(e.target); refresh(); }
  });
  refresh();
  $("#cancel").addEventListener("click", async () => {
    await fetch("/cancel/${token}", { method: "POST" });
    $("#f").hidden = true; $("#done").hidden = false;
    $("#done").querySelector("h2").textContent = "Cancelled";
    $("#done").querySelector("p").textContent = "Nothing was written.";
  });
  $("#f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData($("#f"));
    const body = {};
    for (const [k, v] of fd.entries()) {
      if (k === "surfaces" || k === "tools") (body[k] ||= []).push(v);
      else body[k] = v;
    }
    body.surfaces ||= []; body.tools ||= [];
    await fetch("/submit/${token}", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    $("#f").hidden = true; $("#done").hidden = false;
  });
</script>
</body></html>`;
}

/**
 * Serve the wizard and resolve with the answers, or null when cancelled.
 * Falls back to the terminal wizard if a browser cannot be opened.
 */
export async function runWizard(root, scan, flags) {
  const { detectDefaults } = await import("../cli/defaults.mjs");
  const defaults = detectDefaults(root, scan, flags);
  const token = crypto.randomBytes(12).toString("hex");
  const state = { defaults, scan, token };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      // Give the browser a moment to render its confirmation before the socket dies.
      setTimeout(() => server.close(), 400);
      resolve(value);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === `/${token}`) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderPage(state));
        return;
      }
      if (req.method === "POST" && url.pathname === `/cancel/${token}`) {
        res.writeHead(204).end();
        finish(null);
        return;
      }
      if (req.method === "POST" && url.pathname === `/submit/${token}`) {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 100_000) req.destroy(); // a setup form is never large
        });
        req.on("end", () => {
          res.writeHead(204).end();
          try { finish(normalise(JSON.parse(body), defaults)); }
          catch { finish(null); }
        });
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });

    server.on("error", async (err) => {
      console.log(`  ${c.yellow("⚠")} could not start the browser wizard (${err.message}) — using the terminal instead`);
      finish(await fallback(root, scan, flags));
    });

    server.listen(0, "127.0.0.1", async () => {
      const url = `http://127.0.0.1:${server.address().port}/${token}`;
      const opened = openBrowser(url);
      console.log(`\n  ${opened ? "Opened" : "Open this in a browser:"}  ${c.cyan(url)}`);
      console.log(`  ${c.gray("waiting for the form… (Ctrl+C to cancel)")}\n`);
      if (!opened) console.log(`  ${c.gray("no browser could be launched — the link above still works")}`);
    });
  });
}

/** The browser could not be served. Ask the same questions in the terminal
 * rather than returning nothing — a setup that dead-ends because a port was
 * busy is a setup nobody finishes. */
async function fallback(root, scan, flags) {
  const { gather } = await import("../cli/init.mjs");
  return gather(root, scan, flags);
}

/** Coerce and bound everything the browser sent. A form is untrusted input even
 * when it is your own form on your own machine. */
function normalise(raw, defaults) {
  const str = (v, d = "") => (typeof v === "string" ? v.trim().slice(0, 500) : d);
  const list = (v, allowed, d) => {
    const arr = Array.isArray(v) ? v.filter((x) => allowed.includes(x)) : [];
    return arr.length ? arr : d;
  };
  const one = (v, allowed, d) => (allowed.includes(v) ? v : d);
  const surfaces = list(raw.surfaces, SURFACES, ["web"]);
  return {
    name: str(raw.name, defaults.name) || defaults.name,
    key: (str(raw.key, defaults.key) || defaults.key).toUpperCase(),
    language: one(raw.language, LANGUAGES, "en"),
    surfaces,
    start: str(raw.start),
    url: str(raw.url),
    health: str(raw.health),
    apiBase: "",
    contract: defaults.contract || "",
    mobilePlatform: surfaces.includes("mobile") ? one(raw.mobilePlatform, ["ios", "android", "flutter"], "android") : "",
    mobileDriver: surfaces.includes("mobile") ? one(raw.mobileDriver, ["appium", "maestro"], "maestro") : "",
    dbUrlEnv: surfaces.includes("database") ? (str(raw.dbUrlEnv) || "DATABASE_URL") : "",
    schema: defaults.schema || "",
    tracker: one(raw.tracker, TRACKERS, "markdown"),
    branch: defaults.branch,
    autonomy: one(raw.autonomy, AUTONOMY, "assisted"),
    tools: list(raw.tools, TOOLS, ["claude-code"]),
  };
}
