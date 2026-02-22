import { describe, expect, it } from "bun:test"

import type { ConversationBatch } from "../contracts"
import { buildSubagentPrompt, parseSubagentExtraction } from "../prompt"

describe("prompt", () => {
  it("builds a subagent prompt with provider summary and conversation details", () => {
    const prompt = buildSubagentPrompt(buildBatch(), {
      mode: "openclaw",
      outputPath: "/tmp/workspace",
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
      maxPromptChars: 600,
    })

    expect(prompt).toContain("prompt truncated")
  })

  it("parses JSON and embedded JSON extraction outputs", () => {
    expect(parseSubagentExtraction('{"summary":"clean"}')).toEqual({ summary: "clean" })
    expect(parseSubagentExtraction('status: ok\n{"summary":"embedded"}\nend')).toEqual({ summary: "embedded" })
  })

  it("falls back to clipped raw response when parsing fails", () => {
    const parsed = parseSubagentExtraction("  unstructured output  ")
    expect(parsed.summary).toBe("unstructured output")
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
