---
name: qa
description: "Verify one ticket a developer has claimed done, against the spec, with evidence — and change no product code. Reads the ticket, the spec and the schema to derive what SHOULD happen (citing each source), designs 2-5 test cases chosen by risk (exact acceptance path, a boundary that must behave the other way, whole-screen sanity, and a read-back check for anything that writes), creates any missing data the way a user would through the real UI under a write gate, runs every case for real on the active surfaces, captures named and annotated evidence, cross-checks every claim in the ticket against a file that proves it, passes the machine evidence gate, gets falsified by a fresh challenger, and publishes a report a non-programmer can read in two minutes. It reports defects; it never fixes them."
argument-hint: "<TICKET: {project.key}-nnn | tracker URL> [base=<url overriding app.url for this run>]"
---

# /qa — does it actually do what the spec says?

**What this workflow never does:** edit product code, fix a defect it found,
widen the developer's scope, or produce a verdict from reading code. It answers
one question with evidence: **does the product now behave the way the spec says,
for the requirement this ticket describes — without breaking anything around it?**

---

## Immutable principles

Violating any of these means the verification did not happen, whatever the
report says.

1. **The spec is the oracle.** "Done" means the product matches the written
   specification (plus the schema for data rules) — not that it matches the
   ticket's prose, and not that no error appeared. Every expected value cites
   its source. Ticket contradicts spec → the spec wins, and the contradiction
   is a finding. Spec silent or self-contradictory → that case is **BLOCKED and
   escalated for a decision**. You never invent an expected value.

   `oracle.specs` empty in `aiqa.config.yaml` → say so in the report's first
   line. A verdict with no oracle is an opinion, and it must be labelled one.

2. **Real runs only.** Every verdict comes from something you executed this
   session against the running product. Never from reading code, never from an
   HTTP status alone, never from a previous run, never from the developer's
   demo. A step you could not run is BLOCKED with the reason and the unblock
   path.

3. **Reading code tells you WHERE to look, never WHAT is correct.** Which route,
   which role gate, which table — yes. What the value should be — never.

4. **Test data comes through the real flow.** Missing data is created the way a
   user creates it: sign in, navigate, act. Direct SQL or ORM writes are
   forbidden as a test path; the database is read-only here, used to *verify*
   writes. Every write follows the write gate in `autonomy.write_gate`:
   - `ask` — stop and ask before each write, showing screen, action, exact
     values, and how you will clean up.
   - `minutes-first` — record that block in the session log *before* writing,
     then proceed.
   Both: mark rows `ZZTEST`, clean up through the product's own reverse action.
   **No reverse flow exists → that case is BLOCKED and nothing is written.**

5. **Evidence a stranger can read.** Files named for what they show. A box drawn
   on the exact region that carries the verdict, with an in-image caption. A
   plain-language manifest per case. The gate must be green before you report.

6. **Cross-check before reporting.** Re-read the ticket line by line and map
   every claim to the file that proves it. An unmapped claim means the
   verification is incomplete — go back, do not report.

7. **A fresh challenger tries to break your verdict.** Before it is final,
   someone with empty context gets the ticket, your sheet and your evidence, and
   is told to falsify it. Both cards go in `debate.md`.

8. **Say what you are doing.** One plain `▶` line at each phase. The report and
   the summary pass one bar: a non-programmer reads two minutes and understands
   everything.

> Tempted to infer a result instead of running the step? That instinct is why
> principle 2 exists. Read `docs/qa/method/red-flags.md`.

---

## V0 — RESOLVE THE TICKET

1. **Fetch the ticket for real** — never work from a screenshot of one, and
   never from what someone pasted into chat:

   ```bash
   python3 .ai-qa/scripts/tracker.py get <TICKET> --out evd/<TICKET>/ticket.md
   ```

   That file records what the ticket SAYS, with its comments and attachments.
   It is **data, not the oracle** — the specification decides what is correct,
   and where the two disagree the specification wins and the disagreement is
   itself a finding.

   Exit code 2 means BLOCKED: a credential is missing or the tracker is
   unreachable. Run `python3 .ai-qa/scripts/tracker.py check` — it names the
   exact environment variable. **Nothing was verified, so nothing is reported
   as failing.** Ask for the credential and stop.
