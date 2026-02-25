import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { NormalizedConversation } from "../types"
import type { ConversationBatch, ExtractionMode, SubagentExtraction } from "./contracts"

const PROVIDER_LABELS: Record<NormalizedConversation["source"], string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
}

const DEFAULT_EXTRACTION: SubagentExtraction = {
  summary: "",
}

const SUMMARY_TAG_ALIASES: Record<string, string> = {
  decision: "Decision",
  decisions: "Decision",
  project: "Project",
  projects: "Project",
  fact: "Fact",
  facts: "Fact",
  preference: "Preference",
  preferences: "Preference",
  person: "Person",
  people: "Person",
  interest: "Interest",
  interests: "Interest",
  todo: "Todo",
  open: "Todo",
  next: "Todo",
  followup: "Todo",
  "follow-up": "Todo",
}

const SUMMARY_TAG_PRIORITY: Record<string, number> = {
  Decision: 0,
  Project: 1,
  Fact: 2,
  Preference: 3,
  Person: 4,
  Interest: 5,
  Todo: 6,
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
  memoryWorkspacePath: string
  maxPromptChars?: number
}

export function buildSubagentPrompt(batch: ConversationBatch, options: PromptOptions): string {
  const providerLabel = formatProviderSummary(batch.conversations)
  const outputInstruction =
    options.mode === "openclaw"
      ? `Produce one concise MOST IMPORTANT summary for these conversation(s); the main Reclaw process will build memory/${batch.date}.md and update MEMORY.md/USER.md in ${options.memoryWorkspacePath}.`
      : `Produce one concise MOST IMPORTANT summary for these conversation(s); the main Reclaw process will update Zettelclaw journal sections in ${options.outputPath} and update MEMORY.md/USER.md in ${options.memoryWorkspacePath}.`

  const conversationsMarkdown = serializeBatchConversations(batch, options.maxPromptChars ?? 110_000)
  const agentPrompt = renderPromptTemplate(loadPromptTemplate(PROMPT_FILENAMES.agent), {
    provider_label: providerLabel,
  })
  const subagentPrompt = renderPromptTemplate(loadPromptTemplate(PROMPT_FILENAMES.subagent), {
    output_instruction: outputInstruction,
    providers: providerLabel,
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
  const cleaned = stripMarkdownFences(rawResponse)
  let parsed: unknown

  try {
    parsed = JSON.parse(cleaned)
  } catch {
    parsed = parseEmbeddedJson(cleaned)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return DEFAULT_EXTRACTION
  }

  const record = parsed as Record<string, unknown>
  const summary = sanitizeSubagentSummary(toTrimmed(record.summary))

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
    `provider: ${conversation.source}`,
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

function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim()
  const fencePattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/
  const match = trimmed.match(fencePattern)
  return match?.[1]?.trim() ?? trimmed
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

function sanitizeSubagentSummary(rawSummary: string): string {
  const normalized = rawSummary.replaceAll("\r\n", "\n").trim()
  if (normalized.length === 0) {
    return ""
  }

  const candidates = splitSummaryCandidates(normalized)
  const accepted = new Map<string, { line: string; priority: number; index: number }>()
  let index = 0

  for (const candidate of candidates) {
    const prepared = normalizeSummaryCandidate(candidate)
    if (!prepared || isBlockedSummaryText(prepared)) {
      continue
    }

    const tagged = toTaggedClaim(prepared)
    if (!tagged) {
      continue
    }

    const cleanedValue = cleanClaimValue(tagged.value)
    if (cleanedValue.length === 0) {
      continue
    }

    if (isBlockedSummaryText(cleanedValue)) {
      continue
    }

    if (!hasBalancedMarkers(cleanedValue) || isLikelyTruncatedClaim(cleanedValue)) {
      continue
    }

    const line = `${tagged.tag}: ${cleanedValue}`
    const dedupeKey = line.toLowerCase()
    if (accepted.has(dedupeKey)) {
      continue
    }

    accepted.set(dedupeKey, {
      line,
      priority: SUMMARY_TAG_PRIORITY[tagged.tag] ?? 99,
      index,
    })
    index += 1
  }

  if (accepted.size === 0) {
    return ""
  }

  return [...accepted.values()]
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority
      }
      return left.index - right.index
    })
    .slice(0, 8)
    .map((entry) => entry.line)
    .join("\n")
}

