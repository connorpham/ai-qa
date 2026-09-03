# Regression suite — what is protected, and what is not

Maintained by `/regress`. Coverage is never reported as a percentage here: a
percentage of lines has never protected anyone, and it hides exactly the
question that matters — *what would ship silently?*

**Runtime budget:** _(n minutes)_ · **Current runtime:** _(n)_ · **Cases:** _(n)_

## Protected

| Case | Flow | What it would catch | Proved able to fail by |
|---|---|---|---|
| | | | |

> The last column is not paperwork. A case that has never been made to fail is
> measuring nothing, and a false assurance costs more than no case at all.

## Not protected

| Flow | What would ship silently | Why not covered |
|---|---|---|
| | | no oracle / no budget / not automatable |

> This is the most valuable table in the document and the one there is most
> pressure to shorten. Keep it complete.

## Quarantined

| Case | Symptom | Suspected cause | Owner | Fix-or-delete by |
|---|---|---|---|---|
| | | | | |

> Quarantined cases gate nothing and count as no coverage. A permanent
> quarantine is a graveyard, and graveyards grow.
