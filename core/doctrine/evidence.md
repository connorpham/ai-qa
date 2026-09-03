# Evidence — written for the stranger

Every artefact this lane produces has one audience: **a person with no context,
six months from now, deciding whether to trust a verdict.** Often that person is
you, and you will remember nothing.

## What makes evidence good

**Named for what it shows.** `03_total_after_save.png`, never `03.png`. The
filenames are the first thing a reader sees, and a folder of numbers forces them
to open every file to find the one that matters.

**Annotated.** One box on the region that carried the verdict, with a caption
saying what it proves. A red rectangle with no words explains nothing; a
full-page screenshot with no box makes the reader guess. Both are common, both
are useless.

**Self-contained.** The case manifest says what was done in plain language, so
the images confirm a story the reader already has rather than being a puzzle.

**Honest about what it is not.** Evidence from a different build, a different
account or a previous session is labelled as such — or discarded. Stale evidence
that looks current is worse than none.

## The manifest, per case

```
RESULT:       PASS | FAIL | BLOCKED
AS:           staff@demo (role STAFF)
PRECONDITION: order #4102 exists, state PENDING, created by admin@demo
ENTRY:        signed in → Orders → filter Pending → row #4102 → Edit
STEPS:        1. change quantity 2 → 3   2. press Save
EXPECTED:     total recalculates to 450,000 (spec §3.2)
ACTUAL:       total shows 450,000; "Saved" message appears
AFTER:        list row shows 3 · value survives a reload
BACK:         Back returns to Orders with the Pending filter intact
```

Every field is there because a verification went wrong without it:

- **AS** — half of all interface defects are role-shaped. A verdict with no
  actor cannot be reproduced or trusted.
- **PRECONDITION** — resolved read-only, now. An id from the ticket may not
  exist any more, and an empty list from stale data is "data moved", not a defect.
- **ENTRY** — as a click path. See `red-flags.md`.
- **AFTER** — including the reload. This is where "it works" most often stops
  working.
- **BACK** — Cancel that does not cancel, filters that reset. Cheap to check,
  frequently broken.

## The report

Different audience, different rules. `REPORT.md` is read by people who do not
work in the code: a product owner, a manager, sometimes a customer.

- **Black-box voice.** What a user does and what the product does. No file
  paths, no route names, no internal vocabulary — those go in the appendix.
- **The bar:** a non-programmer reads it in two minutes and understands what was
  asked for, what was checked, what happened, and what should happen next.
- **The verdict first**, in a word, at the top. Everything after it is support.
- **Uncertainty stated, not hidden.** "I could not verify the refund path
  because no test account has refund permission" is a useful sentence. Omitting
  it to make the report look complete is a lie of structure.

## Evidence and git

Text commits; binaries do not. Reports, manifests, verify sheets, debate cards,
database checks and journey scripts all go into version control — a verdict that
lives on one laptop is not reproducible, and an unreproducible verdict is
indistinguishable from a fabricated one.

Images are attached to the ticket instead, and the manifest records their names
and checksums, so a clean checkout can still tell you what was captured even
when the pixels are gone.
