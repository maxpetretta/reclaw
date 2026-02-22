import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { isFilePath } from "../lib/fs"
import { toIsoTimestamp } from "../lib/timestamps"
import type { NormalizedConversation, NormalizedMessage } from "../types"

interface GrokExportRaw {
  conversations?: GrokConversationWrapperRaw[]
}

interface GrokConversationWrapperRaw {
  conversation?: {
    id?: string
    title?: string | null
    create_time?: string | null
    modify_time?: string | null
    system_prompt_name?: string | null
  }
  responses?: Array<{
    response?: GrokResponseRaw
  }>
}

interface GrokResponseRaw {
  _id?: string
  sender?: string | null
  message?: string | null
  create_time?: unknown
  model?: string | null
}

export async function parseGrokConversations(extractsDir: string): Promise<NormalizedConversation[]> {
  const backendPath = await resolveGrokBackendPath(extractsDir)
  const rawText = await readFile(backendPath, "utf8")
  const parsed = JSON.parse(rawText) as GrokExportRaw

  if (!Array.isArray(parsed.conversations)) {
    throw new Error(`Expected Grok export conversations array at ${backendPath}`)
  }

  if (!hasGrokSignature(parsed.conversations)) {
    throw new Error(`File does not match expected Grok export schema: ${backendPath}`)
  }

  return parsed.conversations.map(normalizeGrokConversation)
}

async function resolveGrokBackendPath(extractsDir: string): Promise<string> {
  if (await isFilePath(extractsDir)) {
    return extractsDir
  }

  const parentDir = dirname(extractsDir)
  const searchRoots = [join(extractsDir, "grok"), extractsDir, join(parentDir, "grok")]

  for (const root of searchRoots) {
    try {
      return await findGrokBackendPath(root)
    } catch {
      // try next root
    }
  }

  throw new Error(
    `Could not find prod-grok-backend.json. Tried searching under: ${searchRoots.map((root) => `'${root}'`).join(", ")}`,
  )
}

function normalizeGrokConversation(raw: GrokConversationWrapperRaw): NormalizedConversation {
  const rawResponses = Array.isArray(raw.responses) ? raw.responses : []
  const messages = rawResponses
    .map((item) => normalizeGrokMessage(item.response))
    .filter((message): message is NormalizedMessage => message !== null)
    .sort((a, b) => compareMaybeIsoDates(a.timestamp, b.timestamp))

  const model = messages.find((message) => typeof message.model === "string" && message.model.length > 0)?.model
  const createdAt = normalizeIso(raw.conversation?.create_time) ?? messages[0]?.timestamp ?? new Date(0).toISOString()
  const updatedAt = normalizeIso(raw.conversation?.modify_time)

  const conversation: NormalizedConversation = {
    id: raw.conversation?.id ?? crypto.randomUUID(),
    title: raw.conversation?.title?.trim() || "Untitled Grok conversation",
    source: "grok",
    createdAt,
    messageCount: messages.length,
    messages,
  }

  if (updatedAt) {
    conversation.updatedAt = updatedAt
  }

  if (model) {
    conversation.model = model
  }

  return conversation
}

function normalizeGrokMessage(raw: GrokResponseRaw | undefined): NormalizedMessage | null {
  if (!raw) {
    return null
  }

  const message: NormalizedMessage = {
    role: mapGrokRole(raw.sender ?? undefined),
    content: raw.message ?? "",
  }

  const timestamp = normalizeGrokTimestamp(raw.create_time)
  if (timestamp) {
    message.timestamp = timestamp
  }

  const model = raw.model || undefined
  if (model) {
    message.model = model
  }

  return message
}

function mapGrokRole(sender: string | undefined): NormalizedMessage["role"] {
  if (!sender) {
    return "system"
  }

  const normalizedSender = sender.toLowerCase()
  if (normalizedSender === "human") {
    return "human"
  }

  if (normalizedSender === "system") {
    return "system"
  }

  return "assistant"
}

function normalizeGrokTimestamp(value: unknown): string | undefined {
  return toIsoTimestamp(value)
}

function normalizeIso(value: string | null | undefined): string | undefined {
  return toIsoTimestamp(value)
}

function compareMaybeIsoDates(left: string | undefined, right: string | undefined): number {
  if (!(left || right)) {
    return 0
  }

  if (!left) {
    return -1
  }

  if (!right) {
    return 1
  }

  return Date.parse(left) - Date.parse(right)
}

async function findGrokBackendPath(grokDir: string): Promise<string> {
  const stack = [grokDir]

  while (stack.length > 0) {
    const currentDir = stack.pop()
    if (!currentDir) {
      continue
    }

    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }

      if (entry.isFile() && entry.name === "prod-grok-backend.json") {
        return fullPath
      }
    }
  }

  throw new Error(`Could not find prod-grok-backend.json under ${grokDir}`)
}

function hasGrokSignature(value: GrokConversationWrapperRaw[]): boolean {
  if (value.length === 0) {
    return true
  }

  const firstRecord = value.find((entry) => entry && typeof entry === "object")
  if (!firstRecord) {
    return false
  }

  const hasConversationObject = !!firstRecord.conversation && typeof firstRecord.conversation === "object"
  const hasResponsesArray = Array.isArray(firstRecord.responses)
  return hasConversationObject || hasResponsesArray
}
