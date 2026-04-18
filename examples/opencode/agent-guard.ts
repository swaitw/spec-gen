/**
 * spec-gen Agent Guard — OpenCode plugin
 *
 * Install globally:  spec-gen decisions --install-opencode-plugin
 * Install manually:  copy to ~/.config/opencode/plugins/
 *                    add "./plugins/agent-guard.ts" to the "plugin" array in opencode.json
 *
 * What it does:
 *   1. Anti-premature-stop: injects a system-prompt rule that prevents the agent
 *      from declaring "Task completed" / "Done" without having made real file changes.
 *   2. record_decision nudge: when a structural file (service/, domain/, core/, adapter/)
 *      is modified without a prior record_decision call in the session, appends a
 *      non-blocking reminder to the tool output the agent sees.
 */

import type { Plugin } from "@opencode-ai/plugin"

const STRUCTURAL = /\/(service|domain|core|adapter)\//

export const AgentGuard: Plugin = async () => {
  // Per-session counters — keyed by sessionID so parallel sessions don't interfere
  const toolCalls = new Map<string, number>()
  const rdCalled = new Map<string, boolean>()

  const inc = (sid: string) => toolCalls.set(sid, (toolCalls.get(sid) ?? 0) + 1)
  const reset = (sid: string) => { toolCalls.set(sid, 0); rdCalled.set(sid, false) }

  return {
    // Inject guard into every system prompt sent to the LLM.
    // Prevents "Task completed" before any real work has been done.
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if ((toolCalls.get(sessionID) ?? 0) === 0) {
        output.system.push(
          "Do not say 'Task completed', 'Done', or 'Finished' without having executed " +
          "at least one file modification tool call. If no real work has been done yet, keep working.",
        )
      }
    },

    // Track tool calls per session.
    // Append a record_decision nudge when a structural file is modified.
    "tool.execute.after": async (input, output) => {
      const { sessionID, tool, args } = input
      inc(sessionID)

      if (tool.includes("record_decision")) {
        rdCalled.set(sessionID, true)
        return
      }

      const file: string = args?.filePath ?? args?.path ?? ""
      if (STRUCTURAL.test(file) && !rdCalled.get(sessionID)) {
        output.output +=
          "\n\n[spec-gen] Structural file modified. " +
          "Consider calling record_decision before continuing."
      }
    },

    // Reset per-session counters on session lifecycle events.
    event: async ({ event }) => {
      const sid = (event as any).properties?.sessionID
      if (sid && ["session.idle", "session.created"].includes((event as any).type)) {
        reset(sid)
      }
    },
  }
}
