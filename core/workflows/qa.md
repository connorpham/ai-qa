---
name: qa
description: "Verify one ticket a developer has claimed done, against the spec, with evidence — and change no product code. Reads the ticket for ambiguity first and asks the requirement owner before testing; reads the spec and the schema to derive what SHOULD happen (citing each source); designs 2-5 test cases chosen by risk (the exact acceptance path, a boundary that must behave the other way using a value a real user would produce, whole-screen sanity from the reflex checklist for that feature shape, a read-back check for anything that writes, and an exploratory case driven by one named heuristic when the budget allows); walks every case as a real person would — a named persona, a double-click, a Back after Save, a return after the session expired; creates any missing data the way a user would through the real UI under a write gate, runs every case for real on the active surfaces, captures named and annotated evidence, records what it noticed but was not asked about, cross-checks every claim in the ticket against a file that proves it, passes the machine evidence gate, gets falsified by a fresh challenger, and publishes a report a non-programmer can read in two minutes. It reports defects; it never fixes them."
argument-hint: "<TICKET: {project.key}-nnn | tracker URL> [env=<environment name — else $AIQA_ENV, else environments.default>] [base=<url overriding the environment for this run>]"
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

   **The gate enforces this, it does not merely ask.** Every case that reaches
   PASS or FAIL carries a `REQUIREMENT:` line, and `evd_check.py` reds unless it
   is one of exactly three shapes:

   | Shape | Example | When |
   |---|---|---|
   | a declared document, then the section | `docs/specs/orders.md 3.2 R1` | the normal case |
   | the schema or the API contract | `prisma/schema.prisma Order:total` | a data or response-shape rule |
   | a named floor rule | `FLOOR no unhandled 500 on a valid request` | nothing is written, and the outcome is wrong anyway |

   A bare `3.2` is **not** a citation: it names a section to someone who already
   knows the file, and that is never the person reading the report six weeks
   later. A path that does not exist is worse than nothing — it is the
   appearance of evidence. And the document must be one this project declared in
   `oracle.specs` **before** the run: an oracle picked after the result is known
   is not an oracle.

   `oracle.specs` empty in `aiqa.config.yaml` → the pack goes red as soon as any
   case reaches a verdict, and `ORACLE: NONE` is refused under a PASS or PARTIAL.
   You cannot certify that the product matches the specification and in the same
   breath say there is no specification. The honest verdict there is
   `BLOCKED (no oracle)`, with what needs writing — and that is useful output,
   not a failure to produce any.

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
   is told to falsify it — including whether you tested as a person or as a route.
Both cards go in `debate.md`.

8. **Say what you are doing.** One plain `▶` line at each phase, in the working
   language (`project.language`) — so are the questions you ask, the summary you
   paste and the report you publish. The report and the summary pass one bar: a
   non-programmer reads two minutes and understands everything.

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
  environment: <name — its url> · target: <url>