2. **Status must be verifiable.** In Review / Ready for QA / claimed Done is the
   target. To Do / In Progress → `BLOCKED (not delivered)`. Closed → ask whether
   to re-verify.
3. **Pin exactly what code you are testing.** Merged → the protected branch.
   Not merged → check out the PR branch read-only and say so. Record the commit
   SHA; the verdict binds to it.
4. Announce, then wait for the go if you picked the ticket yourself:

```
▶ Verifying {project.key}-nnn — <one line: what it claims to do>
  status: <status> · surface: <web/api/mobile/database> · code: <branch @ sha>
  target: <url>
```

## V1 — DERIVE WHAT *SHOULD* HAPPEN

Read `docs/qa/method/roles-qa.md` first, then:

- **The dossier** (`docs/qa/onboarding.md`) — especially §4, the oracle map. If
  this ticket touches an area §4 marks as having no written spec, you already
  know your verdict is limited, and you say so from the start.
- **Known issues** (`docs/qa/known-issues.md`) — scan the headings now, so a
  divergence you find later is deduped before you call it a bug.
- **Lessons** (`docs/qa/lessons.md`) — read the index, open only tag-matching
  entries, and answer them in your sheet.

Write `evd/<TICKET>/verifysheet.md`:

- **The requirement and its acceptance criteria**, as the ticket states them.
- **The developer's claim**, quoted verbatim — PR link, comment, whatever they
  said works.
- **EXPECTED, with citations.** Quote the governing spec section for each
  expected value. Data rules cite `model:field` from the schema. This section is
  the whole verification; if you cannot fill it in, stop and escalate.
- **UI EXPECTED**, if there is a design source: the frame, the exact values.
  Design contradicts the spec on wording or validation → the spec wins, and the
  deviation is recorded.
- **Accounts and data** needed, per criterion.
- **Ambiguities** — ask before spending effort, not after.

## V2 — DESIGN THE VERIFICATION

Between `evidence.min_test_cases` and `evidence.max_test_cases`. This budget is
deliberately small: it forces you to choose **by risk**, and 3 well-aimed cases
beat 30 shallow ones. Allocate the way failure hurts — a wrong balance outranks
a wrong colour, always.

Required shapes:

- **① The exact acceptance path** — the criterion as specified.
- **② A boundary that must behave the OTHER way** — the empty value, the
  duplicate, the insufficient balance, the cancelled record, the day before the
  cutoff. A change that overshoots its scope is a defect too.
- **③ Whole-screen sanity** (`evidence.require_whole_screen`) — the rest of the
  screen or flow still behaves. Fixes break neighbours.
- **④ Write → read-back** (`evidence.require_db_verify`) — anything that writes
  gets verified by reading the row back after the action, plus the rollback path
  if one is specified.

**Per case, write the JOURNEY — you are a person using a product, not a script
hitting a route.** The gate requires these by name:

- **AS** — which account, which role. A verdict with no actor is untraceable.
- **PRECONDITION** — what must already be true, resolved read-only right now.
  Never trust an id from the ticket to still exist.
- **ENTRY** — where the user starts and what they click to arrive. Sign in →
  which list → which row → which button. **Typing an address proves the address,
  not the product**: it hides a missing menu item, a wrong permission and an
  unreachable row simultaneously. Keep the deep link as a *second* path if
  useful, never the only one.
- **STEPS** — numbered, in the order a person does them, each screenshotted.
- **EXPECTED** — spec-cited, and the region you will box.
- **AFTER** — what changed: the message, the row in the list behind, and the
  value **still there after a reload** (`evidence.require_reload_check` — a save
  that dies on refresh is not a save).
