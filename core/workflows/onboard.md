---
name: onboard
description: "Walk into this project the way a QA engineer joins on day one — knowing nothing. Runs the machine scan, reads every artefact that exists, and drafts a dossier where each line is marked OBSERVED (with a file citation), INFERRED (with the reasoning shown), or UNKNOWN. Batches the unknowns into a short interview for the team, then PROVES the answers by bringing the app up and walking one journey per role. Publishes docs/qa/onboarding.md — the document a human QA could start from tomorrow — plus a risk map, three runnable test charters, and a readiness verdict naming what is still missing and who owes it. Writes no product code and asserts nothing it did not see."
argument-hint: "[--refresh] [--focus <area>]"
---

# /onboard — arrive knowing nothing, leave able to test

A QA engineer who joins a project on Monday cannot test anything on Monday. They
spend the first days finding out what the product is for, how to run it, who to
log in as, and — the hard one — **what "correct" even means here**. Only then is
their verdict worth anything.

This workflow does that, out loud, and leaves the answers in a file.

**What this is NOT:** a code review, an architecture write-up, or a summary of
the README. It answers one question — *what does a tester need in order to test
this, and how much of it actually exists?* — and it is allowed to answer
"not enough", loudly.

---

## Immutable principles

1. **You know nothing, and you say so.** Every line of the dossier is tagged:
   - `[OBSERVED]` — you read it. **Cite the file and line.** No citation, no tag.
   - `[INFERRED]` — you worked it out. **Show the reasoning in the same sentence**,
     so a human can overrule it in five seconds.
   - `[UNKNOWN]` — nobody has told you and no file says. This is a legitimate,
     valuable output. An honest UNKNOWN protects the team; a plausible invention
     poisons every verdict built on it.

   A dossier with no UNKNOWNs after a first pass is not thorough — it is fabricated.

2. **Never invent an expected value.** Not for a validation rule, not for an
   error message, not for a permission. If the spec is silent, the answer is
   "the spec is silent, and here is the question that has to be answered before
   this can be tested."

3. **Ask humans only what the repo cannot answer.** Interrogating someone about
   a value sitting in `package.json` burns the goodwill you need for the
   questions only they can answer.

4. **A dossier that was never run is fiction.** Before you publish, you bring the
   app up and walk one real journey per role. What you could not run is recorded
   as BLOCKED with the exact error and the unblock path — never smoothed over.

5. **Write for the human who replaces you.** Plain language, in the configured
   project language. A non-programmer reads it in ten minutes and knows what
   this product does, how to run it, and what to be afraid of.

---

## O0 — THE MACHINE PASS

Announce yourself before doing anything:

```
▶ Onboarding onto <project> — I know nothing about this codebase yet.
  Plan: read what exists → tell you what I could not find → ask you → prove it runs.
```

Run the scan and read it as your own to-do list:

```bash
npx ai-qa scan --json .ai-qa/discovery.json --verbose
```

The score is not the point; **the gap list is**. Every gap is a question you
either answer from the repo in O1 or put to a human in O3. Record the score —
you will re-run it at the end and the delta is the value you added.

`--refresh` on an existing dossier: read the current `docs/qa/onboarding.md`
first and treat it as a set of claims to re-verify, not as truth. Facts rot.

## O1 — READ WHAT EXISTS

Read in this order, because it is the order in which things stop being
trustworthy:

1. **`aiqa.config.yaml`** — the coordinates someone already declared. Empty
   fields are declared unknowns; treat them as such, not as defaults.
2. **The product's own words** — README, docs/, any PRD, spec, or RFC. What is
   this for? Who uses it? What is the money/consequence path?
3. **The contract** — OpenAPI/GraphQL/proto, and the schema (Prisma, migrations,
   models). These are the least likely to lie, because code depends on them.
4. **The surface** — routes, pages, screens, controllers, jobs. Enumerate them.
   You need a list of *places a user can be*, not a list of files.
5. **Roles and permissions** — who can do what. Half of all UI defects are
   role-shaped, and you cannot find them signed in as an admin.
6. **What already breaks** — existing tests (what do they cover, do they pass on
   a clean checkout?), CI config, known-issues, the last 30 commits, and the
   issue tracker's recent bugs. Defects cluster: the past tells you where.