```

## V1 — DERIVE WHAT *SHOULD* HAPPEN

Read `docs/qa/method/roles-qa.md` first — it is the index to the method — then
`docs/qa/method/user-mindset.md`, so the person you design cases for is the one
who will actually use this. Then:

- **The dossier** (`docs/qa/onboarding.md`) — especially §4, the oracle map. If
  this ticket touches an area §4 marks as having no written spec, you already
  know your verdict is limited, and you say so from the start. And §1 — who the
  people are, how often they do this, on what device, in what hurry — because
  that decides which persona each case borrows.
- **Known issues** (`docs/qa/known-issues.md`) — scan the headings now, so a
  divergence you find later is deduped before you call it a bug.
- **Lessons** (`docs/qa/lessons.md`) — read the index, open only tag-matching
  entries, and answer them in your sheet.

**Then read the ticket like a QA, before you trust it.** Open
`docs/qa/method/requirement-smells.md` and walk the ticket and its acceptance
criteria against it. For each criterion, try to write the three things a case
will need: a concrete EXPECTED with a source, the boundary that must behave the
other way, and the role that acts. A criterion that cannot produce all three is
not testable as written. Every "should", "quickly", "the user", "like the other
screen", "no change to existing behaviour" is a decision nobody has made yet —
write each as one plain question with what it blocks. **Ask the requirement
owner now, in one batched message, before V2.** Not the developer, who did not
write the ticket; not after a day of testing, when the same question arrives as
an argument. A ticket that is smells all the way down gets the honest verdict
`BLOCKED (not testable as written)` with the question list — that is the
verification's first finding, not its failure.

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
- **Ambiguities** — the questions from the smells pass, each with what it
  blocks, who was asked, and when. An ambiguity that decides a case makes that
  case `BLOCKED (decision needed)` with the question quoted; one that does not
  is noted, and you proceed.

## V2 — DESIGN THE VERIFICATION

Between `evidence.min_test_cases` and `evidence.max_test_cases`. This budget is
deliberately small: it forces you to choose **by risk**, and 3 well-aimed cases
beat 30 shallow ones. Allocate the way failure hurts — a wrong balance outranks
a wrong colour, always.

Required shapes:

- **① The exact acceptance path** — the criterion as specified.
- **② A boundary that must behave the OTHER way** — the empty value, the
  duplicate, the insufficient balance, the cancelled record, the day before the
  cutoff. A change that overshoots its scope is a defect too. Take the value
  from `docs/qa/method/hostile-inputs.md` for the field type in front of you:
  one the spec explicitly refuses, one a real user will produce this week — a
  pasted trailing space, `1.000`, 29 February, someone else's id. A boundary
  chosen because it was convenient is a happy path with a different number.
- **③ Whole-screen sanity** (`evidence.require_whole_screen`) — the rest of the
  screen or flow still behaves. Fixes break neighbours. "Still behaves" is a
  list of specific looks, not a glance: open `docs/qa/method/checklists.md`,
  find the shape the screen is — a form, a list, a money screen, a lifecycle, a
  delete — and walk that list. Record what you looked at even when it was fine.
  Also read the project's own checklist at `docs/qa/checklists.md` if present:
  count the applicable items against your planned cases. If `checklists.md`
  contains criteria not yet covered by your cases, you MUST expand your plan
  to cover each applicable item (or waive out loud with a reason) — a checklist
  item silently ignored invalidates the verification.
  On a screen with a design source or a user-facing surface, open
  `docs/qa/method/ui-fidelity.md`: measure computed style against the design
  token (not the code), confirm the fonts actually loaded, and prove the
  measurable WCAG 2.2 AA checks — contrast, a visible focus ring, keyboard
  reach, real labels — because accessibility is a written oracle even when the
  ticket is silent, and "looks right" is the least trustworthy sentence in QA.
- **④ Write → read-back** (`evidence.require_db_verify`) — anything that writes
  gets verified by reading the row back after the action, plus the rollback path
  if one is specified.
- **⑤ The exploratory slot** — when the budget allows a fifth case, or when the
  ticket touches an area the dossier marks as having no oracle: one case with
  `KIND: exploratory`, driven by **one** heuristic from
  `docs/qa/method/heuristics.md` — an interruption at the worst moment, a tour,
  follow-the-data, a consistency oracle — named as `HEURISTIC:` with a timebox.
  Record what you tried even when you found nothing. Four confirming cases and
  no exploring one has spent the whole budget on what someone already thought of.
- **⑥ The security probe** — when the ticket touches authentication, sessions,
  roles, money, personal data, or uploads, one case sends the input an attacker
  sends **on purpose**. Open `docs/qa/method/security-probes.md` and take the two
  or three probes that fit the surface: is the lockout real and does the error
  message *or its timing* leak which accounts exist; does the session survive a
  password change; does the protected route answer when called directly as the
  wrong role (server-side, not the hidden button); is an injected payload
  executed or echoed unescaped; is a secret in any response. Also test identity
  **across representations** — the uppercase username, the duplicate that differs
  only by case or accent (`test-design.md`), the gap that hides in every happy
  path because the happy path types the value only one way. On a ticket that
  merely brushes security this shares slot ② or ③; on one that **is** auth or
  authorization it takes two or three cases, because there the security floor is
  the requirement. Its EXPECTED is a cited rule or one of the no-citation floor
  outcomes in `security-probes.md`.

**Per case, write the JOURNEY — you are a person using a product, not a script
hitting a route.** Open `docs/qa/method/case-writing.md` before the first record
and hold every field to its fifteen-second test: **TITLE, RESULT, EXPECTED and
ACTUAL alone must tell a stranger what was checked and what happened.** The gate
requires these by name:

- **AS** — which account, which role. A verdict with no actor is untraceable.
- **PERSONA** — which of the four people in `user-mindset.md` this case
  borrows: the first-timer, the daily operator, the interrupted one, the one in
  hostile conditions. It decides which real-user move the STEPS carry and what
  AFTER looks at. Optional in the gate; a journey without one is a route.
- **PRECONDITION** — what must already be true, resolved read-only right now.
  Never trust an id from the ticket to still exist.
- **ENTRY** — where the user starts and what they click to arrive. Sign in →
  which list → which row → which button. **Typing an address proves the address,
  not the product**: it hides a missing menu item, a wrong permission and an
  unreachable row simultaneously. Keep the deep link as a *second* path if
  useful, never the only one.
- **STEPS** — numbered, **one action per number**, in the order a person does
  them, each with the exact value typed and the exact label pressed, each
  screenshotted. No verification verbs — *check*, *verify*, *confirm* belong in
  EXPECTED. **At least one step is a thing a real user does that a script would not** —
  from `user-mindset.md`: Enter instead of Save, a double-click on the button,
  Back afterwards, a refresh right after, a paste instead of typing, the same
  record open in a second tab first, a return after the session would have
  expired. A journey with none of these has tested the route, not the product.
- **EXPECTED** — an **observable fact**: the number, label or state the screen
  will show, with its citation on the line, and the region you will box. Not
  "should", not "works" — the gate refuses an EXPECTED or ACTUAL that is only a
  judgement word, because that is a wish, not a value. **ACTUAL** is written in
  the same shape so the two lines read side by side; on a FAIL it carries the
  exact wrong value and what is missing, never "failed".
- **AFTER** — what changed: the message, the row in the list behind, and the
  value **still there after a reload** (`evidence.require_reload_check` — a save
  that dies on refresh is not a save). Write it as the answers to the four
  questions a person asks after every click: *did it work? where am I? can I
  undo it? did I lose anything?*
- **BACK** — Back, Cancel, browser-back. Does the filter survive? Does Cancel
  actually cancel? This is where "it works" usually stops working.
- **OBSERVATIONS** — what you saw that is *not* the verdict: the badge that did
  not update, the two-second pause, the label two panels away that now names the
  wrong thing, a console error. No severity, no change to RESULT. One click to
  see whether it repeats, one line here. It resurfaces in the report's
  Observations section — the thing you noticed and did not write down is the
  ticket somebody files next week.

**Then the fields the report is built from.** The journey is what you did; these
are what turn a folder of prose into a row somebody can sort, count and act on:

- **TITLE** — a sentence stating what the product does under a condition, from
  the user's side: *An order of exactly 499,999 gets no discount*. It is the
  folder name, the spreadsheet row and the report's table label — the most-read
  line in the pack. A verb, a condition, an outcome; twelve words or fewer; no
  "test", "check" or "verify"; no "and" (that is two cases). The folder is this
  title in snake_case, and the two must say the same thing.
- **KIND** — `acceptance` / `boundary` / `whole-screen` / `write-readback` /
  `exploratory`, so the suite can prove the boundary case was designed at all.
- **HEURISTIC** — on an `exploratory` case, the one heuristic from
  `heuristics.md` being applied, and its timebox. A heuristic you ran but did
  not name was a hunch.
- **REQUIREMENT** — **gate-enforced.** Where this case's EXPECTED was read out
  of: the document first, the section after it
  (`docs/specs/orders.md 3.2 R1; docs/specs/orders.md 3.3`), or `FLOOR <rule>`
  when nothing is written and the outcome is wrong anyway. Several sources are
  separated by `;`. Only a `RESULT: BLOCKED` case may leave it out — a case that
  never ran derived no expected value. Without it the traceability matrix has to
  guess the ids out of your EXPECTED prose, and a citation a tool guessed at is
  worth exactly as much as no citation.
- **On a case whose RESULT is FAIL, two more, and neither is optional:**
  - **SEVERITY** — `Blocker` / `Critical` / `Major` / `Minor`, by consequence,
    per `docs/qa/method/severity.md`.
  - **ORIGIN** — `DEV` (the code diverges from a correct spec) or `SPEC` (the
    specification is itself wrong or missing).
  - **FINDING** — one line describing the *defect*, not the case, readable
    alone by a manager: `[<where>] <what is wrong> — <under what condition>`.
    The title says what you checked; this says what is wrong.
  - **RECOMMENDATION**, optional — what to do about *this* defect. Leave it out
    and the report falls back to the recommendation you wrote for the ticket,
    labelled as ticket-wide, because advice about the ticket is not advice about
    one defect among three.

  Severity written only into the report's prose does not count. A sentence
  cannot be counted, filtered or ranked, and a report naming one severity
  cannot say which of three failed cases it grades — so that defect stays
  ungraded, and every report built from the pack says so out loud.

## V2b — BRING THE ENVIRONMENT UP

**Resolve WHERE this run happens first, by name.** The `env=` argument wins,
else `$AIQA_ENV`, else `environments.default` in `aiqa.config.yaml`. Export
`AIQA_ENV=<name>` before any gate runs, so every gate on every active surface
reads the same coordinates — the resolution lives in one place (`lib/ctx.py`)
and the tools cannot disagree. The chosen name and its url
become the report's `ENVIRONMENT:` line; the evidence gate refuses a report
without one, because a bug found on staging is not evidence about production.

Two refusals, both deliberate:

- **A name the config does not declare is a BLOCKED run.** The gates resolve an
  undeclared environment to an empty url rather than falling back to localhost —
  testing your laptop while the report says `stg` is a fabricated verdict.
- **`writes: forbidden` is a hard scope cut** (and any environment named prod is
  forbidden unless its block explicitly says otherwise). No test data is
  created, the write gate never opens, and every case whose STEPS would create
  or change state is `BLOCKED (read-only environment)` with the environment
  named. Read-only journeys still run and still produce verdicts.

Then follow the Environment block at the top of this file. Quote the `APP: UP`
line into the sheet — that line is your bring-up proof, and its `env:` tag must
name the environment you resolved. Resolve a test account per role you need,
read-only. No usable account → V3.

## V3 — CREATE MISSING DATA, THE WAY A USER WOULD

Only if V2 found gaps — and never on an environment whose `writes` is
`forbidden`: there, a case that needs data the environment does not have is
`BLOCKED (missing data on <name>)` with what exists instead, and nothing is
created. Trace the flow that *produces* the record and drive it
like a person. Follow the write gate (principle 4). Capture the run under
`evd/<TICKET>/data_prep/`. Producing flow does not exist or depends on something
unavailable → that case is `BLOCKED (missing data)` with what you tried. Never
fake it, never reach into the database.

## V4 — RUN IT

Announce each case in one line: which case, which account, what it proves.
Then walk the journey you wrote — from ENTRY, clicking what a user clicks.

Walk it **as the persona**: at their pace, with their habits. The real-user move
in the STEPS is executed, not narrated — the double-click is two clicks, the
return after expiry is a real wait or a real expiry. And at each step take your
eyes off the assertion for a second: the toast, the badge, the row behind, the
button state, the console. Anything that made you pause gets one more click and
one line under `OBSERVATIONS:` — not a verdict, not an investigation. The four
questions — did it work, where am I, can I undo it, did I lose anything — are
what AFTER and BACK record.

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

**Every check photographs itself.** Required on every executed case, not only
failures (`evidence.require_annotation`) — and taken with `shotAnnotated`
rather than a plain `shot`, so the image carries its own context:

```js
await shotAnnotated(page, HERE, ++n, "discount_at_threshold", {
  selector: "#discount",                       // the box is drawn from THIS
  proves:   "the discount line after an order of exactly 500,000",
  expected: "50,000",
  actual:   await read(page, "#discount"),
  cite:     "spec 3.2 R1",
  verdict:  ok ? "PASS" : "FAIL",              // green or red, on sight
});
```

The image comes out carrying a header — ticket, case, step, verdict — and a
line reading *what it proves · must read · actually read · where that is
written*. A ring is drawn on the element the check actually read.

**The box comes from the SELECTOR the check already uses.** Nobody measures
pixels, and nobody can box the wrong element — which is the flaw in picking
`--rect X,Y,W,H` by hand. A selector that matches nothing does not quietly
produce a clean screenshot: the header says `COULD NOT FIND`, in red, because
"I could not find what I was told to look at" is a finding.

`shotAnnotated` also writes `shots.json` beside the images, declaring what each
one proves. **`evd_check` reads it**: a `*_boxed.png` that nothing declares, or
one that declares an empty `proves`, is RED. The old rule was satisfied by any
file whose name ended in `_boxed` — including a plain screenshot somebody
renamed.

`annotate.py box --rect …` remains for evidence that did not come from a
browser — a PDF, a native app, a photograph. There the gate warns rather than
fails, because that path cannot say what it drew.
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
├── index.md             # generated: what is in here, case by case, plus the
│                        # COVERAGE: block. Was `manifest.md` — which also
│                        # named the file inside every case, so "open the
│                        # manifest" always needed a follow-up question.
├── REPORT.md            # V5b: the only thing a non-programmer reads
├── ticket.md            # V0: what the ticket SAYS — data, never the oracle
├── verifysheet.md       # V1/V2: expected values with citations, the journeys
├── debate.md            # V6: your card, the challenger's card, the resolution
├── <TICKET>_testcases.xlsx  # V7: the same record as a spreadsheet (generated)
├── data_prep/           # V3 runs, if any
├── findings/            # V7.7: what this run SAW that the ticket did not ask
│   └── F<n>_<what>/     #   about — the bug is filed elsewhere, the evidence
│       ├── finding.md   #   stays here: SEVERITY · ORIGIN · DEDUP · FILED-AS
│       └── …            #   and the image/query that made you believe it
└── TC_<n>_<what_it_proves>/
    ├── case.md          # TITLE / KIND / RESULT / AS / PRECONDITION / ENTRY /
    │                    # STEPS / EXPECTED / REQUIREMENT / ACTUAL / AFTER /
    │                    # BACK — plus SEVERITY / ORIGIN / FINDING when it FAILED
    ├── journey.mjs      # the run itself — re-runnable evidence
    ├── shots.json       # what each annotated image declares it proves
    ├── TC<n>_01_*.png … # case number + step + what it shows, + *_boxed.png
    ├── request.http     # API cases: the real request
    ├── response.json    # API cases: the real response
    └── db_verify.md     # write cases: the read-only SELECT and the rows after
    #   cmd_verify.md    # non-UI cases with no database: real command + output

```

