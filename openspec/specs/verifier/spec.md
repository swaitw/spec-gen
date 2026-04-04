# Verifier Specification

> Updated: 2026-04-04
> Source: `src/core/verifier/verification-engine.ts`

## Purpose

Verifies code files against specifications using LLM predictions and analysis. The `SpecVerificationEngine` samples files from the dependency graph, asks the LLM to predict each file's purpose and imports/exports, compares predictions against spec claims, and produces a scored verification report.

## Requirements

### Requirement: Selectcandidates

The system SHALL select files for verification from a dependency graph.

#### Scenario: ValidDependencyGraph
- **GIVEN** a valid dependency graph with nodes and significance scores
- **WHEN** `selectCandidates` is called
- **THEN** an array of verification candidates is returned, ranked by significance

#### Scenario: EmptyDependencyGraph
- **GIVEN** an empty dependency graph with no nodes
- **WHEN** `selectCandidates` is called
- **THEN** an empty array is returned

#### Scenario: SampleLimitRespected
- **GIVEN** a dependency graph with more nodes than the configured sample size
- **WHEN** `selectCandidates` is called with a sample limit
- **THEN** at most `sampleSize` candidates are returned

### Requirement: Verifyfile

The system SHALL verify a single file against its specification.

#### Scenario: ValidFileWithMatchingSpecification
- **GIVEN** a file with a matching specification and correct imports/exports
- **WHEN** `verifyFile` is called
- **THEN** a verification result with a score above the pass threshold is returned

#### Scenario: ValidFileWithMismatchedSpecification
- **GIVEN** a file whose actual behaviour differs significantly from its spec
- **WHEN** `verifyFile` is called
- **THEN** a verification result with a score below the pass threshold and actionable feedback is returned

#### Scenario: LlmCallFails
- **GIVEN** the LLM service throws a network or quota error
- **WHEN** `verifyFile` is called
- **THEN** the file is excluded from the report entirely and does not crash the overall run

### Requirement: Getdomains

The system SHALL retrieve a list of domains for verification.

#### Scenario: DomainsAvailable
- **GIVEN** specs have been loaded from a populated openspec directory
- **WHEN** `getDomains` is called
- **THEN** an array of unique domain names found in the loaded specs is returned

#### Scenario: NoDomainsAvailable
- **GIVEN** the openspec directory is empty or contains no domain specs
- **WHEN** `getDomains` is called
- **THEN** an empty array is returned

#### Scenario: DomainsLoadedLazily
- **GIVEN** `getDomains` is called before `verify()` has been run
- **WHEN** `getDomains` is awaited
- **THEN** specs are loaded automatically and the domain list is returned without error


## Sub-components

> `SpecVerificationEngine` is an orchestrator. Each sub-component below implements one logical block.

### Sub-component: Loadspecs

> Implements: `loadSpecs`

Loads and processes specification files from the openspec directory into memory for subsequent verification.

#### Requirement: Loadspecifications

The system SHALL load all spec files from the configured openspec directory on the first call to `verify()` or `getDomains()`.

#### Scenario: SpecsFoundOnDisk
- **GIVEN** spec markdown files exist under `openspec/specs/`
- **WHEN** `loadSpecs` is called
- **THEN** each spec file is read and its domain, purpose, requirements, imports, and exports are extracted

#### Requirement: Processspecifications

The system SHALL parse spec markdown to extract domain name, source file references, and requirement bodies.

#### Scenario: WellFormedSpec
- **GIVEN** a spec markdown with a `## Purpose` section and `### Requirement:` headings
- **WHEN** the spec is processed
- **THEN** the domain, purpose string, and requirement list are correctly extracted

#### Scenario: MalformedSpec
- **GIVEN** a spec file with missing or malformed headings
- **WHEN** the spec is processed
- **THEN** the file is skipped with a warning and processing continues for the remaining specs

### Sub-component: Analysis

> Implements: `analysis`

Analyses code files by parsing AST, building dependency graphs, and scoring significance.

#### Requirement: Parseast

The system SHALL parse the abstract syntax tree (AST) of each candidate source file to extract structural information.

#### Scenario: TypeScriptFile
- **GIVEN** a valid TypeScript source file
- **WHEN** the file is parsed
- **THEN** top-level imports, exports, and function/class declarations are extracted without error

#### Requirement: Buildgraphs

The system SHALL use the dependency graph to rank candidate files by significance.

#### Scenario: PageRankScoring
- **GIVEN** a dependency graph with PageRank scores on each node
- **WHEN** candidate selection runs
- **THEN** files with higher PageRank scores are prioritised as verification candidates

