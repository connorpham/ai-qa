# Writing a test case — understood in fifteen seconds

> `/qa` opens this in V2, the moment it starts writing a case record, and
> again in V4 when it fills in ACTUAL. `/triage` opens it in T6 for the steps
> and the expected line. `/regress` opens it when it promotes a journey.

A test case has two readers. The one who runs it needs to be unable to do it
wrong. The one who reads the result — a product owner, a developer, you in six
months — needs to know **what was checked, what should have happened, and what
did**, without opening a screenshot or asking anyone. Most case records fail the
second reader, and they fail in the same five ways: a title that names a topic
instead of a behaviour, steps that hide the value that was typed, an expected
line that says "works", an actual line that says "failed", and three checks
folded into one case so that none of them can be named.

## The fifteen-second test

Cover everything except **TITLE, RESULT, EXPECTED, ACTUAL**. A stranger reads
those four lines. Do they know what happened? If they have to open STEPS to
understand EXPECTED, the expected line is too thin. If they have to open the
screenshot to understand ACTUAL, the actual line is too thin. If they cannot
tell from the title *which* behaviour was being checked, the title is a label,
not a title.

## TITLE — a sentence about behaviour, not a label about a topic

The title is what the folder is called, what the spreadsheet row says, what the
report's table quotes, and what a developer types into a commit message. It is
the most-read line in the whole pack. Write it as **a sentence stating what the
product does under a condition, from the user's side**:

```
<who / the thing> <does what, under what condition> → <what must happen>
```

| Instead of | Write |
|---|---|
| `Discount test` | `A gold-tier order over 500,000 gets the 10% discount` |
| `TC_2 boundary` | `An order of exactly 499,999 gets no discount` |
| `Check validation` | `A quantity of 0 is refused with a message naming the minimum` |
| `Save works` | `Changing a quantity and pressing Save recalculates the total` |
| `Permissions` | `A staff account cannot open another branch's orders by URL` |
| `Regression` | `The orders list keeps its Pending filter after an edit` |
| `Test expired coupon and used coupon` | Two cases. `An expired code is refused` · `A code already used is refused` |

Rules, each because a title failed without it:

- **Has a verb, and the verb is what the product does** — *gets, is refused,
  recalculates, keeps, cannot open*. "Test", "check", "verify", "validate" are
  what *you* do, and they belong in no title.
- **Names the condition** that makes this case different from its neighbours:
  *over 500,000*, *exactly 499,999*, *by URL*, *after an edit*.
- **States the outcome**, including when the outcome is a refusal. A boundary
  case's title says what is refused, not that a boundary was tested.
- **Twelve words or fewer.** Longer means two behaviours; split them.
- **No "and".** An "and" in a title is two cases sharing one RESULT, and when
  one half fails the other half's PASS is lost.
- **The folder name is the title in snake_case**, so `ls` reads as a test plan:
  `TC_2_an_order_of_exactly_499999_gets_no_discount`. The two must say the same
  thing; a folder called one thing and a TITLE saying another makes the reader
  choose.

## One case, one claim

A case proves one sentence. Three assertions in one case means: a single RESULT
for three facts, a FINDING that has to say "partly", a spreadsheet row that
cannot be sorted, and a developer who fixes one of the three and closes the
case. If you find yourself writing "also check that…", that is the next case's
title.

The exception is deliberate: the whole-screen case walks a *list* of looks. Its
claim is still one sentence — *"the orders screen is intact after the change"*
— and its STEPS record which looks were taken.

## The fields, and what "written well" means for each

Every value is one line unless the field says otherwise. The gate reads the
keys; a human reads the values. Write the values for the human.

**AS** — the account, its role, and the persona in brackets.
`staff@demo (STAFF) — the daily operator`. Not "a user". Not "admin" when the
ticket is about staff.

**PRECONDITION** — the *state* the product is in when the case starts, resolved
now, not the history of how it got there. Every value that STEPS or EXPECTED
depends on is named here, with its id.

