/**
 * RIG-17 — End-to-end pipeline test on a real repository
 *
 * Uses the spec-gen codebase itself as the fixture.  The test opens the
 * vector index produced by `spec-gen analyze --embed` (already on disk) and
 * verifies that business-level queries return the correct source files and
 * that indexed functions carry non-empty docstrings when the source has them.
 *
 * Prerequisites:
 *   npm run embed:up          # start the embedding server
 *   spec-gen analyze --embed  # (re)build the index
 *   npm run test:integration
 *
 * The test is skipped automatically when either the embedding server or the
 * index is missing so it never breaks a cold CI environment.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join, resolve } from 'node:path';
import { VectorIndex } from './vector-index.js';
import { EmbeddingService } from './embedding-service.js';

// ============================================================================
// CONFIG
// ============================================================================

const EMBED_BASE_URL = process.env.EMBED_BASE_URL ?? 'http://localhost:8765/v1';
const EMBED_MODEL    = process.env.EMBED_MODEL    ?? 'all-MiniLM-L6-v2';

/** Root of the spec-gen repo (two levels up from src/core/analyzer/) */
const REPO_ROOT  = resolve(import.meta.dirname, '../../../');
const INDEX_DIR  = join(REPO_ROOT, '.spec-gen/analysis');

// ============================================================================
// HELPERS
// ============================================================================

async function isServerUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// KNOWN QUERIES — business concepts that must map to specific spec-gen files
//
// Each entry states what a developer would ask and which file(s) must appear
// in the top-5 results.  Derived from manual inspection of the codebase.
// ============================================================================

const KNOWN_QUERIES: Array<{
  query: string;
  mustInclude: string[];   // relative file paths that must appear in top-5
  description: string;
}> = [
  {
    query: 'build vector index from call graph nodes and embed functions',
    mustInclude: ['src/core/analyzer/vector-index.ts'],
    description: 'VectorIndex.build — core embedding pipeline',
  },
  {
    query: 'read spec-gen configuration file from project root',
    mustInclude: ['src/core/services/config-manager.ts'],
    description: 'readSpecGenConfig — config loading hub',
  },
  {
    query: 'parse TypeScript Python Go Rust Ruby class method signatures regex multi-language',
    mustInclude: ['src/core/analyzer/signature-extractor.ts'],
    description: 'signature extractor — multi-language signature parsing',
  },
  {
    query: 'detect duplicate code clones structural exact near',
    mustInclude: ['src/core/analyzer/duplicate-detector.ts'],
    description: 'duplicate detector — clone detection',
  },
  {
    query: 'generate OpenSpec specification from LLM pipeline stages',
    mustInclude: ['src/core/generator/spec-pipeline.ts'],
    description: 'SpecGenerationPipeline — orchestrator',
  },
  {
    query: 'semantic search over embedded function vectors hybrid BM25',
    mustInclude: ['src/core/analyzer/vector-index.ts'],
    description: 'VectorIndex.search — hybrid retrieval',
  },
  {
    query: 'validate MCP tool directory argument',
    mustInclude: ['src/core/services/mcp-handlers/utils.ts'],
    description: 'validateDirectory — MCP guard',
  },
];

// ============================================================================
// TESTS
// ============================================================================

describe('RIG-17 — e2e pipeline on real spec-gen codebase', () => {
  let serverAvailable = false;
  let indexExists = false;
  let embedSvc: EmbeddingService;

  beforeAll(async () => {
    serverAvailable = await isServerUp(EMBED_BASE_URL);
    indexExists     = VectorIndex.exists(INDEX_DIR);
    if (serverAvailable) {
      embedSvc = new EmbeddingService({ baseUrl: EMBED_BASE_URL, model: EMBED_MODEL });
    }
  });

  function skipIfNotReady(label: string): boolean {
    if (!indexExists) {
      console.warn(`  ⚠ [${label}] No index at ${INDEX_DIR} — run "spec-gen analyze --embed" first`);
      return true;
    }
    if (!serverAvailable) {
      console.warn(`  ⚠ [${label}] Embedding server not reachable at ${EMBED_BASE_URL}`);
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Sanity — index exists and has rows
  // --------------------------------------------------------------------------

  it('index exists on disk', () => {
    if (!indexExists) {
      console.warn(`  ⚠ No index at ${INDEX_DIR} — run "spec-gen analyze --embed" first`);
      return;
    }
    expect(VectorIndex.exists(INDEX_DIR)).toBe(true);
  });

  it('index has a meaningful number of functions (>= 100)', async () => {
    if (!indexExists) return;

    // Open the table directly to count rows without embedding
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(join(INDEX_DIR, 'vector-index'));
    const table = await db.openTable('functions');
    const rows = await table.query().toArray();
    expect(rows.length).toBeGreaterThanOrEqual(100);
  });

  // --------------------------------------------------------------------------
  // Docstring coverage — functions that have docstrings in source must have
  // non-empty text in the index (regression for the "docstrings not indexed" bug)
  // --------------------------------------------------------------------------

  it('indexed functions with known docstrings have non-empty text', async () => {
    if (!indexExists) return;

    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(join(INDEX_DIR, 'vector-index'));
    const table = await db.openTable('functions');
    const rows = await table.query().toArray() as Array<{ id: string; text: string }>;

    // Functions known to have docstrings in spec-gen source
    const knownDocstringFns = [
      'VectorIndex.build',
      'VectorIndex.search',
      'EmbeddingService.embed',
      'generateCodebaseDigest',
    ];

    for (const fnName of knownDocstringFns) {
      const row = rows.find(r => r.id.includes(fnName) || r.text.includes(fnName));
      if (!row) continue; // function may have been renamed — skip gracefully
      expect(row.text.length, `${fnName} text should be non-trivial`).toBeGreaterThan(30);
    }
  });

  // --------------------------------------------------------------------------
  // Semantic retrieval — known business queries must surface the right files
  // --------------------------------------------------------------------------

  for (const { query, mustInclude, description } of KNOWN_QUERIES) {
    it(`query: "${description}"`, async () => {
      if (skipIfNotReady(description)) return;

      const results = await VectorIndex.search(INDEX_DIR, query, embedSvc, 5);
      const returnedPaths = results.map(r => r.record.filePath);

      for (const expected of mustInclude) {
        const found = returnedPaths.some(p => p.includes(expected) || p.endsWith(expected));
        expect(found, `Expected "${expected}" in top-5 for: "${query}"\nGot: ${returnedPaths.join(', ')}`).toBe(true);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Result quality — scores in valid range, no undefined fields
  // --------------------------------------------------------------------------

  it('search results have valid scores and required fields', async () => {
    if (skipIfNotReady('result quality')) return;

    const results = await VectorIndex.search(INDEX_DIR, 'parse call graph from source files', embedSvc, 5);
    expect(results.length).toBeGreaterThan(0);

    for (const { record, score } of results) {
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(record.id).toBeTruthy();
      expect(record.filePath).toBeTruthy();
      expect(record.name).toBeTruthy();
      expect(record.text.length).toBeGreaterThan(0);
    }
  });
});