#### Requirement: Scoresignificance

The system SHALL score the significance of each candidate file and include the score in the verification result.

#### Scenario: SignificanceInResult
- **GIVEN** a successfully verified file with a known significance score
- **WHEN** the verification result is inspected
- **THEN** `result.significance` is a number between 0 and 1 inclusive

### Sub-component: Selectcandidates

> Implements: `selectCandidates`

Selects verification candidate files based on dependency graph significance and domain membership.

#### Requirement: Inferdomain

The system SHALL infer the domain of each candidate file from its path and the loaded spec domain mappings.

#### Scenario: DomainMatchByPath
- **GIVEN** a file at `src/auth/login.ts` and a spec for the `auth` domain
- **WHEN** domain inference runs
- **THEN** the file is assigned to the `auth` domain

#### Scenario: UnmappedFile
- **GIVEN** a file whose path does not match any known spec domain
- **WHEN** domain inference runs
- **THEN** the file is assigned to the `general` or `unknown` domain and still included as a candidate

#### Requirement: Selectfiles

The system SHALL select candidate files up to the configured sample limit, prioritising high-significance files.

#### Scenario: HighSignificanceFirst
- **GIVEN** files with mixed significance scores
- **WHEN** `selectCandidates` runs with `samples: 5`
- **THEN** the five files with the highest significance are returned

### Sub-component: Discovery

> Implements: `discovery`

Discovers spec files, detects domain patterns, and scans the openspec directory.

#### Requirement: Findfiles

The system SHALL find all `spec.md` files under the configured openspec directory recursively.

#### Scenario: NestedSpecs
- **GIVEN** spec files at `openspec/specs/auth/spec.md` and `openspec/specs/billing/spec.md`
- **WHEN** discovery runs
- **THEN** both spec files are discovered and loaded

#### Requirement: Detectpatterns

The system SHALL detect the domain name from each spec file's directory path.

#### Scenario: DirectoryAsDomain
- **GIVEN** a spec file at `openspec/specs/payments/spec.md`
- **WHEN** the domain is detected
- **THEN** the domain name is `payments`

#### Requirement: Scandirectories

The system SHALL scan all subdirectories of `openspec/specs/` for spec files.

#### Scenario: EmptyOpenspecDir
- **GIVEN** the openspec directory exists but contains no subdirectories or spec files
- **WHEN** scanning runs
- **THEN** an empty list is returned and no error is thrown

### Sub-component: Verifyfile

> Implements: `verifyFile`

Verifies a single file against its specification using LLM predictions and structural comparisons.

#### Requirement: Getprediction

The system SHALL send the file's source code to the LLM and receive a structured prediction containing purpose, imports, and exports.

#### Scenario: SuccessfulPrediction
- **GIVEN** a readable source file and a responding LLM service
- **WHEN** the prediction request is made
- **THEN** a structured object with `purpose`, `imports`, and `exports` fields is returned

#### Scenario: LlmTimeout
- **GIVEN** the LLM service exceeds its timeout
- **WHEN** the prediction request is made
- **THEN** the file is marked as skipped with a timeout warning

#### Requirement: Parsefile

The system SHALL parse the source file to extract its actual imports, exports, and language.

#### Scenario: ImportsExtracted
- **GIVEN** a TypeScript file with `import` statements
- **WHEN** `parseFile` runs
- **THEN** the imported module names are extracted as a string array

#### Scenario: ExportsExtracted
- **GIVEN** a TypeScript file with `export` declarations
- **WHEN** `parseFile` runs
- **THEN** the exported symbol names are extracted as a string array

#### Requirement: Comparepurpose

The system SHALL compare the LLM-predicted purpose with the spec's stated purpose using semantic similarity.

#### Scenario: HighSimilarity
- **GIVEN** a prediction that closely matches the spec purpose
- **WHEN** purpose comparison runs
- **THEN** `purposeScore` is close to 1.0

#### Scenario: LowSimilarity
- **GIVEN** a prediction that describes a completely different function
- **WHEN** purpose comparison runs
- **THEN** `purposeScore` is close to 0.0

#### Requirement: Compareimports

The system SHALL compare the predicted import list against the actual import list using set F1 score.

#### Scenario: PerfectImportMatch
- **GIVEN** the LLM correctly predicts all and only the actual imports
- **WHEN** import comparison runs
- **THEN** `importScore` is 1.0

#### Scenario: PartialImportMatch
- **GIVEN** the LLM predicts half of the actual imports and no false positives
- **WHEN** import comparison runs
- **THEN** `importScore` reflects the partial recall

#### Requirement: Compareexports

The system SHALL compare the predicted export list against the actual export list using set F1 score.