| Instead of | Write |
|---|---|
| `an order exists` | `order #4102 exists, status Pending, 2 × item A at 150,000 (checked read-only at 10:02)` |
| `I created some test data earlier` | `customer ZZTEST-Ánh exists, tier Gold since 2026-08-01, no orders this month` |
| `logged in` | (that is ENTRY, not a precondition) |

**ENTRY** — the click path, with arrows, from signed-in to the screen. Every
word is a label the user sees on screen, spelled the way the screen spells it.
`signed in as staff → Orders → filter "Pending" → row #4102 → "Edit"`. A URL
may follow in brackets as the second path. Never alone.

**STEPS** — numbered, **one action per number**, in the imperative, each with
the exact value entered and the exact label pressed. The spreadsheet splits on
the numbers, so `1. … 2. …` on one line or one per line both work.

| Instead of | Write |
|---|---|
| `enter a valid quantity` | `1. clear "Quantity" · 2. type 3` |
| `apply a coupon` | `3. type SAVE10 into "Coupon code" · 4. press Enter` |
| `save and verify the total` | `5. press "Save"` — verification is not a step; it is EXPECTED |
| `wait for the page` | `6. wait until the "Saved" banner appears` — name what you waited for |
| `try to break it` | the specific thing you did: `7. press "Save" a second time within one second` |