- **BACK** — Back, Cancel, browser-back. Does the filter survive? Does Cancel
  actually cancel? This is where "it works" usually stops working.

**Then the fields the report is built from.** The journey is what you did; these
are what turn a folder of prose into a row somebody can sort, count and act on:

- **TITLE** — one line naming what this case checks.
- **KIND** — `acceptance` / `boundary` / `whole-screen` / `write-readback` /
  `exploratory`, so the suite can prove the boundary case was designed at all.
- **REQUIREMENT** — the spec ids this case checks (`3.2 R1; 3.3`). Without it
  the traceability matrix has to guess them out of your EXPECTED prose, and a
  citation a tool guessed at is worth exactly as much as no citation.
- **On a case whose RESULT is FAIL, two more, and neither is optional:**
  - **SEVERITY** — `Blocker` / `Critical` / `Major` / `Minor`, by consequence,
    per `docs/qa/method/severity.md`.
  - **ORIGIN** — `DEV` (the code diverges from a correct spec) or `SPEC` (the
    specification is itself wrong or missing).
  - **FINDING** — one line describing the *defect*, not the case. The title
    says what you checked; this says what is wrong.
  - **RECOMMENDATION**, optional — what to do about *this* defect. Leave it out
    and the report falls back to the recommendation you wrote for the ticket,
    labelled as ticket-wide, because advice about the ticket is not advice about
    one defect among three.

  Severity written only into the report's prose does not count. A sentence
  cannot be counted, filtered or ranked, and a report naming one severity
  cannot say which of three failed cases it grades — so that defect stays
  ungraded, and every report built from the pack says so out loud.

## V2b — BRING THE ENVIRONMENT UP

Follow the Environment block at the top of this file. Quote the `APP: UP` line
into the sheet — that line is your bring-up proof. Resolve a test account per
role you need, read-only. No usable account → V3.

## V3 — CREATE MISSING DATA, THE WAY A USER WOULD

Only if V2 found gaps. Trace the flow that *produces* the record and drive it
like a person. Follow the write gate (principle 4). Capture the run under
`evd/<TICKET>/data_prep/`. Producing flow does not exist or depends on something
unavailable → that case is `BLOCKED (missing data)` with what you tried. Never
fake it, never reach into the database.

## V4 — RUN IT

Announce each case in one line: which case, which account, what it proves.
Then walk the journey you wrote — from ENTRY, clicking what a user clicks.

<!-- surface:web -->
**Web.** One journey script per case, kept as evidence:
`evd/<TICKET>/TC_<n>/journey.mjs`, importing `launch`/`shot` from
`.ai-qa/scripts/browser.mjs`, walking exactly the V2 journey and calling
`shot(page, dir, n, "<what_it_shows>")` at each meaningful step — the helper
enforces `NN_<what>.png` naming by construction. `node TC_<n>/journey.mjs` opens
a real browser window the owner can watch, moving at a human pace.

Use `click(page, sel, "<why>")` and `typeIn(page, sel, value)` rather than
`page.click`/`page.fill` for anything a user does by hand: the helpers hover
before pressing and type key by key, which is both watchable and a **truer
input** — `fill()` sets the value with one `input` event and no key events at
all, so input masks, digit-only filters, character counters and
Enter-to-submit never run. A value `fill()` accepts can be one no human could
have typed. `beat(page, "<what the user is reading>")` marks a pause where a person
would stop and look. **The script stays in the folder**:
it is evidence, and the next round re-runs the same journey against a new build
instead of re-improvising it.

Then box the region that carries the verdict — required on every executed case,
not only failures (`evidence.require_annotation`):

```bash
python3 .ai-qa/scripts/annotate.py box \
  --img evd/<TICKET>/TC_<n>/03_result.png --rect X,Y,W,H \
  --label "TC_<n>: <what this proves, or what diverges>" \
  --out evd/<TICKET>/TC_<n>/03_result_boxed.png
```

