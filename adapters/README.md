# Adapters — one QA method, five agent tools

An adapter is the ONLY tool-specific code in ai-qa: a thin renderer that turns
the tool-neutral workflows in `core/workflows/` into the format one agent tool
natively discovers. Everything else — gates, doctrine, templates, profiles — is
shared verbatim through `.ai-qa/` in the target repo.

## Contract

Each `<tool>.mjs` exports:

```js
export const id = "<tool>";        // the name used in `ai-qa init --tools`
export const marker = "<path>";    // presence means "installed" (update re-renders)
export function render(wf, ctx) {  // one workflow → one file
  // wf:  { name, description, args, body }  — body already carries the surface
  //      block, the Environment block, and config substitution
  // ctx: { root, cfg, noSubagentNote }
  return { path: "<repo-relative path>", text: "<file content>" };
}
export function pointers(root, cfg) { ... }  // optional: discovery breadcrumbs
```

## Rules

- **Render, never rewrite.** Add frontmatter, a preamble, and pointers. Never
  touch a workflow's semantics — five drifting copies of the QA method means
  five different definitions of "verified".
- **Tools without subagents** must prepend `ctx.noSubagentNote`. The challenger
  pass still happens; it just happens in a fresh chat.
- **Never invent a path.** If a tool's convention changes, change it here in one
  place and ship a version bump — do not teach users to move files by hand.

## Adding a tool

1. Copy the closest module, set `id`, `marker`, and the output path.
2. Add the id to `TOOLS` in `src/cli/adapters.mjs`.
3. Prove it: `ai-qa init --tools <id>` into a scratch repo, then confirm the
   tool actually discovers the files it wrote.
