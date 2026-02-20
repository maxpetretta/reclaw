import type { ConversationBatch, ExtractionMode, SubagentExtraction } from "./contracts"

const PROVIDER_LABELS: Record<ConversationBatch["provider"], string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
}

const DEFAULT_EXTRACTION: SubagentExtraction = {
  summary: "",
  interests: [],
  projects: [],
  facts: [],
  preferences: [],
  people: [],
  decisions: [],
  memory_markdown: "",
}

interface PromptOptions {
  mode: ExtractionMode
  outputPath: string
  maxPromptChars?: number
}

export function buildSubagentPrompt(batch: ConversationBatch, options: PromptOptions): string {
  const outputInstruction =
    options.mode === "openclaw"
      ? `Produce concise memory markdown content for memory/reclaw-${batch.provider}-${batch.date}.md inside ${options.outputPath}.`
      : `Produce atomic note candidates for ${options.outputPath}/Inbox with Zettelclaw-style frontmatter fields.`

  const conversationsMarkdown = serializeBatchConversations(batch, options.maxPromptChars ?? 110_000)

  return [
    `You are a subagent extracting durable memory from ${PROVIDER_LABELS[batch.provider]} conversations.`,
    "",
    "Goal:",
    "- Distill core long-term memory signals instead of preserving raw chat transcript details.",
    "- Focus on stable patterns: interests, projects, life facts, preferences/opinions, important people, major decisions.",
    "",
    "Requirements:",
    `- ${outputInstruction}`,
    "- Avoid raw transcript dumps.",
    "- Prefer concise, high-signal statements.",
    "",
    "Return STRICT JSON only (no markdown fences, no extra prose) with exactly these keys:",
    "{",
    '  "summary": "string",',
    '  "interests": ["string"],',
    '  "projects": ["string"],',
    '  "facts": ["string"],',
    '  "preferences": ["string"],',
    '  "people": ["string"],',
    '  "decisions": ["string"],',
    '  "memory_markdown": "markdown string"',
    "}",
    "",
    "Date batch metadata:",
    `- provider: ${batch.provider}`,
    `- date: ${batch.date}`,
    `- batch: ${batch.index + 1}/${batch.totalForDate}`,
    `- conversations: ${batch.conversations.length}`,
    "",
    "Conversations:",
    conversationsMarkdown,
  ].join("\n")
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
      memory_markdown: toTrimmed(rawResponse),
    }
  }

  const record = parsed as Record<string, unknown>
  const summary = toTrimmed(record.summary)
  const interests = normalizeStringArray(record.interests)
  const projects = normalizeStringArray(record.projects)
  const facts = normalizeStringArray(record.facts)
  const preferences = normalizeStringArray(record.preferences)
  const people = normalizeStringArray(record.people)
  const decisions = normalizeStringArray(record.decisions)
  const memoryMarkdown = toTrimmed(record.memory_markdown)

  return {
    summary,
    interests,
    projects,
    facts,
    preferences,
    people,
    decisions,
    memory_markdown:
      memoryMarkdown || buildFallbackMemoryMarkdown(summary, interests, projects, facts, preferences, people),
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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const output: string[] = []

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue
    }

    const normalized = entry.trim()
    if (normalized.length === 0) {
      continue
    }

    const key = normalized.toLowerCase()
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    output.push(normalized)
  }

  return output
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

function buildFallbackMemoryMarkdown(
  summary: string,
  interests: string[],
  projects: string[],
  facts: string[],
  preferences: string[],
  people: string[],
): string {
  const lines = ["## Summary", summary]

  appendList(lines, "## Interests", interests)
  appendList(lines, "## Projects", projects)
  appendList(lines, "## Facts", facts)
  appendList(lines, "## Preferences", preferences)
  appendList(lines, "## People", people)

  return lines.filter((line) => line.trim().length > 0).join("\n")
}

function appendList(lines: string[], heading: string, values: string[]): void {
  if (values.length === 0) {
    return
  }

  lines.push("", heading)
  for (const value of values) {
    lines.push(`- ${value}`)
  }
}
