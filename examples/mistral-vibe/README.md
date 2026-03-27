# Mistral Vibe assets for spec-gen

Mistral Vibe implementation of the [spec-gen agentic workflow pattern](../../docs/agentic-workflows/README.md).

## Contents

| Path | Purpose |
|---|---|
| `skills/spec-gen-analyze-codebase/` | Full static analysis — architecture, call graph, refactor issues, duplicates |
| `skills/spec-gen-generate/` | Generate OpenSpec specs from analysis results |
| `skills/spec-gen-plan-refactor/` | Identify highest-priority refactor target and write a plan |
| `skills/spec-gen-execute-refactor/` | Apply a refactor plan produced by spec-gen-plan-refactor |

## Usage

Copy the skills into your Mistral Vibe project skills directory and invoke them with their slash commands:

```
/spec-gen-analyze-codebase
/spec-gen-generate
/spec-gen-plan-refactor
/spec-gen-execute-refactor
```

Each skill follows the generic pre-flight pattern:
- `orient` + `analyze_impact` before any code change
- `check_spec_drift` after implementation
