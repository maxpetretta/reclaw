import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { removeCronJob, scheduleSubagentCronJob, waitForCronSummary } from "../lib/openclaw"
import type { NormalizedConversation } from "../types"
import { writeExtractionArtifacts } from "./aggregate"
import type {
  BatchConversationRef,
  BatchExtractionResult,
  ConversationBatch,
  ExtractionArtifacts,
  ExtractionMode,
  ReclawState,
} from "./contracts"
import { buildSubagentPrompt, parseSubagentExtraction } from "./prompt"

export interface ProviderConversations {
  chatgpt: NormalizedConversation[]
  claude: NormalizedConversation[]
  grok: NormalizedConversation[]
}

export interface RunExtractionPipelineOptions {
  providerConversations: ProviderConversations
  selectedProviders: NormalizedConversation["source"][]
  mode: ExtractionMode
  model: string
  targetPath: string
  statePath: string
  batchSize?: number
  onProgress?: (message: string) => void
}

export interface ExtractionPipelineResult {
  totalBatches: number
  processedBatches: number
  skippedBatches: number
  artifacts: ExtractionArtifacts
  statePath: string
}

export function planExtractionBatches(options: {
  providerConversations: ProviderConversations
  selectedProviders: NormalizedConversation["source"][]
  batchSize?: number
}): { batches: ConversationBatch[]; conversationCount: number } {
  const batchSize = options.batchSize ?? 1
  const batches: ConversationBatch[] = []
  let conversationCount = 0

  for (const provider of options.selectedProviders) {
    const conversations = options.providerConversations[provider]
    conversationCount += conversations.length
    const providerBatches = buildProviderBatches(provider, conversations, batchSize)
    batches.push(...providerBatches)
  }

  return {
    batches,
    conversationCount,
  }
}