Then write a **surface inventory** into the dossier: every screen/endpoint/job,
what it is for, which role reaches it, and where its rules are written down (or
`[UNKNOWN]` if nowhere).

Do NOT read the whole codebase. You are mapping a territory, not memorising it.
Reading code is allowed to learn **where** something lives — never to decide
what it **should** do. Code tells you what it does; only the spec tells you
whether that is right.

## O2 — DRAFT THE DOSSIER

Write `docs/qa/onboarding.md` now, while it is still mostly UNKNOWN. Drafting
before the interview is what makes the interview short: you arrive with a
specific list instead of "tell me about the project".

Use the template in `docs/qa/onboarding.md` as installed. Its eight sections
exist because they are the eight things a tester is blocked without:

| § | Section | The question it answers |
|---|---|---|
| 1 | The product | What is this, who uses it, and what happens when it breaks? |
| 2 | Environments | Where do I test, and how do I bring it up? |
| 3 | Access | Who do I sign in as, per role, and where do those credentials come from? |
| 4 | The oracle | Where is "correct" written down — and where is it NOT? |
| 5 | Surface inventory | What are all the places a user can be? |
| 6 | Data | What data exists, how do I make more the way a user would, and how do I clean up? |
| 7 | Process | How does a ticket reach me and what do I do with a verdict? |
| 8 | Risk map | Where does failure hurt most? |

Section 4 is the one that decides whether this project can be tested at all.
Be blunt in it. "There is no written specification for the checkout flow; the
expected behaviour is currently whatever the code does, which means I cannot
call anything a bug there — only a difference" is the most useful sentence you
can write for a team that has never had a QA.

## O3 — THE INTERVIEW

Now, and only now, ask people.

**Batch the questions.** At most three rounds. Round one carries everything that
blocks all testing; a person answering ten questions in one message is a
colleague, the same person answering ten messages is an interruption.

Rules for each question:
- **One question, one line, plain language.** No jargon, no file paths in the
  question itself.
- **Say why you are asking and what it unblocks.** "Which account can approve an
  order? Without it I cannot test the approval rules at all" gets an answer;
  "what are the roles?" gets a shrug.
- **Offer your best guess and ask them to correct it**, when you have one. It is
  far easier to say "no, it's 30 days" than to compose an answer from nothing.
  Mark it `[INFERRED]` until they confirm.
- **Never ask for a password in chat.** Ask *where credentials live* — a vault,
  an env file, a person. Record the location; never the secret.

Ask these unless the repo already answered them:

```
Product        · What does a user come here to do, and what is the worst thing
                 that can go wrong for them?
Environment    · Which URL should I test against, and who else uses it? Is it safe
                 for me to create and delete records there?
Access         · One test account per role, please — and where do I get them?
The oracle     · When something looks wrong, who decides whether it is a bug or
                 intended? Is there a written spec, or is it tribal knowledge?
Scope          · What is currently being built, and what should I not touch?
Data           · May I create test data? Through the app, or is there a seed
                 script? How do I clean it up?
Release        · How does a fix get to production, and how fast can it if I find
                 something serious?
History        · What has broken before? What are you nervous about?
```

Record every answer into the dossier with `[TOLD BY <role/name>, <date>]`.
A fact from a person is evidence with a source, and sources go stale — the date
is what lets the next QA know when to re-ask.

**Unanswered is not the same as unimportant.** A question nobody answers stays
`[UNKNOWN]` in the dossier with the date you asked, and it goes into the
readiness verdict as an owed item.

## O4 — PROVE IT RUNS

Everything above is claims. This phase converts claims into facts.

1. **Bring the app up** exactly as the dossier says a newcomer would — from a
   clean state, following your own written instructions. **If your instructions
   do not work, the instructions are wrong, not the reader.** Fix them and note
   what was missing; that correction is one of the most valuable things this
   whole workflow produces.

   ```bash
   bash .ai-qa/scripts/app_check.sh --wait 60
   ```
   Quote the `APP: UP` line into §2. `APP: DOWN` → §2 says BLOCKED, with the
   error and what you tried.

