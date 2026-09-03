// update.mjs — `ai-qa update`: refresh an install without eating anyone's edits.
//
// The whole contract is one rule: a file whose hash still matches what we last
// wrote is ours to replace; a file whose hash has drifted belongs to a human
// now, and we report it rather than touching it. Silently clobbering someone's
// edited gate is how a tool gets deleted from a repo and never reinstalled.
import fs from "node:fs";
import path from "node:path";
import { gitRoot, writeIfAbsent, say, c, fail } from "./util.mjs";
import { CONFIG_NAME, configPath, loadConfig, get } from "./config.mjs";
import { ManifestGuard } from "./manifest.mjs";
import { renderTool, TOOLS, adapterMarker } from "./adapters.mjs";
import { buildPlan } from "./init.mjs";

/** Which agent tools are already installed here, by looking for each adapter's
 * marker file. Re-rendering only what exists means `update` never installs a
 * tool the user did not ask for. */
async function installedTools(root) {
  const found = [];
  for (const t of TOOLS) {
    const marker = await adapterMarker(t);
    if (fs.existsSync(path.join(root, marker))) found.push(t);
  }
  return found.length ? found : ["claude-code"];
}

export async function update(flags) {
  const root = gitRoot();
  if (!root) fail("update", "not a git repository");
  if (!fs.existsSync(configPath(root))) {
    fail("update", `no ${CONFIG_NAME} here — run \`ai-qa init\` first`);
  }

  const { default: pkg } = await import("../../package.json", { with: { type: "json" } });
  const cfg = loadConfig(root);

  // The config itself is never rewritten by update: it is the one file the user
  // is *expected* to edit, and their edits are the point of it existing.
  const a = {
    name: get(cfg, "project.name", path.basename(root)),
    key: get(cfg, "project.key", "QA"),
    language: get(cfg, "project.language", "en"),
    surfaces: get(cfg, "surfaces", ["web"]),
    start: get(cfg, "app.start", ""),
    url: get(cfg, "app.url", ""),
    health: get(cfg, "app.health", ""),
    apiBase: get(cfg, "api.base_url", ""),
    contract: get(cfg, "api.contract", ""),
    mobilePlatform: get(cfg, "mobile.platform", ""),
    mobileDriver: get(cfg, "mobile.driver", ""),
    dbUrlEnv: get(cfg, "database.url_env", ""),
    schema: get(cfg, "database.schema", ""),
    tracker: get(cfg, "tracker.provider", "markdown"),
    branch: get(cfg, "git.protected_branch", "main"),
    autonomy: get(cfg, "autonomy.level", "assisted"),
  };
  if (!Array.isArray(a.surfaces)) a.surfaces = [a.surfaces].filter(Boolean);
  if (!a.surfaces.length) a.surfaces = ["web"];

  const dry = !!flags["dry-run"];
  const tools = await installedTools(root);
  const { plan, seeds } = await buildPlan(root, a, pkg.version);
  const guard = new ManifestGuard(root, "update", { dryRun: dry });

  // The config is in the plan (init writes it); drop it so an update never
  // reverts a hand-edited config to the values it was created with.
  for (const { rel, text } of plan) {
    if (rel === CONFIG_NAME) { guard.note(rel); continue; }
    guard.write(rel, text);
  }
  // Seeds are documents a human owns: created if absent, never refreshed.
  for (const { rel, text } of seeds) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) { guard.note(rel); continue; }
    if (!dry) writeIfAbsent(abs, text);
    guard.written.push(rel);
  }

  const cfgForRender = {
    project: { name: a.name, key: a.key, language: a.language },
    app: { url: a.url, start: a.start }, surfaces: a.surfaces,
    tracker: { provider: a.tracker }, autonomy: { level: a.autonomy },
  };
  for (const tool of tools) {
    await renderTool(tool, root, cfgForRender, (rel, text) => guard.write(rel, text), { dryRun: dry });
  }

  if (dry) {
    say.head("  Dry run — nothing was written");
    console.log(`  ${c.gray(`would update ${guard.written.length} file(s), leave ${guard.skipped.length} of yours alone`)}`);
    for (const f of guard.written.slice(0, 20)) console.log(`    ${c.green("+")} ${f}`);
    if (guard.written.length > 20) console.log(`    ${c.gray(`… and ${guard.written.length - 20} more`)}`);
    for (const f of guard.skipped) console.log(`    ${c.yellow("~")} ${f} ${c.gray("(yours — untouched)")}`);
    console.log();
    return;
  }

  guard.save(pkg.version);

  say.head(`  Updated to ${pkg.version}`);
  say.ok(`${guard.written.length} refreshed · ${guard.unchanged.length} already current`);
  if (guard.skipped.length) {
    say.warn(`${guard.skipped.length} left alone because you had edited them:`);
    for (const f of guard.skipped) console.log(`      ${c.gray(f)}`);
    console.log(`      ${c.gray("delete a file and re-run update to take the new version")}`);
  }
  console.log(`\n  ${c.gray("Next:")} ${c.cyan("ai-qa doctor")}\n`);
}
