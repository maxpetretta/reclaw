import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseGrokConversations } from "../grok"

describe("parseGrokConversations", () => {
  it("parses a valid Grok export from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-grok-test-"))
    const exportDir = join(root, "grok", "nested")
    await mkdir(exportDir, { recursive: true })

    const payload = {
      conversations: [
        {
          conversation: {
            id: "grok-1",
            title: "Grok planning",
            create_time: "2026-02-20T10:00:00.000Z",
            modify_time: "2026-02-20T10:10:00.000Z",
          },
          responses: [
            {
              response: {
                _id: "r1",
                sender: "human",
                message: "How should we structure v1?",
                create_time: 1_700_000_000,
                model: "grok-3",
              },
            },
            {
              response: {
                _id: "r2",
                sender: "assistant",
                message: "Start with reliability and observability.",
                create_time: 1_700_000_100,
                model: "grok-3",
              },
            },
          ],
        },
      ],
    }
    await writeFile(join(exportDir, "prod-grok-backend.json"), JSON.stringify(payload), "utf8")

    const parsed = await parseGrokConversations(root)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      id: "grok-1",
      title: "Grok planning",
      source: "grok",
      messageCount: 2,
      model: "grok-3",
    })
    expect(parsed[0]?.messages.map((entry) => entry.role)).toEqual(["human", "assistant"])
  })

  it("rejects payloads that do not match Grok schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-grok-strict-test-"))
    const exportDir = join(root, "grok")
    await mkdir(exportDir, { recursive: true })

    const invalidPayload = {
      conversations: [{ id: "wrong-shape" }],
    }
    await writeFile(join(exportDir, "prod-grok-backend.json"), JSON.stringify(invalidPayload), "utf8")

    await expect(parseGrokConversations(root)).rejects.toThrow("File does not match expected Grok export schema")
  })

  it("parses direct backend file paths and normalizes roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-grok-direct-test-"))
    const backendPath = join(root, "prod-grok-backend.json")

    const payload = {
      conversations: [
        {
          conversation: {
            id: "grok-2",
            title: "Role mapping",
          },
          responses: [
            {
              response: {
                sender: "SYSTEM",
                message: "system note",
                create_time: "2026-02-20T10:00:00.000Z",
              },
            },
            {
              response: {
                sender: "other_role",
                message: "assistant fallback",
                create_time: "2026-02-20T10:01:00.000Z",
              },
            },
          ],
        },
      ],
    }
    await writeFile(backendPath, JSON.stringify(payload), "utf8")

    const parsed = await parseGrokConversations(backendPath)
    expect(parsed[0]?.messages.map((entry) => entry.role)).toEqual(["system", "assistant"])
  })

  it("throws when no grok backend file can be found", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-grok-missing-test-"))
    await expect(parseGrokConversations(root)).rejects.toThrow("Could not find prod-grok-backend.json")
  })
})
