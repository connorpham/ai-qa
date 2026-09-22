// browser.mjs — the ONE way this lane drives a browser.
//
// Three jobs, and they are all about honesty:
//
//   1. HEADED BY DEFAULT. A run someone could have watched. When a verification
//      says "I clicked Save", a human should have been able to see it happen.
//      `app.headed: never` in the config drops the visibility for unattended
//      shifts — it never drops a screenshot.
//
//   2. AT A HUMAN PACE. Headed is not the same as watchable. At Playwright's
//      own speed the click, the request and the result land inside one frame,
//      and the watcher sees a slideshow of end states — which is exactly the
//      thing a headed run existed to avoid. `app.pace` puts a real beat
//      between actions, types key by key, and lets the screen settle before
//      the shutter. A verification a human could not follow is a claim again.
//
//   3. NAMING BY CONSTRUCTION. `shot()` builds the filename from the step
//      number and a description, so `03_total_after_save.png` is the only
//      shape that can exist. Asking politely for good filenames does not work;
//      a folder of `1.png 2.png 3.png` is what you get.
//
// Usage inside a journey script:
//
//   import { launch, shot, click, typeIn, beat, close }
//     from "../../.ai-qa/scripts/browser.mjs";
//   const h = await launch();
//   await h.page.goto(process.env.APP_URL);
//   await typeIn(h.page, "#email", "qa+zztest@example.com");
//   await click(h.page, "button[type=submit]", "sign in");
//   await shot(h.page, import.meta.dirname, 1, "signed_in_home");
//     -> evd/SHOP-142/TC_1_save10_applies/TC1_01_signed_in_home.png
//
// One-off override, no config edit:  AIQA_PACE=demo node journey.mjs
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

// ---- pace --------------------------------------------------------------------
// Named paces rather than a bare number, because the number is not the
// decision — who is watching is. Each is (step: ms between actions, key: ms
// between keystrokes, settle: ms of quiet before a screenshot).
const PACES = {
  human: { step: 450, key: 55, settle: 400, note: "someone who knows the app" },
  brisk: { step: 150, key: 20, settle: 250, note: "you have watched this journey before" },
  demo:  { step: 900, key: 90, settle: 700, note: "recording, or a stakeholder is watching" },
  off:   { step: 0,   key: 0,  settle: 0,   note: "unattended" },
};

/** Resolve the pace: explicit argument, then AIQA_PACE, then `app.pace`, then
 * "human" for a headed run. A plain number of milliseconds is accepted
 * everywhere a name is — someone timing a demo should not have to edit this
 * file to get 1200ms. */
export function resolvePace(want, headed = true) {
  // Headless is nobody's demonstration: it never pays the pace cost, whatever
  // the config says, because the only thing a slow unwatched run produces is a
  // longer wait for the same screenshots.
  if (!headed) return { ...PACES.off, name: "off" };
  const raw = String(want ?? process.env.AIQA_PACE ?? cfg("app.pace") ?? "").trim();
  if (!raw) return { ...PACES.human, name: "human" };
  if (/^\d+$/.test(raw)) {
    const step = Number(raw);
    // Keystrokes and settle derive from the step so one number stays coherent.
    return { step, key: Math.min(120, Math.max(15, Math.round(step / 8))),
             settle: step, name: `${step}ms`, note: "explicit" };
  }
  const hit = PACES[raw.toLowerCase()];
  if (!hit) {
    console.error(`  ! unknown pace ${JSON.stringify(raw)} — using human. ` +
      `Valid: ${Object.keys(PACES).join(", ")}, or a number of ms.`);
    return { ...PACES.human, name: "human" };
  }
  return { ...hit, name: raw.toLowerCase() };
}

// The pace of the run currently in flight. Set by launch(), read by the
// helpers below, so a journey script never has to thread it through.
let PACE = { ...PACES.off, name: "off" };

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
 * @param {{headed?: boolean, pace?: string|number, viewport?: {width:number,height:number}, storageState?: string}} opts
 */
