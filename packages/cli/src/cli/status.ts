import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { type Provider, providerLabels } from "./constants"

interface StatusTimestamp {
  iso: string
  local: string
}

interface StateFileStatus {
  path: string
  exists: boolean
  sizeBytes?: number
  modifiedAt?: StatusTimestamp
  parseError?: string
}

interface StatusMetrics {
  completedBatches: number
  completedConversations: number
  providerConversationCounts: Record<Provider, number>
  providerBatchCounts: Record<Provider, number>
  earliestBatchDate?: string
  latestBatchDate?: string
}

interface StatusPaths {
  targetPath: string
  targetPathExists: boolean
  outputDirPath: string
  outputDirExists: boolean
}

interface StateSnapshot {
  version: 1
  runKey: string
  mode: "openclaw" | "zettelclaw"
  model: string
  createdAt: StatusTimestamp
  updatedAt: StatusTimestamp
  paths: StatusPaths
  metrics: StatusMetrics
}

export interface StatusReport {
  checkedAt: StatusTimestamp
  stateFile: StateFileStatus
  state?: StateSnapshot
  notes: string[]
}

export async function printStatus(options: { statePath: string; json?: boolean }): Promise<void> {
  const report = await buildStatusReport(options.statePath)
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printHumanStatus(report)
}

export async function buildStatusReport(statePath: string, now: Date = new Date()): Promise<StatusReport> {
  const checkedAt = toStatusTimestamp(now)
  const notes: string[] = []
  const stateFileStatus: StateFileStatus = {
    path: statePath,
    exists: false,
  }

  try {
    const fileStats = await stat(statePath)
    stateFileStatus.exists = true
    stateFileStatus.sizeBytes = fileStats.size
    stateFileStatus.modifiedAt = toStatusTimestamp(fileStats.mtime)
  } catch (error) {
    if (!isMissingPathError(error)) {
      notes.push(`Could not stat state file: ${errorMessage(error)}`)
    }
  }

  if (!stateFileStatus.exists) {
    notes.push("No state file found yet. Run reclaw extraction once to initialize resumable state.")
    return {
      checkedAt,
      stateFile: stateFileStatus,
      notes,
    }
  }

  let rawState = ""
  try {
    rawState = await readFile(statePath, "utf8")
  } catch (error) {
    notes.push(`Could not read state file: ${errorMessage(error)}`)
    return {
      checkedAt,
      stateFile: stateFileStatus,
      notes,
    }
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawState) as unknown
  } catch (error) {
    const parseError = `Invalid JSON: ${errorMessage(error)}`
    stateFileStatus.parseError = parseError
    notes.push(`State file is not valid JSON. ${parseError}`)
    return {
      checkedAt,
      stateFile: stateFileStatus,
      notes,
    }
  }

  const parsedState = parseStateSnapshot(parsedJson)
  if (!parsedState) {
    stateFileStatus.parseError = "JSON shape does not match reclaw state schema."
    notes.push("State file JSON schema is invalid for reclaw v1 state.")
    return {
      checkedAt,
      stateFile: stateFileStatus,
      notes,
    }
  }

  const targetPathExists = await pathExists(parsedState.targetPath)
  const outputDirPath =
    parsedState.mode === "openclaw"
      ? join(parsedState.targetPath, "memory")
      : join(parsedState.targetPath, "03 Journal")
  const outputDirExists = await pathExists(outputDirPath)

  if (!targetPathExists) {
    notes.push(`Target path does not exist: ${parsedState.targetPath}`)
  }

  if (!outputDirExists) {
    notes.push(`Expected output directory is missing: ${outputDirPath}`)
  }

  const createdAtDate = new Date(parsedState.createdAt)
  const updatedAtDate = new Date(parsedState.updatedAt)

  const state: StateSnapshot = {
    version: 1,
    runKey: parsedState.runKey,
    mode: parsedState.mode,
    model: parsedState.model,
    createdAt: toStatusTimestamp(createdAtDate),
    updatedAt: toStatusTimestamp(updatedAtDate),
    paths: {
      targetPath: parsedState.targetPath,
      targetPathExists,
      outputDirPath,
      outputDirExists,
    },
    metrics: summarizeCompleted(parsedState.completed),
  }

  if (state.metrics.completedBatches === 0) {
    notes.push("No completed batches are recorded in state yet.")
  }

  const ageMs = now.getTime() - updatedAtDate.getTime()
  if (Number.isFinite(ageMs) && ageMs > 14 * 24 * 60 * 60 * 1000) {
    notes.push("State appears stale (last update is older than 14 days).")
  }

  notes.push(
    "Pending/failed batch counts are not derivable from state alone without replaying the current extraction plan.",
  )

  return {
    checkedAt,
    stateFile: stateFileStatus,
    state,
    notes,
  }
}

