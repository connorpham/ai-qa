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

## The pattern behind all of them

Each one trades a real run for a plausible inference, under time pressure, with
a good reason. That is not a character flaw — it is what deadlines do to
everyone. The gates exist so the decision is not left to willpower on a bad day.
