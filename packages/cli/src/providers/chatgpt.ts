import { access, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { NormalizedConversation, NormalizedMessage } from "../types"

interface ChatGptNodeRaw {
  id?: string
  parent?: string | null
  message?: ChatGptMessageRaw | null
}

interface ChatGptConversationRaw {
  id?: string
  conversation_id?: string
  title?: string | null
  create_time?: number | string | null
  update_time?: number | string | null
  current_node?: string | null
  default_model_slug?: string | null
  mapping?: Record<string, ChatGptNodeRaw>
}

interface ChatGptMessageRaw {
  id?: string
  author?: {
    role?: string
  }
  create_time?: number | string | null
  update_time?: number | string | null
  content?: unknown
  metadata?: {
    model_slug?: string
    default_model_slug?: string
  }
}

export async function parseChatGptConversations(extractsDir: string): Promise<NormalizedConversation[]> {
  const filePath = await resolveChatGptFilePath(extractsDir)
  const rawText = await readFile(filePath, "utf8")
  const parsed = JSON.parse(rawText) as unknown

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ChatGPT export to be an array at ${filePath}`)
  }

  return parsed.map((conversation) => normalizeChatGptConversation(conversation as ChatGptConversationRaw))
}

async function resolveChatGptFilePath(extractsDir: string): Promise<string> {
  if (await isFile(extractsDir)) {
    return extractsDir
  }

  const parentDir = dirname(extractsDir)
  const candidates = [
    join(extractsDir, "chatgpt", "conversations.json"),
    join(extractsDir, "conversations.json"),
    join(parentDir, "chatgpt", "conversations.json"),
  ]

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Could not find ChatGPT conversations.json. Tried: ${candidates.map((candidate) => `'${candidate}'`).join(", ")}`,
  )
}