**The folder names are the report's table of contents.** `TC_2/` makes the
reader open a file to learn what case 2 even was; `TC_2_expired_code_is_refused/`
does not. `shot()` stamps the case number into every filename for the same
reason — a screenshot leaves its folder almost immediately, and out there
`03_total.png` belongs to nothing. Both are gated.

Write the index, then gate. The index is generated from the case records, so
it cannot describe a folder that is no longer there:

```bash
python3 .ai-qa/scripts/evd_index.py --evd evd/<TICKET>
```

It rewrites one marked block inside `evd/<TICKET>/index.md` — a table of
case, what it proves, kind, result, and which file to open — and leaves your
prose alone. `evd_check.py` reds a stale one.

**Declare the coverage decision.** In the prose of `evd/<TICKET>/index.md`
(outside the generated block), write a `COVERAGE:` line for each lens the gate
insists a verifier decide about — the two skipped in silence more than any
other. Name the case that covered it, or waive it out loud with a reason:

```markdown
COVERAGE:
- security: TC_4        (or)   security: n/a — cosmetic label change, no auth, session or write path
- accessibility: TC_6  (or)   accessibility: n/a — backend migration, no UI in this change
```

The gate reds on a pack that says nothing — because "nobody wrote it into the
ticket" is exactly how a whole class of defect goes untested while the pack
looks complete. A waiver is a five-second honest answer; the silent skip is what
this refuses. See `docs/qa/method/security-probes.md` and `ui-fidelity.md` for
when each lens genuinely applies.

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

