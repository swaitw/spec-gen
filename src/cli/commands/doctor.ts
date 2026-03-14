/**
 * spec-gen doctor command
 *
 * Self-diagnostic tool that checks all prerequisites and surfaces actionable
 * fixes when something is misconfigured or missing.
 */

import { Command } from 'commander';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import { readSpecGenConfig } from '../../core/services/config-manager.js';
import {
  MIN_NODE_MAJOR_VERSION,
  ANALYSIS_AGE_WARNING_HOURS,
  MIN_DISK_SPACE_FAIL_MB,
  MIN_DISK_SPACE_WARN_MB,
  SPEC_GEN_DIR,
  SPEC_GEN_ANALYSIS_SUBDIR,
  SPEC_GEN_CONFIG_FILENAME,
  SPEC_GEN_CONFIG_REL_PATH,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  ARTIFACT_REPO_STRUCTURE,
} from '../../constants.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// TYPES
// ============================================================================

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

// ============================================================================
// INDIVIDUAL CHECKS
// ============================================================================

async function checkNodeVersion(): Promise<CheckResult> {
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= MIN_NODE_MAJOR_VERSION) {
    return { name: 'Node.js version', status: 'ok', detail: `v${process.versions.node}` };
  }
  return {
    name: 'Node.js version',
    status: 'fail',
    detail: `v${process.versions.node} (requires >=${MIN_NODE_MAJOR_VERSION})`,
    fix: `Install Node.js ${MIN_NODE_MAJOR_VERSION}+ from https://nodejs.org/`,
  };
}

async function checkGit(rootPath: string): Promise<CheckResult> {
  const gitDir = join(rootPath, '.git');
  try {
    await access(gitDir);
  } catch {
    return {
      name: 'Git repository',
      status: 'warn',
      detail: 'No .git directory found',
      fix: "Run 'git init' — drift detection requires git",
    };
  }

  try {
    await execFileAsync('git', ['--version'], { cwd: rootPath });
    return { name: 'Git repository', status: 'ok', detail: 'Git repository detected' };
  } catch {
    return {
      name: 'Git repository',
      status: 'warn',
      detail: '.git found but git binary not on PATH',
      fix: 'Install git from https://git-scm.com/',
    };
  }
}

async function checkConfig(rootPath: string): Promise<CheckResult> {
  const configPath = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_CONFIG_FILENAME);
  try {
    await access(configPath);
    const config = await readSpecGenConfig(rootPath);
    if (!config) {
      return {
        name: 'spec-gen config',
        status: 'fail',
        detail: `${SPEC_GEN_CONFIG_REL_PATH} exists but could not be parsed`,
        fix: `Delete ${SPEC_GEN_CONFIG_REL_PATH} and run 'spec-gen init'`,
      };
    }
    return {
      name: 'spec-gen config',
      status: 'ok',
      detail: `${SPEC_GEN_CONFIG_REL_PATH} (project: ${config.projectType})`,
    };
  } catch {
    return {
      name: 'spec-gen config',
      status: 'warn',
      detail: `${SPEC_GEN_CONFIG_REL_PATH} not found`,
      fix: "Run 'spec-gen init' to create the configuration",
    };
  }
}

async function checkAnalysis(rootPath: string): Promise<CheckResult> {
  const analysisPath = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_REPO_STRUCTURE);
  try {
    const s = await stat(analysisPath);
    const ageHours = (Date.now() - s.mtime.getTime()) / 3_600_000;
    const ageLabel = ageHours < 1 ? 'fresh' : `${ageHours.toFixed(1)}h old`;
    const status: CheckStatus = ageHours > ANALYSIS_AGE_WARNING_HOURS ? 'warn' : 'ok';
    return {
      name: 'Analysis artifacts',
      status,
      detail: `repo-structure.json exists (${ageLabel})`,
      fix: status === 'warn' ? "Run 'spec-gen analyze' to refresh stale analysis" : undefined,
    };
  } catch {
    return {
      name: 'Analysis artifacts',
      status: 'warn',
      detail: 'No analysis found — run spec-gen analyze first',
      fix: "Run 'spec-gen analyze'",
    };
  }
}

async function checkOpenSpecDir(rootPath: string): Promise<CheckResult> {
  const specsDir = join(rootPath, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);
  try {
    await access(specsDir);
    return { name: 'OpenSpec directory', status: 'ok', detail: 'openspec/specs/ exists' };
  } catch {
    return {
      name: 'OpenSpec directory',
      status: 'warn',
      detail: 'openspec/specs/ not found',
      fix: "Run 'spec-gen init' then 'spec-gen generate'",
    };
  }
}

