# Writing the report — understood at first read

> `/qa` opens this in V5b, before writing a word of `REPORT.md`, and again in
> V7 before summarising to the user. `/onboard` applies its language rules to
> the dossier. `/triage` applies them to the bug report.

The report is the only artefact most people ever see. A product owner reads the
first five lines on a phone between meetings. A client reads the table. An
auditor reads the findings six months later. None of them will open the
evidence folder, and none of them work in the code. **The report is finished
when each of those readers can stop after any section and still have the
truth.**

## The five lines everyone reads

The heading and the three lines under the header block are the report. Everything
else is support. Write them last, after you know what you found, and write them
so they can be pasted into a chat without the rest:

```
# SHOP-142 — FAIL
COMMIT: 3d9d99d
VERIFIED-AT: 2026-09-04T10:41:00+07:00
ENVIRONMENT: stg — https://stg.shop.example
ORACLE: docs/spec/discounts.md §3.2

**Verdict:** The SAVE10 discount shows on the screen but is not taken off the total — a customer is charged the full 500,000.
**What it means:** Every discounted order since this change is overcharged; customers will notice on the receipt.
**Next step:** Back to the developer with defect 1 (Critical). Release should wait for it.
```

- **Verdict** — one sentence, what does or does not work, for whom, in the
  user's words. Not "the requirement is not met": *what* is not met and *who*
  feels it.
- **What it means** — the consequence for a person or for money, in one
  sentence. This is the line the manager forwards. If you cannot write it, you
  do not yet know how bad the finding is, and its severity is a guess.
- **Next step** — who does what. *Back to the developer with defect 1* · *Ready
  to release* · *Decision needed from the product owner on whether tax applies
  before or after the discount* · *Blocked until ops grants a refund account*.

Under sixty words for the three together. The forward test: **could the product
owner paste these three lines into the team chat and would everyone know what
to do?**

## The verdict word, in the reader's terms

The first line carries one of six words the gate reads. The reader does not
know what they mean; the Verdict sentence has to say it in plain terms:

| Word | Say it as |
|---|---|
| **PASS** | "does what the specification says, for every check I ran" |
| **FAIL** | "does not do what the specification says" — and name the gap |
| **PARTIAL** | "some of what was asked works; this part does not" |
| **NEW-BUG** | "what was asked works; on the way I found something else broken" |
| **BLOCKED** | "I could not check this, because …" — never a softer word for it |
| **UNCLEAR** | "I checked it, and nothing written says which behaviour is correct" |

There is no "PASS with notes". If a defect was found, the verdict is not PASS.
If the verdict is PASS, the Observations section is where the notes go, and
they are not defects.

## Section by section

**1. What was asked for** — told as a user, in three sentences at most:
*On <screen>, when <who> <does what>, the product must <outcome> — because
<the rule, in plain words>. The developer reports it done.* The source is named
as a person would name it — "the discounts rule" — with the file in the
appendix.

**2. What I checked** — one row per case, and **the row is labelled by the
case's title**, never by its number. `TC_3` tells the reader nothing;
*"An order of exactly 499,999 gets no discount"* tells them everything. Columns:
what I checked · as whom · expected · actual · result. Every cell under fifteen
words; the expected and actual cells carry the number or label, the same way
the case record does. Result is one mark: ✅ passed · ❌ failed · ⛔ could not
run.

> **The row is a Given / When / Then scenario, and that is on purpose.** Behaviour-
> driven development already gave the world a shape every reader understands
> without training: *Given* a situation, *When* someone acts, *Then* this must
> follow. A case record is exactly that — **Given** its `AS` and `PRECONDITION`,
> **When** its `STEPS`, **Then** its `EXPECTED` — so *as whom* is the Given,
> *expected* is the Then, and *actual* is what in fact happened. You do not have
> to write the keywords in the report's table, but the case must be able to be
> read that way; a case that cannot be phrased "Given… When… Then…" is missing an
> actor, an action, or an oracle. The workbook's **Evidence images** sheet prints
> the scenario in full — Given/When/Then in plain language — and then embeds every
> step's screenshot in order, so a reader who opens nothing else still sees *what
> was done*, step by step, not only how it ended.

**3. What I found** — one block per defect, worst first, or the sentence *No
defects found.* Each block is a story with a bold first line:

```
**[Checkout] Total ignores the discount — when the code is applied with Enter.**
When a customer types SAVE10 and presses Enter, the discount line appears but the
total stays at 500,000. It should read 450,000 (the discounts rule, §3.2). The
customer pays 50,000 more than they were promised, on every order that uses a code.
Severity: Critical · Origin: the code, not the rule · Evidence: TC_1 — 03_totals_boxed.png
```

Four sentences: **what a user does and what happens · what should happen and
where that is written · who it hurts and how · the grading line.** The grading
line says "the code" or "the written rule", not DEV or SPEC — those two words
are for the spreadsheet, and the reader of the report has never met them.

**4. Conclusion** — one to three sentences: requirement met or not, how sure,
what was not covered. Then one bold **Recommendation:** line about the ticket
as a whole. The spreadsheet prints this section on its first sheet, so it has
to read as a whole without the rest of the report around it.