An unannotated full-page screenshot makes the reader guess which pixels
mattered; the caption is what a stranger reads instead of asking you.
<!-- /surface -->

<!-- surface:api -->
**API.** `node .ai-qa/scripts/api_check.mjs <method> <path> [--body f.json]`
writes the real request and real response into the case folder. Check the BODY
against the contract, not just the status. A 200 carrying the wrong number is a
defect; a 500 with the correct error shape may not be.
<!-- /surface -->

<!-- surface:database -->
**Database.** `python3 .ai-qa/scripts/db_verify.py --sql <file>` — SELECTs only,
recorded with their real output into `db_verify.md`. Cite the rule id being
checked.
<!-- /surface -->

<!-- surface:mobile -->
**Mobile.** Prove the device is up first (`device_check.sh`), then drive the
real app. Screenshots come off the device.
<!-- /surface -->

### The no-screen branch

A migration, a shared function, a background job — no screen to photograph, and
these are the foundation everything else stands on. Same oracle, same rule that
you run things yourself. Each case needs all four:

1. **Migrations run on a CLEAN database**, not only the developer's. Scratch DB
   → migrate → status clean. A migration that only works where old data masks
   the flaw is a broken migration.
2. **Spec-mandated invariants checked by read-only SELECT**, citing the rule id.
3. **The existing tests must go RED when the behaviour is flipped.** Break one
   core constraint temporarily, run the tests, confirm they fail *in the right
   place*, restore, and `git diff` clean. A green test proves nothing; a test
   that reds where it should is proof the test is real.
4. **A boundary you invented**, not one taken from the developer's tests. They
   tested their understanding; you probe where that understanding could be wrong.

The evidence gate accepts a case with no images when its manifest declares
`TYPE: NON-UI` — but then `db_verify.md` or `cmd_verify.md` is mandatory. No
images and no verification file is not verification.

### Evidence layout

```
evd/<TICKET>/
├── manifest.md          # plain language: the requirement, each verdict — and the
│                        # generated index block (see below)
├── verifysheet.md       # V1/V2: expected values with citations, the journeys
├── debate.md            # V6: your card, the challenger's card, the resolution
├── REPORT.md            # V5b: what a non-programmer reads
├── <TICKET>_testcases.xlsx  # V7: the same record as a spreadsheet (generated, never edited)
├── data_prep/           # V3 runs, if any
└── TC_<n>_<what_it_proves>/
    ├── journey.mjs      # the run itself — re-runnable evidence
    ├── manifest.md      # TITLE / KIND / RESULT / AS / PRECONDITION / ENTRY /
    │                    # STEPS / EXPECTED / REQUIREMENT / ACTUAL / AFTER /
    │                    # BACK — plus SEVERITY / ORIGIN / FINDING when it FAILED
    ├── TC<n>_01_*.png … # case number + step + what it shows, + *_boxed.png
    ├── request.http     # API cases: the real request
    ├── response.json    # API cases: the real response
    └── db_verify.md     # write cases: the read-only SELECT and the rows after

```

**The folder names are the report's table of contents.** `TC_2/` makes the
reader open a file to learn what case 2 even was; `TC_2_expired_code_is_refused/`
does not. `shot()` stamps the case number into every filename for the same
reason — a screenshot leaves its folder almost immediately, and out there
`03_total.png` belongs to nothing. Both are gated.

Write the index, then gate. The index is generated from the case manifests, so
it cannot describe a folder that is no longer there:

```bash
python3 .ai-qa/scripts/evd_index.py --evd evd/<TICKET>
```

It rewrites one marked block inside `evd/<TICKET>/manifest.md` — a table of
case, what it proves, kind, result, and which file to open — and leaves your
prose alone. `evd_check.py` reds a stale one.

Gate before moving on — pass the number of cases you PLANNED, so "planned 5,
ran 1" can go red:

```bash
python3 .ai-qa/scripts/evd_check.py --evd evd/<TICKET> --expect-tcs <N>
```