function printHumanStatus(report: StatusReport): void {
  const lines = [
    "🦞 Reclaw - Status check",
    `- Checked: ${report.checkedAt.local} (${report.checkedAt.iso})`,
    `- State file: ${report.stateFile.path} (${report.stateFile.exists ? "present" : "missing"})`,
  ]

  if (typeof report.stateFile.sizeBytes === "number") {
    lines.push(`- State size: ${report.stateFile.sizeBytes} bytes`)
  }

  if (report.stateFile.modifiedAt) {
    lines.push(`- State modified: ${report.stateFile.modifiedAt.local} (${report.stateFile.modifiedAt.iso})`)
  }

  if (report.stateFile.parseError) {
    lines.push(`- State parse error: ${report.stateFile.parseError}`)
  }

  if (!report.state) {
    if (report.notes.length > 0) {
      lines.push("- Notes:")
      for (const note of report.notes) {
        lines.push(`  - ${note}`)
      }
    }

    console.log(lines.join("\n"))
    return
  }

  const state = report.state

  lines.push(`- Mode: ${state.mode}`)
  lines.push(`- Model: ${state.model}`)
  lines.push(`- Run key: ${state.runKey}`)
  lines.push(`- Created: ${state.createdAt.local} (${state.createdAt.iso})`)
  lines.push(`- Updated: ${state.updatedAt.local} (${state.updatedAt.iso})`)
  lines.push(`- Target path: ${state.paths.targetPath} (${state.paths.targetPathExists ? "exists" : "missing"})`)
  lines.push(`- Output dir: ${state.paths.outputDirPath} (${state.paths.outputDirExists ? "exists" : "missing"})`)
  lines.push(`- Completed batches: ${state.metrics.completedBatches}`)
  lines.push(`- Completed conversations: ${state.metrics.completedConversations}`)

  const providerSummary = providerOrder
    .map((provider) => `${providerLabels[provider]} ${state.metrics.providerConversationCounts[provider]}`)
    .join(", ")
  lines.push(`- Provider conversations: ${providerSummary}`)

  const providerBatchSummary = providerOrder
    .map((provider) => `${providerLabels[provider]} ${state.metrics.providerBatchCounts[provider]}`)
    .join(", ")
  lines.push(`- Provider batches: ${providerBatchSummary}`)

  const dateRange =
    state.metrics.earliestBatchDate && state.metrics.latestBatchDate
      ? `${state.metrics.earliestBatchDate} -> ${state.metrics.latestBatchDate}`
      : "none"
  lines.push(`- Batch date range: ${dateRange}`)

  if (report.notes.length > 0) {
    lines.push("- Notes:")
    for (const note of report.notes) {
      lines.push(`  - ${note}`)
    }
  }

  console.log(lines.join("\n"))
}

