---
name: regress
description: "Build or refresh the regression suite from evidence rather than from imagination. Harvests the journey scripts left behind by past verifications, adds a case for every defect that actually shipped, ranks candidates by consequence, and keeps the suite small enough that people still run it. Proves each new check can FAIL by breaking the behaviour it guards before trusting it, quarantines flaky cases instead of deleting or ignoring them, and retires cases that no longer protect anything. Reports coverage as what is protected, never as a percentage."
argument-hint: "[--area <screen/flow>] [--budget <minutes>]"
---

# /regress — a suite people still run in six months

Regression suites die two ways: they grow until nobody waits for them, or they
go amber until nobody believes them. Both failures start the same way — cases
added because they were easy to write rather than because something broke.

**This workflow never changes product code.** It writes and maintains checks.

---

## Principles

1. **Every case earns its place by consequence.** The question is not "is this
   tested?" but "if this broke silently, what would it cost?"
2. **A check that has never failed is not yet a check.** Before trusting a new
   case, break the behaviour it guards and watch it go red *in the right place*.
   A case that stays green through a real defect is worse than no case: it is a
   false assurance with a maintenance cost.
3. **Past defects outrank imagined ones.** Something that broke once, in this
   codebase, with this team, is evidence. A risk you invented is a guess.
4. **The suite has a time budget.** A suite nobody waits for protects nothing.
   Adding a case means justifying its runtime, and sometimes retiring another.
5. **Flaky is a defect in the suite.** Quarantine it, name the cause, fix or
   delete it. An amber suite teaches people to ignore red, and that habit is
   permanent.

---

## R1 — HARVEST WHAT ALREADY EXISTS

You are not starting from nothing. Every `/qa` run left a runnable journey.

```bash
ls evd/*/TC_*/journey.mjs
```

For each: is the behaviour it walks still worth protecting? A journey written
for a ticket becomes a regression case by being *promoted*, not rewritten —
moved into the suite, given a stable name, and pointed at data it can create for
itself rather than data that happened to exist that day.

Then read the record of what has actually gone wrong:

- `docs/qa/known-issues.md` — the recurring ones.
- Closed bug tickets, especially any that shipped to production or came back a
  second time. **A defect that escaped once has already proven that nothing was
  watching that path.**
- `docs/qa/lessons.md` — entries tagged as gate-shaped were waiting for exactly
  this workflow.

## R2 — RANK THE CANDIDATES

Score each candidate on two axes only:

- **Consequence if it breaks** — money moved or lost > irreversible state >
  data corrupted or leaked > a person blocked from working > wrong number shown
  > cosmetic.
- **Likelihood it breaks** — how often does this area change, how tangled is it,
  has it broken before?

Take the top of that ordering until the time budget is spent. Write the ordering
down, including what you did **not** take — an explicit "not covered, and here
is why" is a real deliverable, and it is the thing that makes the gap visible
instead of invisible.

Cross-check against the risk map in `docs/qa/onboarding.md` §8. A high-risk area
with no regression case and no written spec goes to the top of the report as a
decision request, not into the suite as a guess.

## R3 — WRITE THE CASES

Same journey discipline as `/qa`: AS · PRECONDITION · ENTRY · STEPS · EXPECTED ·
AFTER · BACK. A regression case that skips ENTRY and jumps to a URL will keep
passing after the menu item disappears.

Three rules specific to a suite that has to survive:

- **Self-provisioning.** The case creates its own data through the product and
  removes it afterwards. A case that depends on a row somebody made in March
  fails in April for a reason that has nothing to do with the product.
- **Assert the meaning, not the markup.** The total, the state, the row count —
  not a class name or a pixel offset. Cases that assert markup break on every
  redesign and teach the team that red means "ignore me".
- **Independent and re-runnable.** Any order, any number of times, no shared
  mutable fixture. Order-dependence is the most common cause of flake, and the
  hardest to diagnose six months later.

## R4 — PROVE EACH CASE CAN FAIL

Non-negotiable, one case at a time:

1. Break the behaviour the case guards — a temporary local edit, a flipped
   condition, a wrong constant.
2. Run the case. **It must go red, and the failure message must name the real
   thing** — "expected total 450,000, got 500,000", not "element not found".
   A case that reds for the wrong reason will be misdiagnosed under pressure.
3. Restore. Confirm `git diff` is clean and the case is green again.
4. Record the proof in `docs/qa/suite.md`: the case, what you broke, what it
   said when it failed.

A case that cannot be made to fail is measuring nothing. Delete it and write down
why — that finding is often more interesting than the case would have been.

## R5 — RUN, MEASURE, QUARANTINE

Run the whole suite three times against an unchanged build. Anything that is not
identically green three times is **flaky, not passing**:

- Move it to a quarantine list with the symptom and your best cause.
- Quarantined cases do not gate anything and do not count as coverage.
- Give each a deadline: fixed or deleted. A permanent quarantine is a graveyard,
  and graveyards grow.

Record the total runtime. Over budget → retire the lowest-ranked cases from R2
rather than letting the suite quietly stop being run.

## R6 — REPORT COVERAGE HONESTLY

Never as a percentage. A percentage of what — lines? Nobody was ever protected
by a line. Report what is protected and what is not:

```
▶ Regression suite — <n> cases · <runtime> · <n> quarantined

  PROTECTED     <flow> — <what would be caught> — proved by <the break that made it red>
  NOT PROTECTED <flow> — <what would ship silently> — <why: no oracle / no budget / not automatable>
  QUARANTINED   <case> — <symptom> — <owner, deadline>
```

The NOT PROTECTED block is the most valuable section in the document, and the
one there is most pressure to shorten. Keep it complete.

Wire the suite where it will actually be seen — CI on every change, and before
release. A suite that only runs on someone's laptop is a personal hobby.

---

## Definition of Done

- [ ] Existing journeys harvested and promoted, not rewritten from scratch
- [ ] Every shipped defect from the record considered for a case
- [ ] Candidates ranked by consequence × likelihood; what was NOT taken is written down
- [ ] Each case self-provisions its data and cleans up; no shared mutable fixture
- [ ] Each case asserts meaning, not markup, and enters through a click path
- [ ] **Every case proved able to fail**, with the break and the failure message recorded
- [ ] Suite run three times; anything not identically green quarantined with a deadline
- [ ] Runtime inside budget, or cases explicitly retired to get there
- [ ] Coverage reported as protected / not protected — never as a percentage
- [ ] Suite wired into CI
- [ ] No product code changed
