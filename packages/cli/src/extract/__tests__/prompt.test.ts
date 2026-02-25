import { describe, expect, it } from "bun:test"

import type { ConversationBatch } from "../contracts"
import { buildSubagentPrompt, parseSubagentExtraction } from "../prompt"

describe("prompt", () => {
  it("builds a subagent prompt with provider summary and conversation details", () => {
    const prompt = buildSubagentPrompt(buildBatch(), {
      mode: "openclaw",
      outputPath: "/tmp/workspace",
      memoryWorkspacePath: "/tmp/workspace",
    })

    expect(prompt).toContain("ChatGPT (1), Claude (1)")
    expect(prompt).toContain("provider: chatgpt")
    expect(prompt).toContain("provider: claude")
    expect(prompt).toContain("messages: 2")
  })

  it("truncates when max prompt budget is exceeded", () => {
    const large = buildBatch("x".repeat(20_000))
    const prompt = buildSubagentPrompt(large, {
      mode: "zettelclaw",
      outputPath: "/tmp/vault",
      memoryWorkspacePath: "/tmp/openclaw-workspace",
      maxPromptChars: 600,
    })

    expect(prompt).toContain("prompt truncated")
  })

  it("parses JSON and embedded JSON extraction outputs", () => {
    expect(parseSubagentExtraction('{"summary":"clean"}')).toEqual({ summary: "Fact: clean" })
    expect(parseSubagentExtraction('status: ok\n{"summary":"embedded"}\nend')).toEqual({ summary: "Fact: embedded" })
  })

  it("returns empty summary when parsing fails", () => {
    const parsed = parseSubagentExtraction("  unstructured output  ")
    expect(parsed.summary).toBe("")
  })

  it("strips markdown fences before parsing JSON", () => {
    const parsed = parseSubagentExtraction('```json\n{"summary":"fenced"}\n```')
    expect(parsed.summary).toBe("Fact: fenced")
  })

  it("removes process/meta/filter commentary and keeps only tagged durable lines", () => {
    const parsed = parseSubagentExtraction(
      JSON.stringify({
        summary: [
          "Done. Extracted durable memory and saved to /Users/max/.openclaw/workspace/reclaw-extract-output.json",
          "Reason: This is general knowledge and fails the hard memory filter",
          "**Decision**: Use Bun runtime for this project",
          "Project: Realtime pricing app",
          "The main Reclaw process will integrate this output.",
        ].join("\n"),
      }),
    )

    expect(parsed.summary).toBe("Decision: Use Bun runtime for this project\nProject: Realtime pricing app")
  })
})

function buildBatch(content = "hello world"): ConversationBatch {
  return {
    id: "batch-1",
    providers: ["chatgpt", "claude"],
    date: "2026-02-22",
    index: 0,
    totalForDate: 1,
    conversations: [
      {
        id: "c-1",
        title: "ChatGPT thread",
        source: "chatgpt",
        createdAt: "2026-02-22T10:00:00.000Z",
        messageCount: 2,
        messages: [
          { role: "human", content, timestamp: "2026-02-22T10:00:00.000Z" },
          { role: "assistant", content: "response", timestamp: "2026-02-22T10:01:00.000Z" },
        ],
      },
      {
        id: "c-2",
        title: "Claude thread",
        source: "claude",
        createdAt: "2026-02-22T11:00:00.000Z",
        messageCount: 1,
        messages: [{ role: "assistant", content: "claude reply", timestamp: "2026-02-22T11:00:00.000Z" }],
      },
    ],
  }
}
