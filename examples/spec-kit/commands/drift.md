---
description: "Post-implementation spec drift check — verify the implementation matches existing OpenSpec specifications."
tools:
  - 'spec-gen/check_spec_drift'
---

# spec-gen: Drift Check

Run this command **after** `/speckit.implement` and **only once tests are green**.

It compares the implementation against existing OpenSpec specifications and reports
gaps, stale references, and uncovered files.

> **No specs yet?** If `spec-gen generate` has not been run on this project,
> this command will report everything as uncovered — that is expected.
> Run `spec-gen generate` post-sprint to create specs from the new implementation.

## Prerequisites

1. spec-gen MCP server configured in your AI agent settings
2. Tests passing — do not run drift check on a red test suite
3. `spec-gen analyze` run at least once (same requirement as orient)

## User Input

$ARGUMENTS

If a project directory is provided, use it. Otherwise use the current working directory.

## Step 1 — Confirm tests are green

Ask the user: "Are all tests passing?"

If the answer is no: "Run tests first and fix any failures. Drift check is only
meaningful on a green test suite." Stop here.

## Step 2 — Run drift check

```
spec-gen check_spec_drift
  directory: $PROJECT_ROOT
```

## Step 3 — Interpret results

| Drift type | Meaning | Action |
|---|---|---|
| `uncovered` on new files | New code not yet in any spec | Note for post-sprint spec update |
| `gap` on existing domain | Existing spec missing coverage of new behaviour | Run `spec-gen generate --domains $DOMAIN` |
| `stale` | Spec references a function that no longer exists | Fix the reference in the spec file |
| No drift | ✅ Implementation matches specs | Done |

## Step 4 — Output

Report findings in a compact table. For each gap or uncovered item:
- Which file / domain is affected
- Recommended action (generate, update, or fix)

If drift is found on domains touched by this implementation:
> "Spec drift detected. These updates can be applied now with `spec-gen generate`
> or batched post-sprint. Recommend: note them in `.specify/{feature}/plan.md`
> under a `## Spec Updates` section rather than interrupting the current sprint."

If no drift:
> "✅ No spec drift. Implementation is consistent with existing OpenSpec specifications."
