#!/usr/bin/env node
// ai-qa — an AI QA engineer you can drop into any codebase.
//
// The command surface is deliberately four verbs. A QA tool competes with
// "just ship it"; every extra verb is a reason not to bother.
import { parseArgs, c } from "../src/cli/util.mjs";

const USAGE = `
  ${c.bold("ai-qa")} ${c.gray("— an AI QA engineer you can drop into any codebase")}

  ${c.bold("ai-qa scan")}     grade this repo on one question: could a QA test it, and
                would their verdicts mean anything? Read-only, changes nothing,
                works with ai-qa not installed. Start here.
                ${c.gray("--path <dir> --verbose --json [file]")}

  ${c.bold("ai-qa init")}     install the QA lane into this repo. Asks what it cannot
                observe, writes nothing until you approve the summary.
                ${c.gray("--ui        open the browser wizard instead of the terminal one")}
                ${c.gray("--yes       accept every default (CI-safe, no prompts)")}
                ${c.gray("--name --key --language --surfaces --tracker --tools --autonomy")}

  ${c.bold("ai-qa doctor")}   prove the install works: preflight, file integrity against
                the manifest, and every gate's own --selftest. Green doctor is
                the definition of installed.
                ${c.gray("--json")}

  ${c.bold("ai-qa update")}   refresh an existing install. Files you edited are detected
                by hash and left alone — never silently clobbered.
                ${c.gray("--dry-run")}

  ${c.bold("ai-qa studio")}   open the lane in a browser on 127.0.0.1: chat with the agent
                that has these workflows installed, draw a test flow and run it,
                read the evidence. Local only, single-use token, no dependencies.
                ${c.gray("--port <n> --no-open")}

  ${c.gray("ai-qa --version · ai-qa help")}
`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0] || (flags.version || flags.v ? "version" : "help");

try {
  switch (cmd) {
    case "scan": {
      const { scan } = await import("../src/cli/scan.mjs");
      await scan(flags);
      break;
    }
    case "init": {
      const { init } = await import("../src/cli/init.mjs");
      await init(flags);
      break;
    }
    case "doctor": {
      const { doctor } = await import("../src/cli/doctor.mjs");
      await doctor(flags);
      break;
    }
    case "studio": {
      const { studio } = await import("../src/ui/studio.mjs");
      await studio(flags);
      await new Promise(() => {});   // serve until Ctrl+C
      break;
    }
    case "update": {
      const { update } = await import("../src/cli/update.mjs");
      await update(flags);
      break;
    }
    case "version": {
      const { default: pkg } = await import("../package.json", { with: { type: "json" } });
      console.log(pkg.version);
      break;
    }
    case "help":
    case "--help":
      console.log(USAGE);
      break;
    default:
      console.error(`${c.red("ai-qa:")} unknown command ${JSON.stringify(cmd)}`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (err) {
  console.error(`${c.red("ai-qa:")} ${err && err.message ? err.message : err}`);
  if (process.env.AIQA_DEBUG) console.error(err);
  process.exit(1);
}
