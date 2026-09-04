# QA onboarding dossier

> **What this is.** Everything a tester needs to know to test this project —
> and, just as importantly, everything nobody has told them yet.
>
> **How to read it.** Every line carries a tag:
>
> | Tag | Means |
> |---|---|
> | `[OBSERVED]` | Read in a file. The citation is on the line. |
> | `[INFERRED]` | Worked out. The reasoning is on the line, so you can overrule it in five seconds. |
> | `[TOLD BY <who>, <date>]` | A person said so. People change their minds and facts rot — the date is when to re-ask. |
> | `[UNKNOWN]` | Nobody has said and no file says. **This is a real answer, not a gap in the writing.** |
>
> An UNKNOWN protects you. A plausible invention in its place poisons every
> verdict built on top of it.
>
> Filled in by `/onboard`. Re-run it with `--refresh` when this starts to feel
> out of date; the tags tell you which lines were only ever guesses.

**Last updated:** _(date)_ · **By:** _(who)_ · **QA readiness score:** _(n)/100_

---

## 1. The product

_What is this, who uses it, and what happens when it breaks?_

- **What it does:** _[UNKNOWN]_
- **Who uses it, and in what roles:** _[UNKNOWN]_
- **Who the people are** — how often they do this, on what device and network,
  in what hurry, what they complain about most. This decides which persona a
  test case borrows (`method/user-mindset.md`): _[UNKNOWN]_
- **The money or consequence path** — where does value move, where is state
  irreversible, what would be genuinely bad: _[UNKNOWN]_
- **What it is NOT for** — scope boundaries that stop you filing "defects"
  against deliberate decisions: _[UNKNOWN]_

## 2. Environments

_Where do I test, and how do I bring it up?_

| Environment | URL | Who else uses it | Safe to create/delete data? |
|---|---|---|---|
| local | | just me | |
| dev / staging | | | |
| production | | everyone | **no — never test here** |

**Bring-up, from a clean machine:**

```
1.
2.
3.
```

> These steps get followed literally by the next person. If they do not work,
> the steps are wrong — not the reader. Fix them here the moment you find out.

- **Health proof:** _(paste the `APP: UP …` line from `app_check.sh`)_
- **Known bring-up problems:** _[UNKNOWN]_

## 3. Access

_Who do I sign in as?_

| Role | What this role can do | Test account | Where the credentials live |
|---|---|---|---|
| | | | |

- **Authentication mechanism** (password, SSO, OTP, magic link — this decides
  whether a browser run can log in unattended at all): _[UNKNOWN]_
- **Who to ask for an account:** _[UNKNOWN]_

> **Credentials are never written in this file.** Record *where* they live — an
> env var name, a vault entry, a person. A dossier is a document that gets
> committed, shared, and eventually pasted somewhere it should not be.

## 4. The oracle — where "correct" is written

_The most important section in this file._

| Area / feature | Where correct behaviour is written | Trustworthy? |
|---|---|---|
| | | |

- **Areas with NO written specification:** _[UNKNOWN]_

  > For these, a verification can only report *differences*, never *defects*.
  > Say so in every report that touches them. Quietly adopting whatever the code
  > does as the expected value turns a missing spec into a permanent one.

- **Who decides "bug or intended?"** _[UNKNOWN]_
- **Where the API contract lives:** _[UNKNOWN]_
- **Where the data model lives:** _[UNKNOWN]_
- **Design source for UI comparison:** _[UNKNOWN]_

## 5. Surface inventory

_Every place a user can be._

| Screen / endpoint / job | What it is for | Which role reaches it | Rules written where? |
|---|---|---|---|
| | | | |

> Not a file listing. A list of places a person can be, and what they can do
> there. If a row's last column is empty, that surface cannot be verified yet —
> only described.

## 6. Data

- **Seed data:** is there any, how is it loaded, what does it contain? _[UNKNOWN]_
- **How to create test data the way a user would** — the real flow, screen by
  screen: _[UNKNOWN]_
- **How to clean it up** — the product's own reverse action. **A flow with no
  reverse action means test data must not be created there at all**: _[UNKNOWN]_
- **Marker convention for test rows:** `ZZTEST`
- **Anything that must never be touched** — real customer records, live
  payments, anything that emails a human: _[UNKNOWN]_

## 7. Process

- **Where tickets live, and their statuses:** _[UNKNOWN]_
- **What a ticket must contain before it is testable:** _[UNKNOWN]_
- **Where a verdict goes** — comment, status change, who is told: _[UNKNOWN]_
- **How a fix reaches production, and how fast it can in an emergency:** _[UNKNOWN]_
- **Release cadence and freeze windows:** _[UNKNOWN]_

## 8. Risk map

_Ranked by consequence, not by size._

| # | What breaks | Who it hurts | How I would notice | Oracle exists? |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

**A high-risk row with no oracle is the most dangerous configuration in a
codebase.** It means nobody can tell a defect from a decision in the place where
being wrong costs the most. Escalate those rows; do not work around them.

### What surprised me on arrival

_Today is the only day this product will be seen with fresh eyes. The gap
between the documented flow and the real one is where defects live, and it will
never be this obvious again._

-

---

## Still owed

| Question | Asked of | When | Blocks |
|---|---|---|---|
| | | | |