function normalizeChatGptConversation(raw: ChatGptConversationRaw): NormalizedConversation {
  const branchNodes = getCurrentBranchNodes(raw.mapping, raw.current_node)
  const messages: NormalizedMessage[] = []
  for (const node of branchNodes) {
    const normalizedMessage = normalizeChatGptMessage(node.message, raw.default_model_slug ?? undefined)
    if (normalizedMessage) {
      messages.push(normalizedMessage)
    }
  }

  const createdAt = toIsoString(raw.create_time) ?? messages[0]?.timestamp ?? toIsoString(raw.update_time)
  const updatedAt = toIsoString(raw.update_time)
  const model = raw.default_model_slug ?? undefined

  const conversation: NormalizedConversation = {
    id: raw.id ?? raw.conversation_id ?? crypto.randomUUID(),
    title: raw.title?.trim() || "Untitled ChatGPT conversation",
    source: "chatgpt",
    createdAt: createdAt ?? new Date(0).toISOString(),
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

function getCurrentBranchNodes(
  mapping: Record<string, ChatGptNodeRaw> | undefined,
  currentNodeId: string | null | undefined,
) {
  if (!mapping) {
    return []
  }

  if (currentNodeId && mapping[currentNodeId]) {
    const nodes: ChatGptNodeRaw[] = []
    const visited = new Set<string>()
    let nodeId: string | null | undefined = currentNodeId

    while (nodeId && !visited.has(nodeId) && mapping[nodeId]) {
      visited.add(nodeId)
      const node: ChatGptNodeRaw | undefined = mapping[nodeId]
      if (!node) {
        break
      }

      nodes.push(node)
      nodeId = node.parent
    }

    nodes.reverse()
    return nodes
  }

  return Object.values(mapping).sort((a, b) => {
    const aTime = toMilliseconds(a.message?.create_time)
    const bTime = toMilliseconds(b.message?.create_time)
    return aTime - bTime
  })
}

function normalizeChatGptMessage(raw: ChatGptMessageRaw | null | undefined, fallbackModel: string | undefined) {
  if (!raw) {
    return null
  }

  const content = toLimitedString(extractChatGptContent(raw.content))
  const message: NormalizedMessage = {
    role: mapChatGptRole(raw.author?.role),
    content,
  }

  const timestamp = toIsoString(raw.create_time) ?? toIsoString(raw.update_time)
  if (timestamp) {
    message.timestamp = timestamp
  }

  const model = raw.metadata?.model_slug ?? raw.metadata?.default_model_slug ?? fallbackModel
  if (model) {
    message.model = model
  }

  return message
}

function extractChatGptContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }

  if (!content || typeof content !== "object") {
    return ""
  }

  const payload = content as Record<string, unknown>
  const contentType = typeof payload.content_type === "string" ? payload.content_type : "unknown"

  if (Array.isArray(payload.parts)) {
    const joinedParts = payload.parts.map(stringifyPart).filter(Boolean).join("\n")
    if (joinedParts) {
      return joinedParts
    }
  }

  switch (contentType) {
    case "code":
    case "execution_output":
      return readString(payload.text)
    case "reasoning_recap":
      return readString(payload.content)
    case "thoughts": {
      const thoughts = Array.isArray(payload.thoughts) ? payload.thoughts : []
      const thoughtText = thoughts
        .map((thought) => {
          if (!thought || typeof thought !== "object") {
            return ""
          }

          const typedThought = thought as Record<string, unknown>
          const contentText = readString(typedThought.content)
          if (contentText) {
            return contentText
          }

          return readString(typedThought.summary)
        })
        .filter(Boolean)
        .join("\n")

      if (thoughtText) {
        return thoughtText
      }

      return JSON.stringify(payload)
    }
    case "user_editable_context": {
      const profile = readString(payload.user_profile)
      const instructions = readString(payload.user_instructions)
      return [profile, instructions].filter(Boolean).join("\n\n")
    }
    case "citable_code_output":
      return readString(payload.output_str)
    case "system_error":
      return [readString(payload.name), readString(payload.text)].filter(Boolean).join(": ")
    case "tether_quote":
    case "sonic_webpage":
      return [readString(payload.title), readString(payload.text), readString(payload.snippet)]
        .filter(Boolean)
        .join("\n")
    case "tether_browsing_display":
      return [readString(payload.summary), readString(payload.result)].filter(Boolean).join("\n")
    case "super_widget": {
      const widgets = payload.widgets
      if (widgets && typeof widgets === "object") {
        const typedWidgets = widgets as Record<string, unknown>
        const navlinks = Array.isArray(typedWidgets.navlinks) ? typedWidgets.navlinks : []
        const linkLines = navlinks
          .map((item) => {
            if (!item || typeof item !== "object") {
              return ""
            }

            const typedItem = item as Record<string, unknown>
            return readString(typedItem.title)
          })
          .filter(Boolean)
          .join("\n")

        if (linkLines) {
          return linkLines
        }
      }

      return JSON.stringify(payload)
    }
    default: {
      const directText = readString(payload.text)
      if (directText) {
        return directText
      }

      return JSON.stringify(payload)
    }
  }
}

function stringifyPart(part: unknown): string {
  if (typeof part === "string") {
    return part
  }

  if (!part || typeof part !== "object") {
    return ""
  }

  const typedPart = part as Record<string, unknown>
  const text = readString(typedPart.text)
  if (text) {
    return text
  }

  const title = readString(typedPart.title)
  const url = readString(typedPart.url)
  if (title && url) {
    return `${title} (${url})`
  }

  const contentType = readString(typedPart.content_type) || readString(typedPart.type)
  if (contentType) {
    return `[${contentType}]`
  }

  return JSON.stringify(typedPart)
}

function mapChatGptRole(role: string | undefined): NormalizedMessage["role"] {
  if (role === "user") {
    return "human"
  }

  if (role === "assistant") {
    return "assistant"
  }

  return "system"
}

function toIsoString(value: number | string | null | undefined): string | undefined {
  if (typeof value === "number") {
    return new Date(Math.trunc(value * 1000)).toISOString()
  }

  if (typeof value === "string") {
    const asNumber = Number(value)
    if (!Number.isNaN(asNumber) && value.trim() !== "") {
      return new Date(Math.trunc(asNumber * 1000)).toISOString()
    }

    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString()
    }
  }

  return undefined
}

function toMilliseconds(value: number | string | null | undefined): number {
  const iso = toIsoString(value)
  if (!iso) {
    return Number.NEGATIVE_INFINITY
  }

  return Date.parse(iso)
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
