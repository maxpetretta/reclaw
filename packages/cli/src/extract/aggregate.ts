import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { uniqueStrings } from "../lib/collections"
import type {
  AggregatedInsights,
  BackupMode,
  BatchExtractionResult,
  ExtractionArtifacts,
  ExtractionMode,
} from "./contracts"
import { writeZettelclawArtifacts } from "./journal-artifacts"
import { updateMemoryAndUserWithMainAgent } from "./main-doc-updater"
import { collectSessionRefs, summarizeProviders } from "./session-refs"
import { extractSummarySignals } from "./summary-signals"

interface WriteArtifactsOptions {
  mode: ExtractionMode
  targetPath: string
  memoryWorkspacePath: string
  model: string
  backupMode: BackupMode
  includeSessionFooters: boolean
}

export async function writeExtractionArtifacts(
  batchResults: BatchExtractionResult[],
  options: WriteArtifactsOptions,
): Promise<ExtractionArtifacts> {
  const insights = aggregateInsights(batchResults)
  const backupTimestamp = options.backupMode === "timestamped" ? formatBackupTimestamp(new Date()) : undefined

  const outputFiles =
    options.mode === "openclaw"
      ? await writeOpenClawMemoryFiles(batchResults, options.targetPath, options.includeSessionFooters)
      : (
          await writeZettelclawArtifacts(batchResults, options.targetPath, {
            includeSessionFooters: options.includeSessionFooters,
          })
        ).outputFiles

  const memoryFilePath = join(options.memoryWorkspacePath, "MEMORY.md")
  const userFilePath = join(options.memoryWorkspacePath, "USER.md")
  await backupFileIfExists(memoryFilePath, options.backupMode, backupTimestamp)
  await backupFileIfExists(userFilePath, options.backupMode, backupTimestamp)

  await updateMemoryAndUserWithMainAgent({
    mode: options.mode,
    targetPath: options.targetPath,
    memoryWorkspacePath: options.memoryWorkspacePath,
    model: options.model,
    insights,
    batchResults,
    memoryFilePath,
    userFilePath,
  })

  return {
    outputFiles,
    memoryFilePath,
    userFilePath,
    insights,
  }
}

function aggregateInsights(batchResults: BatchExtractionResult[]): AggregatedInsights {
  const summaries: string[] = []
  const interests: string[] = []
  const projects: string[] = []
  const facts: string[] = []
  const preferences: string[] = []
  const people: string[] = []
  const decisions: string[] = []

  for (const result of batchResults) {
    const summary = result.extraction.summary.trim()
    if (summary.length > 0) {
      summaries.push(summary)
    }

    const signals = extractSummarySignals(summary)
    interests.push(...signals.interests)
    projects.push(...signals.projects)
    facts.push(...signals.facts)
    preferences.push(...signals.preferences)
    people.push(...signals.people)
    decisions.push(...signals.decisions)
  }

  return {
    summary: uniqueStrings(summaries).slice(0, 8).join(" "),
    interests: uniqueStrings(interests),
    projects: uniqueStrings(projects),
    facts: uniqueStrings(facts),
    preferences: uniqueStrings(preferences),
    people: uniqueStrings(people),
    decisions: uniqueStrings(decisions),
  }
}

async function writeOpenClawMemoryFiles(
  batchResults: BatchExtractionResult[],
  targetPath: string,
  includeSessionFooters: boolean,
): Promise<string[]> {
  const memoryDir = join(targetPath, "memory")
  await mkdir(memoryDir, { recursive: true })

  const groups = new Map<string, BatchExtractionResult[]>()
  for (const batchResult of batchResults) {
    const existing = groups.get(batchResult.date)
    if (existing) {
      existing.push(batchResult)
    } else {
      groups.set(batchResult.date, [batchResult])
    }
  }

  const outputFiles: string[] = []
  for (const [date, group] of groups.entries()) {
    const filePath = join(memoryDir, `${date}.md`)
    const content = buildOpenClawDailyMemoryContent(date, group, includeSessionFooters)
    await writeFile(filePath, content, "utf8")
    outputFiles.push(filePath)
  }

  return outputFiles.sort((left, right) => left.localeCompare(right))
}

function buildOpenClawDailyMemoryContent(
  date: string,
  batchResults: BatchExtractionResult[],
  includeSessionFooters: boolean,
): string {
  const providerSummary = summarizeProviders(batchResults)
  const decisions = uniqueStrings(
    batchResults.flatMap((entry) => extractSummarySignals(entry.extraction.summary).decisions),
  )
  const facts = uniqueStrings(
    batchResults.flatMap((entry) => {
      const signals = extractSummarySignals(entry.extraction.summary)
      return [...signals.facts, ...signals.projects, ...signals.preferences, ...signals.people]
    }),
  )
  const interests = uniqueStrings(
    batchResults.flatMap((entry) => extractSummarySignals(entry.extraction.summary).interests),
  )
  const open = uniqueStrings(batchResults.flatMap((entry) => extractSummarySignals(entry.extraction.summary).open))

  const lines = [`# Reclaw Memory Import ${date}`, "", `Source providers: ${providerSummary}`, ""]
  appendSection(lines, "## Decisions", decisions)
  appendSection(lines, "## Facts", facts)
  appendSection(lines, "## Interests", interests)
  appendSection(lines, "## Open", open)

  if (includeSessionFooters) {
    const sessionRefs = collectSessionRefs(batchResults)
    lines.push("---", "", "## Sessions")
    if (sessionRefs.length === 0) {
      lines.push("- n/a")
    } else {
      for (const ref of sessionRefs) {
        lines.push(`- ${ref}`)
      }
    }
    lines.push("")
  }

  return `${lines.join("\n").trimEnd()}\n`
}

function appendSection(lines: string[], heading: string, values: string[]): void {
  if (values.length === 0) {
    return
  }

  lines.push(heading)
  for (const value of values) {
    lines.push(`- ${value}`)
  }
  lines.push("")
}

async function backupFileIfExists(path: string, mode: BackupMode, timestamp?: string): Promise<void> {
  try {
    await copyFile(path, buildBackupPath(path, mode, timestamp))
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : ""
    if (code === "ENOENT") {
      return
    }

    throw error
  }
}

function buildBackupPath(path: string, mode: BackupMode, timestamp?: string): string {
  if (mode === "timestamped") {
    const suffix = timestamp ?? formatBackupTimestamp(new Date())
    return `${path}.bak.${suffix}`
  }

  return `${path}.bak`
}

function formatBackupTimestamp(now: Date): string {
  const year = now.getFullYear().toString().padStart(4, "0")
  const month = (now.getMonth() + 1).toString().padStart(2, "0")
  const day = now.getDate().toString().padStart(2, "0")
  const hour = now.getHours().toString().padStart(2, "0")
  const minute = now.getMinutes().toString().padStart(2, "0")
  const second = now.getSeconds().toString().padStart(2, "0")
  const millis = now.getMilliseconds().toString().padStart(3, "0")
  return `${year}${month}${day}-${hour}${minute}${second}-${millis}`
}
