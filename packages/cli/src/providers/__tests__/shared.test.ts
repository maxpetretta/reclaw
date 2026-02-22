import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConversationsFilePath } from "../shared"

describe("resolveConversationsFilePath", () => {
  it("returns the input path when extractsDir is already a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-provider-shared-test-"))
    const filePath = join(root, "conversations.json")
    await writeFile(filePath, "[]", "utf8")

    await expect(resolveConversationsFilePath(filePath, "chatgpt", "ChatGPT")).resolves.toBe(filePath)
  })

  it("resolves provider-specific and root conversations files", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-provider-shared-test-"))
    const providerFile = join(root, "chatgpt", "conversations.json")
    await mkdir(join(root, "chatgpt"), { recursive: true })
    await writeFile(providerFile, "[]", "utf8")

    await expect(resolveConversationsFilePath(root, "chatgpt", "ChatGPT")).resolves.toBe(providerFile)
  })

  it("falls back to parent provider folder file", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-provider-shared-test-"))
    const child = join(root, "extracts")
    await mkdir(child, { recursive: true })
    const parentProviderFile = join(root, "claude", "conversations.json")
    await mkdir(join(root, "claude"), { recursive: true })
    await writeFile(parentProviderFile, "[]", "utf8")

    await expect(resolveConversationsFilePath(child, "claude", "Claude")).resolves.toBe(parentProviderFile)
  })

  it("throws when no candidate exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-provider-shared-test-"))
    await expect(resolveConversationsFilePath(root, "chatgpt", "ChatGPT")).rejects.toThrow(
      "Could not find ChatGPT conversations.json.",
    )
  })
})
