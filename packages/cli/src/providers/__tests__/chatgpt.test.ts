import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseChatGptConversations } from "../chatgpt"

describe("parseChatGptConversations", () => {
  it("parses a valid ChatGPT export", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-chatgpt-test-"))
    const exportDir = join(root, "chatgpt")
    await mkdir(exportDir, { recursive: true })

    const payload = [
      {
        id: "chat-1",
        title: "Plan sprint",
        create_time: 1_700_000_000,
        update_time: 1_700_000_100,
        current_node: "node-2",
        default_model_slug: "gpt-4o",
        mapping: {
          "node-1": {
            id: "node-1",
            message: {
              author: { role: "user" },
              create_time: 1_700_000_000,
              content: { parts: ["Need a sprint plan"] },
            },
          },
          "node-2": {
            id: "node-2",
            parent: "node-1",
            message: {
              author: { role: "assistant" },
              create_time: 1_700_000_050,
              content: { parts: ["Here is a sprint plan"] },
              metadata: { model_slug: "gpt-4o" },
            },
          },
        },
      },
    ]
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify(payload), "utf8")

    const parsed = await parseChatGptConversations(root)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      id: "chat-1",
      title: "Plan sprint",
      source: "chatgpt",
      messageCount: 2,
      model: "gpt-4o",
    })
    expect(parsed[0]?.messages.map((entry) => entry.role)).toEqual(["human", "assistant"])
  })

  it("rejects non-ChatGPT schema payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-chatgpt-strict-test-"))
    const exportDir = join(root, "chatgpt")
    await mkdir(exportDir, { recursive: true })

    const claudeLike = [
      {
        uuid: "not-chatgpt",
        name: "Claude style payload",
        chat_messages: [],
      },
    ]
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify(claudeLike), "utf8")

    await expect(parseChatGptConversations(root)).rejects.toThrow("File does not match expected ChatGPT export schema")
  })

  it("parses diverse ChatGPT content payloads on non-current-node fallback path", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-chatgpt-rich-test-"))
    const exportDir = join(root, "chatgpt")
    await mkdir(exportDir, { recursive: true })

    const payload = [
      {
        id: "chat-rich",
        title: "Rich content",
        create_time: "2026-02-20T10:00:00.000Z",
        mapping: {
          a: {
            id: "a",
            message: {
              author: { role: "user" },
              create_time: "2026-02-20T10:02:00.000Z",
              content: { content_type: "code", text: "console.log('x')" },
            },
          },
          b: {
            id: "b",
            message: {
              author: { role: "assistant" },
              create_time: "2026-02-20T10:01:00.000Z",
              content: {
                parts: ["part one", { title: "Doc", url: "https://example.com" }],
              },
            },
          },
          c: {
            id: "c",
            message: {
              author: { role: "assistant" },
              create_time: "2026-02-20T10:03:00.000Z",
              content: { content_type: "reasoning_recap", content: "recap text" },
            },
          },
          d: {
            id: "d",
            message: {
              author: { role: "system" },
              create_time: "2026-02-20T10:04:00.000Z",
              content: {
                content_type: "thoughts",
                thoughts: [{ summary: "summary thought" }],
              },
            },
          },
          e: {
            id: "e",
            message: {
              author: { role: "assistant" },
              create_time: "2026-02-20T10:05:00.000Z",
              content: {
                content_type: "user_editable_context",
                user_profile: "Profile",
                user_instructions: "Instructions",
              },
            },
          },
          f: {
            id: "f",
            message: {
              author: { role: "assistant" },
              create_time: "2026-02-20T10:06:00.000Z",
              content: {
                content_type: "super_widget",
                widgets: { navlinks: [{ title: "A" }, { title: "B" }] },
              },
            },
          },
        },
      },
    ]
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify(payload), "utf8")

    const parsed = await parseChatGptConversations(root)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.messageCount).toBe(6)
    expect(parsed[0]?.messages[0]?.content).toContain("part one")
    expect(parsed[0]?.messages[1]?.content).toContain("console.log")
    expect(parsed[0]?.messages[2]?.content).toBe("recap text")
    expect(parsed[0]?.messages[3]?.role).toBe("system")
    expect(parsed[0]?.messages[4]?.content).toContain("Profile")
    expect(parsed[0]?.messages[5]?.content).toContain("A")
  })

  it("supports empty exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-chatgpt-empty-test-"))
    const exportDir = join(root, "chatgpt")
    await mkdir(exportDir, { recursive: true })
    await writeFile(join(exportDir, "conversations.json"), "[]", "utf8")

    await expect(parseChatGptConversations(root)).resolves.toEqual([])
  })

  it("rejects non-array exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-chatgpt-shape-test-"))
    const exportDir = join(root, "chatgpt")
    await mkdir(exportDir, { recursive: true })
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify({ wrong: true }), "utf8")

    await expect(parseChatGptConversations(root)).rejects.toThrow("Expected ChatGPT export to be an array")
  })

  it("handles additional content types and default fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-chatgpt-content-test-"))
    const exportDir = join(root, "chatgpt")
    await mkdir(exportDir, { recursive: true })

    const payload = [
      {
        id: "chat-more",
        title: "More content types",
        update_time: "2026-02-20T10:08:00.000Z",
        mapping: {
          a: {
            id: "a",
            message: {
              author: { role: "assistant" },
              content: { content_type: "execution_output", text: "exec output" },
            },
          },
          b: {
            id: "b",
            message: {
              author: { role: "assistant" },
              content: { content_type: "citable_code_output", output_str: "code output" },
            },
          },
          c: {
            id: "c",
            message: {
              author: { role: "assistant" },
              content: { content_type: "system_error", name: "ERR", text: "boom" },
            },
          },
          d: {
            id: "d",
            message: {
              author: { role: "assistant" },
              content: { content_type: "tether_quote", title: "Title", text: "Body", snippet: "Snippet" },
            },
          },
          e: {
            id: "e",
            message: {
              author: { role: "assistant" },
              content: { content_type: "tether_browsing_display", summary: "Summary", result: "Result" },
            },
          },
          f: {
            id: "f",
            message: {
              author: { role: "assistant" },
              content: { content_type: "super_widget", widgets: {} },
            },
          },
          g: {
            id: "g",
            message: {
              author: { role: "assistant" },
              content: { text: "plain text fallback", extra: true },
            },
          },
          h: {
            id: "h",
            message: {
              author: { role: "assistant" },
              content: { anything: "else" },
            },
          },
          i: {
            id: "i",
            message: {
              author: { role: "assistant" },
              content: { parts: [{ content_type: "image" }, { foo: "bar" }] },
              metadata: { default_model_slug: "fallback-model" },
            },
          },
          j: {
            id: "j",
            message: {
              author: { role: "assistant" },
              content: "x".repeat(17_000),
            },
          },
        },
      },
    ]
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify(payload), "utf8")

    const parsed = await parseChatGptConversations(root)
    const contents = parsed[0]?.messages.map((message) => message.content) ?? []
    expect(contents.some((value) => value.includes("exec output"))).toBeTrue()
    expect(contents.some((value) => value.includes("code output"))).toBeTrue()
    expect(contents.some((value) => value.includes("ERR: boom"))).toBeTrue()
    expect(contents.some((value) => value.includes("Title"))).toBeTrue()
    expect(contents.some((value) => value.includes("Summary"))).toBeTrue()
    expect(contents.some((value) => value.includes('"content_type":"super_widget"'))).toBeTrue()
    expect(contents.some((value) => value.includes("plain text fallback"))).toBeTrue()
    expect(contents.some((value) => value.includes('"anything":"else"'))).toBeTrue()
    expect(contents.some((value) => value.includes("[image]"))).toBeTrue()
    expect(contents.some((value) => value.endsWith("\n..."))).toBeTrue()
    expect(parsed[0]?.messages.some((message) => message.model === "fallback-model")).toBeTrue()
  })
})