## V5 — CROSS-CHECK AGAINST THE TICKET

A table in the sheet, one row per claim in the ticket *and* in the developer's
delivery comment: `claim → case → evidence file → matches spec?`

- A claim with no evidence row = INCOMPLETE. Back to V2/V4. Do not report.
- Criterion met but a NEW divergence appeared nearby → verdict `NEW-BUG` for
  that finding, with evidence. Report it; never fix it here.
- Ticket described the behaviour wrongly but the product still diverges from the
  spec → the verdict follows the real divergence, and you note the correction.

## V5b — WRITE THE REPORT

`evd/<TICKET>/REPORT.md`, in `{project.language}`, black-box voice, zero jargon
in the body — no file paths, no route names, no "oracle" (those go in the
appendix). Bar: **a non-programmer reads it in two minutes and understands
everything.**

```markdown
# <TICKET> — <PASS / FAIL / PARTIAL / NEW-BUG / BLOCKED / UNCLEAR>
COMMIT: <sha the cases ran against>
VERIFIED-AT: <ISO timestamp>
ORACLE: <spec files cited — or "NONE: this verdict compares against nothing written">

## 1. What was asked for? (told as a user)
On <screen>, when <the user does what>, the product must <outcome> — per <source>.
The developer reports it done.

## 2. How I checked
| # | What I did (account, screen, action, data) | Expected | Actual | Match? |

## 3. Evidence
One line per file: path → what that file shows.

## 4. Conclusion
1-3 sentences. Requirement met or not · new findings or none · recommendation.
Each finding adds: **Severity** (Blocker/Critical/Major/Minor — definitions in
docs/qa/method/severity.md) and **Origin** (DEV: code diverges from the spec ·
SPEC: the specification itself is wrong or missing).

## 5. If BLOCKED — why, and what is needed
Could not verify <what> because <reason> · Tried: <what> · To unblock: <who/what>.

## Appendix
Verify sheet · spec citations · debate.md · remaining evidence files.
```

## V6 — THE CHALLENGER

1. Write **your** card into `debate.md` first: verdict, strongest evidence, and
   `MY WEAK SPOT:` — the one thing most likely to be wrong. Writing it before
   the challenger arrives is what stops you defending instead of thinking.
2. Spawn ONE fresh agent with empty context. Give it the ticket verbatim, the
   sheet, the evidence paths, the report, and this brief: *"Falsify this
   verification. Wrong role or account? A difference that is really about data,
   not behaviour? A boundary never tested? Evidence that is stale or does not
   show what its caption claims? Any sentence in the report a non-technical
   reader could not follow? Return your own card."*
3. Challenger finds a hole → **run the decisive experiment**. Never argue in
   prose. Append the resolution and a `Remaining dissent:` line.
4. Agreement reached without any run that actually executed = UNCLEAR, not PASS.

## V7 — REPORT AND CLOSE

1. Finalise the report with the challenger's readability fixes. Re-run
   `evd_check.py` — green. Then produce the spreadsheet, because most of the
   people this verdict is for will never open a markdown file:

   ```bash
   python3 .ai-qa/scripts/xlsx_export.py --evd evd/<TICKET> --strict
   ```

   It writes `evd/<TICKET>/<TICKET>_testcases.xlsx` — the same record, nothing
   added, laid out to ISO/IEC/IEEE 29119-3: a summary that answers *how many
   defects and how bad is the worst one* on the first screen, the cases as a
   test case specification, the defects as an incident report graded by
   severity, a requirement traceability matrix, and an index of every evidence
   file. `--strict` exits 1 while any field the report needs is still
   undeclared, and names it. Fill those in and re-run — never hand over a
   workbook whose severity column reads NOT DECLARED. It is generated: fix the
   pack, never the spreadsheet, or the two stop agreeing and only one of them
   has the evidence behind it.
