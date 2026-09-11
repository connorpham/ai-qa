// setup.mjs — building the one command that installs the lane.
//
// Adding a project used to end at a dead end: four places told you to open a
// terminal and run `ai-qa init` yourself. The studio now removes that, and the
// way it removes it matters more than the fact that it does.
//
//   The page never sends a command. It sends FIELDS.
//
// A local page is still untrusted input, and "it is only localhost" is exactly
// how command injection gets shipped. So every field is validated here, the
// argv is built from constants plus validated values, and the result is shown
// to the person BEFORE it runs — in a terminal they watch, in their own shell.
// Nothing is written into someone's repository that they have not seen the
// command for.
//
// This lives in its own module so the validation can be tested directly,
// without standing a server up to reach it.

export const SURFACES = ["web", "api", "mobile", "database"];
export const KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;

export class Invalid extends Error {}

/** Shell-quote, but only what actually needs it — the preview is a command a
 *  person should be able to read, and paste into their own terminal unchanged. */
export function quote(a) {
  return /^[A-Za-z0-9_.:,/=-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`;
}

/**
 * @param fields  { key, surfaces, start, url, tools? } straight off the page
 * @param binPath absolute path to bin/ai-qa.mjs — never a bare `ai-qa`, which
 *                may not be on this person's PATH
 * @returns {{argv: string[], preview: string}}
 * @throws  {Invalid} with a message written for the person, not the log
 */
export function setupCommand(fields, binPath) {
  const key = String(fields?.key ?? "").trim().toUpperCase();
  if (!KEY_RE.test(key)) {
    throw new Invalid("ticket key: 1-10 letters or digits, starting with a letter");
  }

  const surfaces = (Array.isArray(fields?.surfaces) ? fields.surfaces : []).filter((s) => SURFACES.includes(s));
  if (!surfaces.length) throw new Invalid("choose at least one surface");

  const start = String(fields?.start ?? "").trim();
  const url = String(fields?.url ?? "").trim();

  // A newline would let a second command ride into the terminal behind the
  // first one. Refused before anything is built, not escaped afterwards.
  for (const [name, v] of [["start command", start], ["URL", url]]) {
    if (/[\r\n]/.test(v)) throw new Invalid(`the ${name} must be a single line`);
  }
  if (url && !/^https?:\/\//.test(url)) throw new Invalid("the URL must start with http:// or https://");

  const argv = ["node", binPath, "init", "--yes", "--key", key,
    "--surfaces", surfaces.join(","), "--tools", "claude-code"];
  if (start) argv.push("--start", start);
  if (url) argv.push("--url", url);

  return { argv, preview: argv.map(quote).join(" ") };
}
