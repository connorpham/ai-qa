# ai-qa

**An AI QA engineer you can drop into any codebase.**

It onboards the way a person does — works out what it can, says plainly what it
cannot find, asks the team the rest — and then verifies tickets against the spec
with evidence a non-programmer can read in two minutes.

It reports defects. It never fixes them, and it never invents an expected value.

```bash
npx ai-qa scan     # grade this repo: could a QA test it, and would their verdicts mean anything?
npx ai-qa init     # install the QA lane (terminal wizard, or --ui for the browser)
npx ai-qa doctor   # prove every gate still works — green doctor is the definition of installed
```

Then, inside your agent: `/onboard` · `/qa` · `/triage` · `/regress`.

---

## The problem this exists for

Ask an AI agent to test a feature and you get a confident paragraph. Ask what it
actually ran and the answer is usually: it read the code, saw a function that
looked right, and wrote "verified".

The deeper problem is older than AI. **A QA engineer joining a project cannot
test anything until they know what "correct" means here** — and on most teams
that knowledge is not written down. It lives in three people's heads. So the new
tester quietly adopts whatever the code currently does as the expected value,
and from that moment nobody is checking anything.

ai-qa attacks both:

1. **It arrives knowing nothing, and admits it.** `/onboard` tags every line it
   produces as `[OBSERVED]` (with a file citation), `[INFERRED]` (with the
   reasoning shown), `[TOLD BY <who>, <date>]`, or `[UNKNOWN]`. A dossier with no
   UNKNOWNs after a first pass is not thorough — it is fabricated.
2. **It refuses to invent an oracle.** No written spec for an area? Then a
   verification there reports *differences*, never *defects*, and the report says
   so in its first lines. That refusal is the product.

---

## `ai-qa scan` — the mirror, before you commit to anything

Read-only. No network. Works in repos without ai-qa installed. Always exits 0.

```
  QA readiness  ~/work/shop
  38/100  grade D   next.js, react · web+database

  RUN       ████████████░░░░░░  13/20  Can I start it?
  ACCESS    ██████░░░░░░░░░░░░   5/15  Can I get in?
  ORACLE    ░░░░░░░░░░░░░░░░░░   0/25  Do I know what 'correct' means?
  SURFACE   ███████████░░░░░░░   9/15  Do I know what to test?
  COVERAGE  ███████░░░░░░░░░░░   6/15  What is already covered?
  PROCESS   ██████░░░░░░░░░░░░   5/10  How does work arrive and leave?

  What I would have to ask a human before I could test this
  — these are the questions /onboard puts to the team, one at a time —

  ? [ORACLE] Where is the written description of correct behaviour? Without it every
    verdict is my opinion against the developer's — and I will not guess an expected value.
  ? [ACCESS] Which test accounts exist, one per role? A verdict with no actor is
    untraceable — half of all UI bugs are role-shaped.
```

**ORACLE carries the most weight (25 points) on purpose.** Tests written against
nothing verify nothing, so a repo with a great test suite and no specification
still scores badly — which is exactly the situation where a new tester cannot
tell a feature from a defect.

The score is not the point. **The gap list is** — it is a to-do list for the
team, phrased as the questions a new colleague would actually ask.

## `ai-qa init` — a setup that already read your repo

The scan runs first, so the wizard is short and its defaults are already right.
It asks only what your repo cannot answer, and writes nothing until you approve
the summary.

```
ai-qa init          # terminal wizard
ai-qa init --ui     # the same questions in a browser form on 127.0.0.1
ai-qa init --yes    # accept every detected default (CI-safe)
```

A value it cannot detect is left **empty**, and empty is not a default — it is a
declared unknown that the workflows report as a blocker. A guessed URL that
happens to be wrong costs more than an admitted blank.

Installs into `.ai-qa/` (gates, profiles, manifest), `docs/qa/` (the dossier and
method), and whatever each chosen agent tool natively discovers.

## The four workflows

| | What it does |
|---|---|
| **`/onboard`** | Arrive knowing nothing. Read everything that exists, draft the dossier, batch the unknowns into a short interview, then **prove the answers** by bringing the app up and walking one journey per role. Publishes `docs/qa/onboarding.md`, a risk map, three runnable charters, and a readiness verdict naming what is still missing and who owes it. |
| **`/qa`** | Verify one ticket against the spec. Derive expected values **with citations**, design 2–5 cases chosen by risk, run them for real, capture named and annotated evidence, cross-check every claim, pass the machine gate, get falsified by a fresh challenger, publish a report a non-programmer can read. |
| **`/triage`** | Turn "it's broken" into something a developer can fix today: reproduce first-hand, narrow to the minimal conditions, separate observation from theory, dedup, assign severity by consequence, file with numbered steps and evidence. |
| **`/regress`** | Build a suite people still run in six months. Promote the journeys past verifications left behind, rank by consequence × likelihood, **prove every case can fail**, quarantine flakes with a deadline, and report coverage as what is protected — never as a percentage. |

