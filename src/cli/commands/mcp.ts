/**
 * spec-gen MCP Server
 *
 * Exposes spec-gen's static analysis capabilities as Model Context Protocol
 * tools, usable from Cline, Claude Code, or any MCP-compatible AI agent.
 *
 * Transport: stdio (standard for editor-embedded MCP servers)
 *
 * Tools:
 *   analyze_codebase    — Run static analysis, return structured summary
 *   get_refactor_report — Return refactoring priorities (from cached analysis)
 *   get_call_graph      — Return call graph: hubs, entry points, violations
 *   get_signatures      — Return compact function/class signatures per file
 *   get_subgraph        — Extract upstream/downstream call subgraph from a function
 *
 * Configuration for Cline / Claude Code:
 *   {
 *     "mcpServers": {
 *       "spec-gen": {
 *         "command": "node",
 *         "args": ["/path/to/spec-gen/dist/cli/index.js", "mcp"]
 *       }
 *     }
 *   }
 */

import { Command } from 'commander';
// We use the low-level `Server` class rather than the high-level `McpServer`
// because our tool definitions use raw JSON Schema. `McpServer` requires Zod.
// eslint-disable-next-line deprecation/deprecation
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runAnalysis } from './analyze.js';
import { analyzeForRefactoring } from '../../core/analyzer/refactor-analyzer.js';
import { formatSignatureMaps } from '../../core/analyzer/signature-extractor.js';
import type { LLMContext } from '../../core/analyzer/artifact-generator.js';
import type { SerializedCallGraph } from '../../core/analyzer/call-graph.js';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOL_DEFINITIONS = [
  {
    name: 'analyze_codebase',
    description:
      'Run static analysis on a project directory. Extracts repo structure, ' +
      'dependency graph, call graph (hub functions, entry points), and top ' +
      'refactoring priorities — all without an LLM. Results are cached for 1 hour.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory to analyze',
        },
        force: {
          type: 'boolean',
          description: 'Force re-analysis even if a recent cache exists (default: false)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_refactor_report',
    description:
      'Return a prioritized list of functions that need refactoring, based on ' +
      'the cached static analysis. Issues detected: unreachable code, high fan-in ' +
      '(hub overload), high fan-out (god function), SRP violations (multi-requirement), ' +
      'and cyclic dependencies. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_call_graph',
    description:
      'Return the call graph for a project: hub functions (high fan-in), ' +
      'entry points (no internal callers), and architectural layer violations. ' +
      'Supports TypeScript, JavaScript, Python, Go, Rust, Ruby, Java. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_signatures',
    description:
      'Return compact function and class signatures for files in a project. ' +
      'Useful for understanding a codebase\'s public API without reading full source. ' +
      'Optionally filter by file path pattern. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        filePattern: {
          type: 'string',
          description:
            'Optional substring to filter file paths (e.g. "services", "api", ".py")',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_subgraph',
    description:
      'Extract a subgraph of the call graph centred on a specific function. ' +
      'Useful for impact analysis ("what does X call?"), dependency tracing ' +
      '("who calls X?"), or understanding a change\'s blast radius. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        functionName: {
          type: 'string',
          description: 'Name of the function to centre the subgraph on (exact or partial match)',
        },
        direction: {
          type: 'string',
          enum: ['downstream', 'upstream', 'both'],
          description:
            'downstream = what this function calls (default), ' +
            'upstream = who calls this function, ' +
            'both = full neighbourhood',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 3)',
        },
      },
      required: ['directory', 'functionName'],
    },
  },
];

// ============================================================================
// CACHE HELPERS
// ============================================================================

async function readCachedContext(directory: string): Promise<LLMContext | null> {
  try {
    const raw = await readFile(
      join(directory, '.spec-gen', 'analysis', 'llm-context.json'),
      'utf-8'
    );
    return JSON.parse(raw) as LLMContext;
  } catch {
    return null;
  }
}