Three rules: **no verification verbs in STEPS** (check, verify, confirm, see
that — those are EXPECTED's job); **the value is written as typed**, including
the trailing space if that was the point (`type "SHOP-142 " — note the trailing
space`); **seven steps or fewer**, because more than seven means PRECONDITION
should have carried more of the setup.

**EXPECTED** — an **observable fact**, stated as what *is*, with the number or
label the screen shows and the citation in brackets. The whole verification
lives in this line. It must be something a person can look at the screen and
agree or disagree with.

| Instead of | Write |
|---|---|
| `works as expected` | `the "Total" line reads 450,000 ₫ (spec §3.2 R1)` |
| `discount is applied correctly` | `a "Discount" line reads −50,000 and "Total" reads 450,000 (spec §3.2 R1)` |
| `shows an error` | `the field turns red and reads "Minimum quantity is 1"; nothing is saved (spec §3.4)` |
| `should not allow` | `"Save" stays disabled and the row keeps quantity 2 (spec §3.4)` |
| `redirects properly` | `lands on Orders, filter still "Pending", row #4102 highlighted (spec §5.1)` |
| `the API returns 200` | `status 201; body `total` is 450000 and `discount` is 50000 (contract §orders.create)` |

Four rules: **no "should"** — write the fact, the spec already carries the
obligation; **a number, a label, or a state**, not an adjective; **the same
grain as ACTUAL** so the two lines can be read side by side; **the citation on
the line**, because an expected value with no source is your opinion, and the
traceability sheet is built from it.

Words that cannot appear as the whole of EXPECTED or ACTUAL — the gate refuses
them, because each one has been the entire content of a real case record:
*works · works fine · works correctly · works as expected · correct · correctly ·
properly · OK · fine · success · successfully · passes · no errors · no issues ·
behaves as expected*. If the only thing you can write is one of these, you do
not yet know what the product is supposed to show. Go back to the spec.

**ACTUAL** — the same shape as EXPECTED, so the eye compares line by line. On a
PASS it may say `as expected` **only after** restating the value: `"Total"
reads 450,000 ₫ — as expected`. On a FAIL it carries **the exact wrong value
and what is missing**, never a judgement.

| Instead of | Write |
|---|---|
| `failed` | `"Total" reads 500,000 ₫; no "Discount" line is shown` |
| `did not work` | `"Save" stayed enabled; a second order #4103 was created` |
| `error` | `a grey page reading "Something went wrong" with no way back; the quantity was not saved` |
| `ok` | `the field turned red and read "Minimum quantity is 1"; the row kept quantity 2 — as expected` |

**AFTER** and **BACK** — the answers to the four questions a person asks after
every click: did it work, where am I, can I undo it, did I lose anything.
`AFTER: banner "Order #4102 saved" · list row shows 3 · Total 450,000 survives a
reload · badge "Pending 12" unchanged`. `BACK: browser Back returns to Orders
with the "Pending" filter kept; Cancel on the edit form discards the change.`

**FINDING** (on FAIL) — the defect, not the case. One line a manager can read
alone: `<where> <what is wrong> — <under what condition>`.
`[Order edit] Total ignores the quantity change — when Save is pressed with
Enter instead of the button`. **SEVERITY** and **ORIGIN** are one word each.

**OBSERVATIONS** — what you saw and did not judge, one line each.

## Numbers, dates, names

- **Money** with thousands separators and its currency: `450,000 ₫`, `$1,299.00`.
  A bare `450000` makes the reader count digits.
- **Dates** unambiguous: `2026-09-04` or `4 Sep 2026`. Never `09/04`.
- **Times** with the timezone when it matters: `23:59 (Asia/Ho_Chi_Minh)`.
- **Ids** with their prefix: `order #4102`, `customer ZZTEST-Ánh`.
- **Labels** exactly as the screen spells them, in quotes: press `"Save"`, not
  *the save button*. When the screen is in Vietnamese, the label is in
  Vietnamese.
- **The same name for the same thing** throughout the pack. The screen you call
  "Orders" in ENTRY is "Orders" in BACK, not "the order list".

## Words from the code stay out

The reader is a person who uses the product. Selectors, route names, table and
column names, HTTP verbs, component names — none of it belongs in a case record
a stranger reads. It goes in `db_verify.md`, `cmd_verify.md`, the journey script,
or the report's appendix, where the person who needs it will look.

| Instead of | Write |
|---|---|
| `click #btn-save` | `press "Save"` |
| `POST /orders returns 201` | in a UI case: `an order appears in the list with status "New"` · in an API case, in cmd_verify: the request and the body fields by name |
| `orders.total column updated` | `the order's total, read back from the database, is 450,000` (and the query is in db_verify.md) |
| `the modal component re-renders` | `the dialog closes and the list behind it shows the new value` |

## Writing in the project's language

The record is written in `project.language`. The **field keys** stay in English
— `RESULT:`, `EXPECTED:`, `SEVERITY:` — because the gate reads them, and so do
the six result words `PASS / FAIL / BLOCKED` and the severity ladder. Every
**value** is in the project's language, including screen labels as the localised
screen shows them. A Vietnamese team should not need to read English to know
what "the total reads 450,000" means; the sentence after `EXPECTED:` is theirs.

## One record, before and after

Before — every field present, the gate green, and nobody can tell what happened:

```
TITLE: discount test
RESULT: FAIL
AS: user
PRECONDITION: order exists
ENTRY: go to the order
STEPS: 1. apply coupon 2. check total
EXPECTED: discount applied correctly
ACTUAL: not working
```

After — the same case, readable by a stranger in fifteen seconds:

```
TITLE: A SAVE10 code on an order of 500,000 takes 50,000 off the total
KIND: acceptance
RESULT: FAIL
AS: customer zztest.anh@demo (CUSTOMER) — the daily operator, keyboard
PRECONDITION: cart holds 2 × "Áo sơ mi" at 250,000 = 500,000; code SAVE10 is active until 2026-09-30 (checked read-only 10:02)
ENTRY: signed in → cart icon → "Checkout"
STEPS: 1. type SAVE10 into "Coupon code" · 2. press Enter · 3. read the totals block
EXPECTED: a "Discount" line reads −50,000 ₫ and "Total" reads 450,000 ₫ (spec §3.2 R1)
ACTUAL: "Discount" line reads −50,000 ₫; "Total" still reads 500,000 ₫
AFTER: after a reload "Total" still reads 500,000 ₫; the order summary email quotes 500,000 ₫
BACK: Back returns to the cart with 2 items; the code is no longer shown as applied
REQUIREMENT: 3.2 R1
SEVERITY: Critical
ORIGIN: DEV
FINDING: [Checkout] Total ignores the discount line — when the code is applied with Enter
OBSERVATIONS: the "Apply" button next to the field did nothing on the first click, worked on the second
```

The second record is longer by nine lines and shorter by every question the
reader would otherwise have had to ask.