#### Scenario: PerfectExportMatch
- **GIVEN** the LLM correctly predicts all exported symbols
- **WHEN** export comparison runs
- **THEN** `exportScore` is 1.0

#### Requirement: Analyzerequirementcoverage

The system SHALL analyse which spec requirements are referenced or implied by the file's content.

#### Scenario: CoveredRequirements
- **GIVEN** a file that implements behaviour described in spec requirements
- **WHEN** requirement coverage analysis runs
- **THEN** the matching requirements are listed in the result's `coveredRequirements` field

#### Requirement: Calculateoverallscore

The system SHALL calculate a weighted overall score from purpose, import, and export sub-scores.

#### Scenario: WeightedScore
- **GIVEN** `purposeScore=1.0`, `importScore=0.0`, `exportScore=0.0`
- **WHEN** the overall score is calculated
- **THEN** the overall score equals the purpose weight (approximately 0.40)

#### Scenario: PassThreshold
- **GIVEN** an overall score above the configured pass threshold (default 0.5)
- **WHEN** the result is evaluated
- **THEN** `result.passed` is `true`

#### Requirement: Generatefeedback

The system SHALL generate human-readable feedback explaining why a file failed verification.

#### Scenario: FeedbackOnFailure
- **GIVEN** a file with a score below the pass threshold
- **WHEN** feedback is generated
- **THEN** the feedback string identifies which sub-score was lowest and suggests a fix

#### Scenario: NoFeedbackOnPass
- **GIVEN** a file with a score above the pass threshold
- **WHEN** feedback is generated
- **THEN** the feedback field is empty or contains a positive confirmation

### Sub-component: Generatereport

> Implements: `generateReport`

Generates a Markdown verification report summarising the overall run.

#### Requirement: Generateverificationreport

The system SHALL generate a Markdown report with aggregate statistics and per-file results after verification completes.

#### Scenario: ReportContainsStats
- **GIVEN** a completed verification run with some passed and some failed files
- **WHEN** the report is generated
- **THEN** the Markdown contains a summary table with `Files Passed`, `Files Failed`, and pass rate percentage

#### Scenario: ZeroSampledFiles
- **GIVEN** all LLM calls threw errors and no files were successfully sampled
- **WHEN** the report is generated
- **THEN** the pass rate is shown as `N/A` instead of `NaN%`

### Sub-component: Savereport

> Implements: `saveReport`

Saves the verification report to disk.

#### Requirement: Saveverificationreport

The system SHALL save the verification report Markdown to the configured output path.

#### Scenario: ReportWritten
- **GIVEN** a generated verification report
- **WHEN** `saveReport` is called with a target path
- **THEN** the Markdown file is written to that path

### Sub-component: Warning

> Implements: `warning`

Handles non-fatal issues, skipped files, and fallback behaviour during verification.

#### Requirement: Handlenonfatalissues

The system SHALL collect non-fatal warnings (skipped files, LLM errors) and include them in the final report without aborting the run.

#### Scenario: LlmErrorCollected
- **GIVEN** one file's LLM call throws an error
- **WHEN** verification completes
- **THEN** that file is absent from the report results, a warning is logged, and other files are still verified

#### Requirement: Skipfiles

The system SHALL skip files that cannot be read, parsed, or predicted, and record the reason.

#### Scenario: UnreadableFile
- **GIVEN** a candidate file that cannot be read from disk
- **WHEN** `verifyFile` is called for that file
- **THEN** the file is added to `skippedFiles` with a read-error reason

#### Requirement: Fallbackbehavior

The system SHALL fall back to a minimal result when a file cannot be verified, preserving run integrity.

#### Scenario: FallbackResult
- **GIVEN** a file that fails both parsing and LLM prediction
- **WHEN** verification runs
- **THEN** the file is excluded from results and a warning is logged, rather than propagating an exception or recording a misleading zero score

## Technical Notes

- **Dependencies**: `LLMService`, `DependencyGraphResult`
- **Pass threshold**: Default 0.5 (configurable via `VerifyApiOptions.threshold`)
- **Score weights**: purpose = 0.40, imports = 0.15, exports = 0.15, requirements = 0.30 (see `calculateOverallScore`)
- **Note on weights**: Specs describe behaviour and architecture, not exact import paths or export names. Weighting imports+exports too heavily makes it structurally impossible to pass regardless of spec quality. With the current weights, the maximum achievable score when import/export F1=0 is 0.70 (purpose 0.40 + requirements 0.30), which is above the default pass threshold of 0.50. Import/export F1 still contributes as a positive signal when the LLM predicts correctly.
