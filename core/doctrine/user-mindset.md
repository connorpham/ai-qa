# The user's mind — test as the person who will actually use this

> `/qa` reads this in V1, before it designs a single case. `/triage` reads it
> before reproducing. If a case in your sheet could have been written by
> someone who has never watched a real person use software, this file is why
> it will miss the defect.

## The user is not you, and not the developer

The developer knows where every button is, types the right value the first
time, waits for the spinner, and never presses anything twice. So do you, by
the third case. **Nothing that breaks in production is found by that person.**

The person the product is for is doing a job, and the product is in the way of
it. They are in a hurry. They are interrupted. They do not read. They do not
know the internal name for anything. They will press whatever looks most like
the thing they want, and when nothing happens they will press it again. They
copy from Excel, paste with a trailing space, and answer the phone mid-form.
They come back tomorrow to a tab they left open, and they expect it to work.

A verification that never puts the product in front of that person has verified
it for nobody.

## Four people to borrow, one per case

Name the one you are borrowing in the case manifest as `PERSONA:`. It changes
which steps you take and what you look at afterwards.

| Persona | How they arrive | What they do that your script would not | What they notice |
|---|---|---|---|
| **The first-timer** | Reads nothing. Follows the biggest visible affordance. | Takes the wrong path first and backs out. Leaves the required field for last. Does not know a red border means "fix me". | Whether the screen tells them what happened, and what to do next. An empty state with no words is a dead end to them. |
| **The daily operator** | The 200th time today. Keyboard, Tab, Enter, muscle memory. | Presses Enter instead of Save. Tabs past the new field you added. Relies on the default that changed. Does the same action twice in a row and expects two records. | Every extra click. A default that moved. A field that lost focus. Speed — a 2-second delay they meet 200 times is a defect to them. |
| **The interrupted one** | Starts, stops, comes back. | Phone rings mid-form. Returns after lunch to an expired session. Leaves the tab open overnight. Opens the same record in a second tab to check something. Presses Back after Save. | Whether their half-done work survived. Whether the second tab and the first now disagree. Whether "session expired" ate the form. |
| **The one in hostile conditions** | Slow network, small screen, browser autofill, a locale that is not the developer's. | Double-clicks Submit because nothing happened. Refreshes mid-load. Pastes `1.000,00`. Autofill puts an email in the name field. Zooms to 150% and loses the button below the fold. | Whether the product falls over or degrades. Whether one click became two orders. |

The persona is not decoration. The daily operator finds the default that
silently changed; the interrupted one finds the save that only works if you
never leave; the hostile one finds the double order. None of them appears in a
happy path.

## What real people do that scripts never do

Put at least one of these into the STEPS of every case — not as a separate case,
as part of the journey. This is what "test as a user" means in practice.

| The move | Why a real person makes it | What it usually finds |
|---|---|---|
| **Double-click Submit / Pay / Send** | Nothing visible happened for half a second. | Two records, two payments, two emails. The single most expensive defect class in commerce. |
| **Press Enter instead of clicking** | Keyboard users, always. | The form submits with a different handler, or does not submit at all. |
| **Back after Save** | To see the list, or by reflex. | The form resubmits; the confirmation is gone; the browser asks about re-posting. |
| **Refresh mid-action, or right after** | Impatience, or a wobble in the network. | A save that never landed; a spinner that never ends; state that reverts. |
| **The same record in two tabs** | Checking something without losing their place. | The second save overwrites the first silently. No conflict warning. |
| **Paste, not type** | Copying from a spreadsheet, an email, a chat. | Trailing whitespace passes validation and breaks the lookup; the input mask never ran; the character counter is wrong. |
| **Browser autofill** | Every address form, every time. | Values land in the wrong fields; a hidden field is filled; validation fires before the user typed. |
| **Type, delete, retype** | They changed their mind. | Validation state sticks to the old value; a stale error stays; a stale success stays. |
| **Select all, delete** | Clearing a field. | Empty is treated as unchanged; the old value is silently kept. |
| **Escape, click outside, close the modal** | The universal "never mind". | Half the action already happened. Cancel that does not cancel. |
| **Navigate away with unsaved changes** | A notification, a link, a thought. | Work lost with no warning — or a warning that fires when there is nothing to lose. |
| **Return via the link in the email or notification** | That is what the link is for. | It lands on the wrong record, the wrong tab, as the wrong role, or on a login screen that forgets where they were going. |
| **Come back tomorrow** | People have lives. | The list is stale and edits fail; the session expired mid-form and the form is gone; the "new" badge never clears. |
| **Sort, then filter, then page, then edit** | Finding one row among thousands. | The edit returns to page 1 with the filter reset. The row they edited is gone from view and they edit it again. |
| **Do the minimum, accept every default** | Most people, most of the time. | The default is wrong. Nobody tested the default because everybody typed a value. |

## The four questions after every action

A real person asks these after every click, and a screen that fails to answer
one is a defect a spec rarely bothers to write down:

1. **Did it work?** — a confirmation they can see without scrolling, naming what happened.
2. **Where am I now?** — the list behind, the breadcrumb, the tab, the selected row.
3. **Can I undo it?** — Cancel that cancels, Back that goes back, the reverse action.
4. **Did I lose anything?** — the filter, the draft, the other fields, the other tab's work.

Write the AFTER and BACK fields of the manifest as the answers to these four.
"AFTER: toast says Saved" answers one of them. Answer all four.

## What the user actually notices

Whole-screen sanity is not "the page rendered". It is what a person would see
was wrong in the first three seconds. Look at these before you call a case done:

- **The number in the header** — cart total, balance, count. It is the one thing everyone reads.
- **The badge** — unread count, pending count. A stale badge is the most reported "bug" in any inbox-shaped product.
- **The row in the list behind the form** — does it show the new value, in the right position, with the right status?
- **The toast or banner** — did it say the right thing, once, and go away?
- **The email or notification that should have gone out** — to the right person, with the same numbers as the screen.
- **The button state** — is Save disabled now, and Edit enabled? Is anything still spinning?
- **The empty state** — when the last row goes, does the screen say so and offer the next step, or is it just blank?
- **The wording** — a label that says "Customer" above a field that now holds a supplier. Fixes rename things and forget the labels.

## How this changes the manifest

Nothing is removed; the gate's fields stay. Three lines are added when they apply:

```
PERSONA:      the interrupted one — starts the form, session expires, returns via the email link
STEPS:        1. … 2. leave the tab for 35 min (session TTL 30, dossier §3) 3. return, press Save
OBSERVATIONS: the Save button stayed enabled during the request — pressed twice, one record created (ok);
              the list behind still showed the old total until a manual refresh (not in scope; noted)
```

**OBSERVATIONS are not verdicts.** They are what you saw while looking for
something else: a flicker, a slow response, a wrong label two panels away, a
console error, a badge that did not update. They carry no severity and change no
RESULT. They go in the case manifest and into the report's Observations section,
because the thing that made you pause is very often the next ticket — and
because a verification that reports only what it was asked about has thrown
away half of what it saw.

The rule for them: **the thing that made you say "hm" gets one more click and
one line.** Not an investigation. One click, one line, move on.

## The line you do not cross

None of this changes the oracle rule. A persona tells you *how* to arrive and
*what to look at*; it never tells you what the value should be. "A daily
operator would expect Enter to save" is a reason to press Enter, and a reason
to write a decision request if the spec is silent — it is not a reason to file a
defect. What a real person would do is your method. What is correct is still
written down somewhere, or it is still unknown.