export async function launch(opts = {}) {
  const pw = await loadPlaywright();
  if (!pw) {
    console.error(`BROWSER: BLOCKED — ${INSTALL_HINT}`);
    process.exit(BLOCKED);
  }
  const headedCfg = cfg("app.headed");
  const headed = opts.headed !== undefined ? opts.headed : headedCfg !== "never";

  PACE = resolvePace(opts.pace, headed);

  const browser = await pw.chromium.launch({
    headless: !headed,
    // Slow enough that a human watching can follow what happened. This is not
    // decoration: an unwatchable run is one nobody ever checks.
    slowMo: PACE.step,
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

  if (headed) {
    console.log(`  · browser: headed · pace: ${PACE.name} ` +
      `(${PACE.step}ms per action — ${PACE.note})`);
  }

  return { browser, context, page, headed, pace: PACE };
}

/** Click the way a person does: put the pointer on the thing first, let it be
 * seen there, then press. Playwright's own click already moves a real mouse to
 * the element — the pause is what makes it legible to a watcher, and it is
 * also where a hover-only menu or a tooltip gets its chance to appear. */
export async function click(page, selector, why) {
  if (why) console.log(`  … ${why}`);
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded().catch(() => { /* already in view */ });
  await target.hover().catch(() => { /* not hoverable — the click still stands */ });
  if (PACE.step) await page.waitForTimeout(Math.round(PACE.step / 2));
  await target.click();
}

/** Type key by key, the way the user will. `fill()` sets the value and fires a
 * single `input` event — and NO key events at all. Every keydown/keypress/keyup
 * handler your users hit is therefore skipped: input masks, digit-only filters,
 * character counters, autocomplete dropdowns, Enter-to-submit. A field that
 * `fill()` accepts can be one a human physically cannot type into. */
export async function typeIn(page, selector, text, why) {
  if (why) console.log(`  … ${why}`);
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded().catch(() => { /* already in view */ });
  await target.click();
  if (typeof target.pressSequentially === "function") {
    await target.pressSequentially(String(text), { delay: PACE.key });
  } else {
    await page.type(selector, String(text), { delay: PACE.key });   // playwright < 1.38
  }
}

/** A deliberate pause between logical steps — the beat where a real user reads
 * the screen before deciding what to do next. Free in an unattended run. */
export async function beat(page, why, factor = 1) {
  if (why) console.log(`  … ${why}`);
  if (PACE.step) await page.waitForTimeout(Math.round(PACE.step * factor));
}

/**
 * Screenshot a step. The filename is built for you:
 *   TC<case>_NN_<what_it_shows>.png
 * @param page       Playwright page
 * @param dir        the case folder (evd/<TICKET>/TC_<n>_<what_it_proves>)
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
  // The case number is taken from the folder the journey runs in rather than
  // asked for, because a screenshot leaves its folder almost immediately —
  // into a ticket, a chat, a slide — and out there `03_total.png` belongs to
  // nothing. Nobody has to remember to pass it, so it is always there.
  const caseNo = /^TC_(\d+)(?:_|$)/.exec(path.basename(dir));
  const file = path.join(dir, `${caseNo ? `TC${caseNo[1]}_` : ""}${String(n).padStart(2, "0")}_${slug}.png`);
  fs.mkdirSync(dir, { recursive: true });
  // Let the screen finish arriving. A shutter fired mid-transition produces a
  // half-rendered image that reads as a defect to everyone who sees it later.
  if (PACE.settle) await page.waitForTimeout(PACE.settle);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  · ${path.relative(process.cwd(), file)}`);
  return file;
}

/**
 * A screenshot that explains itself.
 *
 * The complaint that produced this was exact: "evd thiếu khoanh vùng chỗ kiểm
 * thử · nhìn vào hình ảnh không biết đang làm gì cả." Both halves were true.
 * A plain screenshot of a whole page asks the reader to guess which pixels
 * carried the verdict, and tells them nothing about what was being checked —
 * and the reader is usually the person who was not there, months later.
 *
 * So the image carries its own context, burned in:
 *
 *   a header strip   which ticket, which case, which step of how many, and
 *                    what this step was trying to establish
 *   a box            on the element the check actually read — drawn from the
 *                    SELECTOR the case already declares, so nobody picks
 *                    coordinates by hand and nobody can box the wrong thing
 *   a caption        expected · actual · where it is written down · the verdict
 *
 * Drawn in the page before the shutter rather than composited afterwards:
 * pixel-exact by construction, no image library, no second process. The
 * overlay is `position: fixed`, `pointer-events: none`, and removed straight
 * after — it cannot move the layout it is describing.
 *
 * A selector that matches nothing does NOT fall back to an unboxed image: the
 * header says so, in red. "I could not find what I was told to look at" is a
 * finding, and hiding it behind a clean screenshot is the failure this whole
 * tool exists to refuse.
 */
export async function shotAnnotated(page, dir, n, what, opts = {}) {
  const { selector = "", proves = "", expected = "", actual = "", cite = "", verdict = "", title = "" } = opts;

  // Two arguments are refused rather than defaulted, because both of them are
  // the complaint this function exists to answer. A helper that lets you take
  // an unexplained screenshot would leave the problem exactly where it was.
  if (!selector) {
    throw new Error("shotAnnotated(): `selector` is required — the box is drawn from the selector the "
      + "check already reads, so nobody picks coordinates by hand and nobody can box the wrong element.");
  }
  if (!proves) {
    throw new Error("shotAnnotated(): `proves` is required — one line saying what this image shows. "
      + "A reader who was not there has nothing else to go on.");
  }

  const caption = [proves, expected ? `must read ${expected}` : "", actual ? `actually read ${JSON.stringify(actual)}` : ""]
    .filter(Boolean).join("  ·  ");
  let missing = false;
  let overlayError = "";

  if (PACE.settle) await page.waitForTimeout(PACE.settle);
  try {
    missing = await page.evaluate(({ selector, title, caption, verdict, cite, what }) => {
      const OLD = document.getElementById("__aiqa_overlay__");
      if (OLD) OLD.remove();
      const box = document.createElement("div");
      box.id = "__aiqa_overlay__";
      box.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif";

      let el = null;
      try { el = selector ? document.querySelector(selector.replace(/^text=/, "")) : null; } catch { el = null; }
      if (!el && selector.startsWith("text=")) {
        const needle = selector.slice(5).toLowerCase();
        el = [...document.querySelectorAll("button,a,label,span,div,td,th,p,h1,h2,h3")]
          .find((x) => x.textContent.trim().toLowerCase() === needle) || null;
      }
      const notFound = !!selector && !el;

      const ok = String(verdict).toUpperCase() === "PASS";
      const accent = notFound ? "#e40014" : ok ? "#00a544" : verdict ? "#e40014" : "#dd7400";

      // The header carries EVERYTHING a reader needs, and carries it in the
      // same place every time. The first version floated the caption next to
      // the box, where it sat on top of the very content the reader was trying
      // to check — the line below the one being verified.
      // If the thing being checked sits at the very top of the page, a header
      // pinned to the top would cover the evidence it is describing. It moves
      // to the bottom instead — the one place it can never hide the subject.
      const rTop = el ? el.getBoundingClientRect().top : 999;
      const atBottom = rTop < 66;
      const head = document.createElement("div");
      head.style.cssText = `position:absolute;left:0;right:0;${atBottom ? "bottom:0" : "top:0"};background:${accent};color:#fff;padding:8px 12px;display:flex;flex-direction:column;gap:2px`;
      const l1 = document.createElement("div");
      l1.style.cssText = "font-weight:600;display:flex;gap:10px;align-items:baseline";
      const h1 = document.createElement("span"); h1.textContent = title || what;
      const h2 = document.createElement("span"); h2.style.cssText = "font-weight:700;letter-spacing:.04em";
      h2.textContent = notFound ? `COULD NOT FIND ${selector}` : (verdict || "");
      l1.append(h1, h2);
      const l2 = document.createElement("div");
      l2.style.cssText = "font-weight:400;opacity:.95";
      l2.textContent = [caption, cite].filter(Boolean).join("   ·   ");
      head.append(l1); if (l2.textContent) head.append(l2);
      box.append(head);

      if (el) {
        const r = el.getBoundingClientRect();
        const pad = 6;
        const ring = document.createElement("div");
        ring.style.cssText = `position:absolute;left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;border:3px solid ${accent};border-radius:6px;box-shadow:0 0 0 3px #fff, 0 0 0 9999px rgba(10,10,10,.10)`;
        box.append(ring);

      }

      document.body.append(box);
      return notFound;
    }, { selector, title, caption, verdict, cite, what });
  } catch (e) {
    // NEVER silent. A swallowed failure here produced the worst possible
    // artefact: a bare screenshot named `_boxed`, with a sidecar swearing the
    // element was found. The shot still goes out — a picture of the moment is
    // better than none — but it goes out ADMITTING it is unannotated, and the
    // sidecar records that too.
    overlayError = String(e && e.message ? e.message : e).split("\n")[0];
    console.error(`  ! shotAnnotated could not draw the overlay: ${overlayError}`);
  }

  const slug = String(what).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const caseNo = /^TC_(\d+)(?:_|$)/.exec(path.basename(dir));
  const file = path.join(dir, `${caseNo ? `TC${caseNo[1]}_` : ""}${String(n).padStart(2, "0")}_${slug}_boxed.png`);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  try { await page.evaluate(() => document.getElementById("__aiqa_overlay__")?.remove()); } catch { /* gone */ }

  // The same words go into a sidecar, so the requirement stops being "a file
  // whose NAME ends in _boxed" — which an unannotated screenshot satisfies —
  // and becomes "this image declares what it proves", which evd_check reads.
  const sidecar = path.join(dir, "shots.json");
  let shots = [];
  try { shots = JSON.parse(fs.readFileSync(sidecar, "utf8")); } catch { shots = []; }
  if (!Array.isArray(shots)) shots = [];
  shots = shots.filter((s) => s.file !== path.basename(file));
  shots.push({
    file: path.basename(file), proves, selector, expected, actual, cite, verdict,
    selectorFound: !missing && !overlayError,
    annotated: !overlayError,
    ...(overlayError ? { overlayError } : {}),
    at: new Date().toISOString(),
  });
  fs.writeFileSync(sidecar, `${JSON.stringify(shots, null, 2)}\n`);

  console.log(`  · ${path.relative(process.cwd(), file)}${missing ? "  ! selector matched nothing — the image says so, in red" : ""}`);
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
    const p = resolvePace(undefined, headed);
    console.log(`BROWSER: OK  chromium ${v}  ·  mode: ${headed ? "headed (a window you can watch)" : "headless (app.headed: never)"}`);
    console.log(`             pace: ${p.name} · ${p.step}ms per action, ${p.key}ms per keystroke — ${p.note}`);
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
