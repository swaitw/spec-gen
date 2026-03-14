# CLI Specification

> Updated: 2026-03-12
> Source: `src/cli/commands/`

## Purpose

Provides the `spec-gen` command-line interface with nine subcommands that expose the full spec-gen pipeline to end users. Each command maps to a function in `src/cli/commands/`.

## Commands

### Command: init

**Purpose:** Initialises spec-gen in a project directory by detecting project type, writing `.spec-gen/config.json`, and scaffolding the `openspec/` directory structure.

**Usage:** `spec-gen init [options]`

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--force` | boolean | false | Overwrite existing configuration |
| `--openspec-path <path>` | string | `"openspec"` | Custom path for the openspec output directory |

**Requirements:**

#### Requirement: InitCreatesConfig

The system SHALL create `.spec-gen/config.json` with detected project type and default settings when invoked in a directory that does not already have a config.

#### Scenario: FreshProject
- **GIVEN** a project directory with no `.spec-gen/config.json`
- **WHEN** `spec-gen init` is executed
- **THEN** `.spec-gen/config.json` is created with the detected project type
- **AND** the `openspec/` directory structure is scaffolded

#### Scenario: ExistingConfigWithForce
- **GIVEN** a project with an existing `.spec-gen/config.json`
- **WHEN** `spec-gen init --force` is executed
- **THEN** the existing configuration is overwritten

#### Scenario: ExistingConfigWithoutForce
- **GIVEN** a project with an existing `.spec-gen/config.json`
- **WHEN** `spec-gen init` is executed without `--force`
- **THEN** the command exits with a message indicating config already exists

---

### Command: analyze

**Purpose:** Runs static analysis on the codebase (no LLM required) to produce a repository map, dependency graph, significance scores, and LLM context artifacts.

**Usage:** `spec-gen analyze [options]`

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--output <path>` | string | `.spec-gen/analysis/` | Directory to write analysis results |
| `--max-files <n>` | number | 500 | Maximum number of files to analyse |
| `--include <glob>` | string (repeatable) | — | Additional patterns to force-include |
| `--exclude <glob>` | string (repeatable) | — | Additional patterns to exclude |
| `--force` | boolean | false | Force re-analysis even if recent analysis exists |
| `--embed` | boolean | false | Build semantic vector index after analysis |
| `--reindex-specs` | boolean | false | Re-index specs into vector index without full re-analysis |

**Output files:**

| File | Description |
|------|-------------|
| `.spec-gen/analysis/repo-structure.json` | Repository structure and file metadata |
| `.spec-gen/analysis/dependency-graph.json` | Import/export dependency graph |
| `.spec-gen/analysis/llm-context.json` | Optimised context for LLM generation |
| `.spec-gen/analysis/dependencies.mermaid` | Visual dependency diagram |
| `.spec-gen/analysis/SUMMARY.md` | Human-readable analysis summary |

**Requirements:**

#### Requirement: AnalyzeProducesArtifacts

The system SHALL produce all five output artifacts after a successful analysis run.

#### Scenario: SuccessfulAnalysis
- **GIVEN** a project directory with source files
- **WHEN** `spec-gen analyze` is executed
- **THEN** `repo-structure.json`, `dependency-graph.json`, `llm-context.json`, `dependencies.mermaid`, and `SUMMARY.md` are written to `.spec-gen/analysis/`

#### Scenario: RecentAnalysisSkipped
- **GIVEN** a project with analysis output newer than the reuse threshold
- **WHEN** `spec-gen analyze` is executed without `--force`
- **THEN** the command reports that recent analysis exists and exits without re-running

---

### Command: generate

**Purpose:** Generates OpenSpec specification files from analysis artifacts using an LLM. Requires a valid API key.