/** Returns true if the cached analysis is present and less than 1 hour old. */
async function isCacheFresh(directory: string): Promise<boolean> {
  try {
    const s = await stat(join(directory, '.spec-gen', 'analysis', 'llm-context.json'));
    return Date.now() - s.mtimeMs < 60 * 60 * 1000;
  } catch {
    return false;
  }
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

/**
 * Run a full static analysis pass on `directory` and return a compact summary.
 *
 * Always writes results to `<directory>/.spec-gen/analysis/`. The `force`
 * flag bypasses the 1-hour cache and triggers a fresh analysis.
 *
 * Returned object includes: project metadata, file/dep/call-graph stats,
 * detected domains, and the top-10 refactoring priorities (if a call graph
 * was produced).
 */
async function handleAnalyzeCodebase(
  directory: string,
  force: boolean
): Promise<Record<string, unknown>> {
  const absDir = resolve(directory);
  const outputPath = join(absDir, '.spec-gen', 'analysis');

  // Skip re-analysis if cache is fresh and force is not set
  if (!force && await isCacheFresh(absDir)) {
    const ctx = await readCachedContext(absDir);
    if (ctx) {
      const cg = ctx.callGraph;
      const topRefactorIssues = cg
        ? analyzeForRefactoring(cg as SerializedCallGraph).priorities.slice(0, 10).map(e => ({
            function: e.function, file: e.file, issues: e.issues, priorityScore: e.priorityScore,
          }))
        : [];
      return {
        cached: true,
        callGraph: cg
          ? { totalNodes: cg.stats.totalNodes, totalEdges: cg.stats.totalEdges,
              hubs: cg.hubFunctions.length, entryPoints: cg.entryPoints.length,
              layerViolations: cg.layerViolations.length }
          : null,
        topRefactorIssues,
        analysisPath: join('.spec-gen', 'analysis'),
      };
    }
  }

  const result = await runAnalysis(absDir, outputPath, {
    maxFiles: 500,
    include: [],
    exclude: [],
  });

  const { artifacts, repoMap, depGraph } = result;
  const rs = artifacts.repoStructure;
  const cg = artifacts.llmContext.callGraph;

  // Compute top refactor priorities if call graph available
  let topRefactorIssues: unknown[] = [];
  if (cg) {
    const report = analyzeForRefactoring(cg as SerializedCallGraph);
    topRefactorIssues = report.priorities.slice(0, 10).map(e => ({
      function: e.function,
      file: e.file,
      issues: e.issues,
      priorityScore: e.priorityScore,
    }));
  }

  return {
    projectName: rs.projectName,
    projectType: rs.projectType,
    frameworks: rs.frameworks,
    architecture: rs.architecture.pattern,
    stats: {
      files: repoMap.summary.totalFiles,
      analyzedFiles: repoMap.summary.analyzedFiles,
      depNodes: depGraph.statistics.nodeCount,
      depEdges: depGraph.statistics.edgeCount,
      cycles: depGraph.statistics.cycleCount,
    },
    callGraph: cg
      ? {
          totalNodes: cg.stats.totalNodes,
          totalEdges: cg.stats.totalEdges,
          hubs: cg.hubFunctions.length,
          entryPoints: cg.entryPoints.length,
          layerViolations: cg.layerViolations.length,
        }
      : null,
    domains: rs.domains.map(d => d.name),
    topRefactorIssues,
    analysisPath: join('.spec-gen', 'analysis'),
  };
}

/**
 * Return a prioritized refactor report from cached analysis.
 *
 * Detects five issue categories: unreachable code, high fan-in (hub overload),
 * high fan-out (god function), SRP violations, and cyclic dependencies.
 * Requires a prior successful `analyze_codebase` call.
 */
async function handleGetRefactorReport(directory: string): Promise<unknown> {
  const absDir = resolve(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }
  if (!ctx.callGraph) {
    return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };
  }

  return analyzeForRefactoring(ctx.callGraph as SerializedCallGraph);
}

/**
 * Return the call graph summary from cached analysis.
 *
 * Includes hub functions (high fan-in), entry points (no internal callers),
 * and architectural layer violations. Supports TypeScript, JavaScript, Python,
 * Go, Rust, Ruby, and Java. Requires a prior `analyze_codebase` call.
 */
async function handleGetCallGraph(directory: string): Promise<unknown> {
  const absDir = resolve(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }
  if (!ctx.callGraph) {
    return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };
  }

  const cg = ctx.callGraph;
  return {
    stats: cg.stats,
    hubFunctions: cg.hubFunctions.map(n => ({
      name: n.name,
      file: n.filePath,
      className: n.className,
      fanIn: n.fanIn,
      fanOut: n.fanOut,
      language: n.language,
    })),
    entryPoints: cg.entryPoints.map(n => ({
      name: n.name,
      file: n.filePath,
      className: n.className,
      language: n.language,
    })),
    layerViolations: cg.layerViolations,
  };
}

/**
 * Return compact function and class signatures for files in the project.
 *
 * Useful for understanding a codebase's public API without reading full source.
 * Pass `filePattern` to filter by path substring (e.g. `"services"`, `".py"`).
 * Multiple chunks are joined with a `---` separator.
 * Requires a prior `analyze_codebase` call.
 */
async function handleGetSignatures(directory: string, filePattern?: string): Promise<string> {
  const absDir = resolve(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    return 'No analysis found. Run analyze_codebase first.';
  }
  if (!ctx.signatures || ctx.signatures.length === 0) {
    return 'No signatures available in cached analysis. Re-run analyze_codebase.';
  }

  const filtered = filePattern
    ? ctx.signatures.filter(s => s.path.includes(filePattern))
    : ctx.signatures;

  if (filtered.length === 0) {
    return `No files matching pattern "${filePattern}" found in analysis.`;
  }

  const chunks = formatSignatureMaps(filtered);
  return chunks.join('\n\n---\n\n');
}

