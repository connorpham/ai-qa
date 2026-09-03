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

**③ Whole-screen sanity.** The rest of the screen still behaves. Fixes break
neighbours, and the neighbour is what real users notice.

**④ Write → read back.** Anything that writes gets verified by reading the row
after the action, plus the rollback path if one is specified. The interface
saying "Saved" is a claim about the interface, not about the data.

## Equivalence classes — pick one, not all

Ten valid emails test one thing ten times. One valid, one invalid, one edge —
that is the same coverage in a fraction of the time, and the time saved goes
into a boundary that actually differs.

The trap is classes that look equivalent and are not: a 0, a negative number and
an empty field are three different classes in most systems, however similar they
look in the form.

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
