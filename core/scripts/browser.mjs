// browser.mjs — the ONE way this lane drives a browser.
//
// Two jobs, and they are both about honesty:
//
//   1. HEADED BY DEFAULT. A run someone could have watched. When a verification
//      says "I clicked Save", a human should have been able to see it happen.
//      `app.headed: never` in the config drops the visibility for unattended
//      shifts — it never drops a screenshot.
//
//   2. NAMING BY CONSTRUCTION. `shot()` builds the filename from the step
//      number and a description, so `03_total_after_save.png` is the only
//      shape that can exist. Asking politely for good filenames does not work;
//      a folder of `1.png 2.png 3.png` is what you get.
//
// Usage inside a journey script:
//
//   import { launch, shot, close } from "../../.ai-qa/scripts/browser.mjs";
//   const { page } = await launch();
//   await page.goto(process.env.APP_URL);
//   await shot(page, import.meta.dirname, 1, "sign_in_page");
//
// Preflight:  node .ai-qa/scripts/browser.mjs check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Exit 2 = BLOCKED: the run could not start. Exit 1 is reserved for a real
// finding, and every other gate here already draws that line — conflating them
// is how a laptop with no browser installed gets reported as a broken product.
const BLOCKED = 2;

const INSTALL_HINT = `Playwright is not available.

  npm install --no-save playwright
  npx playwright install chromium

This is a BLOCKED run, not a reason to fall back to headless or to skip the
screenshots. A verification nobody could have watched is a claim, not evidence.`;

/** Read one value out of aiqa.config.yaml via the Python reader, so the two
 * parsers never drift. Returns "" when anything at all goes wrong — callers
 * treat "" as "not configured", which is always the safe branch. */
export function cfg(key) {
  const r = spawnSync("python3", [path.join(HERE, "lib", "ctx.py"), key],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? String(r.stdout).trim() : "";
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

/**
 * Open a real browser window.
 * @param {{headed?: boolean, viewport?: {width:number,height:number}, storageState?: string}} opts
 */
export async function launch(opts = {}) {
  const pw = await loadPlaywright();
  if (!pw) {
    console.error(`BROWSER: BLOCKED — ${INSTALL_HINT}`);
    process.exit(BLOCKED);
  }
  const headedCfg = cfg("app.headed");
  const headed = opts.headed !== undefined ? opts.headed : headedCfg !== "never";

  const browser = await pw.chromium.launch({
    headless: !headed,
    // Slow enough that a human watching can follow what happened. This is not
    // decoration: an unwatchable run is one nobody ever checks.
    slowMo: headed ? 120 : 0,
  });
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    storageState: opts.storageState && fs.existsSync(opts.storageState) ? opts.storageState : undefined,
  });
  const page = await context.newPage();

  // Console errors are evidence too — a screen that looks fine while throwing
  // is a defect somebody will meet later.
  page.on("pageerror", (e) => console.error(`  ! page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`  ! console error: ${m.text()}`);
  });

  return { browser, context, page, headed };
}

/**
 * Screenshot a step. The filename is built for you: NN_<what_it_shows>.png
 * @param page       Playwright page
 * @param dir        the case folder (evd/<TICKET>/TC_<n>)
 * @param n          step number
 * @param what       what the image SHOWS, snake_case — "orders_list", not "step3"
 */
export async function shot(page, dir, n, what) {
  if (!what || /^step\d*$/i.test(what) || /^\d+$/.test(what)) {
    throw new Error(
      `shot(): name the file after what it SHOWS, not "${what}". ` +
      `The filenames are the first thing a reader sees.`);
  }
  const slug = String(what).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const file = path.join(dir, `${String(n).padStart(2, "0")}_${slug}.png`);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  · ${path.relative(process.cwd(), file)}`);
  return file;
}

/** Full-page variant, for the whole-screen sanity case. */
export async function shotFull(page, dir, n, what) {
  const file = await shot(page, dir, n, what);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

export async function close(handles) {
  try { await handles.context?.close(); } catch { /* already gone */ }
  try { await handles.browser?.close(); } catch { /* already gone */ }
}

// ---- preflight ---------------------------------------------------------------
async function check() {
  const pw = await loadPlaywright();
  if (!pw) {
    console.log(`BROWSER: BLOCKED\n${INSTALL_HINT}`);
    process.exit(BLOCKED);
  }
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const v = browser.version();
    await browser.close();
    const headed = cfg("app.headed") !== "never";
    console.log(`BROWSER: OK  chromium ${v}  ·  mode: ${headed ? "headed (a window you can watch)" : "headless (app.headed: never)"}`);
  } catch (e) {
    try { await browser?.close(); } catch { /* ignore */ }
    console.log(`BROWSER: BLOCKED — chromium failed to launch: ${e.message}`);
    console.log("  unblock: npx playwright install chromium");
    process.exit(BLOCKED);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "check") await check();
  else {
    console.log("usage: node browser.mjs check");
    console.log("       (as a library: import { launch, shot, close })");
  }
}
