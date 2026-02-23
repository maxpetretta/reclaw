import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import { pathExists } from "../lib/fs"
import { removeCronJob, scheduleSubagentCronJob, waitForCronSummary } from "../lib/openclaw"
import type { AggregatedInsights, BatchExtractionResult, ExtractionMode } from "./contracts"
import { collectResultSessionEntries, formatProviderList } from "./session-refs"

const MEMORY_SECTION_START = "<!-- reclaw-memory:start -->"
const MEMORY_SECTION_END = "<!-- reclaw-memory:end -->"
const USER_SECTION_START = "<!-- reclaw-user:start -->"
const USER_SECTION_END = "<!-- reclaw-user:end -->"

export interface MainAgentDocUpdateOptions {
  mode: ExtractionMode
  targetPath: string
  memoryWorkspacePath: string
  model: string
  insights: AggregatedInsights
  batchResults: BatchExtractionResult[]
  memoryFilePath: string
  userFilePath: string
}

export async function updateMemoryAndUserWithMainAgent(options: MainAgentDocUpdateOptions): Promise<void> {
  const [memoryBefore, userBefore] = await Promise.all([
    readFileIfExists(options.memoryFilePath),
    readFileIfExists(options.userFilePath),
  ])

  const prompt = buildMainAgentDocUpdatePrompt(options)
  const scheduled = await scheduleSubagentCronJob({
    message: prompt,
    model: options.model,
    sessionName: "reclaw-main-docs",
    timeoutSeconds: 1800,
  })

  try {
    await waitForCronSummary(scheduled.jobId, 1_900_000)
  } catch (error) {
    removeCronJob(scheduled.jobId)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Main agent doc update failed: ${message}`)
  }

  const [hasMemory, hasUser] = await Promise.all([pathExists(options.memoryFilePath), pathExists(options.userFilePath)])
  if (!(hasMemory && hasUser)) {
    const missing = [hasMemory ? "" : options.memoryFilePath, hasUser ? "" : options.userFilePath].filter(
      (entry) => entry.length > 0,
    )
    throw new Error(`Main agent did not produce expected file updates: ${missing.join(", ")}`)
  }

  const [memoryAfter, userAfter] = await Promise.all([
    readFile(options.memoryFilePath, "utf8"),
    readFile(options.userFilePath, "utf8"),
  ])

  if (!hasManagedSection(memoryAfter, MEMORY_SECTION_START, MEMORY_SECTION_END)) {
    throw new Error(`Main agent did not write required managed section markers in ${options.memoryFilePath}`)
  }

  if (!hasManagedSection(userAfter, USER_SECTION_START, USER_SECTION_END)) {
    throw new Error(`Main agent did not write required managed section markers in ${options.userFilePath}`)
  }

  const memoryChanged = digest(memoryBefore) !== digest(memoryAfter)
  const userChanged = digest(userBefore) !== digest(userAfter)
  if (!(memoryChanged && userChanged)) {
    const unchangedPaths = [
      memoryChanged ? "" : options.memoryFilePath,
      userChanged ? "" : options.userFilePath,
    ].filter((entry) => entry.length > 0)
    throw new Error(`Main agent did not modify expected files: ${unchangedPaths.join(", ")}`)
  }
}

function buildMainAgentDocUpdatePrompt(options: MainAgentDocUpdateOptions): string {
  const batchSummaries = serializeBatchSummaries(options.batchResults, 48_000)
  const insights = [
    `Summary: ${options.insights.summary || "No summary captured."}`,
    formatInlineList("Projects", options.insights.projects),
    formatInlineList("Interests", options.insights.interests),
    formatInlineList("Facts", options.insights.facts),
    formatInlineList("Preferences", options.insights.preferences),
    formatInlineList("People", options.insights.people),
    formatInlineList("Decisions", options.insights.decisions),
  ].join("\n")

  return [
    "You are Reclaw's main synthesis agent.",
    "Use your own tools to edit files directly on disk.",
    "",
    "Task:",
    `1. Update ${options.memoryFilePath}`,
    `2. Update ${options.userFilePath}`,
    "",
    "Constraints:",
    "- Preserve all content outside managed sections.",
    "- Backups already exist next to target files (.bak or .bak.<timestamp>); do not modify backup files.",
    "- If target files do not exist, create them.",
    "- Keep outputs concise, durable, and high-signal.",
    "- Re-filter aggressively: if an item is general knowledge (even if it appeared in subagent output), exclude it.",
    "- Do not treat one-off questions as durable interests.",
    "- If a fact is true for nearly all users of a technology, exclude it unless the item is specific to this user's setup/decision.",
    "",
    "Managed section requirements:",
    "- MEMORY.md section markers: <!-- reclaw-memory:start --> ... <!-- reclaw-memory:end -->",
    "- USER.md section markers: <!-- reclaw-user:start --> ... <!-- reclaw-user:end -->",
    "- Replace existing section content when markers exist; otherwise append a new managed section.",
    "",
    "MEMORY.md managed section format:",
    "Updated: <ISO-8601 timestamp>",
    `Model: ${options.model}`,
    `Mode: ${options.mode}`,
    "",
    "Summary: <single concise paragraph>",
    "Projects: <semicolon-separated list or n/a>",
    "Interests: <semicolon-separated list or n/a>",
    "Facts: <semicolon-separated list or n/a>",
    "Preferences: <semicolon-separated list or n/a>",
    "People: <semicolon-separated list or n/a>",
    "Decisions: <semicolon-separated list or n/a>",
    "",
    "USER.md managed section format:",
    "Updated: <ISO-8601 timestamp>",
    `Model: ${options.model}`,
    `Mode: ${options.mode}`,
    "",
    "High-priority durable user context:",
    "- One bullet per item, max 40 bullets total, or '- n/a' when empty.",
    "",
    "Run context:",
    `- Output mode: ${options.mode}`,
    `- Output target path: ${options.targetPath}`,
    `- Memory workspace path: ${options.memoryWorkspacePath}`,
    "",
    "Aggregated signal hints:",
    insights,
    "",
    "Per-subagent summaries from this run:",
    batchSummaries,
    "",
    "After edits are complete, respond with a short status summary only.",
  ].join("\n")
}

function serializeBatchSummaries(batchResults: BatchExtractionResult[], maxChars: number): string {
  const sorted = [...batchResults].sort((left, right) => {
    const dateCompare = left.date.localeCompare(right.date)
    if (dateCompare !== 0) {
      return dateCompare
    }

    const providerCompare = left.providers.join(",").localeCompare(right.providers.join(","))
    if (providerCompare !== 0) {
      return providerCompare
    }

    return left.batchId.localeCompare(right.batchId)
  })

  const lines: string[] = []
  let consumed = 0

  for (const result of sorted) {
    const summary = result.extraction.summary.replaceAll(/\s+/g, " ").trim()
    if (summary.length === 0) {
      continue
    }

    const refs = collectResultSessionEntries(result)
      .map((entry) => (entry.timestamp ? `${entry.id}@${entry.timestamp}` : entry.id))
      .join(", ")
    const line = `- ${result.date} | ${formatProviderList(result.providers)} | ${refs || "no-session-ref"} | ${summary}`
    if (consumed + line.length + 1 > maxChars) {
      lines.push(`- ... truncated after ${lines.length} summaries to stay within prompt budget.`)
      break
    }

    lines.push(line)
    consumed += line.length + 1
  }

  return lines.length > 0 ? lines.join("\n") : "- n/a"
}

function formatInlineList(title: string, values: string[]): string {
  if (values.length === 0) {
    return `${title}: n/a`
  }

  return `${title}: ${values.slice(0, 25).join("; ")}`
}

async function readFileIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : ""
    if (code === "ENOENT") {
      return ""
    }

    throw error
  }
}

function hasManagedSection(content: string, startMarker: string, endMarker: string): boolean {
  const start = content.indexOf(startMarker)
  if (start === -1) {
    return false
  }

  const end = content.indexOf(endMarker, start + startMarker.length)
  return end !== -1 && end > start
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}