Open `docs/qa/method/report-writing.md` first. `evd/<TICKET>/REPORT.md` is
written in `{project.language}`, in the user's words, with zero technical
vocabulary in the body — no file paths, no route names, no case numbers in
prose, no "oracle" (the appendix is where those live). The bar: **a product
owner reads the first five lines on a phone and knows what to do; a
non-programmer reads the rest in two minutes and can stop after any section
with the truth.**

Write the three summary lines **last**, once you know what you found, and write
them so they can be pasted into a chat without the rest of the report.

```markdown
# <TICKET> — <PASS / FAIL / PARTIAL / NEW-BUG / BLOCKED / UNCLEAR>
COMMIT: <sha the cases ran against>
VERIFIED-AT: <ISO timestamp>
ENVIRONMENT: <name — url, e.g. "stg — https://stg.shop.example">
ORACLE: <the declared documents this verdict was compared against, e.g. "docs/specs/orders.md 3.2">
        <NONE is allowed only under BLOCKED / FAIL / NEW-BUG / UNCLEAR — never under PASS or PARTIAL>

**Verdict:** <one sentence — what does or does not work, for whom, in the user's words>
**What it means:** <the consequence for a person or for money, in one sentence>
**Next step:** <who does what — "back to the developer with defect 1" · "ready to release" · "decision needed from <who> on <what>" · "blocked until <who> <does what>">

## 1. What was asked for
On <screen>, when <who> <does what>, the product must <outcome> — because <the rule, in plain words>.
The developer reports it done.

## 2. What I checked
| What I checked (the case title) | As whom | Expected | Actual | Result |
|---|---|---|---|---|
| <the case TITLE — never TC_n> | <role> | <the number or label> | <the number or label> | ✅ / ❌ / ⛔ |

## 3. What I found
One block per defect, worst first — or "No defects found."

**[<Where>] <what is wrong> — <under what condition>.**
When <who> <does what>, <what happens>. It should <expected> (<the rule, in plain words>).
<Who it hurts, and how.>
Severity: <Blocker / Critical / Major / Minor> · Origin: <the code / the written rule> · Evidence: <case title> — <file>

## 4. Conclusion
1–3 sentences: requirement met or not · how sure · what was not covered.
**Recommendation:** <what to do about this ticket as a whole, one sentence>

## 5. What I could not check
"Nothing" — or: I could not check <what> because <reason>. Tried: <what>. To unblock: <who does what>.

## 6. Observations — seen, not judged
One line each, no severity — or "none".

## Appendix
Verify sheet · citations by file and section · debate.md · every evidence file as
path → what it shows · the technical vocabulary kept out of the body.
```

