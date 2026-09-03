// api_check.mjs — make one real API call and keep the proof.
//
// A status code is not a verdict. `200 OK` carrying the wrong number is a
// defect; `422` with the documented error shape may be correct behaviour. So
// this records the REQUEST and the RESPONSE as files a reader can check, and
// lets you assert on the body, not just the line.
//
//   node .ai-qa/scripts/api_check.mjs GET /orders/4102 \
//     --out evd/SHOP-142/TC_1 --expect-status 200 --expect total=450000
//
//   node .ai-qa/scripts/api_check.mjs POST /orders --body new_order.json \
//     --out evd/SHOP-142/TC_2 --expect-status 201
//
// Auth: pass --auth-env AUTH_TOKEN and the value of that environment variable
// is sent as a bearer token. The value is NEVER written to the evidence files —
// the recorded request shows `Authorization: Bearer <$AUTH_TOKEN>`.
//
// Exit 0 = every assertion held. Exit 1 = an assertion failed (a real finding).
// Exit 2 = the call could not be made (BLOCKED, not FAILED — the difference
// matters, and conflating them is how a broken environment gets reported as a
// broken product).
//
// Prove it:  node api_check.mjs --selftest
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REDACTED = "<redacted>";

function cfg(key) {
  const r = spawnSync("python3", [path.join(HERE, "lib", "ctx.py"), key],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? String(r.stdout).trim() : "";
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const expects = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expect") { expects.push(argv[++i]); continue; }
    if (a === "--header") { (flags.header ||= []).push(argv[++i]); continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
      continue;
    }
    positional.push(a);
  }
  return { flags, positional, expects };
}

/** Dotted lookup into a parsed body: `items.0.total` */
function dig(obj, dotted) {
  let cur = obj;
  for (const k of String(dotted).split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k];
  }
  return cur;
}

/** Record the exchange. The token is replaced by the NAME of its env var, so
 * the file is committable and still tells a reader how to reproduce the call. */
function writeEvidence(dir, req, res) {
  fs.mkdirSync(dir, { recursive: true });
  const headerLines = Object.entries(req.headers)
    .map(([k, v]) => `${k}: ${v}`).join("\n");
  const httpFile = [
    `${req.method} ${req.url}`,
    headerLines,
    "",
    req.body || "",
  ].join("\n").trimEnd() + "\n";
  fs.writeFileSync(path.join(dir, "request.http"), httpFile);

  const resFile = {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body: res.json !== undefined ? res.json : res.text,
    recorded_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "response.json"), `${JSON.stringify(resFile, null, 2)}\n`);
  return [path.join(dir, "request.http"), path.join(dir, "response.json")];
}

export async function call(opts) {
  const base = (opts.base || "").replace(/\/$/, "");
  const url = /^https?:\/\//.test(opts.pathname) ? opts.pathname : `${base}${opts.pathname.startsWith("/") ? "" : "/"}${opts.pathname}`;

  const headers = { accept: "application/json" };
  for (const h of opts.headers || []) {
    const i = h.indexOf(":");
    if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
  }
  let recordedHeaders = { ...headers };
  if (opts.authEnv) {
    const token = process.env[opts.authEnv];
    if (!token) {
      return { blocked: `$${opts.authEnv} is not set · unblock: export it, or pass a different --auth-env` };
    }
    headers.authorization = `Bearer ${token}`;
    recordedHeaders.authorization = `Bearer <$${opts.authEnv}>`;
  }

  let body;
  if (opts.bodyFile) {
    if (!fs.existsSync(opts.bodyFile)) return { blocked: `no such body file: ${opts.bodyFile}` };
    body = fs.readFileSync(opts.bodyFile, "utf8");
    headers["content-type"] ||= "application/json";
    recordedHeaders = { ...recordedHeaders, "content-type": headers["content-type"] };
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { method: opts.method, headers, body, redirect: "manual" });
  } catch (e) {
    return { blocked: `${opts.method} ${url} — ${e.message} · unblock: is the app running? check app.url` };
  }
  const took = Date.now() - started;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON, keep the text */ }

  return {
    req: { method: opts.method, url, headers: recordedHeaders, body },
    res: {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      text, json, took,
    },
  };
}

