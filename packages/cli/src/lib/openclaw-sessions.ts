import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { NormalizedConversation, NormalizedMessage } from "../types"
import { parseJson as parseJsonWithError } from "./json"
import { runOpenClaw } from "./openclaw"

interface OpenClawStatusResponse {
  agents?: {
    defaultId?: unknown
    agents?: unknown
  }
}

interface OpenClawAgentStatus {
  id: string
  workspaceDir: string
  sessionsPath: string
}

interface SessionStoreEntry {
  sessionId: string
  sessionFile: string
  updatedAt: number
  chatType: "direct"
  model?: string
  origin?: Record<string, unknown>
  reclawLegacy?: Record<string, unknown>
}

type SessionStore = Record<string, SessionStoreEntry>

export type LegacySessionMode = "on" | "off" | "required"

export interface LegacyProviderImportInput {
  provider: NormalizedConversation["source"]
  sourcePath: string
  conversations: NormalizedConversation[]
}

export interface ImportLegacySessionsOptions {
  workspacePath: string
  providers: LegacyProviderImportInput[]
}

export interface LegacySessionImportError {
  provider: NormalizedConversation["source"]
  conversationId: string
  conversationTitle: string
  reason: string
}

export interface LegacySessionImportResult {
  agentId: string
  sessionStorePath: string
  attempted: number
  imported: number
  updated: number
  skipped: number
  failed: number
  errors: LegacySessionImportError[]
}

interface SessionStoreTarget {
  agentId: string
  sessionsPath: string
}

interface SessionIdentity {
  sessionKey: string
  sessionId: string
  sessionFile: string
}