The gate reads the verdict word on the first line, the four `KEY:` lines and —
on a failing verdict — the words Severity and Origin. The spreadsheet prints
section 4 on its first sheet and reads the bold **Recommendation:** line, so
both have to stand without the rest of the report around them. Everything else
in the template is for the person reading it.

## V6 — THE CHALLENGER

1. Write **your** card into `debate.md` first: verdict, strongest evidence, and
   `MY WEAK SPOT:` — the one thing most likely to be wrong. Writing it before
   the challenger arrives is what stops you defending instead of thinking.
2. Spawn ONE fresh agent with empty context. Give it the ticket verbatim, the
   sheet, the evidence paths, the report, and this brief: *"Falsify this
   verification. Wrong role or account? A difference that is really about data,
   not behaviour? A boundary never tested? Evidence that is stale or does not
   show what its caption claims? Was this walked as a person or as a route —
   which real-user move is missing: the double-click, the Back after Save, the
   refresh, the second tab? Which line of `checklists.md` for this screen's
   shape was never looked at? Which consistency oracle would have turned a
   'difference' into a finding with an owner? Any sentence in the report a
   non-technical reader could not follow? Return your own card."*
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
2. **Summarise to the user** by pasting the report's first five lines — the
   verdict word and the three summary lines — then the section-2 table, the
   findings, the evidence paths and any remaining dissent. If the summary needs
   a sentence the report does not have, the report is not finished.
