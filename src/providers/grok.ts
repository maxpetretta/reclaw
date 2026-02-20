import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

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
  const providerDir = join(extractsDir, "grok")
  const backendPath = await findGrokBackendPath(providerDir)
  const rawText = await readFile(backendPath, "utf8")
  const parsed = JSON.parse(rawText) as GrokExportRaw

  if (!Array.isArray(parsed.conversations)) {
    throw new Error(`Expected Grok export conversations array at ${backendPath}`)
  }

  return parsed.conversations.map(normalizeGrokConversation)
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
  if (!value) {
    return undefined
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString()
    }

    const numeric = Number(value)
    if (!Number.isNaN(numeric)) {
      return new Date(numeric).toISOString()
    }

    return undefined
  }

  if (typeof value === "number") {
    return new Date(value).toISOString()
  }

  if (typeof value === "object") {
    const typedValue = value as {
      $date?: string | { $numberLong?: string }
      $numberLong?: string
    }

    if (typeof typedValue.$numberLong === "string") {
      const numeric = Number(typedValue.$numberLong)
      if (!Number.isNaN(numeric)) {
        return new Date(numeric).toISOString()
      }
    }

    if (typeof typedValue.$date === "string") {
      const parsed = Date.parse(typedValue.$date)
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toISOString()
      }
    }

    if (typeof typedValue.$date === "object" && typeof typedValue.$date.$numberLong === "string") {
      const numeric = Number(typedValue.$date.$numberLong)
      if (!Number.isNaN(numeric)) {
        return new Date(numeric).toISOString()
      }
    }
  }

  return undefined
}

function normalizeIso(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return undefined
  }

  return new Date(parsed).toISOString()
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
