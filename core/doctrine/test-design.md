# Choosing the two-to-five cases

The budget is small because choosing is the skill. Thirty shallow cases that all
walk the happy path prove less than three that were aimed.

## Start from consequence

```
money moved or lost  >  irreversible state change  >  data corrupted or leaked
>  a person blocked from working  >  wrong number displayed  >  cosmetic drift
```

Allocate the budget in that proportion. If a ticket touches money, at least one
case is about money, even when the ticket is nominally about a button.

## The shapes that earn their place

**① The exact acceptance path.** The criterion as specified, walked as a user.
Not the whole feature — the specific claim.

**② A boundary that must behave the OTHER way.** For every rule, there is an
adjacent input that must be refused, or handled differently:

| Rule | The boundary worth testing |
|---|---|
| minimum order 100,000 | 99,999 and exactly 100,000 |
| unique email | the same email again, and the same with different case |
| cancel before shipping | a record already shipped |
| discount for members | a lapsed member, expiring today |
| max 10 items | the 10th and the 11th |

A change that works for the happy case and *also* accepts what it should refuse
is a defect. This case catches overshoot, which no happy-path test can.

Choose the boundary value from `hostile-inputs.md`, by the field type the ticket
touches: one value the spec explicitly refuses, one a real user will produce
this week. A boundary chosen because it was convenient is a happy-path case
with a different number.

**③ Whole-screen sanity.** The rest of the screen still behaves. Fixes break
neighbours, and the neighbour is what real users notice. "Still behaves" is not
"still renders": open `checklists.md`, find the shape the screen is — a form, a
list, a money screen, a lifecycle — and walk that list. Record what you looked
at even when it was fine.

**④ Write → read back.** Anything that writes gets verified by reading the row
after the action, plus the rollback path if one is specified. The interface
saying "Saved" is a claim about the interface, not about the data.

**⑤ The exploratory slot** — when the budget allows a fifth case, or when the
ticket touches an area the dossier marks as having no oracle, one case is
`KIND: exploratory`. Pick **one** heuristic from `heuristics.md` — an
interruption at the worst moment, a tour, a consistency oracle, follow-the-data
— name it as `HEURISTIC:`, give it a timebox, and record what you tried even
when nothing was found. This is the only case whose purpose is to look where
nobody thought to look; the other four confirm what someone already thought of.
A pack with five cases and no exploratory one has spent its whole budget on
confirmation.

**⑥ The security probe** — when the ticket touches authentication, sessions,
roles, money, personal data, or uploads, one of the five cases sends the input
an attacker sends **on purpose**, not the one a user fumbles by accident. Open
`security-probes.md` and take the two or three probes that fit the surface: is
the lockout real, does the error message or the response *clock* leak which
accounts exist, does the session survive a password change, does the protected
route answer when called directly as the wrong role, does a payload get executed
or echoed unescaped. On a ticket that merely brushes security, this shares the
boundary or whole-screen slot; on a ticket that **is** authentication or
authorization, it takes two or three cases, because there the security floor is
the requirement. Its EXPECTED is either a cited rule or one of the no-citation
floor outcomes in `security-probes.md`.

## The real-user move — in every case, not in a case of its own

Cases ① to ④ are shapes; a person still has to walk them. Every case's STEPS
carries at least one thing a real user does that a script would not — from
`user-mindset.md`: press Enter instead of Save, double-click the button, press
Back afterwards, refresh right after, paste the value instead of typing it,
open the record in a second tab first, leave and return after the session
would have expired. Name the persona you are borrowing as `PERSONA:` so the
reader knows why the journey took the turn it did.

This is not a fifth shape. It is the difference between a case that proves the
route works and a case that proves the product works for someone.

## Equivalence classes — pick one, not all

Ten valid emails test one thing ten times. One valid, one invalid, one edge —
that is the same coverage in a fraction of the time, and the time saved goes
into a boundary that actually differs.

The trap is classes that look equivalent and are not: a 0, a negative number and
an empty field are three different classes in most systems, however similar they
look in the form.

The **opposite** trap is just as common: values that look different but are the
**same** class, and the product forgets it. `admin`, `ADMIN` and `Admin` are one
identity when the rule says "case-insensitive"; `+84 90…` and `090…` are one
phone; `café` typed and `café` pasted (one glyph vs `e` + combining accent) are
one name. The test is not "does each form work" — it is "do they collapse to
**one**": logging in with the uppercase form must succeed, and registering the
second form must be refused as a duplicate. A rule about "unique" or
"case-insensitive" or "normalised" that is never tested across representations is
a rule tested at zero of its edges. (This is the class of miss that hides in a
happy path forever, because the happy path only ever types the value one way.)

## State transitions

Anything with a lifecycle — order, subscription, document, ticket — is candidate
number one. Draw the states and the legal moves. Then test:

- one legal transition (does it work?),
- one **illegal** transition (is it actually prevented, or merely hidden from
  the interface?),
- one transition after a reload, because state is where session bugs live.

Hiding a button is not preventing a transition. Whether the underlying action is
refused is a different question, and usually the more important one.

## Choosing under a missing spec

No written oracle for the area? You still test — you just cannot call anything a
defect. Record differences as *differences*, name what each one implies, and
send the important ones back as decision requests. Then say plainly in the
report that the verdict compares against nothing written.

That is an honest, useful outcome. Quietly adopting whatever the code does as
the expected value is not, and it converts a missing spec into a permanent one.

You are not, however, limited to "different". A product can be **inconsistent
with something it should be consistent with** even when no spec exists — its
own other screen, its previous release, its own tooltip, the law, what every
comparable product does. Those are the consistency oracles in `heuristics.md`,
and a finding written as "inconsistent with <which>, decision requested from
<owner>" is a legitimate result with an owner, not an opinion. It still is not a
defect against a spec, and the report still says so.
