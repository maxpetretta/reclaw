import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { ConversationBatch, ExtractionMode, SubagentExtraction } from "./contracts"

const PROVIDER_LABELS: Record<ConversationBatch["provider"], string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
}

const DEFAULT_EXTRACTION: SubagentExtraction = {
  summary: "",
}

const PROMPT_FILENAMES = {
  agent: "agent.md",
  subagent: "subagent.md",
} as const

const TEMPLATE_DIR_CANDIDATES = buildTemplateDirCandidates()
const TEMPLATE_CACHE = new Map<string, string>()

interface PromptOptions {
  mode: ExtractionMode
  outputPath: string
  maxPromptChars?: number
}

export function buildSubagentPrompt(batch: ConversationBatch, options: PromptOptions): string {
  const outputInstruction =
    options.mode === "openclaw"
      ? `Produce one concise MOST IMPORTANT summary for these conversation(s); the main Reclaw process will build memory/${batch.date}.md and update MEMORY.md/USER.md in ${options.outputPath}.`
      : "Produce one concise MOST IMPORTANT summary for these conversation(s); the main Reclaw process will update Zettelclaw journal sections, inbox drafts, MEMORY.md, and USER.md."

  const conversationsMarkdown = serializeBatchConversations(batch, options.maxPromptChars ?? 110_000)
  const agentPrompt = renderPromptTemplate(loadPromptTemplate(PROMPT_FILENAMES.agent), {
    provider_label: PROVIDER_LABELS[batch.provider],
  })
  const subagentPrompt = renderPromptTemplate(loadPromptTemplate(PROMPT_FILENAMES.subagent), {
    output_instruction: outputInstruction,
    provider: batch.provider,
    date: batch.date,
    batch_index: String(batch.index + 1),
    batch_total: String(batch.totalForDate),
    conversation_count: String(batch.conversations.length),
    conversations_markdown: conversationsMarkdown,
  })

  return [agentPrompt, "", subagentPrompt].join("\n")
}

function buildTemplateDirCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return [
    resolve(moduleDir, "../../prompts"),
    resolve(moduleDir, "../prompts"),
    resolve(moduleDir, "./prompts"),
    resolve(process.cwd(), "packages/cli/prompts"),
  ]
}

function loadPromptTemplate(filename: string): string {
  const cached = TEMPLATE_CACHE.get(filename)
  if (cached) {
    return cached
  }

  for (const directory of TEMPLATE_DIR_CANDIDATES) {
    const filePath = resolve(directory, filename)
    if (!existsSync(filePath)) {
      continue
    }

    const template = readFileSync(filePath, "utf8").trimEnd()
    TEMPLATE_CACHE.set(filename, template)
    return template
  }

  throw new Error(
    `Missing prompt template '${filename}'. Searched: ${TEMPLATE_DIR_CANDIDATES.map((entry) => `${entry}/${filename}`).join(", ")}`,
  )
}

function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  const missingKeys = new Set<string>()
  const rendered = template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (fullMatch, key: string) => {
    if (!Object.hasOwn(variables, key)) {
      missingKeys.add(key)
      return fullMatch
    }

    return variables[key] ?? ""
  })

  if (missingKeys.size > 0) {
    throw new Error(
      `Prompt template is missing values for: ${[...missingKeys].sort((left, right) => left.localeCompare(right)).join(", ")}`,
    )
  }

  return rendered
}

export function parseSubagentExtraction(rawResponse: string): SubagentExtraction {
  let parsed: unknown

  try {
    parsed = JSON.parse(rawResponse)
  } catch {
    parsed = parseEmbeddedJson(rawResponse)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ...DEFAULT_EXTRACTION,
      summary: toTrimmed(rawResponse).slice(0, 500),
    }
  }

  const record = parsed as Record<string, unknown>
  const summary = toTrimmed(record.summary) || toTrimmed(rawResponse).slice(0, 500)

  return {
    summary,
  }
}

function serializeBatchConversations(batch: ConversationBatch, maxChars: number): string {
  const chunks: string[] = []
  let consumed = 0

  for (const conversation of batch.conversations) {
    const chunk = serializeConversation(conversation)
    if (consumed + chunk.length > maxChars) {
      chunks.push(
        `... prompt truncated after ${chunks.length} conversations due to size budget (${maxChars.toLocaleString()} chars).`,
      )
      break
    }

    chunks.push(chunk)
    consumed += chunk.length
  }

  return chunks.join("\n\n")
}

function serializeConversation(conversation: ConversationBatch["conversations"][number]): string {
  const messages = sampleMessages(conversation.messages, 28)

  const serializedMessages = messages
    .map((message, index) => {
      const timestamp = message.timestamp ? ` @ ${message.timestamp}` : ""
      const model = message.model ? ` (${message.model})` : ""
      const content = clipText(message.content, 900)
      return `${index + 1}. [${message.role}${model}${timestamp}] ${content}`
    })
    .join("\n")

  return [
    `### ${conversation.title}`,
    `id: ${conversation.id}`,
    `created: ${conversation.createdAt}`,
    `messages: ${conversation.messageCount}`,
    serializedMessages,
  ].join("\n")
}

function sampleMessages<T>(messages: T[], limit: number): T[] {
  if (messages.length <= limit) {
    return messages
  }

  const headCount = Math.ceil(limit / 2)
  const tailCount = Math.floor(limit / 2)
  const head = messages.slice(0, headCount)
  const tail = messages.slice(-tailCount)
  return [...head, ...tail]
}

function toTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value
  }

  return `${value.slice(0, limit)} ...`
}

function parseEmbeddedJson(raw: string): unknown {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")

  if (start === -1 || end === -1 || end <= start) {
    return undefined
  }

  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown
  } catch {
    return undefined
  }
}