2. **Summarise to the user**: verdict, the V5 table, evidence paths, new
   findings, remaining dissent.
3. **Comment on the ticket** once both machine gates are green, and attach the
   images — they live outside git, so the tracker is the only place they
   survive the session:

   ```bash
   python3 .ai-qa/scripts/tracker.py comment <TICKET> --body-file evd/<TICKET>/REPORT.md
   python3 .ai-qa/scripts/tracker.py attach  <TICKET> evd/<TICKET>/TC_*/*_boxed.png \
     evd/<TICKET>/<TICKET>_testcases.xlsx --record evd/<TICKET>/manifest.md
   ```

   `--record` writes a TRACKER ATTACHMENTS section into the manifest, so a
   clean checkout can still say what was captured after the pixels are gone.
4. **Transition the ticket** with
   `python3 .ai-qa/scripts/tracker.py transition <TICKET> "<status>"`, per
   `autonomy.level`:
   - `off` — propose; a human moves it.
   - `assisted` — PASS with a merged PR and green CI → propose the move and
     wait. FAIL/NEW-BUG → propose returning it with the report linked.
   - `full` — do it: PASS → Done. FAIL/NEW-BUG → back to To Do with a `reopen`
     label and a comment linking the report. Blocker/Critical findings become
     the next item, before any new ticket.
5. **Commit the text dossier** — report, manifests, sheet, debate, db_verify.
   Images and the `.xlsx` stay out of git: one is binary, the other is
   regenerated from the text in a second, and a spreadsheet in a diff is a
   spreadsheet nobody can review. A verdict that lives on one machine is not
   reproducible, and an unreproducible verdict is a fabricated one.
6. **Clean up** the `ZZTEST` data through the product's reverse flow; record any
   residue in the manifest.
7. **A finding outside this ticket's scope** gets its own bug report — deduped
   against known-issues first, then filed with: environment, numbered steps to
   reproduce, expected (cited), actual, severity, and the evidence path.
8. **Close the learning loop.** Append a lesson to `docs/qa/lessons.md`, even
   after a FAIL or a BLOCKED run — or state explicitly that there was none.
   Prefer graduating it: gate-shaped → into `evd_check.py`; recurring
   environment quirk → into known-issues; unconditional → into this workflow.
   Then delete it from lessons. A lesson that keeps being violated is not a
   lesson, it is a missing gate.

---

## Definition of Done

- [ ] Status verifiable; the exact code under test pinned by branch and SHA
- [ ] Every expected value derived from the spec or schema **with a citation** —
      never from the ticket prose, never from the code
- [ ] No written oracle → the report says so in its first lines and the verdict
      is labelled an opinion, not a fact
- [ ] Every case ran for real this session; bring-up proven by the quoted
      `APP: UP` line; blocked cases carry reason and unblock path
- [ ] Boundary case and whole-screen case both ran — not only the happy path
- [ ] Web cases walked from ENTRY as a click path; AFTER checked including
      survives-a-reload; BACK/Cancel checked
- [ ] Writes verified by reading the row back; all test data created through the
      product under the write gate, `ZZTEST`-marked, and cleaned up
- [ ] Every ticket and developer claim mapped to an evidence file
- [ ] `evd_check.py --expect-tcs <N>` green against the PLANNED count
- [ ] Report follows the template, jargon-free body, COMMIT and VERIFIED-AT present
- [ ] Every finding carries Severity and Origin — in the failed case's own
      record (`SEVERITY:` / `ORIGIN:`), not only in the report's prose
- [ ] `xlsx_export.py --evd evd/<TICKET> --strict` green, and the workbook
      attached to the ticket
- [ ] `debate.md` holds both cards and a resolution; the challenger was genuinely fresh
- [ ] Text dossier committed; images attached to the tracker
- [ ] **Not one line of product code changed** — findings reported, never fixed
- [ ] A lesson appended, or "no new lesson" stated
- [ ] Every phase narrated; all user-facing output passes the plain-language bar