**Usage:** `spec-gen generate [options]`

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--analysis <path>` | string | `.spec-gen/analysis/` | Path to existing analysis artifacts |
| `--model <name>` | string | provider default | LLM model to use |
| `--dry-run` | boolean | false | Preview without writing files |
| `--domains <list>` | string | — | Comma-separated domains to generate |
| `--reanalyze` | boolean | false | Force fresh analysis before generation |
| `--merge` | boolean | false | Merge into existing specs instead of replacing |
| `--no-overwrite` | boolean | false | Skip files that already exist |
| `-y, --yes` | boolean | false | Skip all confirmation prompts |
| `--output-dir <path>` | string | from config | Override openspec output location |
| `--adr` | boolean | false | Generate Architecture Decision Records alongside specs |
| `--adr-only` | boolean | false | Only generate ADRs, skip spec generation |

**Requirements:**

#### Requirement: GenerateWritesSpecs

The system SHALL write one spec file per detected domain plus overview and architecture specs to the `openspec/specs/` directory.

#### Scenario: SuccessfulGeneration
- **GIVEN** valid analysis artifacts and an LLM API key
- **WHEN** `spec-gen generate` is executed
- **THEN** spec files are written under `openspec/specs/{domain}/spec.md`

#### Scenario: DryRun
- **GIVEN** valid analysis artifacts and an LLM API key
- **WHEN** `spec-gen generate --dry-run` is executed
- **THEN** the command shows what would be generated without writing any files

#### Scenario: MissingApiKey
- **GIVEN** no LLM API key is set in the environment
- **WHEN** `spec-gen generate` is executed
- **THEN** the command exits with a clear error message naming the required environment variable

---

### Command: run

**Purpose:** Runs the complete spec-gen pipeline (init → analyze → generate) in a single command with smart step-skipping.

**Usage:** `spec-gen run [options]`

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--force` | boolean | false | Force re-initialisation and overwrite existing config |
| `--reanalyze` | boolean | false | Force fresh analysis even if recent analysis exists |
| `--model <name>` | string | provider default | LLM model to use for generation |
| `--dry-run` | boolean | false | Preview all steps without making changes |
| `--yes` | boolean | false | Auto-confirm all prompts |
| `--max-files <n>` | number | 500 | Maximum files to analyse |
| `--adr` | boolean | false | Generate Architecture Decision Records |

**Requirements:**

#### Requirement: RunExecutesPipeline

The system SHALL execute init, analyze, and generate steps in sequence, skipping any step that is already satisfied.

#### Scenario: FullPipeline
- **GIVEN** a project directory with no prior spec-gen setup
- **WHEN** `spec-gen run` is executed
- **THEN** init, analyze, and generate steps all run in order

#### Scenario: SkipInit
- **GIVEN** a project with an existing valid config
- **WHEN** `spec-gen run` is executed without `--force`
- **THEN** the init step is skipped and analysis proceeds

#### Scenario: SkipAnalysis
- **GIVEN** a project with recent analysis and existing config
- **WHEN** `spec-gen run` is executed without `--reanalyze`
- **THEN** the analysis step is skipped and generation proceeds with existing artifacts

---

### Command: verify

**Purpose:** Tests generated spec accuracy by sampling source files, asking the LLM to predict each file's purpose and imports/exports, and comparing predictions against spec claims.

**Usage:** `spec-gen verify [options]`

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--files <list>` | string | — | Comma-separated file paths to verify |
| `--domains <list>` | string | — | Comma-separated domains to verify |
| `--json` | boolean | false | Output results as JSON |

**Requirements:**

#### Requirement: VerifyProducesReport

The system SHALL produce a verification report with per-file scores and an overall pass/fail result.

#### Scenario: SuccessfulVerification
- **GIVEN** valid specs, analysis artifacts, and an LLM API key
- **WHEN** `spec-gen verify` is executed
- **THEN** a verification report is printed showing per-file scores and overall status

#### Scenario: MissingSpecs
- **GIVEN** no generated specs exist
- **WHEN** `spec-gen verify` is executed
- **THEN** the command exits with a clear error indicating specs must be generated first

---

### Command: drift

**Purpose:** Detects spec drift by comparing git-changed files against existing specs. Reports gaps (code changed without spec update), stale specs, uncovered files, and orphaned specs.

**Usage:** `spec-gen drift [options]`

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--base <ref>` | string | `"auto"` | Git base reference (branch, tag, or commit SHA) |
| `--files <list>` | string | — | Comma-separated paths to check (instead of all git changes) |
| `--domains <list>` | string | — | Comma-separated domains to restrict check to |
| `--fail-on <severity>` | string | `"warning"` | Minimum severity that causes non-zero exit: `error`, `warning`, `info` |
| `--llm` | boolean | false | Use LLM to classify ambiguous changes |
| `--max-files <n>` | number | 50 | Maximum changed files to process |
| `--json` | boolean | false | Output results as JSON |

**Drift issue kinds:**

| Kind | Description |
|------|-------------|
| `gap` | Source file changed but its spec domain was not updated |
| `stale` | Spec file changed but source was not |
| `uncovered` | Changed file has no spec coverage |
| `orphaned-spec` | Spec references a file that no longer exists |
| `adr-gap` | Decision was made but no ADR records it |
| `adr-orphaned` | ADR references a removed or renamed decision |

**Requirements:**

#### Requirement: DriftDetectsGaps

The system SHALL detect when source files are changed without a corresponding spec update and report these as `gap` issues.