export async function importLegacySessionsToOpenClawHistory(
  options: ImportLegacySessionsOptions,
): Promise<LegacySessionImportResult> {
  const target = resolveSessionStoreTarget(options.workspacePath)
  const sessionsDir = dirname(target.sessionsPath)
  await mkdir(sessionsDir, { recursive: true })

  const store = await readSessionStore(target.sessionsPath)

  let attempted = 0
  let imported = 0
  let updated = 0
  let skipped = 0
  let failed = 0
  const errors: LegacySessionImportError[] = []

  for (const providerInput of options.providers) {
    for (const conversation of providerInput.conversations) {
      attempted += 1
      try {
        const importResult = await importSingleConversation({
          agentId: target.agentId,
          sessionsDir,
          store,
          provider: providerInput.provider,
          sourcePath: providerInput.sourcePath,
          workspacePath: options.workspacePath,
          conversation,
        })

        if (importResult === "imported") {
          imported += 1
          continue
        }

        if (importResult === "updated") {
          updated += 1
          continue
        }

        skipped += 1
      } catch (error) {
        failed += 1
        errors.push({
          provider: providerInput.provider,
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  await writeSessionStore(target.sessionsPath, store)

  return {
    agentId: target.agentId,
    sessionStorePath: target.sessionsPath,
    attempted,
    imported,
    updated,
    skipped,
    failed,
    errors,
  }
}

function resolveSessionStoreTarget(workspacePath: string): SessionStoreTarget {
  const status = parseJson<OpenClawStatusResponse>(runOpenClaw(["status", "--json"]).stdout)
  const agentsSection = status.agents
  const agents = parseAgentStatuses(agentsSection?.agents)

  if (agents.length === 0) {
    throw new Error("OpenClaw status did not include any registered agents.")
  }

  const resolvedWorkspacePath = resolve(workspacePath)
  const directMatch = agents.find((agent) => resolve(agent.workspaceDir) === resolvedWorkspacePath)
  if (directMatch) {
    return {
      agentId: directMatch.id,
      sessionsPath: directMatch.sessionsPath,
    }
  }

  const knownWorkspaces = agents.map((agent) => `${agent.id}:${agent.workspaceDir}`).join(", ")
  throw new Error(
    `Could not map workspace '${workspacePath}' to an OpenClaw agent sessions store. Known agents: ${knownWorkspaces}`,
  )
}

function parseAgentStatuses(value: unknown): OpenClawAgentStatus[] {
  if (!Array.isArray(value)) {
    return []
  }

  const output: OpenClawAgentStatus[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue
    }

    const record = entry as Record<string, unknown>
    const id = asString(record.id)
    const workspaceDir = asString(record.workspaceDir)
    const sessionsPath = asString(record.sessionsPath)
    if (id && workspaceDir && sessionsPath) {
      output.push({
        id,
        workspaceDir,
        sessionsPath,
      })
    }
  }

  return output
}

async function readSessionStore(sessionsPath: string): Promise<SessionStore> {
  try {
    const raw = await readFile(sessionsPath, "utf8")
    const parsed = parseJson<unknown>(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid OpenClaw sessions store at ${sessionsPath}: expected object.`)
    }

    return parsed as SessionStore
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException
    if (maybeNodeError.code === "ENOENT") {
      return {}
    }

    throw error
  }
}

async function writeSessionStore(sessionsPath: string, store: SessionStore): Promise<void> {
  const orderedEntries = Object.entries(store).sort(([left], [right]) => left.localeCompare(right))
  const ordered: SessionStore = {}
  for (const [key, value] of orderedEntries) {
    ordered[key] = value
  }

  await writeFile(sessionsPath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8")
}

async function importSingleConversation(options: {
  agentId: string
  sessionsDir: string
  store: SessionStore
  provider: NormalizedConversation["source"]
  sourcePath: string
  workspacePath: string
  conversation: NormalizedConversation
}): Promise<"imported" | "updated" | "skipped"> {
  const { provider, sourcePath, conversation } = options
  const sourcePathResolved = resolve(sourcePath)
  const contentChecksum = buildConversationChecksum(conversation)
  const sessionIdentity = buildSessionIdentity({
    agentId: options.agentId,
    provider,
    sourcePath: sourcePathResolved,
    conversationId: conversation.id,
    sessionsDir: options.sessionsDir,
  })

  const existing = options.store[sessionIdentity.sessionKey]
  const existingLegacy = existing?.reclawLegacy
  const existingChecksum =
    existingLegacy && typeof existingLegacy === "object"
      ? asString((existingLegacy as Record<string, unknown>).contentChecksum)
      : ""

  if (existing && existingChecksum === contentChecksum) {
    return "skipped"
  }

  const importedAtIso = new Date().toISOString()
  const transcript = buildTranscript({
    conversation,
    workspacePath: options.workspacePath,
    provider,
    sourcePath: sourcePathResolved,
    contentChecksum,
    sessionId: sessionIdentity.sessionId,
    importedAtIso,
  })

  await writeFile(sessionIdentity.sessionFile, transcript, "utf8")

  const updatedAtMs =
    toTimestampMs(conversation.updatedAt) ??
    toTimestampMs(lastConversationMessageTimestamp(conversation)) ??
    toTimestampMs(conversation.createdAt) ??
    Date.now()

  const entry: SessionStoreEntry = {
    sessionId: sessionIdentity.sessionId,
    sessionFile: sessionIdentity.sessionFile,
    updatedAt: updatedAtMs,
    chatType: "direct",
    origin: {
      label: "reclaw-legacy-import",
      source: "reclaw",
      legacy: true,
    },
    reclawLegacy: {
      legacy: true,
      source: true,
      sourceProvider: provider,
      sourcePath: sourcePathResolved,
      sourceConversationId: conversation.id,
      sourceConversationTitle: conversation.title,
      sourceConversationCreatedAt: conversation.createdAt,
      sourceConversationUpdatedAt: conversation.updatedAt ?? null,
      importedAt: importedAtIso,
      contentChecksum,
    },
  }

  if (conversation.model) {
    entry.model = conversation.model
  }

  options.store[sessionIdentity.sessionKey] = entry
  return existing ? "updated" : "imported"
}

function buildTranscript(options: {
  conversation: NormalizedConversation
  workspacePath: string
  provider: NormalizedConversation["source"]
  sourcePath: string
  contentChecksum: string
  sessionId: string
  importedAtIso: string
}): string {
  const { conversation } = options
  const conversationTimestamp = normalizeIsoTimestamp(conversation.createdAt, options.importedAtIso)

  const lines: Record<string, unknown>[] = []

  lines.push({
    type: "session",
    version: 3,
    id: options.sessionId,
    timestamp: conversationTimestamp,
    cwd: resolve(options.workspacePath),
  })

  let parentId: string | null = null

  const markerId = randomLineId()
  lines.push({
    type: "custom",
    customType: "reclaw:legacy-source",
    data: {
      legacy: true,
      source: true,
      provider: options.provider,
      sourcePath: options.sourcePath,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      conversationCreatedAt: conversation.createdAt,
      conversationUpdatedAt: conversation.updatedAt ?? null,
      messageCount: conversation.messageCount,
      importedAt: options.importedAtIso,
      checksum: options.contentChecksum,
    },
    id: markerId,
    parentId,
    timestamp: conversationTimestamp,
  })
  parentId = markerId

  for (const [index, message] of conversation.messages.entries()) {
    const fallbackTimestamp = new Date(Date.parse(conversationTimestamp) + index).toISOString()
    const messageTimestamp = normalizeIsoTimestamp(message.timestamp, fallbackTimestamp)
    const messageId = randomLineId()

    lines.push(
      buildMessageEvent({
        id: messageId,
        parentId,
        timestamp: messageTimestamp,
        message,
      }),
    )

    parentId = messageId
  }

  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
}

function buildMessageEvent(options: {
  id: string
  parentId: string | null
  timestamp: string
  message: NormalizedMessage
}): Record<string, unknown> {
  const contentText = typeof options.message.content === "string" ? options.message.content : ""
  const messageTimestampMs = toTimestampMs(options.message.timestamp) ?? toTimestampMs(options.timestamp)

  const messagePayload: Record<string, unknown> = {
    role: mapMessageRole(options.message.role),
    content: [{ type: "text", text: contentText }],
  }

  if (messageTimestampMs !== undefined) {
    messagePayload.timestamp = messageTimestampMs
  }

  return {
    type: "message",
    id: options.id,
    parentId: options.parentId,
    timestamp: options.timestamp,
    message: messagePayload,
  }
}

function mapMessageRole(role: NormalizedMessage["role"]): "user" | "assistant" | "system" {
  switch (role) {
    case "human":
      return "user"
    case "assistant":
      return "assistant"
    default:
      return "system"
  }
}

function buildSessionIdentity(options: {
  agentId: string
  provider: NormalizedConversation["source"]
  sourcePath: string
  conversationId: string
  sessionsDir: string
}): SessionIdentity {
  const identitySeed = `${options.agentId}\n${options.provider}\n${options.sourcePath}\n${options.conversationId}`
  const digest = createHash("sha256").update(identitySeed).digest("hex")
  const sessionId = toUuidV4Like(digest.slice(0, 32))
  const sessionKey = `agent:${options.agentId}:legacy:reclaw:${options.provider}:${digest.slice(0, 16)}`
  const sessionFile = join(options.sessionsDir, `${sessionId}.jsonl`)

  return {
    sessionKey,
    sessionId,
    sessionFile,
  }
}

function buildConversationChecksum(conversation: NormalizedConversation): string {
  const chunks = [
    conversation.source,
    conversation.id,
    conversation.title,
    conversation.createdAt,
    conversation.updatedAt ?? "",
    conversation.model ?? "",
    ...conversation.messages.map(
      (message) => `${message.role}|${message.timestamp ?? ""}|${message.model ?? ""}|${message.content}`,
    ),
  ]

  return createHash("sha256").update(chunks.join("\n")).digest("hex")
}

function parseJson<T>(value: string): T {
  return parseJsonWithError(value, (message) => new Error(`Could not parse JSON: ${message}`))
}

function toUuidV4Like(hex32: string): string {
  const clean = hex32
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
    .padEnd(32, "0")
    .slice(0, 32)
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20, 32)}`
}

function randomLineId(): string {
  return randomBytes(4).toString("hex")
}

function normalizeIsoTimestamp(candidate: string | undefined, fallback: string): string {
  const parsed = toTimestampMs(candidate)
  if (parsed === undefined) {
    return fallback
  }

  return new Date(parsed).toISOString()
}

function toTimestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return undefined
  }

  return parsed
}

function lastConversationMessageTimestamp(conversation: NormalizedConversation): string | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const timestamp = conversation.messages[index]?.timestamp
    if (timestamp) {
      return timestamp
    }
  }

  return undefined
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}
