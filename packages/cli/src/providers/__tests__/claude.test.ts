import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseClaudeConversations } from "../claude"

describe("parseClaudeConversations", () => {
  it("parses a valid Claude export", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-claude-test-"))
    const exportDir = join(root, "claude")
    await mkdir(exportDir, { recursive: true })

    const payload = [
      {
        uuid: "claude-1",
        name: "Claude plan",
        created_at: "2026-02-20T10:00:00.000Z",
        updated_at: "2026-02-20T10:05:00.000Z",
        chat_messages: [
          {
            uuid: "m1",
            sender: "human",
            text: "Draft a release checklist",
            created_at: "2026-02-20T10:00:00.000Z",
          },
          {
            uuid: "m2",
            sender: "assistant",
            content: [{ type: "text", text: "Here is the checklist" }],
            created_at: "2026-02-20T10:01:00.000Z",
          },
        ],
      },
    ]
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify(payload), "utf8")

    const parsed = await parseClaudeConversations(root)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      id: "claude-1",
      title: "Claude plan",
      source: "claude",
      messageCount: 2,
    })
    expect(parsed[0]?.messages.map((entry) => entry.role)).toEqual(["human", "assistant"])
  })

  it("rejects non-Claude schema payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-claude-strict-test-"))
    const exportDir = join(root, "claude")
    await mkdir(exportDir, { recursive: true })

    const chatGptLike = [
      {
        id: "not-claude",
        current_node: "node-2",
        mapping: {},
      },
    ]
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify(chatGptLike), "utf8")

    await expect(parseClaudeConversations(root)).rejects.toThrow("File does not match expected Claude export schema")
  })

  it("parses rich Claude content variants and truncates oversized text", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-claude-rich-test-"))
    const exportDir = join(root, "claude")
    await mkdir(exportDir, { recursive: true })

    const veryLong = "x".repeat(17_000)
    const payload = [
      {
        uuid: "claude-rich",
        name: "Rich Claude",
        chat_messages: [
          {
            sender: "human",
            content: [
              { type: "tool_use", name: "search", input: { q: "reclaw" } },
              {
                type: "tool_result",
                message: "result message",
                content: [{ title: "Result", url: "https://example.com", text: "detail" }],
              },
              { type: "thinking", summaries: [{ summary: "reasoning summary" }] },
              { type: "voice_note", title: "Voice", text: "Transcript" },
              { type: "unknown_type", text: veryLong },
            ],
            created_at: "2026-02-20T10:00:00.000Z",
          },
        ],
      },
    ]
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify(payload), "utf8")

    const parsed = await parseClaudeConversations(root)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.messages).toHaveLength(1)
    expect(parsed[0]?.messages[0]?.content).toContain("Tool use: search")
    expect(parsed[0]?.messages[0]?.content).toContain("Result - https://example.com")
    expect(parsed[0]?.messages[0]?.content).toContain("reasoning summary")
    expect(parsed[0]?.messages[0]?.content).toContain("Voice")
    expect(parsed[0]?.messages[0]?.content.endsWith("\n...")).toBeTrue()
  })

  it("supports empty exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-claude-empty-test-"))
    const exportDir = join(root, "claude")
    await mkdir(exportDir, { recursive: true })
    await writeFile(join(exportDir, "conversations.json"), "[]", "utf8")

    await expect(parseClaudeConversations(root)).resolves.toEqual([])
  })

  it("rejects non-array exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-claude-shape-test-"))
    const exportDir = join(root, "claude")
    await mkdir(exportDir, { recursive: true })
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify({ wrong: true }), "utf8")

    await expect(parseClaudeConversations(root)).rejects.toThrow("Expected Claude conversations export to be an array")
  })

  it("covers additional Claude content fallbacks and role mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-claude-content-test-"))
    const exportDir = join(root, "claude")
    await mkdir(exportDir, { recursive: true })

    const payload = [
      {
        uuid: "claude-extra",
        chat_messages: [
          {
            sender: "bot",
            text: "fallback text",
            content: null,
            updated_at: "2026-02-20T10:00:00.000Z",
          },
          {
            sender: "assistant",
            content: [{ type: "tool_result", message: "base", content: "string result" }],
          },
          {
            sender: "assistant",
            content: [
              {
                type: "tool_result",
                content: [{ title: "Only title", url: "https://example.com" }, { text: "Only text" }, { random: true }],
              },
            ],
          },
          {
            sender: "assistant",
            content: [{ type: "thinking", thinking: "direct thinking" }],
          },
          {
            sender: "assistant",
            content: [{ type: "unknown", payload: true }],
          },
        ],
      },
    ]
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify(payload), "utf8")

    const parsed = await parseClaudeConversations(root)
    expect(parsed[0]?.messages[0]?.role).toBe("system")
    expect(parsed[0]?.messages[0]?.content).toBe("fallback text")
    expect(parsed[0]?.messages[1]?.content).toContain("string result")
    expect(parsed[0]?.messages[2]?.content).toContain("Only title - https://example.com")
    expect(parsed[0]?.messages[2]?.content).toContain("Only text")
    expect(parsed[0]?.messages[3]?.content).toContain("direct thinking")
    expect(parsed[0]?.messages[4]?.content).toContain('"payload":true')
  })
})