function splitSummaryCandidates(summary: string): string[] {
  const lines: string[] = []
  for (const chunk of summary.split("\n")) {
    const trimmed = stripListPrefix(chunk)
    if (trimmed.length === 0) {
      continue
    }

    if (trimmed.includes(";")) {
      const parts = trimmed
        .split(";")
        .map((entry) => stripListPrefix(entry).trim())
        .filter((entry) => entry.length > 0)
      if (parts.length > 1) {
        lines.push(...parts)
        continue
      }
    }

    lines.push(trimmed)
  }

  return lines
}

function stripListPrefix(value: string): string {
  return value
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim()
}

function normalizeSummaryCandidate(value: string): string {
  return value
    .trim()
    .replace(/^\*\*([a-zA-Z-]+)\*\*\s*:\s*/u, "$1: ")
    .replace(/\s+/g, " ")
    .trim()
}

function toTaggedClaim(line: string): { tag: string; value: string } | undefined {
  const tagMatch = line.match(/^([a-zA-Z-]+)\s*:\s*(.+)$/u)
  if (tagMatch?.[1] && tagMatch[2]) {
    const canonicalTag = SUMMARY_TAG_ALIASES[tagMatch[1].trim().toLowerCase()]
    if (!canonicalTag) {
      return undefined
    }
    return {
      tag: canonicalTag,
      value: tagMatch[2].trim(),
    }
  }

  if (/^[a-zA-Z][a-zA-Z\s-]{0,48}:/u.test(line)) {
    return undefined
  }

  return {
    tag: "Fact",
    value: line.trim(),
  }
}

function cleanClaimValue(value: string): string {
  let cleaned = value
    .trim()
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

  if (cleaned.length > 220) {
    const clipped = cleaned.slice(0, 220)
    const boundary = clipped.lastIndexOf(" ")
    cleaned = (boundary > 120 ? clipped.slice(0, boundary) : clipped).trim()
  }

  return cleaned
}

function isBlockedSummaryText(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) {
    return true
  }

  if (
    /^(summary|analysis|reason|reasoning|signal distilled|key signal|memory extraction complete)\s*:/u.test(normalized)
  ) {
    return true
  }

  if (/\/users\/|\.json\b|reclaw-extract-output|\.memory-extract/u.test(normalized)) {
    return true
  }

  return /done\b|saved to|main reclaw process|hard memory filter|would i need to know this person|general knowledge|one-off|no durable user-specific|no user-specific|does not meet.*filter|filtered out/u.test(
    normalized,
  )
}

function hasBalancedMarkers(value: string): boolean {
  const starPairs = (value.match(/\*\*/g) ?? []).length
  if (starPairs % 2 !== 0) {
    return false
  }

  return (
    countChar(value, "(") === countChar(value, ")") &&
    countChar(value, "[") === countChar(value, "]") &&
    countChar(value, "{") === countChar(value, "}")
  )
}

function countChar(value: string, char: string): number {
  let count = 0
  for (const current of value) {
    if (current === char) {
      count += 1
    }
  }
  return count
}

function isLikelyTruncatedClaim(value: string): boolean {
  if (/[([{]\s*$/u.test(value)) {
    return true
  }

  if (/\b(prese|approac|decis|criter|integra|signif|durab|proces|answ|req)\s*$/iu.test(value)) {
    return true
  }

  return value.length >= 100 && /\b(and|or|to|for|with|from|in|on|at|by|vs)\s*$/iu.test(value)
}

function formatProviderSummary(conversations: ConversationBatch["conversations"]): string {
  const counts = new Map<NormalizedConversation["source"], number>()
  for (const conversation of conversations) {
    counts.set(conversation.source, (counts.get(conversation.source) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, count]) => `${PROVIDER_LABELS[provider]} (${count})`)
    .join(", ")
}
