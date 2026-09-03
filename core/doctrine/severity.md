# Severity and origin — the house of record

Every FAIL, NEW-BUG and filed bug report carries both. They answer different
questions and neither substitutes for the other.

## Severity — how much does this hurt?

| Level | Definition | Handling |
|---|---|---|
| **Blocker** | Testing or use cannot continue · the system is unreachable · data is lost | Everything else stops. Next session. |
| **Critical** | A core function is broken with no workaround — money and irreversible state first | Before any new work in the same cycle |
| **Major** | Behaviour contradicts the spec, but a workaround exists | Within the cycle |
| **Minor** | Small deviation, no business impact — visual drift, wording | May roll to the next cycle; recorded in the backlog |

**Severity is set by consequence, not by frequency.** One user losing money
outranks fifty users seeing a misaligned button. Frequency belongs in the report
so the team can prioritise; it does not change the severity.

**Severity is not priority.** Severity is a property of the defect and QA owns
it. Priority is a business decision about when to fix it, and the product owner
owns that. A Critical defect can be deprioritised — that is a legitimate call,
made in the open, and it does not make the defect Minor.

## Origin — where did it enter?

| Origin | Meaning | Where the work goes |
|---|---|---|
| **DEV** | The code diverges from a correctly written specification | The developer, with the citation |
| **SPEC** | The specification itself is wrong, missing, or contradictory | The person who owns the requirement — **not** the developer |

Routing a SPEC-origin finding to a developer wastes a day and produces a fix
that is still wrong, because nobody decided what right was.

Origin is recorded to improve the process, never to assign blame. A team where
origin becomes a scoreboard will stop recording it honestly within a month, and
then the data is worse than useless.

## The third outcome

Some findings are neither. The product does one thing, the reporter expected
another, and **nothing written says which is correct**. That is not a defect and
not a misunderstanding — it is an undecided question. It goes back as a decision
request quoting both readings, and no work starts until it is answered.

Recording that honestly, instead of picking whichever reading is easier to
implement, is one of the most valuable things a QA does.