async function checkLLMProvider(): Promise<CheckResult> {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
  const hasApiBase = !!process.env.SPEC_GEN_API_BASE;

  // Check if claude CLI is available (Claude Code / Max plan)
  let hasClaudeCode = false;
  try {
    await execFileAsync('claude', ['--version']);
    hasClaudeCode = true;
  } catch { /* not installed */ }

  if (hasAnthropic) {
    return { name: 'LLM provider', status: 'ok', detail: 'ANTHROPIC_API_KEY set' };
  }
  if (hasOpenAI) {
    return { name: 'LLM provider', status: 'ok', detail: 'OPENAI_API_KEY set' };
  }
  if (hasGemini) {
    return { name: 'LLM provider', status: 'ok', detail: 'GEMINI_API_KEY set' };
  }
  if (hasClaudeCode) {
    return { name: 'LLM provider', status: 'ok', detail: 'claude CLI detected (Claude Code / Max)' };
  }
  if (hasApiBase) {
    return {
      name: 'LLM provider',
      status: 'warn',
      detail: `SPEC_GEN_API_BASE set to ${process.env.SPEC_GEN_API_BASE} (no API key)`,
    };
  }

  return {
    name: 'LLM provider',
    status: 'fail',
    detail: 'No LLM provider configured',
    fix:
      'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.\n' +
      '  Alternatively install Claude Code (claude CLI) for subscription-based access.',
  };
}

async function checkDiskSpace(rootPath: string): Promise<CheckResult> {
  // Use df to check available space — best-effort, skip on unsupported platforms
  try {
    const { stdout } = await execFileAsync('df', ['-k', rootPath]);
    const lines = stdout.trim().split('\n');
    const dataLine = lines[lines.length - 1];
    const parts = dataLine.trim().split(/\s+/);
    // df -k: Filesystem  1K-blocks  Used  Available  Use%  Mounted-on
    const availableKB = Number(parts[3]);
    if (isNaN(availableKB)) {
      return { name: 'Disk space', status: 'ok', detail: 'Could not parse df output' };
    }
    const availableMB = Math.round(availableKB / 1024);
    if (availableMB < MIN_DISK_SPACE_FAIL_MB) {
      return {
        name: 'Disk space',
        status: 'fail',
        detail: `Only ${availableMB} MB available`,
        fix: `Free up disk space — analysis artifacts and vector index can use ${MIN_DISK_SPACE_FAIL_MB}–${MIN_DISK_SPACE_WARN_MB} MB`,
      };
    }
    if (availableMB < MIN_DISK_SPACE_WARN_MB) {
      return {
        name: 'Disk space',
        status: 'warn',
        detail: `${availableMB} MB available (low)`,
        fix: 'Consider freeing disk space before using --embed (vector index can be large)',
      };
    }
    return { name: 'Disk space', status: 'ok', detail: `${availableMB} MB available` };
  } catch {
    return { name: 'Disk space', status: 'ok', detail: 'Check skipped (df not available)' };
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function printResult(r: CheckResult, useColor: boolean): void {
  const icons: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };
  const colors: Record<CheckStatus, string> = {
    ok: useColor ? '\x1b[32m' : '',
    warn: useColor ? '\x1b[33m' : '',
    fail: useColor ? '\x1b[31m' : '',
  };
  const reset = useColor ? '\x1b[0m' : '';
  const dim = useColor ? '\x1b[2m' : '';

  const icon = `${colors[r.status]}${icons[r.status]}${reset}`;
  console.log(`  ${icon}  ${r.name.padEnd(22)} ${dim}${r.detail}${reset}`);
  if (r.fix) {
    console.log(`       ${' '.repeat(22)} ${colors.warn}→ ${r.fix}${reset}`);
  }
}

// ============================================================================
// COMMAND
// ============================================================================

export const doctorCommand = new Command('doctor')
  .description('Check your environment and configuration for common issues')
  .addHelpText(
    'after',
    `
Examples:
  $ spec-gen doctor           Run all checks
  $ spec-gen doctor --json    Output results as JSON

Checks performed:
  • Node.js version (>=${MIN_NODE_MAJOR_VERSION} required)
  • Git repository detection
  • spec-gen configuration (${SPEC_GEN_CONFIG_REL_PATH})
  • Analysis artifacts freshness
  • OpenSpec directory presence
  • LLM provider configuration
  • Available disk space
`
  )
  .option('--json', 'Output results as JSON', false)
  .action(async (options: { json: boolean }) => {
    const rootPath = process.cwd();
    const useColor = process.stdout.isTTY && !options.json;

    if (!options.json) {
      logger.section('spec-gen doctor');
      console.log('');
    }

    const checks = await Promise.all([
      checkNodeVersion(),
      checkGit(rootPath),
      checkConfig(rootPath),
      checkAnalysis(rootPath),
      checkOpenSpecDir(rootPath),
      checkLLMProvider(),
      checkDiskSpace(rootPath),
    ]);

    if (options.json) {
      console.log(JSON.stringify(checks, null, 2));
      return;
    }

    for (const result of checks) {
      printResult(result, useColor);
    }

    console.log('');

    const failures = checks.filter(c => c.status === 'fail');
    const warnings = checks.filter(c => c.status === 'warn');

    if (failures.length > 0) {
      logger.error(`${failures.length} check(s) failed — fix the issues above before proceeding`);
      process.exitCode = 1;
    } else if (warnings.length > 0) {
      logger.warning(`${warnings.length} warning(s) — some features may not work correctly`);
    } else {
      logger.success('All checks passed!');
    }
    console.log('');
  });