## Gates that can actually go red

Every gate ships its own `--selftest` that mutates a passing fixture and asserts
each mutation turns it red. A gate that has never failed does not exist.

| Gate | Refuses |
|---|---|
| `evd_check.py` | Missing actor, precondition, entry path, reload check, boundary case, annotation, severity, or challenger card. Catches "planned 5 cases, ran 1". **20 mutations, each proven to go red.** |
| `db_verify.py` | Any write — including one hidden inside a CTE, behind a comment, or batched after a `SELECT`. **7 reads allowed, 18 writes refused.** |
| `api_check.mjs` | Silent assertion failures; a token reaching an evidence file; an unreachable host being reported as a failure rather than as BLOCKED. |
| `annotate.py` | An "annotation" with no box and no caption — that is a copy. |
| `browser.mjs` | Falling back to headless when Playwright is missing. That is a BLOCKED run with an install command. |

`ai-qa doctor` runs all of them, checks file integrity against the manifest, and
verifies that the Node and Python config readers agree — because if they drift,
the gates read a different config than the CLI wrote.

## Rules the lane will not bend

- **The spec is the oracle** — not the ticket prose, not the code. Spec silent →
  the case is BLOCKED and escalated, never guessed.
- **A verdict needs a run that happened.** Not a status code, not a previous
  session, not the developer's demo.
- **Test data comes through the product**, under a write gate, marked `ZZTEST`,
  and cleaned up. No reverse flow → nothing is written and the case blocks.
- **The database is read-only.** It verifies writes; it never makes them.
- **Entry is a click path.** A typed address hides a missing menu item, a wrong
  permission, and an unreachable row at once.
- **No product code is ever changed.** The moment QA edits the code, nobody is
  checking it.

Every one of these has a matching entry in
[`core/doctrine/red-flags.md`](core/doctrine/red-flags.md) — the excuse, and the
gate that catches it.

## Surfaces

Chosen at init; each activates its own gates and its own branch of the workflows,
and an unchosen surface is not installed.

- **web** — headed browser, journey scripts kept as re-runnable evidence, boxed screenshots
- **api** — request and response recorded as files; the body is checked, not just the status
- **database** — read-only verification, migrations proven on a clean database, tests proven able to red
- **mobile** — device/emulator gating and evidence rules. *Honest scope: it gates the environment and the evidence; your project's Appium or Maestro setup does the driving.*

## Agent tools

One method, rendered into whatever each tool discovers natively:
**Claude Code** (`.claude/skills/`), **Cursor** (`.cursor/rules/`),
**Windsurf** (`.windsurf/workflows/`), **Codex** (`.codex/prompts/` + AGENTS.md),
**GitHub Copilot** (`.github/prompts/`).

Tools without subagents still owe the challenger pass — they run it in a fresh
chat. The requirement does not soften; only the mechanism changes.

## Updating safely

`ai-qa update` re-renders everything, then compares each file against the hash
recorded when it was written. Unchanged is ours to replace. **Drifted belongs to
you** — it is reported and left alone. Your config is never reverted.

`--dry-run` genuinely writes nothing; the e2e suite asserts it by hashing the
whole tree before and after.

## Layout

```
bin/ai-qa.mjs        scan · init · doctor · update
src/cli/             the CLI; scan.mjs holds the readiness rubric
src/ui/server.mjs    the browser wizard (local, single-use, no dependencies)
core/workflows/      onboard · qa · triage · regress   (tool-neutral)
core/doctrine/       the QA method: roles, severity, evidence, test design, red flags
core/scripts/        the gates, each with a --selftest
core/templates/      the dossier and registries a human owns after install
adapters/            one thin renderer per agent tool
profiles/            web · api · mobile · database
```

## Requirements

Node ≥ 20 · Python 3 (3.9+) for the gates · Pillow for image annotation ·
Playwright for browser runs. The last two are installed on demand and report a
loud BLOCKED with the install command rather than degrading quietly.

## Tests

```bash
npm test        # 186 conformance checks + 70 end-to-end checks
```

The e2e suite installs into a scratch repository and then tries to break each
promise: that `--dry-run` writes nothing, that `update` protects a file you
edited, that `doctor` goes red when a gate goes missing, and that a repo with
nothing detectable records empty values instead of guessing.

## Licence

MIT