3. **Comment on the ticket** once both machine gates are green, and attach the
   images — they live outside git, so the tracker is the only place they
   survive the session:

   ```bash
   python3 .ai-qa/scripts/tracker.py comment <TICKET> --body-file evd/<TICKET>/REPORT.md
   python3 .ai-qa/scripts/tracker.py attach  <TICKET> evd/<TICKET>/TC_*/*_boxed.png \
     evd/<TICKET>/<TICKET>_testcases.xlsx --record evd/<TICKET>/index.md
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
7. **A finding outside this ticket's scope gets a folder here, and a ticket
   there.** The bug lives in the tracker; the evidence stays where it was
   captured, because a run's record must remain exactly as that run left it:

   ```
   evd/<TICKET>/findings/F1_<what_it_is>/
     finding.md    SEVERITY · ORIGIN · DEDUP · FILED-AS  (+ what and where)
     …             the image, query or recorded response that made you believe it
   ```

   `DEDUP:` names the known issue it duplicates, or says it is in none — check
   `docs/qa/known-issues.md` BEFORE filing; re-reporting a KI costs the team
   more than the report is worth. `FILED-AS:` is the ticket it became, or
   `none — <why it is not worth one>`; silence there is how a finding
   evaporates. **The gate reds on every one of those being absent.**

   The bug ticket you file points back at this folder. Copying the evidence
   into it would create two versions that can drift; leaving it unnamed inside
   another ticket's folder is how it is lost.
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
- [ ] Every case that reached PASS or FAIL carries `REQUIREMENT:` naming a
      declared document and section, or a named `FLOOR` rule — the gate reds
      on a section number with no document, a file that does not exist, and a
      document `oracle.specs` never declared
- [ ] No written oracle → `ORACLE: NONE` and the verdict is `BLOCKED`, with what
      needs writing. Never a PASS labelled as an opinion in the prose while the
      first line still reads PASS
- [ ] Every case ran for real this session; bring-up proven by the quoted
      `APP: UP` line; blocked cases carry reason and unblock path
- [ ] The environment resolved by NAME before bring-up, exported as `AIQA_ENV`,
      and recorded as `ENVIRONMENT: <name — url>` in the report; nothing was
      created or changed on a `writes: forbidden` environment
- [ ] Ticket read for requirement smells before V2; every question asked of the
      requirement owner with what it blocked — or the ticket honestly
      `BLOCKED (not testable as written)`
- [ ] Boundary case and whole-screen case both ran — not only the happy path;
      the boundary value came from `hostile-inputs.md`, the whole-screen case
      walked the `checklists.md` shape for that screen
- [ ] Project checklist (`docs/qa/checklists.md`) audited if present; every applicable item covered with evidence or waived with reason — no item silently omitted
- [ ] Ticket touches auth / sessions / roles / money / personal data / uploads →
      at least one `security-probes.md` probe ran (lockout real, enumeration by
      message *and* timing, session invalidation, server-side authorization,
      injection refused), and identity was tested across representations
      (uppercase, duplicate-by-case-or-accent) — or the report says why none applied
- [ ] Ticket has a design source or user-facing screen → `ui-fidelity.md` run:
      computed style measured against the design token, fonts proven to load, and
      the WCAG 2.2 AA checks that apply (contrast, focus visible, keyboard reach,
      labels) proven with numbers — a11y failures cited against their SC as defects
- [ ] Every case names a `PERSONA:` and carries at least one real-user move in
      its STEPS — none tested only the route
- [ ] Exploratory slot used with a named `HEURISTIC:` when the budget allowed —
      or the report says why not
- [ ] `OBSERVATIONS:` recorded per case and surfaced in the report's
      Observations section, or "none" stated
- [ ] Web cases walked from ENTRY as a click path; AFTER checked including
      survives-a-reload; BACK/Cancel checked
- [ ] Writes verified by reading the row back; all test data created through the
      product under the write gate, `ZZTEST`-marked, and cleaned up
- [ ] Every ticket and developer claim mapped to an evidence file
- [ ] `evd_check.py --expect-tcs <N>` green against the PLANNED count
- [ ] Every case record passes the fifteen-second test: TITLE is a sentence
      about behaviour and matches the folder name, STEPS carry exact values,
      EXPECTED and ACTUAL are observable facts in the same shape
- [ ] Report opens with the three summary lines a product owner could paste into
      a chat; every table row is labelled by the case title; every finding says
      who it hurts; the body is free of jargon, file paths and case numbers;
      "What I could not check" is present even when it says Nothing; COMMIT and
      VERIFIED-AT present
- [ ] Every finding carries Severity and Origin — in the failed case's own
      record (`SEVERITY:` / `ORIGIN:`), not only in the report's prose
- [ ] `xlsx_export.py --evd evd/<TICKET> --strict` green, and the workbook
      attached to the ticket
- [ ] `debate.md` holds both cards and a resolution; the challenger was genuinely fresh
- [ ] Text dossier committed; images attached to the tracker
- [ ] **Not one line of product code changed** — findings reported, never fixed
- [ ] A lesson appended, or "no new lesson" stated
- [ ] Every phase narrated; all user-facing output passes the plain-language bar
