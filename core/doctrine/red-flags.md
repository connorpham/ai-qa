# Red flags — the excuses, and the gate that catches each one

Every line here is a real shortcut with a real justification attached. They are
listed so that when you hear yourself think one, you recognise it as a known
pattern rather than as this situation being special.

| The thought | What it actually is | Caught by |
|---|---|---|
| "The code clearly does X, so it works." | Reading, not testing. Code tells you what it does — never whether that is right. | Principle 2: a verdict needs a run that happened |
| "The API returned 200." | A status code is not a behaviour. A 200 carrying the wrong number is a defect. | Body checked against the contract |
| "It worked when the developer demoed it." | Their path, their data, their machine. Defects hide off the beaten path. | Independent data through the real flow |
| "I'll just set the row directly, it's faster." | You tested the database, not the product. The flow that creates the row is often where the defect is. | Write gate: data through the UI or BLOCKED |
| "I'll type the URL, the menu is fine." | The address proves the address. A missing menu item, a wrong permission and an unreachable row all hide behind it. | ENTRY must be a click path |
| "The number changed, that's the assertion." | A save that dies on reload is not a save. | AFTER includes survives-a-reload |
| "The spec doesn't say, but obviously it should…" | Inventing an expected value. The most damaging thing in this file. | BLOCKED and escalated — never guessed |
| "It's basically the same as the known issue." | Either it is a duplicate or it is not; "basically" is how a real defect gets closed. | Dedup with the id written down |
| "Screenshot of the whole page is enough." | The reader has to guess which pixels mattered. In six months, that reader is you. | Annotation gate: box plus caption |
| "I'll write the report after I fix the flaky test." | The report is the deliverable. Everything else is preparation. | Evidence gate before reporting |
| "The challenger agreed, so we're done." | Agreement without a run is two opinions, not a verification. | Consensus with no executed run = UNCLEAR |
| "I found a small bug, I'll just fix it." | The moment QA edits product code, nobody is checking it — including this change. | No product code changed |
| "It's only cosmetic." | Maybe. Say so and record it as Minor, with evidence. Do not skip it silently. | Every finding carries a severity |
| "I couldn't run it, but it obviously works." | The single sentence that makes a whole report worthless. | BLOCKED with reason and unblock path |
| "I'll fill that unknown in later." | It never gets filled in, and by then it reads as a fact. | Dossier tags: OBSERVED / INFERRED / TOLD BY / UNKNOWN |
| "I typed the perfect value once and it saved." | A script tested the route. Nobody double-clicked, pasted, pressed Enter, or came back after lunch. | A real-user move in every case's STEPS; `PERSONA:` named |
| "The ticket is clear enough, I'll start." | "Should", "quickly", "the user", "like the other screen" — each one is a decision nobody has made yet, and you will find it on day two as an argument. | Ambiguities listed and asked **before** V2 — `requirement-smells.md` |
| "That flicker isn't what I'm testing." | It is what the user will report next week. | `OBSERVATIONS:` in the manifest — one click, one line |
| "No spec, so I can't say anything." | You can say what it is inconsistent with — itself, its last release, its own tooltip — and who owes the decision. | Consistency oracles in `heuristics.md`; ORIGIN: SPEC |

## The traps in your own head

The excuses above are things you say. These are things you do without saying
anything, and they are why the fresh challenger, the exploratory slot and the
`MY WEAK SPOT:` line exist. You cannot will them away; you can only build the
run so they have less room.

| The trap | How it shows up in a verification | The countermeasure built into the lane |
|---|---|---|
| **Confirmation bias** | You are looking for the PASS. The screenshot that shows it is the one you take; the toast that said "error" two seconds earlier is the one you did not see. | Write `MY WEAK SPOT:` *before* the challenger. Design case ② to make the product refuse something. |
| **Anchoring on the developer's description** | The ticket says "fixed the total", so you check the total. The rounding on the line items is where the fix moved the defect to. | Derive EXPECTED from the spec, then read the ticket. Whole-screen case from `checklists.md`, not from the ticket. |
| **Automation bias** | The gate is green, the assertion passed, therefore it works. The assertion checked a status code. | The gate checks the *folder*, not the product. A verdict needs a run you watched. |
| **Authority bias** | "The senior dev looked at it." "The PO said it's fine." | Testimony is not evidence. Cite a file or mark it UNVERIFIED. |
| **Recency — testing only the change** | You test the new field. The field next to it, which shared a validator, is now broken. | Fixes break neighbours: case ③ is mandatory. RCRCRC's **R**epaired. |
| **Inattentional blindness of the scripted eye** | You are watching for the value in the box, so you do not see the badge that did not update or the second email. | `OBSERVATIONS:` — the thing that made you pause gets one line. The **four questions** after every action. |
| **Sunk cost** | Two hours in, the environment finally works; the case that would need another hour becomes "probably fine". | A case you did not run is BLOCKED, and the report says so. Not running it is allowed; calling it PASS is not. |
| **The pesticide paradox** | The same five cases, the same five values, every ticket. They stopped finding anything a month ago. | The exploratory slot: one heuristic per pack, different each time. `hostile-inputs.md` instead of the same sample value. |
| **Expert blindness** | You know where the button is, what the field wants, how long the spinner takes. The first-timer does not, and the product was built for them. | Borrow a persona from `user-mindset.md`. Take the wrong path first on purpose. |
| **Deadline gravity** | It is Friday. The verdict everyone wants is PASS. | Severity is set by consequence, not by the calendar. `red-flags.md` — this file — is read again. |

## The pattern behind all of them

Each one trades a real run for a plausible inference, under time pressure, with
a good reason. That is not a character flaw — it is what deadlines do to
everyone. The gates exist so the decision is not left to willpower on a bad day.
