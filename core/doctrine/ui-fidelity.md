# UI fidelity — measure the surface, don't admire it

> `/qa` opens this for the whole-screen case, and for any ticket with a **design
> source** (a Figma frame, a token file) or a user-facing screen. It turns "looks
> right" — the least trustworthy sentence in QA — into numbers a stranger can
> re-measure.

A screenshot proves the layout arrived. It does not prove the font downloaded,
the contrast passes, the focus ring exists, or the button is reachable by
keyboard. Those are read from the running browser, not from the picture — and
the moment you read them, "looks right" becomes a value with a source, exactly
like every other expected value in the lane.

## Measure by machine, not by eye — and not against the code

Two traps, both fatal to the verdict:

- **The eye can't see a 6% colour drift or a 1px radius**, and it certainly
  can't see that `font-family` says "Be Vietnam Pro" while the file 404'd and the
  browser quietly rendered Arial. Read `getComputedStyle` for colour, size,
  weight, radius, spacing; call `document.fonts.check(...)` and confirm the
  font's request was **200, not a fallback**, before you trust a single glyph.
- **Never measure the app against the code.** The expected value comes from the
  *design source* — the Figma node's own JSON, the token in the design system —
  never from the CSS you are testing. Measuring code against code is self-grading:
  it always passes, and it proves nothing.

Tolerance, so "match" means one thing: **colour, font-family, font-size, weight
= exact**; px for size / spacing / radius = **±0.75** (subpixel rounding). A
value outside that is a deviation, and a deviation is a defect **unless** it
carries a labelled reason — `a11y:`, `SRS:`, or `responsive:` with a sentence.
"I thought it looked better" is not a reason; it is an unrequested redesign.

## Accessibility is a written oracle — even when the ticket is silent

This is the part that changes verdicts. When no spec mentions the visual detail,
QA usually reports a *difference*, not a defect. Accessibility is the exception:
**WCAG 2.2 Level AA is a written standard** — cited by law in many jurisdictions
and by most teams' own policy — so a failure against it is a defect **against
WCAG**, with the success criterion as its citation, not a matter of taste. This
is also why a design source and an accessibility rule can disagree and the
accessibility rule wins: it is the higher-standing spec.

The measurable AA subset a functional QA can prove with the browser — no
specialist tools:

| Check | The measurable rule | WCAG |
|---|---|---|
| **Text contrast** | text vs its background ≥ **4.5:1** (≥ **3:1** for large text ≥ 24px, or ≥ 18.66px bold) | SC 1.4.3 |
| **Non-text contrast** | a control's boundary, a focus ring, a meaningful icon, a state indicator vs adjacent colour ≥ **3:1** | SC 1.4.11 |
| **Focus visible** | every interactive element shows a focus indicator on Tab, ≥ 3:1 against its unfocused self, ≥ a 2px perimeter | SC 2.4.7 / 2.4.11 |
| **Focus not obscured** | a sticky header, modal, or fly-out does not cover the focused element | SC 2.4.11 |
| **Keyboard operable** | every action reachable and operable by Tab / Enter / Space, in a sensible order, with **no trap** | SC 2.1.1 / 2.1.2 |
| **Programmatic label** | every input has a real label — `<label for>`, `aria-label`, or `aria-labelledby`, not just grey placeholder text | SC 1.3.1 / 4.1.2 |
| **Target size** | a tap/click target ≥ **24×24 px** (or 24px spacing around it) | SC 2.5.8 |
| **Text resize / zoom** | at 200% zoom nothing is clipped or overlapped and no horizontal scroll appears | SC 1.4.4 / 1.4.10 |

Pick the ones the screen actually has — a form's cases are labels, focus, and
contrast; a data table's are keyboard order and target size. Two or three
measured checks beat a checklist swept without looking.

## The real-user move, for the eye and the hand

The whole-screen case (`test-design.md` ③) already walks the screen as a person.
Fidelity adds the moves a *keyboard* and a *screen* make that a mouse does not:

- **Tab through the whole screen once.** Watch where focus goes and whether you
  can always see it. This one motion finds missing focus rings, wrong tab order,
  and keyboard traps — three defects a mouse never meets.
- **Load the fonts cold.** A hard reload (cache empty) is where a font that
  "worked on my machine" reveals it was only in the developer's OS.
- **Zoom to 200%, then narrow the window.** Reflow and clipping hide at the
  default size and the default width.

## Where it lands

`ui_fidelity`-style measurement (computed style vs the design node) and the
font-load check are a `whole-screen` case, or a case of their own on a
UI-heavy ticket. A pure a11y read with no journey is `TYPE: NON-UI` and its proof
is the recorded measurement table — the contrast numbers, the focus-ring ratio,
the label audit — the same way a database read proves itself. Box the region a
number describes and put the number in the caption: `contrast 3.9:1 — needs 4.5`
tells the reader in one glance what a red rectangle never could.

Honest scope, stated so nobody over-claims: this proves the **measurable** slice
of accessibility. Whether a screen reader announces the flow sensibly, whether
the reading order matches the visual order for a blind user, whether an
animation triggers vestibular trouble — those need assistive tech and a human,
and a pack that measured contrast has not tested them. Say which you did.