#### Scenario: GapDetected
- **GIVEN** a git commit that modifies a source file covered by a spec
- **WHEN** `spec-gen drift` is executed
- **THEN** a `gap` issue is reported for the modified file

#### Scenario: CleanRepo
- **GIVEN** all changed files have corresponding spec updates
- **WHEN** `spec-gen drift` is executed
- **THEN** the command exits 0 with no issues reported

#### Scenario: ExitCodeOnDrift
- **GIVEN** at least one issue at or above `--fail-on` severity
- **WHEN** `spec-gen drift` is executed
- **THEN** the command exits with a non-zero exit code

---

### Command: view

**Purpose:** Starts a local Vite dev server that renders an interactive dependency graph and spec viewer in the browser.

**Usage:** `spec-gen view [options]`

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--analysis <path>` | string | `.spec-gen/analysis/` | Path to analysis directory |
| `--spec <path>` | string | `./openspec/specs/` | Path to spec files directory |
| `--port <n>` | number | 7017 | Port to bind the viewer server |
| `--host <host>` | string | `"localhost"` | Host to bind (use `0.0.0.0` for LAN) |
| `--no-open` | boolean | false | Do not open the browser automatically |

**Requirements:**

#### Requirement: ViewStartsServer

The system SHALL start a local HTTP server serving the graph viewer and open the user's default browser.

#### Scenario: ServerStart
- **GIVEN** valid analysis artifacts exist
- **WHEN** `spec-gen view` is executed
- **THEN** a Vite server starts on the configured port and the browser opens to `http://localhost:{port}`

#### Scenario: NoOpen
- **GIVEN** valid analysis artifacts exist
- **WHEN** `spec-gen view --no-open` is executed
- **THEN** the server starts but the browser is not opened

---

### Command: mcp

**Purpose:** Starts a Model Context Protocol (MCP) server over stdio, exposing spec-gen's analysis and drift-detection capabilities as tools to AI agents (Claude Code, Cline, etc.).

**Usage:** `spec-gen mcp`

**Transport:** stdio (compatible with any MCP client that supports stdio transport)

**Exposed tool groups:**

| Group | Tools |
|-------|-------|
| Analysis | `analyzeCodebase`, `getArchitectureOverview`, `getRefactorReport`, `getDuplicateReport`, `getSignatures`, `getMapping`, `getFunctionSkeleton` |
| Drift | `checkSpecDrift` |
| Graph | `getCallGraph`, `getSubgraph`, `analyzeImpact`, `getCriticalHubs`, `getLeafFunctions`, `getLowRiskRefactorCandidates`, `getGodFunctions` |
| Semantic | `searchCode`, `suggestInsertionPoints`, `searchSpecs`, `listSpecDomains` |

**Requirements:**

#### Requirement: McpExposesTools

The system SHALL register all tools with the MCP SDK and respond to `tools/call` requests over stdio.

#### Scenario: ToolCall
- **GIVEN** an MCP client connected over stdio
- **WHEN** the client calls `getArchitectureOverview` with a valid directory
- **THEN** the server returns architecture data as an MCP tool result

---

### Command: doctor

**Purpose:** Runs a suite of self-diagnostic checks and prints a human-readable report with actionable fix suggestions for any failures.

**Usage:** `spec-gen doctor`

**Checks performed:**

| Check | Failure condition |
|-------|------------------|
| Node.js version | Version below minimum supported |
| Git availability | `git` not on PATH or not a git repository |
| Configuration | `.spec-gen/config.json` missing or invalid JSON |
| Analysis artifacts | Analysis older than 24 hours (warning) |
| Disk space | Below `MIN_DISK_SPACE_FAIL_MB` (fail) or `MIN_DISK_SPACE_WARN_MB` (warn) |
| LLM API key | No recognised API key set in environment |
| OpenSpec structure | `openspec/` directory or `openspec.json` missing |

**Requirements:**

#### Requirement: DoctorReportsStatus

The system SHALL run all checks and print each result as `ok`, `warn`, or `fail`, followed by a summary line and actionable fix suggestions for any non-ok results.

#### Scenario: AllChecksPass
- **GIVEN** a fully configured project with fresh analysis and a valid API key
- **WHEN** `spec-gen doctor` is executed
- **THEN** all checks print `ok` and the command exits 0

#### Scenario: MissingApiKey
- **GIVEN** no LLM API key in the environment
- **WHEN** `spec-gen doctor` is executed
- **THEN** the API key check prints `warn` with a suggestion to set the key

#### Scenario: StaleAnalysis
- **GIVEN** analysis artifacts older than 24 hours
- **WHEN** `spec-gen doctor` is executed
- **THEN** the analysis freshness check prints `warn` with a suggestion to run `spec-gen analyze`
