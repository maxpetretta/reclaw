import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { OpenClawError, removeCronJob, scheduleSubagentCronJob, waitForCronSummary } from "../lib/openclaw"
import type { NormalizedConversation } from "../types"
import { writeExtractionArtifacts } from "./aggregate"
import type {
  BackupMode,
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
  backupMode?: BackupMode
  maxParallelJobs?: number
  onProgress?: (message: string) => void
}

export interface ExtractionPipelineResult {
  totalBatches: number
  processedBatches: number
  skippedBatches: number
  failedBatches: number
  failedBatchErrors: string[]
  artifacts: ExtractionArtifacts
  statePath: string
}

export function planExtractionBatches(options: {
  providerConversations: ProviderConversations
  selectedProviders: NormalizedConversation["source"][]
}): { batches: ConversationBatch[]; conversationCount: number } {
  const selectedConversations: NormalizedConversation[] = []
  let conversationCount = 0

  for (const provider of options.selectedProviders) {
    const conversations = options.providerConversations[provider]
    conversationCount += conversations.length
    selectedConversations.push(...conversations)
  }

  return {
    batches: buildDateBatches(selectedConversations),
    conversationCount,
  }
}

export async function runExtractionPipeline(options: RunExtractionPipelineOptions): Promise<ExtractionPipelineResult> {
  const plan = planExtractionBatches({
    providerConversations: options.providerConversations,
    selectedProviders: options.selectedProviders,
  })

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

  const pendingBatches: ConversationBatch[] = []
  let processedBatches = 0
  let skippedBatches = 0
  const failedBatchErrors: string[] = []

  for (const batch of plan.batches) {
    const existing = state.completed[batch.id]
    if (existing) {
      skippedBatches += 1
      continue
    }

    pendingBatches.push(batch)
  }

  if (pendingBatches.length > 0) {
    const parallelJobs = resolveParallelJobs(options.maxParallelJobs, pendingBatches.length)
    const totalPendingConversations = pendingBatches.reduce((sum, batch) => sum + batch.conversations.length, 0)

    options.onProgress?.(
      `Progress: 0/${totalPendingConversations} conversations complete (0/${pendingBatches.length} batches, 0 failed, 0 active)`,
    )

    let settledBatches = 0
    let settledConversations = 0
    let activeJobs = 0
    let nextBatchIndex = 0
    let saveChain = Promise.resolve()

    const enqueueStateSave = async (): Promise<void> => {
      saveChain = saveChain.then(() => saveState(options.statePath, state))
      await saveChain
    }

    const worker = async (): Promise<void> => {
      while (true) {
        const batchIndex = nextBatchIndex
        nextBatchIndex += 1
        if (batchIndex >= pendingBatches.length) {
          return
        }

        const batch = pendingBatches[batchIndex]
        if (!batch) {
          return
        }

        activeJobs += 1

        try {
          const batchResult = await runBatchExtraction(batch, options)
          state.completed[batch.id] = batchResult
          state.updatedAt = new Date().toISOString()
          await enqueueStateSave()
          processedBatches += 1
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failedBatchErrors.push(`Batch ${batch.id}: ${message}`)
        } finally {
          activeJobs -= 1
          settledBatches += 1
          settledConversations += batch.conversations.length
          options.onProgress?.(
            `Progress: ${settledConversations}/${totalPendingConversations} conversations complete (${settledBatches}/${pendingBatches.length} batches, ${failedBatchErrors.length} failed, ${activeJobs} active)`,
          )
        }
      }
    }

    await Promise.all(Array.from({ length: parallelJobs }, () => worker()))
    await saveChain
  }

  const allResults = plan.batches
    .map((batch) => state.completed[batch.id])
    .filter((result): result is BatchExtractionResult => result !== undefined)

  if (allResults.length === 0) {
    const detail = failedBatchErrors.length > 0 ? ` First failure: ${failedBatchErrors[0]}` : ""
    throw new Error(`Extraction produced no successful batch results.${detail}`)
  }

  const artifacts = await writeExtractionArtifacts(allResults, {
    mode: options.mode,
    targetPath: options.targetPath,
    model: options.model,
    backupMode: options.backupMode ?? "overwrite",
  })

  return {
    totalBatches: plan.batches.length,
    processedBatches,
    skippedBatches,
    failedBatches: failedBatchErrors.length,
    failedBatchErrors,
    artifacts,
    statePath: options.statePath,
  }
}