function summarizeCompleted(completedRaw: Record<string, unknown>): StatusMetrics {
  const providerConversationCounts: Record<Provider, number> = {
    chatgpt: 0,
    claude: 0,
    grok: 0,
  }
  const providerBatchCounts: Record<Provider, number> = {
    chatgpt: 0,
    claude: 0,
    grok: 0,
  }

  let completedConversations = 0
  const batchDates: string[] = []

  for (const batch of Object.values(completedRaw)) {
    const record = asRecord(batch)
    if (!record) {
      continue
    }

    const conversationCount = readConversationCount(record)
    completedConversations += conversationCount

    const providers = readProviders(record)
    for (const provider of providers) {
      providerBatchCounts[provider] += 1
    }

    const refs = Array.isArray(record.conversationRefs) ? record.conversationRefs : []
    if (refs.length > 0) {
      for (const ref of refs) {
        const refRecord = asRecord(ref)
        if (!refRecord) {
          continue
        }
        const provider = parseProvider(refRecord.provider)
        if (provider) {
          providerConversationCounts[provider] += 1
        }
      }
    } else if (providers.length > 0) {
      const estimatedPerProvider = Math.floor(conversationCount / providers.length)
      const remainder = conversationCount % providers.length
      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index]
        if (!provider) {
          continue
        }
        providerConversationCounts[provider] += estimatedPerProvider + (index < remainder ? 1 : 0)
      }
    }

    if (typeof record.date === "string" && record.date.length > 0) {
      batchDates.push(record.date)
    }
  }

  batchDates.sort((left, right) => left.localeCompare(right))

  const metrics: StatusMetrics = {
    completedBatches: Object.keys(completedRaw).length,
    completedConversations,
    providerConversationCounts,
    providerBatchCounts,
  }

  const earliestBatchDate = batchDates[0]
  if (earliestBatchDate) {
    metrics.earliestBatchDate = earliestBatchDate
  }

  const latestBatchDate = batchDates.length > 0 ? batchDates[batchDates.length - 1] : undefined
  if (latestBatchDate) {
    metrics.latestBatchDate = latestBatchDate
  }

  return metrics
}

function parseStateSnapshot(value: unknown): {
  runKey: string
  mode: "openclaw" | "zettelclaw"
  model: string
  targetPath: string
  createdAt: string
  updatedAt: string
  completed: Record<string, unknown>
} | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  if (
    record.version !== 1 ||
    typeof record.runKey !== "string" ||
    typeof record.model !== "string" ||
    typeof record.targetPath !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return null
  }

  const mode = record.mode
  if (mode !== "openclaw" && mode !== "zettelclaw") {
    return null
  }

  const completed = asRecord(record.completed)
  if (!completed) {
    return null
  }

  return {
    runKey: record.runKey,
    mode,
    model: record.model,
    targetPath: record.targetPath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completed,
  }
}

function readConversationCount(record: Record<string, unknown>): number {
  if (typeof record.conversationCount === "number" && Number.isFinite(record.conversationCount)) {
    const normalized = Math.floor(record.conversationCount)
    if (normalized > 0) {
      return normalized
    }
  }

  const ids = Array.isArray(record.conversationIds) ? record.conversationIds : []
  return ids.length
}

function readProviders(record: Record<string, unknown>): Provider[] {
  const providersRaw = Array.isArray(record.providers) ? record.providers : []
  const providers: Provider[] = []
  for (const entry of providersRaw) {
    const provider = parseProvider(entry)
    if (provider && !providers.includes(provider)) {
      providers.push(provider)
    }
  }

  return providers
}

function parseProvider(value: unknown): Provider | undefined {
  if (value === "chatgpt" || value === "claude" || value === "grok") {
    return value
  }

  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function toStatusTimestamp(value: Date): StatusTimestamp {
  if (!Number.isFinite(value.getTime())) {
    return {
      iso: "invalid",
      local: "Invalid date",
    }
  }

  return {
    iso: value.toISOString(),
    local: value.toLocaleString(),
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }

    return false
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const maybeCode = (error as { code?: unknown }).code
  return maybeCode === "ENOENT"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

const providerOrder: Provider[] = ["chatgpt", "claude", "grok"]