/**
 * Extract a depth-limited subgraph centred on a named function.
 *
 * `functionName` is matched case-insensitively as a substring against all node
 * names; multiple seed nodes may be returned. Traversal direction:
 *   - `downstream` — what this function calls (blast radius / impact analysis)
 *   - `upstream`   — who calls this function (dependency tracing)
 *   - `both`       — full neighbourhood
 *
 * `maxDepth` limits BFS depth (default: 3). Returns seed nodes, all reachable
 * nodes with fan-in/fan-out metrics, and the edges within the subgraph.
 * Requires a prior `analyze_codebase` call.
 */
async function handleGetSubgraph(
  directory: string,
  functionName: string,
  direction: 'downstream' | 'upstream' | 'both' = 'downstream',
  maxDepth = 3
): Promise<unknown> {
  const absDir = resolve(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }
  if (!ctx.callGraph) {
    return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };
  }

  const cg = ctx.callGraph as SerializedCallGraph;

  // Find seed nodes — all functions whose name contains functionName (case-insensitive)
  const lower = functionName.toLowerCase();
  const seeds = cg.nodes.filter(n => n.name.toLowerCase().includes(lower));

  if (seeds.length === 0) {
    return { error: `No function matching "${functionName}" found in call graph.` };
  }

  // Build adjacency lists
  const forward = new Map<string, string[]>();  // callerId → calleeIds
  const backward = new Map<string, string[]>(); // calleeId → callerIds
  for (const node of cg.nodes) {
    forward.set(node.id, []);
    backward.set(node.id, []);
  }
  for (const edge of cg.edges) {
    if (!edge.calleeId) continue;
    forward.get(edge.callerId)?.push(edge.calleeId);
    backward.get(edge.calleeId)?.push(edge.callerId);
  }

  // BFS in the requested direction(s)
  const visitedIds = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = seeds.map(n => ({ id: n.id, depth: 0 }));
  for (const seed of seeds) visitedIds.add(seed.id);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const neighbours: string[] = [];
    if (direction === 'downstream' || direction === 'both') {
      neighbours.push(...(forward.get(id) ?? []));
    }
    if (direction === 'upstream' || direction === 'both') {
      neighbours.push(...(backward.get(id) ?? []));
    }

    for (const nId of neighbours) {
      if (!visitedIds.has(nId)) {
        visitedIds.add(nId);
        queue.push({ id: nId, depth: depth + 1 });
      }
    }
  }

  // Collect subgraph nodes and edges
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const subNodes = Array.from(visitedIds)
    .map(id => nodeMap.get(id)!)
    .filter(Boolean)
    .map(n => ({
      name: n.name,
      file: n.filePath,
      className: n.className,
      fanIn: n.fanIn,
      fanOut: n.fanOut,
      language: n.language,
      isSeed: seeds.some(s => s.id === n.id),
    }));

  const subEdges = cg.edges
    .filter(e => e.calleeId && visitedIds.has(e.callerId) && visitedIds.has(e.calleeId))
    .map(e => ({
      caller: nodeMap.get(e.callerId)?.name ?? e.callerId,
      callee: nodeMap.get(e.calleeId)?.name ?? e.calleeId,
      callerFile: nodeMap.get(e.callerId)?.filePath,
      calleeFile: nodeMap.get(e.calleeId)?.filePath,
    }));

  return {
    query: { functionName, direction, maxDepth },
    seeds: seeds.map(n => ({ name: n.name, file: n.filePath })),
    stats: { nodes: subNodes.length, edges: subEdges.length },
    nodes: subNodes,
    edges: subEdges,
  };
}

// ============================================================================
// MCP SERVER
// ============================================================================

async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'spec-gen', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let result: unknown;

      if (name === 'analyze_codebase') {
        const { directory, force = false } = args as { directory: string; force?: boolean };
        result = await handleAnalyzeCodebase(directory, force);
      } else if (name === 'get_refactor_report') {
        const { directory } = args as { directory: string };
        result = await handleGetRefactorReport(directory);
      } else if (name === 'get_call_graph') {
        const { directory } = args as { directory: string };
        result = await handleGetCallGraph(directory);
      } else if (name === 'get_signatures') {
        const { directory, filePattern } = args as { directory: string; filePattern?: string };
        result = await handleGetSignatures(directory, filePattern);
      } else if (name === 'get_subgraph') {
        const { directory, functionName, direction = 'downstream', maxDepth = 3 } =
          args as { directory: string; functionName: string; direction?: 'downstream' | 'upstream' | 'both'; maxDepth?: number };
        result = await handleGetSubgraph(directory, functionName, direction, maxDepth);
      } else {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const text =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      return {
        content: [{ type: 'text', text }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Tool error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdio is closed by the client
}

// ============================================================================
// COMMAND EXPORT
// ============================================================================

export const mcpCommand = new Command('mcp')
  .description('Start spec-gen as an MCP server (stdio transport, for Cline/Claude Code)')
  .action(startMcpServer);