function checkExpectations(res, flags, expects) {
  const failures = [];
  if (flags["expect-status"]) {
    const want = Number(flags["expect-status"]);
    if (res.status !== want) {
      failures.push(`status: expected ${want}, got ${res.status} ${res.statusText}`);
    }
  }
  for (const e of expects) {
    const i = e.indexOf("=");
    if (i < 1) { failures.push(`--expect must look like path=value (got ${JSON.stringify(e)})`); continue; }
    const key = e.slice(0, i);
    const want = e.slice(i + 1);
    const got = dig(res.json, key);
    // Compare as strings: a JSON number 450000 and the CLI's "450000" are the
    // same claim, and forcing the caller to think about types here helps nobody.
    if (String(got) !== want) {
      failures.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got === undefined ? null : got)}`);
    }
  }
  return failures;
}

async function main(argv) {
  const { flags, positional, expects } = parseArgs(argv);
  const method = (positional[0] || "GET").toUpperCase();
  const pathname = positional[1];
  if (!pathname) {
    console.log("usage: node api_check.mjs <METHOD> <path> [--out <dir>] [--expect-status N] [--expect key=value]");
    console.log("                          [--body file.json] [--auth-env VAR] [--header 'K: V'] [--base URL]");
    return 2;
  }

  const base = flags.base || cfg("api.base_url") || cfg("app.url");
  if (!base && !/^https?:\/\//.test(pathname)) {
    console.log("API: BLOCKED — no base URL · unblock: set api.base_url or app.url in aiqa.config.yaml, or pass --base");
    return 2;
  }

  const out = await call({
    method, pathname, base,
    headers: flags.header || [],
    bodyFile: flags.body && flags.body !== true ? flags.body : null,
    authEnv: flags["auth-env"] && flags["auth-env"] !== true ? flags["auth-env"] : null,
  });

  if (out.blocked) {
    console.log(`API: BLOCKED — ${out.blocked}`);
    return 2;
  }

  const files = flags.out ? writeEvidence(String(flags.out), out.req, out.res) : [];
  const failures = checkExpectations(out.res, flags, expects);

  console.log(`API: ${failures.length ? "FAIL" : "OK"}  ${method} ${out.req.url} → ${out.res.status} ${out.res.statusText} (${out.res.took}ms)`);
  for (const f of failures) console.log(`  x ${f}`);
  for (const f of files) console.log(`  · ${path.relative(process.cwd(), f)}`);
  if (!flags.out) {
    console.log("  ! no --out: this call produced no evidence file, so it cannot support a verdict");
  }
  return failures.length ? 1 : 0;
}

// ---- selftest ----------------------------------------------------------------
// Spins a real local server, because a recorder that has only been tested
// against a mock has not been tested against HTTP.
async function selftest() {
  const http = await import("node:http");
  const os = await import("node:os");
  const fails = [];
  const expect = (c, m) => { if (!c) fails.push(m); };

  const server = http.createServer((req, res) => {
    if (req.url === "/orders/4102") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 4102, total: 450000, items: [{ sku: "A", qty: 3 }] }));
    } else if (req.url === "/boom") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "nope" }));
    } else {
      res.writeHead(404); res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiqa-api-"));

  try {
    const ok = await call({ method: "GET", pathname: "/orders/4102", base });
    expect(!ok.blocked, "a live GET was reported as blocked");
    expect(ok.res.status === 200, `expected 200, got ${ok.res?.status}`);
    expect(ok.res.json.total === 450000, "the JSON body was not parsed");

    // assertions must be able to PASS and to FAIL
    expect(checkExpectations(ok.res, { "expect-status": "200" }, ["total=450000"]).length === 0,
      "a correct assertion was reported as a failure");
    expect(checkExpectations(ok.res, { "expect-status": "200" }, ["total=999"]).length === 1,
      "a wrong value did NOT fail — the assertion is decorative");
    expect(checkExpectations(ok.res, { "expect-status": "201" }, []).length === 1,
      "a wrong status did NOT fail");
    expect(checkExpectations(ok.res, {}, ["items.0.qty=3"]).length === 0,
      "dotted path into an array did not resolve");
    expect(checkExpectations(ok.res, {}, ["nope.deep=1"]).length === 1,
      "a missing path did not fail");

    // a 500 is recorded, not swallowed
    const bad = await call({ method: "GET", pathname: "/boom", base });
    expect(bad.res.status === 500, "a 500 was not recorded as 500");

    // evidence files exist and the token is NOT in them
    process.env.AIQA_TEST_TOKEN = "super-secret-value";
    const authed = await call({ method: "GET", pathname: "/orders/4102", base, authEnv: "AIQA_TEST_TOKEN" });
    const dir = path.join(tmp, "TC_1");
    writeEvidence(dir, authed.req, authed.res);
    const reqText = fs.readFileSync(path.join(dir, "request.http"), "utf8");
    expect(reqText.includes("GET "), "request.http does not record the method");
    expect(!reqText.includes("super-secret-value"), "THE TOKEN LEAKED into request.http");
    expect(reqText.includes("<$AIQA_TEST_TOKEN>"), "request.http does not name the token's env var");
    expect(fs.existsSync(path.join(dir, "response.json")), "response.json was not written");

    // a missing auth env var is BLOCKED, not a silent unauthenticated call
    delete process.env.AIQA_TEST_TOKEN;
    const noAuth = await call({ method: "GET", pathname: "/orders/4102", base, authEnv: "AIQA_TEST_TOKEN" });
    expect(!!noAuth.blocked, "a missing auth token did not block the call");

    // an unreachable host is BLOCKED, never FAILED
    const dead = await call({ method: "GET", pathname: "/x", base: "http://127.0.0.1:1" });
    expect(!!dead.blocked, "an unreachable host was not reported as blocked");
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (fails.length) {
    console.error("api_check --selftest FAILED");
    for (const f of fails) console.error(`  x ${f}`);
    return 1;
  }
  console.log("api_check --selftest passed  (live server, assertions pass and fail, token never written, unreachable = BLOCKED)");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  process.exit(argv.includes("--selftest") ? await selftest() : await main(argv));
}
