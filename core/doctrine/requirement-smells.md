# Requirement smells — reading a ticket like a QA

> `/qa` applies this in V1, before writing a single expected value. `/onboard`
> applies it to the specs it finds in O1. The cheapest defect to find is the one
> that is still a sentence.

A ticket is the developer's brief, and it was written to get the work started,
not to be tested against. The words that make a ticket easy to write are the
words that make it impossible to verify. Reading for them is the highest-leverage
hour in the whole verification: an ambiguity found now costs one question; the
same ambiguity found after a day of testing costs the day, and then the argument.

## The test every acceptance criterion must pass

For each criterion, try to write the three things the case manifest will need:

| Can you write… | If not, the criterion is… |
|---|---|
| **EXPECTED as a concrete value with a source** — "total = 450,000, spec §3.2" | a wish, not a requirement |
| **the boundary that must behave the other way** — "449,999 is refused" | a rule with no edge, so nobody knows where it stops |
| **AS — the role, and the state they start in** | a behaviour with no actor, so it cannot be reproduced |

A criterion that fails all three is not an acceptance criterion; it is a
sentence that sounds like one. The ticket is not wrong for containing it. It is
untestable *as written*, and saying so before you start is the job.

## The words that hide a decision

| The word | What it is hiding | The question to ask |
|---|---|---|
| **should / may / could / ideally** | Whether this is required at all | "Is this a must, or a nice-to-have? If the product does not do it, is that a defect?" |
| **quickly / fast / responsive / user-friendly / intuitive / appropriate / properly / correctly / as expected** | A number, or a picture | "What number? Under how many seconds, on which connection? Show me one screen that does it right." |
| **etc. / and so on / such as / …** | The rest of the list | "Is the list complete? What is the full set — and what is deliberately not on it?" |
| **the user** | Which role | "Which roles can do this? Which roles must not — and what do they see instead?" |
| **handle / process / manage / support / deal with** | The outcome | "What exactly happens, on the screen and in the data, when it is handled?" |
| **show an error / display a message** | Which message, where, and what happens to the data | "What is the exact text? Next to the field or at the top? Does the form keep what was typed?" |
| **like the other screen / same as X / consistent with** | Whether X is specified, and which parts carry over | "Which screen exactly? Is X's behaviour written anywhere, or are we copying whatever it currently does?" |
| **always / never / all / none** | The exception | "Including when the order is already shipped? Including the admin? Including the import?" |
| **over / under / more than / at least / up to / between** | Whether the boundary is included | "Is exactly 100 over 100? Is the range inclusive at both ends?" |
| **a number with no unit** | The unit, the currency, the timezone, the precision | "100 what? Before or after tax? In which currency? Rounded how?" |
| **and/or · or** | Whether both can be true; which wins | "If both apply, what happens? Which rule takes precedence?" |
| **passive voice with no actor** — "the order is cancelled" | Who or what triggers it | "Cancelled by whom, from where, at what moment? Can it be cancelled twice?" |
| **automatically / in the background** | When, how often, and what the user sees | "When exactly? What if it fails? Does the user know it ran?" |
| **valid / invalid** | The rule | "Valid according to which rule, written where?" |
| **the system** | Which component, and therefore which screen the user is on | "Where does the user see this happen?" |

## The shapes that hide a missing half

| The ticket has… | And says nothing about… |
|---|---|
| A happy path | What happens when it fails — the network, the validation, the permission, the concurrent edit |
| A permission granted | The denied side — what the other role sees, and whether the URL is also blocked, not just the menu item |
| A state change forward | The reverse; what happens when it is already in that state; what happens after a reload |
| A notification | The recipient, the channel, the timing, the exact content, and what stops it being sent twice |
| A new field | Its default; whether it is required; whether existing records have it; the export, the API, the search |
| A date rule | The timezone; the boundary at midnight; month-end |
| A calculation | The rounding; the order of operations; the currency; what is displayed vs stored |
| "No change to existing behaviour" | **What the existing behaviour is, and where it is written.** This is the regression claim, and it is usually the largest claim in the ticket, made in the smallest sentence. |
| A solution ("add a flag", "add a column") | The problem — the user outcome it serves. A solution with no outcome cannot be verified, only confirmed to exist. |
| A fixed defect ("fixed the total") | The reproduction steps of the original, so the fix can be checked against them — and the neighbours the fix may have broken |

## What the ticket says versus what the spec says

Read them side by side. Three things can happen, and each has a name:

- **They agree** — proceed; cite the spec, not the ticket.
- **The ticket adds detail the spec does not have** — the detail is
  `[INFERRED from ticket]`, not an expected value. Ask whether the spec should
  be updated; until it is, a divergence there is a *difference*, not a defect.
- **They contradict each other** — the spec wins, and the contradiction is a
  finding **before any testing starts**. A developer who builds to the ticket
  will build the wrong thing correctly, and the earlier they hear, the cheaper.

## What to do with what you find

1. Write every question into the verify sheet under **Ambiguities**, one line
   each, in plain language, with **what it blocks** — "until this is answered I
   cannot design the boundary case for criterion 2."
2. **Ask before testing, not after.** Batch the questions into one message to
   the requirement owner — not the developer, who did not write the ticket.
3. An ambiguity that decides a case → that case is `BLOCKED (decision needed)`
   with the question quoted. An ambiguity that does not → note it and proceed.
4. A ticket that is smells all the way down gets the honest verdict:
   `BLOCKED (not testable as written)`, with the list of questions. That is not
   a failure of the verification. It is the verification's first finding.

## Tone

The questions are about the text, never about a person. "This sentence can be
read two ways — which one is meant?" gets an answer in five minutes. "This
ticket is vague" gets a defence. The person who wrote the ticket was trying to
get work started, and did. You are trying to find out what "done" means, and
that is a different job with a different reader.