export async function runExtractionPipeline(options: RunExtractionPipelineOptions): Promise<ExtractionPipelineResult> {
  const planOptions: {
    providerConversations: ProviderConversations
    selectedProviders: NormalizedConversation["source"][]
    batchSize?: number
  } = {
    providerConversations: options.providerConversations,
    selectedProviders: options.selectedProviders,
  }

  if (typeof options.batchSize === "number") {
    planOptions.batchSize = options.batchSize
  }

  const plan = planExtractionBatches(planOptions)

  const runKey = buildRunKey({
    mode: options.mode,
    model: options.model,
    targetPath: options.targetPath,
    selectedProviders: options.selectedProviders,
    batches: plan.batches,
  })

  const state = await loadState({
    statePath: options.statePath,
    runKey,
    mode: options.mode,
    model: options.model,
    targetPath: options.targetPath,
  })

  const allResults: BatchExtractionResult[] = []
  let processedBatches = 0
  let skippedBatches = 0

  for (const batch of plan.batches) {
    const existing = state.completed[batch.id]
    if (existing) {
      skippedBatches += 1
      allResults.push(existing)
      continue
    }

    options.onProgress?.(
      `Processing ${batch.provider} ${batch.date} batch ${batch.index + 1}/${batch.totalForDate} (${batch.conversations.length} conversations)`,
    )

    const prompt = buildSubagentPrompt(batch, {
      mode: options.mode,
      outputPath: options.targetPath,
    })

    const scheduled = await scheduleSubagentCronJob({
      message: prompt,
      model: options.model,
      sessionName: "reclaw-extract",
      timeoutSeconds: 1800,
    })

    let summary = ""
    try {
      summary = await waitForCronSummary(scheduled.jobId, 1_900_000)
    } catch (error) {
      removeCronJob(scheduled.jobId)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Batch ${batch.id} failed: ${message}`)
    }

    const extraction = parseSubagentExtraction(summary)
    const batchResult: BatchExtractionResult = {
      batchId: batch.id,
      provider: batch.provider,
      date: batch.date,
      conversationIds: batch.conversations.map((conversation) => conversation.id),
      conversationRefs: batch.conversations.map((conversation) => ({
        id: conversation.id,
        timestamp: conversation.updatedAt ?? conversation.createdAt,
      })),
      conversationCount: batch.conversations.length,
      extraction,
    }

    allResults.push(batchResult)
    state.completed[batch.id] = batchResult
    state.updatedAt = new Date().toISOString()
    await saveState(options.statePath, state)
    processedBatches += 1
  }

  const artifacts = await writeExtractionArtifacts(allResults, {
    mode: options.mode,
    targetPath: options.targetPath,
    model: options.model,
  })

  return {
    totalBatches: plan.batches.length,
    processedBatches,
    skippedBatches,
    artifacts,
    statePath: options.statePath,
  }
}

function buildProviderBatches(
  provider: NormalizedConversation["source"],
  conversations: NormalizedConversation[],
  batchSize: number,
): ConversationBatch[] {
  const byDate = new Map<string, NormalizedConversation[]>()

  for (const conversation of conversations) {
    const date = conversation.createdAt.slice(0, 10)
    const existing = byDate.get(date)
    if (existing) {
      existing.push(conversation)
    } else {
      byDate.set(date, [conversation])
    }
  }

  const batches: ConversationBatch[] = []
  const sortedDates = [...byDate.keys()].sort((left, right) => left.localeCompare(right))

  for (const date of sortedDates) {
    const dateConversations = byDate.get(date) ?? []
    const chunks = chunkConversations(dateConversations, batchSize)

    for (const [index, chunk] of chunks.entries()) {
      const id = buildBatchId(provider, date, index, chunk)
      batches.push({
        id,
        provider,
        date,
        index,
        totalForDate: chunks.length,
        conversations: chunk,
      })
    }
  }

  return batches
}

function chunkConversations(conversations: NormalizedConversation[], size: number): NormalizedConversation[][] {
  if (size < 1) {
    return [conversations]
  }

  const chunks: NormalizedConversation[][] = []
  for (let index = 0; index < conversations.length; index += size) {
    chunks.push(conversations.slice(index, index + size))
  }

  return chunks
}

function buildBatchId(
  provider: NormalizedConversation["source"],
  date: string,
  index: number,
  conversations: NormalizedConversation[],
): string {
  const hash = createHash("sha1")
  hash.update(provider)
  hash.update(date)
  hash.update(String(index))

  for (const conversation of conversations) {
    hash.update(conversation.id)
  }

  return `${provider}-${date}-${index}-${hash.digest("hex").slice(0, 12)}`
}

function buildRunKey(input: {
  mode: ExtractionMode
  model: string
  targetPath: string
  selectedProviders: NormalizedConversation["source"][]
  batches: ConversationBatch[]
}): string {
  const hash = createHash("sha1")
  hash.update(input.mode)
  hash.update(input.model)
  hash.update(input.targetPath)
  hash.update(input.selectedProviders.join(","))
  hash.update(String(input.batches.length))

  for (const batch of input.batches) {
    hash.update(batch.id)
  }

  return hash.digest("hex")
}

async function loadState(input: {
  statePath: string
  runKey: string
  mode: ExtractionMode
  model: string
  targetPath: string
}): Promise<ReclawState> {
  let parsed: ReclawState | null = null

  try {
    const raw = await readFile(input.statePath, "utf8")
    const value = JSON.parse(raw) as unknown
    parsed = parseState(value)
  } catch {
    parsed = null
  }

  if (parsed && parsed.runKey === input.runKey) {
    return parsed
  }

  const now = new Date().toISOString()
  return {
    version: 1,
    runKey: input.runKey,
    mode: input.mode,
    model: input.model,
    targetPath: input.targetPath,
    createdAt: now,
    updatedAt: now,
    completed: {},
  }
}

async function saveState(statePath: string, state: ReclawState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8")
}

function parseState(value: unknown): ReclawState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  if (record.version !== 1) {
    return null
  }

  if (
    typeof record.runKey !== "string" ||
    typeof record.mode !== "string" ||
    typeof record.model !== "string" ||
    typeof record.targetPath !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return null
  }

  const completedRaw = record.completed
  if (!completedRaw || typeof completedRaw !== "object" || Array.isArray(completedRaw)) {
    return null
  }

  const completed: Record<string, BatchExtractionResult> = {}

  for (const [key, entry] of Object.entries(completedRaw)) {
    const parsedResult = parseBatchResult(entry)
    if (parsedResult) {
      completed[key] = parsedResult
    }
  }

  if (record.mode !== "openclaw" && record.mode !== "zettelclaw") {
    return null
  }

  return {
    version: 1,
    runKey: record.runKey,
    mode: record.mode,
    model: record.model,
    targetPath: record.targetPath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completed,
  }
}

function parseBatchResult(value: unknown): BatchExtractionResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const provider = record.provider
  if (provider !== "chatgpt" && provider !== "claude" && provider !== "grok") {
    return null
  }

  const conversationIds = Array.isArray(record.conversationIds)
    ? record.conversationIds.filter((entry): entry is string => typeof entry === "string")
    : []
  const conversationRefs: BatchConversationRef[] = []
  if (Array.isArray(record.conversationRefs)) {
    for (const entry of record.conversationRefs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue
      }

      const typedEntry = entry as Record<string, unknown>
      if (typeof typedEntry.id !== "string") {
        continue
      }

      if (typeof typedEntry.timestamp === "string") {
        conversationRefs.push({
          id: typedEntry.id,
          timestamp: typedEntry.timestamp,
        })
      } else {
        conversationRefs.push({
          id: typedEntry.id,
        })
      }
    }
  } else {
    for (const id of conversationIds) {
      conversationRefs.push({ id })
    }
  }

  const extraction = record.extraction
  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) {
    return null
  }

  const extractionRecord = extraction as Record<string, unknown>

  return {
    batchId: typeof record.batchId === "string" ? record.batchId : "",
    provider,
    date: typeof record.date === "string" ? record.date : "1970-01-01",
    conversationIds,
    conversationRefs,
    conversationCount: typeof record.conversationCount === "number" ? record.conversationCount : conversationIds.length,
    extraction: {
      summary: asString(extractionRecord.summary),
    },
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}
