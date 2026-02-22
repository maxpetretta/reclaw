import { readFile } from "node:fs/promises"

import { toIsoTimestamp } from "../lib/timestamps"
import type { NormalizedConversation, NormalizedMessage } from "../types"
import { resolveConversationsFilePath } from "./shared"

interface ClaudeConversationRaw {
  uuid?: string
  name?: string | null
  created_at?: string | null
  updated_at?: string | null
  chat_messages?: ClaudeMessageRaw[]
}

interface ClaudeMessageRaw {
  uuid?: string
  text?: string | null
  content?: unknown
  sender?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export async function parseClaudeConversations(extractsDir: string): Promise<NormalizedConversation[]> {
  const filePath = await resolveClaudeConversationsPath(extractsDir)
  const rawText = await readFile(filePath, "utf8")
  const parsed = JSON.parse(rawText) as unknown

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected Claude conversations export to be an array at ${filePath}`)
  }

  if (!hasClaudeSignature(parsed)) {
    throw new Error(`File does not match expected Claude export schema: ${filePath}`)
  }

  return parsed.map((conversation) => normalizeClaudeConversation(conversation as ClaudeConversationRaw))
}

function resolveClaudeConversationsPath(extractsDir: string): Promise<string> {
  return resolveConversationsFilePath(extractsDir, "claude", "Claude")
}

function normalizeClaudeConversation(raw: ClaudeConversationRaw): NormalizedConversation {
  const messages = (raw.chat_messages ?? []).map(normalizeClaudeMessage)
  const createdAt = normalizeIso(raw.created_at) ?? messages[0]?.timestamp ?? new Date(0).toISOString()
  const updatedAt = normalizeIso(raw.updated_at)

  const conversation: NormalizedConversation = {
    id: raw.uuid ?? crypto.randomUUID(),
    title: raw.name?.trim() || "Untitled Claude conversation",
    source: "claude",
    createdAt,
    messageCount: messages.length,
    messages,
  }

  if (updatedAt) {
    conversation.updatedAt = updatedAt
  }

  return conversation
}

function normalizeClaudeMessage(raw: ClaudeMessageRaw): NormalizedMessage {
  const richContent = flattenClaudeContent(raw.content)
  const fallbackText = typeof raw.text === "string" ? raw.text : ""
  const timestamp = normalizeIso(raw.created_at) ?? normalizeIso(raw.updated_at)

  const message: NormalizedMessage = {
    role: mapClaudeRole(raw.sender ?? undefined),
    content: toLimitedString(richContent || fallbackText),
  }

  if (timestamp) {
    message.timestamp = timestamp
  }

  return message
}

function flattenClaudeContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return ""
  }

  const chunks = content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return ""
      }

      const typedPart = part as Record<string, unknown>
      const type = typeof typedPart.type === "string" ? typedPart.type : "unknown"

      switch (type) {
        case "text":
          return readString(typedPart.text)
        case "tool_use": {
          const name = readString(typedPart.name)
          const input = typedPart.input ? JSON.stringify(typedPart.input) : ""
          return [`Tool use: ${name}`.trim(), input].filter(Boolean).join("\n")
        }
        case "tool_result": {
          const baseMessage = readString(typedPart.message)
          const results = flattenClaudeToolResultContent(typedPart.content)
          return [baseMessage, results].filter(Boolean).join("\n")
        }
        case "thinking": {
          const thinking = readString(typedPart.thinking)
          if (thinking) {
            return thinking
          }

          const summaries = Array.isArray(typedPart.summaries) ? typedPart.summaries : []
          return summaries
            .map((summary) => {
              if (!summary || typeof summary !== "object") {
                return ""
              }

              return readString((summary as Record<string, unknown>).summary)
            })
            .filter(Boolean)
            .join("\n")
        }
        case "voice_note": {
          const title = readString(typedPart.title)
          const text = readString(typedPart.text)
          return [title, text].filter(Boolean).join("\n")
        }
        default: {
          const text = readString(typedPart.text)
          if (text) {
            return text
          }

          return JSON.stringify(typedPart)
        }
      }
    })
    .filter(Boolean)

  return chunks.join("\n\n")
}

function flattenClaudeToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return ""
      }

      const typedEntry = entry as Record<string, unknown>
      const title = readString(typedEntry.title)
      const text = readString(typedEntry.text)
      const url = readString(typedEntry.url)
      const line = [title, url].filter(Boolean).join(" - ")

      if (line && text) {
        return `${line}\n${text}`
      }

      if (line) {
        return line
      }

      if (text) {
        return text
      }

      return JSON.stringify(typedEntry)
    })
    .filter(Boolean)
    .join("\n\n")
}

function mapClaudeRole(sender: string | undefined): NormalizedMessage["role"] {
  if (sender === "human") {
    return "human"
  }

  if (sender === "assistant") {
    return "assistant"
  }

  return "system"
}

function normalizeIso(value: string | null | undefined): string | undefined {
  return toIsoTimestamp(value)
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function toLimitedString(value: string, limit = 16_000): string {
  if (value.length <= limit) {
    return value
  }

  return `${value.slice(0, limit)}\n...`
}

function hasClaudeSignature(value: unknown[]): boolean {
  if (value.length === 0) {
    return true
  }

  const firstRecord = value.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
  if (!firstRecord || typeof firstRecord !== "object" || Array.isArray(firstRecord)) {
    return false
  }

  const typed = firstRecord as Record<string, unknown>
  const hasKnownClaudeField =
    "chat_messages" in typed || "created_at" in typed || "updated_at" in typed || "uuid" in typed
  const hasChatGptOnlyField = "mapping" in typed || "current_node" in typed || "default_model_slug" in typed
  return hasKnownClaudeField && !hasChatGptOnlyField
}