**5. What I could not check** — never omitted. *Nothing* is an acceptable
answer; a missing section is not. Otherwise: *I could not check <what> because
<reason>. Tried: <what>. To unblock: <who does what>.* A report that hides what
it could not check is lying by structure, and it is the most common lie in the
genre.

**6. Observations — seen, not judged** — one line each, no severity. The reader
planning next week starts here; the reader who wanted the verdict has already
stopped.

**Appendix** — the verify sheet, the citations by file and section, the debate,
every evidence file as *path → what it shows*, and all the technical vocabulary
that was kept out of the body. Unbounded.

## Language rules

The body — everything above the appendix — is read by someone who uses the
product and has never seen its code. Every rule here exists because a report
was ignored by the person who most needed to read it.

- **The user's words, the screen's labels.** "The Checkout screen", "the Save
  button", "the Pending filter" — spelled as the screen spells them.
- **Active voice, one idea per sentence.** *The total ignores the discount.*
  Not *It was observed that the discount was not reflected in the total.*
- **Numbers with separators and units; dates you cannot misread.**
  `450,000 ₫`, `4 Sep 2026`, `23:59 Hanoi time`.
- **The same name for the same thing**, every time. The screen you call
  "Orders" in section 1 is "Orders" in section 3.
- **No hedging where you saw it.** *Seems to*, *appears*, *might*, *I think*,
  *probably* — either you observed it, and you say so, or you did not, and it
  goes under what you could not check.
- **No case numbers in prose.** Say the title. `TC_3` is a folder name.
- **No technical vocabulary in the body.** The words below arrive by habit;
  each has a plain version:

| Arrives by habit | Say instead |
|---|---|
| the oracle | the written rule · the specification |
| the manifest · the case record | the record of the check |
| assertion · assert | check · the check that … |
| endpoint · route · API | the screen · the call the app makes |
| regression | something nearby that used to work |
| boundary case | the edge of the rule — exactly 499,999 |
| happy path | the normal case |
| precondition | the starting point |
| persona | the kind of user — a first-time customer |
| DEV / SPEC | the code · the written rule |
| reproduce | make it happen again |
| stack trace · 500 · exception | an error page · the product fell over |
| null · undefined · NaN | blank · missing · not a number |
| commit · SHA | the exact version tested (and the appendix carries the id) |

## Length

| Part | Budget |
|---|---|
| Header and the three summary lines | under 60 words |
| 1. What was asked for | three sentences |
| 2. What I checked | one row per case, cells under fifteen words |
| 3. What I found | four sentences per defect |
| 4. Conclusion | three sentences and one recommendation |
| 5. Could not check | one line per item |
| 6. Observations | one line per item |
| Appendix | unbounded |

Sections 1 to 6 fit on one screen without scrolling on a laptop. If they do
not, something from the body belongs in the appendix.

## Writing in the project's language

`project.language` is the WORKING language, not a translation step at the end:
the `▶` narration, the questions to the team, the chat summary, the bug report
and the dossier are written in it from the first word. Drafting in English and
translating afterwards produces the stilted sentence a reader stumbles on — if
you find yourself translating, you drafted in the wrong language.

The report is written in `project.language`. Six things stay in English because
the gate and the spreadsheet read them: the verdict word on the first line, the
`COMMIT:` / `VERIFIED-AT:` / `ENVIRONMENT:` / `ORACLE:` keys, the four severity
words, and the bold `**Recommendation:**` label. Everything else — the three summary lines,
the section headings' text, the table headers, the findings — is written for
the team that reads it, and English test jargon is not mixed in. *"Verdict"*
can be *"Kết luận"*; *"PASS"* on the first line cannot.

Screen labels are quoted as the product displays them. On a Vietnamese product
the button is *"Lưu"*, so the step says `press "Lưu"` — never `press "Save"`
with the label translated back to English, because the reader will look for a
button that does not exist.

## Before and after

A conclusion as they are usually written:

> The verification was executed against the ticket's acceptance criteria. TC_1
> passed. TC_2 failed due to an issue with the discount calculation logic where
> the total did not reflect the applied discount value. TC_3 passed. Severity
> Major. It is recommended that the development team investigate the
> calculation and re-submit for QA.

The same conclusion, for the person who has to act on it:

> The discount shows on the screen but is not taken off the total, so a customer
> using SAVE10 pays the full 500,000 instead of 450,000. The other two checks —
> an order under the threshold gets no discount, and the checkout screen is
> otherwise intact — passed. I could not check the email receipt, because no
> test account receives mail.
>
> **Recommendation:** send it back to the developer for the total; release
> should wait, because every discounted order is overcharged until it is fixed.

The first version is not wrong. It is unreadable by the person it is for, and
it grades a defect *Major* whose consequence — every discounted order
overcharged — is Critical. Writing the consequence out is how the severity
gets checked.

## Before you send it

Read the three summary lines aloud as if to the product owner. Then ask:

1. Could they act on those three lines alone?
2. Does every finding say who it hurts?
3. Is there a case number, a file path, or a word from the jargon table in the body?
4. Is the "could not check" section present, even if it says *Nothing*?
5. Would a reader who stopped after section 2 believe something the conclusion contradicts?

Five yeses and one no on question 3 and 5, and it is ready.