2. **Sign in as every role** the dossier claims exists, one at a time. A role you
   could not sign in as is `[UNKNOWN — could not verify]`, never `[OBSERVED]`.

3. **Walk one real journey per role** — the single most important thing that role
   does. Entry through the menu the way a person arrives, not by typing a URL:
   a typed address hides a missing menu item, a wrong permission, and an
   unreachable row all at once.

   ```bash
   node .ai-qa/scripts/browser.mjs check     # preflight, once
   ```
   Save the walk under `evd/onboarding/<role>/` with named screenshots. This is
   your first evidence folder and the template for every one after it.

4. **For each non-web surface in play**, prove the same thing its own way: one
   real API call with its response recorded (`api_check.mjs`), one read-only
   query that returns real rows (`db_verify.py`), one app launch on a real
   device or emulator (`device_check.sh`).

5. **Write down what surprised you.** The gap between the documented flow and the
   real one is where defects live, and today is the only day you will see this
   product with fresh eyes. Put it in §8 — it will never be this obvious again.

## O5 — RISK MAP

Rank the surface inventory by consequence, not by size. The ordering that has
held up across every domain:

```
money moved or lost        > irreversible state change > data corrupted or leaked
> a person blocked from working > wrong number displayed > cosmetic drift
```

For each of the top items write one line: **what breaks, who it hurts, how you
would notice.** That last clause matters — a risk you cannot detect is not yet a
test, it is a worry.

Cross the map against §4. **A high-risk area with no written oracle is the
single most dangerous configuration in a codebase**, and it belongs at the top
of the readiness verdict as a request for a decision — not as something you
quietly work around.

## O6 — THREE TEST CHARTERS

Write three charters into `docs/qa/charters.md`, each runnable tomorrow by
someone who has read only the dossier. One charter is:

```
CHARTER <n> — <what we are trying to find out>
  AS          <role, and the account to use>
  EXPLORE     <the screen / endpoint / flow>
  LOOKING FOR <the class of defect: wrong money, lost state, a role seeing
              what it must not, a save that does not survive a reload>
  ORACLE      <where "correct" is written — or "NONE: ask <who> first">
  TIMEBOX     <e.g. 45 minutes>
```

Pick them by the risk map, not by what is easy to reach. A charter whose ORACLE
is NONE is still worth writing — it makes the missing spec visible as a cost.

## O7 — READINESS VERDICT

Re-run the scan. Report honestly:

```
▶ Onboarding complete — <project>
  QA readiness: <before>/100 → <after>/100
  I can test now:      <list of areas with a real oracle and a working login>
  I cannot test yet:   <area> — because <missing thing> — needs <who>
  Biggest risk found:  <one line from §5>
```

Then:

1. **Commit the dossier.** `docs/qa/onboarding.md`, `charters.md`, and the
   evidence text from O4. A dossier that lives on one laptop was never written.
2. **Post the owed list** to the team: every `[UNKNOWN]` that blocks testing,
   with who was asked and when. Do not soften it — a QA who reports "all good"
   after finding no oracle has already failed at the job.
3. **Name the next action.** Usually: run charter 1, or get a decision on the
   highest-risk unspecified area.

---

## Definition of Done

- [ ] Every dossier line is tagged `[OBSERVED]` (with citation), `[INFERRED]`
      (with reasoning), `[TOLD BY <who>, <date>]`, or `[UNKNOWN]` — no untagged claims
- [ ] §4 states plainly whether a written oracle exists, per area
- [ ] Interview happened in ≤3 batched rounds, in plain language, no credentials requested in chat
- [ ] The app was actually brought up, or §2 records BLOCKED with the real error
- [ ] One journey walked per claimed role, from a click path — evidence saved under `evd/onboarding/`
- [ ] A role that could not be signed into is marked unverified, never assumed
- [ ] Every active surface proved its own way (browser / API / database / device)
- [ ] Risk map ranks by consequence and flags every high-risk area with no oracle
- [ ] Three charters written, each with a named oracle or an explicit NONE
- [ ] Scan re-run; before/after reported without rounding up
- [ ] Owed items posted with who was asked and when
- [ ] No product code changed, no expected value invented, no UNKNOWN quietly filled
