---
name: triage
description: "Turn a vague bug report into something a developer can fix today. Reproduces it first-hand (or proves it does not reproduce, which is equally useful), narrows it to the smallest set of conditions that still triggers it, separates what the reporter observed from what they concluded, checks it against known issues and recent changes, assigns severity by consequence rather than by volume, and files or updates a report with numbered steps, a cited expected value, real evidence, and a first suspect area. It never fixes the defect."
argument-hint: "<report: a ticket id, a URL, or a pasted description>"
---

# /triage — from \"it's broken\" to a report someone can act on

Most bug reports describe a *reaction*, not a defect: what the person felt, at
which moment, mixed with their theory of the cause. Triage separates those three
things and turns them into a reproducible fact.

**This workflow never fixes anything.** Its output is a report, a severity, and
a suspect area.

---

## Principles

1. **Reproduce before you believe.** Second-hand symptoms are a starting point,
   never a finding. If it does not reproduce, that is a *result* — report it with
   exactly what you tried.
2. **Separate observation from conclusion.** "The total was 450,000" is an
   observation. "The tax calculation is broken" is a theory. Reports that carry
   a theory as a fact send developers to the wrong file.
3. **The smallest reproduction wins.** Every condition you can remove and still
   see the failure is one the developer will not have to eliminate themselves.
4. **Severity is about consequence, not volume.** One user losing money outranks
   fifty users seeing a misaligned button. Frequency goes in the report; it does
   not set the severity.
5. **Dedup before filing.** Re-reporting a known issue dilutes signal and costs
   the team more than the report is worth.

---

## T1 — CAPTURE WHAT WAS ACTUALLY SAID

If the report is already a ticket, fetch it rather than working from what was
pasted into chat — the comments usually carry half the context:

```bash
python3 .ai-qa/scripts/tracker.py get <TICKET> --out evd/<TICKET>/ticket.md
```

Restate the report in three separate blocks, and ask the reporter for anything
missing before you spend time reproducing:

```
GOAL        <what they were trying to get done — the job, not the click>
OBSERVED    <what they saw, in their words — the screen, the value, the message>
EXPECTED    <what they expected, and — crucially — WHY they expected it>
CONCLUDED   <their theory, quarantined here so it does not steer the search>
CONTEXT     <account/role · device/browser · when · environment · how often ·
             what they had just done before — the interruption, the second tab,
             the paste>
```

`GOAL` is the line most reports lack and most developers need. "The total was
wrong" is a symptom; "I was trying to apply a coupon after changing the
address" is the path that reproduces it. People report the click; ask for the
job.

`EXPECTED` with no "why" is the most common gap. "It should be 500,000" —
according to what? A spec, a previous release, or an assumption? The answer
changes whether this is a defect or a misunderstanding, and it is worth one
question to find out now.

## T2 — REPRODUCE, FIRST-HAND

Bring the environment up. Sign in **as the role in the report**, not as an admin
— a defect that only appears for one role disappears the moment you test as a
superuser. And reproduce **as the person**, not only as the role: same haste,
same habits, same device class. A defect that only appears when you double-click,
or paste, or come back after ten minutes, disappears for a tester who types the
perfect value once and waits. Borrow the persona from
`docs/qa/method/user-mindset.md` that fits the CONTEXT.

Walk the reported path exactly, from a click entry, and record it as a case:
`evd/<TICKET>/TC_1_<what_you_were_reproducing>/`.

**One shape for everything that happened.** A reproduction IS a case — it has
an actor, a precondition, an entry, steps, an expected value and an actual one.
It used to land in a folder of its own called `repro/`, which meant a reader
had to learn two layouts and the evidence gate knew only one of them. Write
`case.md` with the same fields `/qa` uses, and take the pictures with
`shotAnnotated` so each one says what it shows.

Three possible outcomes, all legitimate:

- **REPRODUCED** — you saw it. Box the evidence, note the exact conditions.
- **NOT REPRODUCED** — write down precisely what you tried: account, data,
  environment, build. Then vary **one** thing at a time from the report's
  context — a different role, different data, a different browser. Vary with
  intent, not at random: the interruptions and data shapes in
  `docs/qa/method/heuristics.md`, the values in `docs/qa/method/hostile-inputs.md`
  for the field involved, the real-user moves in `user-mindset.md`. Many "cannot
  reproduce" reports are environment-shaped or habit-shaped, and finding which
  variable matters is the whole finding. "Cannot reproduce" after one attempt
  with the perfect value is not a result.
- **DIFFERENT DEFECT FOUND** — you saw something else wrong on the way. File it
  separately; do not let it absorb this report.

## T3 — NARROW IT

Remove conditions one at a time and re-run. Stop when removing anything makes it
disappear. Record the minimal set.

Then bracket it:

- **When did it start?** Check recent commits and releases touching that area.
  `git log` on the relevant paths, and the changelog. A defect that appeared in
  a specific release is half-diagnosed.
- **How wide is it?** Same defect on an adjacent screen, an adjacent role, an
  adjacent record? Defects cluster — one found means you look around the hole.
  `docs/qa/method/checklists.md` for the shape of the screen says where the
  neighbours are: the export, the email, the badge, the other list that shows
  the same number.
- **Is it data or behaviour?** A wrong value can be a bad calculation or a bad
  row. A read-only query settles it, and the answer sends the report to a
  completely different place.

## T4 — DECIDE WHAT IT IS

Against the oracle, not against taste:

| Finding | What it means | Where it goes |
|---|---|---|
| Diverges from the written spec | A defect | Developer, with the citation |
| Matches the spec, reporter expected otherwise | A specification gap or a misunderstanding | Whoever owns the requirement — **not** the developer |
| Nothing written either way | Undecided | A decision request, quoting both readings, before any work |
| Already in known-issues | Duplicate | Link it, add the new occurrence, do not re-file |

The third row is the one that gets skipped, and skipping it is how teams argue
for a week. Write both readings down and ask for a decision.

## T5 — SEVERITY

From `docs/qa/method/severity.md`:

| Level | Definition |
|---|---|
| **Blocker** | Testing or use cannot continue · system unreachable · data lost |
| **Critical** | A core function broken with no workaround — money and irreversible state first |
| **Major** | Contradicts the spec, but a workaround exists |
| **Minor** | Small deviation, no business impact |

Then **Origin**: `DEV` (the code diverges from the spec) or `SPEC` (the
specification itself is wrong or missing). Origin is recorded to improve the
process, never to assign blame — and a `SPEC`-origin report that goes to a
developer wastes everyone's day.

## T6 — FILE IT

Dedup first. Then file or update, with every section filled.

**One defect, one report, one title that says where, what, and under what
condition.** A report holding two defects gets one fixed and the other closed
with it. The title is what everyone reads and most people stop at, so it has to
carry the finding: `[Where] What goes wrong — under what condition`. For example
`[Checkout] Total ignores the coupon — when the address is changed after
applying it`. Not "checkout bug", not "total wrong", and never the reporter's
theory. Anything else you saw on the way goes under `[Observations]` or into its
own report — it does not ride along.

```
[Title]         [Where] What goes wrong — under what condition
[Environment]   <url · branch/build · role and account · device/browser>
[Steps]         1. … 2. … 3.   (the MINIMAL set from T3)
[Expected]      <value> — per <spec citation>, or "UNSPECIFIED: decision needed"
[Actual]        <what happened>
[Frequency]     always | intermittent (n of m attempts) | once
[Started]       <release/commit where it first appears, or "unknown">
[Severity]      <level> · [Origin] DEV | SPEC
[Evidence]      evd/<TICKET>/TC_1_…/ (boxed image; db_verify.md if a write is involved)
[Suspect area]  <where to look first — labelled a HINT, never a diagnosis>
[Observations]  <seen on the way, not part of this defect — filed separately if it matters>
```

`[Steps]` and `[Expected]` follow `docs/qa/method/case-writing.md`: one action
per step with the exact value typed and the exact label pressed; expected as an
observable fact — a number, a label, a state — never "works" or "should". The
whole report follows the language rules in `docs/qa/method/report-writing.md`:
the screen's own labels, no code vocabulary, and who it hurts written out, so
the person who decides its priority does not have to ask.

`[Suspect area]` is a courtesy, and it must be labelled as one. QA pointing at a
file is a hint; QA insisting on a cause is QA doing the developer's job badly.

Finally, add a line to `docs/qa/known-issues.md` if this is an environment quirk
or an accepted deviation rather than a defect to fix.

---

## Definition of Done

- [ ] Observation, expectation and theory recorded separately; the reporter's
      "why" for the expectation captured or explicitly asked for
- [ ] The reporter's GOAL captured — the job, not the click
- [ ] Reproduction attempted first-hand, as the reported role **and as the
      person** — their haste, their habits, their device — with evidence; or
      NOT-REPRODUCED recorded with exactly what was tried and varied, using the
      heuristics and hostile inputs rather than one perfect attempt
- [ ] Minimal reproduction found; conditions that do not matter removed
- [ ] Blast radius checked: adjacent screens, roles and records
- [ ] Classified against the oracle — spec gaps routed to the requirement owner,
      not to a developer
- [ ] Deduped against known-issues before filing
- [ ] Severity by consequence; Origin recorded
- [ ] One defect per report; the title names where, what, and under what condition
- [ ] Report filed with every section, including the minimal steps and evidence
- [ ] Suspect area labelled as a hint
- [ ] No product code changed
