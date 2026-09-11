// promote.mjs — a verification that already happened becomes a flow you can run again.
//
// THE ARROW THAT WAS MISSING
//
// The /regress doctrine has said this from the start: "promote the journeys
// past verifications left behind". A case that ran once already encodes the
// hard-won knowledge — which account, which click path, which value mattered —
// and re-deriving it by hand for the next build is the manual work this tool
// exists to remove.
//
// Studio-authored cases carry `flow.json` into their evidence folder, so
// promoting one is exact: the same document, nothing re-parsed, nothing
// guessed. It comes back as a NEW flow rather than reopening the old one,
// because a past verification is a record — you fork it, you do not edit it.
//
// AGENT-WRITTEN CASES ARE A DIFFERENT STORY, AND THIS SAYS SO
//
// A case written by /qa has `journey.mjs` and no `flow.json`. We could try to
// parse that JavaScript back into nodes. We do not: an agent writes it by
// hand, in whatever style it likes, and a parser that silently mis-reads one
// would hand you a flow that LOOKS right and tests something else. Those cases
// are listed with exactly what is missing, and the fix belongs at the other
// end — /qa writing a flow.json alongside.
import fs from "node:fs";
import path from "node:path";

const CASE_DIR = /^TC_\d+(_[a-z0-9_-]+)?$/i;

function readJSON(abs) {
  try { return JSON.parse(fs.readFileSync(abs, "utf8")); } catch { return null; }
}

function field(text, key) {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text || "");
  return m ? m[1].trim() : "";
}

/**
 * Every finished case under the evidence directory, and whether it can come
 * back as a flow.
 *
 * `importable` is only ever true when a real flow.json parsed. Everything else
 * is reported with a reason a person can act on.
 */
export function pastCases(root, evidenceDir = "evd") {
  const base = path.join(root, evidenceDir);
  const out = [];
  let tickets;
  try { tickets = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch { return out; }

  for (const t of tickets.slice(0, 200)) {
    const ticketDir = path.join(base, t.name);
    let cases;
    try { cases = fs.readdirSync(ticketDir, { withFileTypes: true }).filter((e) => e.isDirectory() && CASE_DIR.test(e.name)); }
    catch { continue; }

    for (const c of cases) {
      const dir = path.join(ticketDir, c.name);
      const rel = path.posix.join(evidenceDir, t.name, c.name);
      const manifest = (() => { try { return fs.readFileSync(path.join(dir, "manifest.md"), "utf8"); } catch { return ""; } })();
      const flow = readJSON(path.join(dir, "flow.json"));
      const hasJourney = fs.existsSync(path.join(dir, "journey.mjs"));

      const entry = {
        ticket: t.name,
        case: c.name,
        path: rel,
        title: field(manifest, "TITLE") || field(manifest, "EXPECTED").slice(0, 80),
        result: field(manifest, "RESULT") || "",
        ranAt: field(manifest, "RAN-AT") || "",
        kind: field(manifest, "KIND") || "",
        as: field(manifest, "AS") || "",
        steps: 0,
        importable: false,
        reason: "",
      };

      if (flow && Array.isArray(flow.nodes) && flow.nodes.length) {
        entry.importable = true;
        entry.steps = flow.nodes.length;
        entry.name = String(flow.name || "");
      } else if (flow) {
        entry.reason = "flow.json is there but carries no steps — nothing to bring back";
      } else if (hasJourney) {
        // The agent path. Named precisely, because the fix is at the producer.
        entry.reason = "written by an agent: journey.mjs but no flow.json. Re-parsing that JavaScript could "
          + "hand you a flow that looks right and tests something else, so it is not attempted — /qa needs to "
          + "write a flow.json beside its journey.";
      } else if (manifest) {
        entry.reason = "a manifest with no flow.json and no journey.mjs — there is nothing runnable here to bring back";
      } else {
        continue;   // not a case folder at all
      }
      out.push(entry);
    }
  }
  out.sort((a, b) => String(b.ranAt).localeCompare(String(a.ranAt)) || a.ticket.localeCompare(b.ticket));
  return out;
}

/** A name that does not collide with an existing flow. `boundary_x` becomes
 *  `boundary_x_2`, then `_3` — the fork is visibly a fork. */
export function freeName(base, taken) {
  const clean = String(base || "case").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 52) || "case";
  if (!taken.includes(clean)) return clean;
  for (let i = 2; i < 100; i++) {
    const n = `${clean}_${i}`;
    if (!taken.includes(n)) return n;
  }
  return `${clean}_${Date.now().toString(36)}`;
}

/**
 * The flow document to write, from a past case.
 *
 * The RESULT is deliberately NOT carried over. A verdict belongs to the run
 * that produced it, on the code it ran against; inheriting "PASS" into a fresh
 * flow would be a claim about a build nobody has tested yet.
 */
export function flowFromCase(root, entry, takenNames, evidenceDir = "evd") {
  const abs = path.join(root, evidenceDir, entry.ticket, entry.case, "flow.json");
  const flow = readJSON(abs);
  if (!flow || !Array.isArray(flow.nodes) || !flow.nodes.length) return null;
  const name = freeName(flow.name || entry.case, takenNames);
  return {
    ...flow,
    name,
    // Where it came from, so six months later the fork explains itself.
    promotedFrom: path.posix.join(evidenceDir, entry.ticket, entry.case),
    promotedAt: new Date().toISOString(),
    // A fresh flow has not run. Anything that implies otherwise is removed.
    result: undefined,
    ranAt: undefined,
    worktree: undefined,
  };
}