async function runBatchExtraction(
  batch: ConversationBatch,
  options: Pick<RunExtractionPipelineOptions, "mode" | "targetPath" | "model">,
): Promise<BatchExtractionResult> {
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
    if (error instanceof OpenClawError && error.details && error.details.trim().length > 0) {
      throw new Error(`Batch ${batch.id} failed: ${error.message} (${error.details})`)
    }

    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Batch ${batch.id} failed: ${message}`)
  }

  const extraction = parseSubagentExtraction(summary)
  return {
    batchId: batch.id,
    providers: batch.providers,
    date: batch.date,
    conversationIds: batch.conversations.map((conversation) => conversation.id),
    conversationRefs: batch.conversations.map((conversation) => ({
      provider: conversation.source,
      id: conversation.id,
      timestamp: conversation.updatedAt ?? conversation.createdAt,
    })),
    conversationCount: batch.conversations.length,
    extraction,
  }
}

function resolveParallelJobs(value: number | undefined, pendingCount: number): number {
  if (pendingCount <= 0) {
    return 1
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1
  }

  const normalized = Math.floor(value)
  if (normalized < 1) {
    return 1
  }

  return normalized > pendingCount ? pendingCount : normalized
}

function buildDateBatches(conversations: NormalizedConversation[]): ConversationBatch[] {
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
    const dateConversations = [...(byDate.get(date) ?? [])].sort((left, right) => {
      const leftTime = left.createdAt || ""
      const rightTime = right.createdAt || ""
      if (leftTime !== rightTime) {
        return leftTime.localeCompare(rightTime)
      }

      const leftUpdated = left.updatedAt || ""
      const rightUpdated = right.updatedAt || ""
      if (leftUpdated !== rightUpdated) {
        return leftUpdated.localeCompare(rightUpdated)
      }

      if (left.source !== right.source) {
        return left.source.localeCompare(right.source)
      }

      return left.id.localeCompare(right.id)
    })

    const providers = uniqueProviders(dateConversations)
    const id = buildBatchId(date, dateConversations)
    batches.push({
      id,
      providers,
      date,
      index: 0,
      totalForDate: 1,
      conversations: dateConversations,
    })
  }

  return batches
}

function buildBatchId(date: string, conversations: NormalizedConversation[]): string {
  const hash = createHash("sha1")
  hash.update(date)

  for (const conversation of conversations) {
    hash.update(conversation.source)
    hash.update(conversation.id)
  }

  return `date-${date}-${hash.digest("hex").slice(0, 12)}`
}

function uniqueProviders(conversations: NormalizedConversation[]): NormalizedConversation["source"][] {
  const providers = new Set<NormalizedConversation["source"]>()
  for (const conversation of conversations) {
    providers.add(conversation.source)
  }

  return [...providers].sort((left, right) => left.localeCompare(right))
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
  const legacyProvider = parseProvider(record.provider)
  const providers = parseProviders(record.providers, legacyProvider)
  if (providers.length === 0) {
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

      const provider = parseProvider(typedEntry.provider) ?? legacyProvider ?? providers[0]
      if (!provider) {
        continue
      }

      if (typeof typedEntry.timestamp === "string") {
        conversationRefs.push({
          provider,
          id: typedEntry.id,
          timestamp: typedEntry.timestamp,
        })
      } else {
        conversationRefs.push({
          provider,
          id: typedEntry.id,
        })
      }
    }
  } else {
    const fallbackProvider = legacyProvider ?? providers[0]
    if (!fallbackProvider) {
      return null
    }

    for (const id of conversationIds) {
      conversationRefs.push({ provider: fallbackProvider, id })
    }
  }

  const extraction = record.extraction
  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) {
    return null
  }

  const extractionRecord = extraction as Record<string, unknown>

  return {
    batchId: typeof record.batchId === "string" ? record.batchId : "",
    providers,
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

function parseProvider(value: unknown): NormalizedConversation["source"] | undefined {
  if (value === "chatgpt" || value === "claude" || value === "grok") {
    return value
  }

  return undefined
}

function parseProviders(
  value: unknown,
  fallback?: NormalizedConversation["source"],
): NormalizedConversation["source"][] {
  const providers: NormalizedConversation["source"][] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      const provider = parseProvider(entry)
      if (provider) {
        providers.push(provider)
      }
    }
  }

  if (providers.length === 0 && fallback) {
    providers.push(fallback)
  }

  return [...new Set(providers)]
}
