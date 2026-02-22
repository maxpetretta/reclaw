import { beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { enqueueSpawnResult, getSpawnCalls, resetSpawnMock } from "../../test/spawn-mock"

let inputDiscovery: typeof import("../input-discovery")

describe("prepareInputSources", () => {
  beforeAll(async () => {
    inputDiscovery = await import("../input-discovery")
  })

  beforeEach(() => {
    resetSpawnMock()
  })

  it("detects provider from direct conversations.json file", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    const filePath = join(root, "conversations.json")
    await writeFile(filePath, JSON.stringify([{ mapping: {}, current_node: "a" }]), "utf8")

    const prepared = await inputDiscovery.prepareInputSources(filePath)

    expect(prepared.detectedProviders).toEqual(["chatgpt"])
    expect(prepared.parseCandidatesByProvider.chatgpt).toEqual([filePath])
    expect(prepared.parseCandidatesByProvider.claude).toEqual([filePath])
    expect(prepared.parseCandidatesByProvider.grok).toEqual([filePath])
    expect(prepared.extractedArchiveCount).toBe(0)
    expect(prepared.warnings).toEqual([])
  })

  it("detects providers from directory layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    await mkdir(join(root, "claude"), { recursive: true })
    await mkdir(join(root, "grok"), { recursive: true })
    await writeFile(
      join(root, "claude", "conversations.json"),
      JSON.stringify([{ uuid: "c1", chat_messages: [] }]),
      "utf8",
    )
    await writeFile(join(root, "grok", "prod-grok-backend.json"), "{}", "utf8")

    const prepared = await inputDiscovery.prepareInputSources(root)
    expect(prepared.detectedProviders).toEqual(["claude", "grok"])
    expect(prepared.parseCandidatesByProvider.claude).toEqual([root])
    expect(prepared.parseCandidatesByProvider.grok).toEqual([root])
  })

  it("extracts supported providers from a zip file", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    const zipPath = join(root, "chat export.zip")
    await writeFile(zipPath, "placeholder", "utf8")

    enqueueSpawnResult({
      status: 0,
      stdout: "export/chatgpt/conversations.json\nexport/chatgpt/chat.html\n",
      stderr: "",
    })
    enqueueSpawnResult({
      status: 0,
      stdout: "",
      stderr: "",
    })

    const prepared = await inputDiscovery.prepareInputSources(zipPath)
    expect(prepared.detectedProviders).toEqual(["chatgpt"])
    expect(prepared.extractedArchiveCount).toBe(1)
    expect(prepared.extractionRootPath).toBeString()
    expect(prepared.parseCandidatesByProvider.chatgpt[0]).not.toBe(zipPath)
    expect(getSpawnCalls().map((call) => call.args.slice(0, 2))).toEqual([
      ["-Z", "-1"],
      ["-oq", zipPath],
    ])
  })

  it("emits warnings for unsafe zip entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    const zipPath = join(root, "archive.zip")
    await writeFile(zipPath, "placeholder", "utf8")

    enqueueSpawnResult({
      status: 0,
      stdout: "../evil.txt\n",
      stderr: "",
    })

    const prepared = await inputDiscovery.prepareInputSources(root)
    expect(prepared.extractedArchiveCount).toBe(0)
    expect(prepared.warnings.join("\n")).toContain("unsafe path")
  })

  it("emits warnings when unzip is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    const zipPath = join(root, "archive.zip")
    await writeFile(zipPath, "placeholder", "utf8")

    const noUnzipError = Object.assign(new Error("unzip missing"), { code: "ENOENT" })
    enqueueSpawnResult({ error: noUnzipError })

    const prepared = await inputDiscovery.prepareInputSources(zipPath)
    expect(prepared.extractedArchiveCount).toBe(0)
    expect(prepared.warnings.join("\n")).toContain("`unzip` was not found on PATH")
  })

  it("records extraction warnings when zip unpack fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    const zipPath = join(root, "broken.zip")
    await writeFile(zipPath, "placeholder", "utf8")

    enqueueSpawnResult({
      status: 0,
      stdout: "export/chatgpt/conversations.json\nexport/chatgpt/chat.html\n",
      stderr: "",
    })
    enqueueSpawnResult({
      status: 2,
      stdout: "",
      stderr: "inflate failed",
    })

    const prepared = await inputDiscovery.prepareInputSources(zipPath)
    expect(prepared.extractedArchiveCount).toBe(0)
    expect(prepared.warnings.join("\n")).toContain("Could not extract zip archive")
  })

  it("skips extracting archives that only contain already-detected providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    await mkdir(join(root, "chatgpt"), { recursive: true })
    await writeFile(join(root, "chatgpt", "conversations.json"), JSON.stringify([{ mapping: {} }]), "utf8")
    const zipPath = join(root, "chatgpt-only.zip")
    await writeFile(zipPath, "placeholder", "utf8")

    enqueueSpawnResult({
      status: 0,
      stdout: "export/chatgpt/conversations.json\nexport/chatgpt/chat.html\n",
      stderr: "",
    })

    const prepared = await inputDiscovery.prepareInputSources(root)
    expect(prepared.detectedProviders).toContain("chatgpt")
    expect(prepared.extractedArchiveCount).toBe(0)
  })

  it("extracts archive providers missing from direct directory detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    await mkdir(join(root, "chatgpt"), { recursive: true })
    await writeFile(join(root, "chatgpt", "conversations.json"), JSON.stringify([{ mapping: {} }]), "utf8")
    const zipPath = join(root, "grok.zip")
    await writeFile(zipPath, "placeholder", "utf8")

    enqueueSpawnResult({
      status: 0,
      stdout: "export/grok/prod-grok-backend.json\n",
      stderr: "",
    })
    enqueueSpawnResult({
      status: 0,
      stdout: "",
      stderr: "",
    })

    const prepared = await inputDiscovery.prepareInputSources(root)
    expect(prepared.detectedProviders).toEqual(["chatgpt", "grok"])
    expect(prepared.extractedArchiveCount).toBe(1)
    expect(prepared.parseCandidatesByProvider.grok[0]).not.toBe(root)
  })

  it("detects grok exports when the root directory name contains grok", async () => {
    const parent = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    const root = join(parent, "my-grok-export")
    await mkdir(join(root, "nested"), { recursive: true })
    await writeFile(join(root, "nested", "prod-grok-backend.json"), "{}", "utf8")

    const prepared = await inputDiscovery.prepareInputSources(root)
    expect(prepared.detectedProviders).toEqual(["grok"])
  })

  it("falls back to input path when conversations.json cannot be inferred", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    const filePath = join(root, "conversations.json")
    await writeFile(filePath, JSON.stringify([{ unknown: true }]), "utf8")

    const prepared = await inputDiscovery.prepareInputSources(filePath)
    expect(prepared.detectedProviders).toEqual([])
    expect(prepared.parseCandidatesByProvider.chatgpt).toEqual([filePath])
    expect(prepared.parseCandidatesByProvider.claude).toEqual([filePath])
    expect(prepared.parseCandidatesByProvider.grok).toEqual([filePath])
  })

  it("records inspection warnings for non-ENOENT unzip errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-input-discovery-test-"))
    const zipPath = join(root, "archive.zip")
    await writeFile(zipPath, "placeholder", "utf8")

    const unzipError = Object.assign(new Error("permission denied"), { code: "EACCES" })
    enqueueSpawnResult({ error: unzipError })

    const prepared = await inputDiscovery.prepareInputSources(zipPath)
    expect(prepared.warnings.join("\n")).toContain("permission denied")
  })
})
