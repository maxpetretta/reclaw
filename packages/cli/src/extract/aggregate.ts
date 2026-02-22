import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { removeCronJob, scheduleSubagentCronJob, waitForCronSummary } from "../lib/openclaw"
import type {
  AggregatedInsights,
  BackupMode,
  BatchExtractionResult,
  ExtractionArtifacts,
  ExtractionMode,
} from "./contracts"
import { extractSummarySignals } from "./summarySignals"

interface WriteArtifactsOptions {
  mode: ExtractionMode
  targetPath: string
  model: string
  backupMode: BackupMode
}

interface ZettelclawArtifactsResult {
  outputFiles: string[]
}

interface ZettelclawLayout {
  journalPath: string
}

interface SessionEntry {
  id: string
  timestamp?: string
}

interface ContentUpdateResult {
  content: string
  changed: boolean
}

interface MainAgentDocUpdateOptions {
  mode: ExtractionMode
  targetPath: string
  model: string
  insights: AggregatedInsights
  batchResults: BatchExtractionResult[]
  memoryFilePath: string
  userFilePath: string
}

const PROVIDER_LABELS: Record<"chatgpt" | "claude" | "grok", string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
}

const ZETTELCLAW_JOURNAL_FOLDER = "03 Journal"

export async function writeExtractionArtifacts(
  batchResults: BatchExtractionResult[],
  options: WriteArtifactsOptions,
): Promise<ExtractionArtifacts> {
  const insights = aggregateInsights(batchResults)
  const backupTimestamp = options.backupMode === "timestamped" ? formatBackupTimestamp(new Date()) : undefined

  if (options.mode === "openclaw") {
    const outputFiles = await writeOpenClawMemoryFiles(batchResults, options.targetPath)

    const memoryFilePath = join(options.targetPath, "MEMORY.md")
    const userFilePath = join(options.targetPath, "USER.md")
    await backupFileIfExists(memoryFilePath, options.backupMode, backupTimestamp)
    await backupFileIfExists(userFilePath, options.backupMode, backupTimestamp)
    await updateMemoryAndUserWithMainAgent({
      mode: options.mode,
      targetPath: options.targetPath,
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

  const zettelclawArtifacts = await writeZettelclawArtifacts(batchResults, options.targetPath)
  const memoryFilePath = join(options.targetPath, "MEMORY.md")
  const userFilePath = join(options.targetPath, "USER.md")
  await backupFileIfExists(memoryFilePath, options.backupMode, backupTimestamp)
  await backupFileIfExists(userFilePath, options.backupMode, backupTimestamp)
  await updateMemoryAndUserWithMainAgent({
    mode: options.mode,
    targetPath: options.targetPath,
    model: options.model,
    insights,
    batchResults,
    memoryFilePath,
    userFilePath,
  })

  return {
    outputFiles: zettelclawArtifacts.outputFiles,
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

  const uniqueInterests = uniqueStrings(interests)
  const uniqueProjects = uniqueStrings(projects)
  const uniqueFacts = uniqueStrings(facts)
  const uniquePreferences = uniqueStrings(preferences)
  const uniquePeople = uniqueStrings(people)
  const uniqueDecisions = uniqueStrings(decisions)

  return {
    summary: uniqueStrings(summaries).slice(0, 8).join(" "),
    interests: uniqueInterests,
    projects: uniqueProjects,
    facts: uniqueFacts,
    preferences: uniquePreferences,
    people: uniquePeople,
    decisions: uniqueDecisions,
  }
}

async function writeOpenClawMemoryFiles(batchResults: BatchExtractionResult[], targetPath: string): Promise<string[]> {
  const memoryDir = join(targetPath, "memory")
  await mkdir(memoryDir, { recursive: true })

  const groups = new Map<string, BatchExtractionResult[]>()
  for (const batchResult of batchResults) {
    const key = batchResult.date
    const existing = groups.get(key)
    if (existing) {
      existing.push(batchResult)
    } else {
      groups.set(key, [batchResult])
    }
  }

  const outputFiles: string[] = []
  for (const [date, group] of groups.entries()) {
    const filePath = join(memoryDir, `${date}.md`)
    const content = buildOpenClawDailyMemoryContent(date, group)
    await writeFile(filePath, content, "utf8")
    outputFiles.push(filePath)
  }

  return outputFiles.sort((left, right) => left.localeCompare(right))
}

function buildOpenClawDailyMemoryContent(date: string, batchResults: BatchExtractionResult[]): string {
  const providerSummary = summarizeProviders(batchResults)
  const sessionRefs = collectSessionRefs(batchResults)
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

  const lines = [`# Reclaw Import ${date}`, "", `Source providers: ${providerSummary}`, ""]
  appendSection(lines, "## Decisions", decisions)
  appendSection(lines, "## Facts", facts)
  appendSection(lines, "## Interests", interests)
  appendSection(lines, "## Open", open)

  lines.push("---", "", "## Sessions")
  if (sessionRefs.length === 0) {
    lines.push("- n/a")
  } else {
    for (const ref of sessionRefs) {
      lines.push(`- ${ref}`)
    }
  }
  lines.push("")

  return `${lines.join("\n").trimEnd()}\n`
}

async function writeZettelclawArtifacts(
  batchResults: BatchExtractionResult[],
  vaultPath: string,
): Promise<ZettelclawArtifactsResult> {
  const layout = resolveZettelclawLayout(vaultPath)
  await mkdir(layout.journalPath, { recursive: true })

  const journalFiles = await writeZettelclawJournalImports(batchResults, layout.journalPath)
  return { outputFiles: journalFiles.sort((left, right) => left.localeCompare(right)) }
}

function resolveZettelclawLayout(vaultPath: string): ZettelclawLayout {
  return {
    journalPath: join(vaultPath, ZETTELCLAW_JOURNAL_FOLDER),
  }
}

async function writeZettelclawJournalImports(
  batchResults: BatchExtractionResult[],
  journalPath: string,
): Promise<string[]> {
  const byDate = new Map<string, BatchExtractionResult[]>()
  for (const result of batchResults) {
    const existing = byDate.get(result.date)
    if (existing) {
      existing.push(result)
    } else {
      byDate.set(result.date, [result])
    }
  }

  const todayDate = new Date().toISOString().slice(0, 10)
  const writtenFiles: string[] = []

  for (const date of [...byDate.keys()].sort((left, right) => left.localeCompare(right))) {
    const dateResults = byDate.get(date)
    if (!dateResults || dateResults.length === 0) {
      continue
    }

    const filePath = join(journalPath, `${date}.md`)
    let content = await readOrCreateJournalFile(filePath, date, todayDate)
    const ensured = ensureDailyJournalSections(content)
    content = ensured.content
    let changed = ensured.changed
    const normalizedSections = normalizeJournalSections(content)
    content = normalizedSections.content
    changed = changed || normalizedSections.changed

    const existingSessionIds = collectSessionIds(content)
    const sessionEntries = collectSessionEntries(dateResults)
    const sessionIdsToAppend = new Set<string>()
    const footerEntriesToAppend: string[] = []
    for (const sessionEntry of sessionEntries) {
      const key = sessionEntry.id.toLowerCase()
      if (existingSessionIds.has(key)) {
        continue
      }

      existingSessionIds.add(key)
      sessionIdsToAppend.add(key)
      footerEntriesToAppend.push(`${sessionEntry.id} — ${formatSessionClock(sessionEntry.timestamp)}`)
    }

    if (sessionIdsToAppend.size > 0) {
      const pendingResults = dateResults.filter((result) =>
        collectResultSessionEntries(result).some((entry) => sessionIdsToAppend.has(entry.id.toLowerCase())),
      )

      const decisions = uniqueStrings(
        pendingResults.flatMap((entry) => extractSummarySignals(entry.extraction.summary).decisions),
      )
      const facts = uniqueStrings(
        pendingResults.flatMap((entry) => {
          const signals = extractSummarySignals(entry.extraction.summary)
          return [...signals.facts, ...signals.projects, ...signals.people, ...signals.preferences]
        }),
      )
      const interests = uniqueStrings(
        pendingResults.flatMap((entry) => extractSummarySignals(entry.extraction.summary).interests),
      )
      const open = uniqueStrings(
        pendingResults.flatMap((entry) => extractSummarySignals(entry.extraction.summary).open),
      )
      const cleanedDecisions = cleanJournalBullets(decisions)
      const cleanedFacts = cleanJournalBullets(facts)
      const cleanedInterests = cleanJournalBullets(interests)
      const cleanedOpen = cleanJournalBullets(open)

      const decisionsUpdate = appendUniqueSectionBullets(content, "## Decisions", cleanedDecisions)
      content = decisionsUpdate.content
      changed = changed || decisionsUpdate.changed

      const factsUpdate = appendUniqueSectionBullets(content, "## Facts", cleanedFacts)
      content = factsUpdate.content
      changed = changed || factsUpdate.changed

      const interestsUpdate = appendUniqueSectionBullets(content, "## Interests", cleanedInterests)
      content = interestsUpdate.content
      changed = changed || interestsUpdate.changed

      const openUpdate = appendUniqueSectionBullets(content, "## Open", cleanedOpen)
      content = openUpdate.content
      changed = changed || openUpdate.changed

      const sessionsUpdate = appendUniqueSectionBullets(content, "## Sessions", footerEntriesToAppend)
      content = sessionsUpdate.content
      changed = changed || sessionsUpdate.changed
    }

    if (!changed) {
      continue
    }

    content = ensureFrontmatterDate(content, "updated", todayDate)
    await writeFile(filePath, `${content.trimEnd()}\n`, "utf8")
    writtenFiles.push(filePath)
  }

  return writtenFiles.sort((left, right) => left.localeCompare(right))
}

async function readOrCreateJournalFile(filePath: string, date: string, updatedDate: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    const template = buildJournalTemplate(date, updatedDate)
    await writeFile(filePath, template, "utf8")
    return template
  }
}

function buildJournalTemplate(date: string, updatedDate: string): string {
  return [
    "---",
    "type: journal",
    "tags: [journals]",
    `created: ${date}`,
    `updated: ${updatedDate}`,
    "---",
    "---",
    "## Sessions",
    "",
  ].join("\n")
}

function ensureDailyJournalSections(content: string): ContentUpdateResult {
  const lines = content.replaceAll("\r\n", "\n").split("\n")
  let changed = stripBlankLinesAfterFrontmatter(lines)

  if (removeSection(lines, "## Done")) {
    changed = true
  }

  const sessionsFooter = ensureSessionsFooter(lines)
  changed = changed || sessionsFooter.changed

  let sessionsIndex = findLineIndex(lines, "## Sessions")
  if (sessionsIndex === -1) {
    lines.push("---", "## Sessions", "")
    sessionsIndex = findLineIndex(lines, "## Sessions")
    changed = true
  }

  let dividerIndex = findDividerBefore(lines, sessionsIndex)
  if (dividerIndex === -1) {
    lines.splice(sessionsIndex, 0, "---")
    dividerIndex = sessionsIndex
    sessionsIndex += 1
    changed = true
  }

  for (const heading of ["## Decisions", "## Facts", "## Interests", "## Open"]) {
    const bounds = findSectionBounds(lines, heading)
    if (!bounds || bounds.start >= dividerIndex) {
      continue
    }

    if (sectionHasBullets(lines, bounds)) {
      continue
    }

    removeSection(lines, heading)
    changed = true
    sessionsIndex = findLineIndex(lines, "## Sessions")
    if (sessionsIndex === -1) {
      break
    }
    dividerIndex = findDividerBefore(lines, sessionsIndex)
    if (dividerIndex === -1) {
      lines.splice(sessionsIndex, 0, "---")
      dividerIndex = sessionsIndex
      sessionsIndex += 1
      changed = true
    }
  }

  return {
    content: `${lines.join("\n").trimEnd()}\n`,
    changed,
  }
}

function stripBlankLinesAfterFrontmatter(lines: string[]): boolean {
  if (lines.length < 3 || lines[0]?.trim() !== "---") {
    return false
  }

  let frontmatterEnd = -1
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === "---") {
      frontmatterEnd = index
      break
    }
  }

  if (frontmatterEnd === -1) {
    return false
  }

  let changed = false
  while (frontmatterEnd + 1 < lines.length && (lines[frontmatterEnd + 1] ?? "").trim().length === 0) {
    lines.splice(frontmatterEnd + 1, 1)
    changed = true
  }

  return changed
}

function normalizeJournalSections(content: string): ContentUpdateResult {
  const lines = content.replaceAll("\r\n", "\n").split("\n")
  let changed = false

  for (const heading of ["## Decisions", "## Facts", "## Interests", "## Open"]) {
    const bounds = findSectionBounds(lines, heading)
    if (!bounds) {
      continue
    }

    const cleanedBullets = cleanJournalBullets(
      lines
        .slice(bounds.start + 1, bounds.end)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2)),
    )

    if (cleanedBullets.length === 0) {
      removeSection(lines, heading)
      changed = true
      continue
    }

    const replacement = [heading, ...cleanedBullets.map((value) => `- ${value}`), ""]
    const current = lines.slice(bounds.start, bounds.end)
    if (!arraysEqual(current, replacement)) {
      lines.splice(bounds.start, bounds.end - bounds.start, ...replacement)
      changed = true
    }
  }

  return {
    content: `${lines.join("\n").trimEnd()}\n`,
    changed,
  }
}

function ensureSessionsFooter(lines: string[]): { changed: boolean } {
  let changed = false
  let sessionsIndex = findLineIndex(lines, "## Sessions")
  if (sessionsIndex === -1) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim().length === 0) {
      lines.pop()
    }
    if (lines.length > 0) {
      lines.push("")
    }
    lines.push("---", "## Sessions", "")
    return { changed: true }
  }

  const dividerIndex = findDividerBefore(lines, sessionsIndex)
  if (dividerIndex === -1) {
    lines.splice(sessionsIndex, 0, "---")
    sessionsIndex += 1
    changed = true
  }

  if (sessionsIndex + 1 >= lines.length || lines[sessionsIndex + 1]?.trim().length !== 0) {
    lines.splice(sessionsIndex + 1, 0, "")
    changed = true
  }

  return { changed }
}

function appendUniqueSectionBullets(content: string, heading: string, values: string[]): ContentUpdateResult {
  const uniqueValues = uniqueStrings(values)
  if (uniqueValues.length === 0) {
    return { content, changed: false }
  }

  const lines = content.replaceAll("\r\n", "\n").split("\n")
  let changed = false
  const ensured = ensureSectionForAppend(lines, heading)
  changed = ensured.changed

  const bounds = findSectionBounds(lines, heading)
  if (!bounds) {
    return {
      content: `${lines.join("\n").trimEnd()}\n`,
      changed,
    }
  }

  const existing = new Set<string>()
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const line = lines[index]?.trim() ?? ""
    if (!line.startsWith("- ")) {
      continue
    }

    const bulletValue = line.slice(2).trim()
    const key =
      heading === "## Sessions" ? parseSessionId(bulletValue).toLowerCase() : normalizeBulletValue(bulletValue)
    if (key.length > 0) {
      existing.add(key)
    }
  }

  let insertIndex = bounds.end
  while (insertIndex > bounds.start + 1 && lines[insertIndex - 1]?.trim().length === 0) {
    insertIndex -= 1
  }

  for (const value of uniqueValues) {
    const key = heading === "## Sessions" ? parseSessionId(value).toLowerCase() : normalizeBulletValue(value)
    if (key.length === 0 || existing.has(key)) {
      continue
    }

    lines.splice(insertIndex, 0, `- ${value}`)
    insertIndex += 1
    existing.add(key)
    changed = true
  }

  if (!changed) {
    return { content, changed: false }
  }

  if (insertIndex < lines.length && lines[insertIndex]?.trim().length !== 0) {
    lines.splice(insertIndex, 0, "")
  }

  return {
    content: `${lines.join("\n").trimEnd()}\n`,
    changed: true,
  }
}

function collectSessionIds(content: string): Set<string> {
  const lines = content.replaceAll("\r\n", "\n").split("\n")
  const bounds = findSectionBounds(lines, "## Sessions")
  if (!bounds) {
    return new Set<string>()
  }

  const ids = new Set<string>()
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const line = lines[index]?.trim() ?? ""
    if (!line.startsWith("- ")) {
      continue
    }

    const id = parseSessionId(line.slice(2)).toLowerCase()
    if (id.length > 0) {
      ids.add(id)
    }
  }

  return ids
}

function collectSessionEntries(results: BatchExtractionResult[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>()

  for (const result of results) {
    for (const entry of collectResultSessionEntries(result)) {
      const existing = byId.get(entry.id)
      if (!existing) {
        byId.set(entry.id, entry)
        continue
      }

      if (!existing.timestamp && entry.timestamp) {
        byId.set(entry.id, entry)
      }
    }
  }

  return [...byId.values()].sort((left, right) => {
    const leftTime = left.timestamp ?? ""
    const rightTime = right.timestamp ?? ""
    if (leftTime.length > 0 && rightTime.length > 0 && leftTime !== rightTime) {
      return leftTime.localeCompare(rightTime)
    }
    if (leftTime.length > 0 && rightTime.length === 0) {
      return -1
    }
    if (leftTime.length === 0 && rightTime.length > 0) {
      return 1
    }

    return left.id.localeCompare(right.id)
  })
}

function collectResultSessionEntries(result: BatchExtractionResult): SessionEntry[] {
  const refs =
    result.conversationRefs.length > 0
      ? result.conversationRefs
      : result.conversationIds.map((id) => ({
          provider: result.providers[0] ?? "chatgpt",
          id,
          timestamp: undefined as string | undefined,
        }))

  const byId = new Map<string, SessionEntry>()
  for (const ref of refs) {
    const id = ref.id.trim()
    if (id.length === 0) {
      continue
    }

    const fullId = `${ref.provider}:${id}`
    const timestamp = ref.timestamp?.trim()
    const existing = byId.get(fullId)
    if (!existing || (!existing.timestamp && timestamp)) {
      const entry: SessionEntry = { id: fullId }
      if (timestamp && timestamp.length > 0) {
        entry.timestamp = timestamp
      }
      byId.set(fullId, entry)
    }
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function formatSessionClock(timestamp?: string): string {
  if (!timestamp) {
    return "unknown"
  }

  const trimmed = timestamp.trim()
  if (trimmed.length === 0) {
    return "unknown"
  }

  const timeMatch = trimmed.match(/T(\d{2}):(\d{2})/)
  if (timeMatch?.[1] && timeMatch[2]) {
    return `${timeMatch[1]}:${timeMatch[2]}`
  }

  const directMatch = trimmed.match(/^(\d{2}):(\d{2})/)
  if (directMatch?.[1] && directMatch[2]) {
    return `${directMatch[1]}:${directMatch[2]}`
  }

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return "unknown"
  }

  const hours = parsed.getUTCHours().toString().padStart(2, "0")
  const minutes = parsed.getUTCMinutes().toString().padStart(2, "0")
  return `${hours}:${minutes}`
}

function normalizeBulletValue(value: string): string {
  return value.trim().toLowerCase()
}

function parseSessionId(value: string): string {
  const normalized = value.trim()
  const delimiter = normalized.indexOf("—")
  if (delimiter === -1) {
    return normalized
  }

  return normalized.slice(0, delimiter).trim()
}

function findSectionBounds(lines: string[], heading: string): { start: number; end: number } | undefined {
  const start = findLineIndex(lines, heading)
  if (start === -1) {
    return undefined
  }

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? ""
    if (trimmed === "---" || trimmed.startsWith("## ")) {
      end = index
      break
    }
  }

  return { start, end }
}

function sectionHasBullets(lines: string[], bounds: { start: number; end: number }): boolean {
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    if ((lines[index] ?? "").trim().startsWith("- ")) {
      return true
    }
  }

  return false
}

function removeSection(lines: string[], heading: string): boolean {
  const bounds = findSectionBounds(lines, heading)
  if (!bounds) {
    return false
  }

  let start = bounds.start
  while (start > 0 && lines[start - 1]?.trim().length === 0) {
    start -= 1
  }

  lines.splice(start, bounds.end - start)
  return true
}

function ensureSectionForAppend(lines: string[], heading: string): { changed: boolean } {
  if (findLineIndex(lines, heading) !== -1) {
    return { changed: false }
  }

  let changed = false
  if (heading === "## Sessions") {
    const ensured = ensureSessionsFooter(lines)
    return { changed: ensured.changed }
  }

  let sessionsIndex = findLineIndex(lines, "## Sessions")
  if (sessionsIndex === -1) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim().length === 0) {
      lines.pop()
    }
    if (lines.length > 0) {
      lines.push("")
    }
    lines.push("---", "## Sessions", "")
    changed = true
    sessionsIndex = findLineIndex(lines, "## Sessions")
  }

  if (sessionsIndex === -1) {
    return { changed }
  }

  let dividerIndex = findDividerBefore(lines, sessionsIndex)
  if (dividerIndex === -1) {
    lines.splice(sessionsIndex, 0, "---")
    sessionsIndex += 1
    dividerIndex = sessionsIndex - 1
    changed = true
  }

  if (dividerIndex > 0 && lines[dividerIndex - 1]?.trim().length !== 0) {
    lines.splice(dividerIndex, 0, "")
    dividerIndex += 1
    changed = true
  }

  lines.splice(dividerIndex, 0, heading, "")
  changed = true
  return { changed }
}

function findDividerBefore(lines: string[], index: number): number {
  for (let lineIndex = index - 1; lineIndex >= 0; lineIndex -= 1) {
    const trimmed = lines[lineIndex]?.trim() ?? ""
    if (trimmed.length === 0) {
      continue
    }
    return trimmed === "---" ? lineIndex : -1
  }

  return -1
}

function findLineIndex(lines: string[], target: string): number {
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === target) {
      return index
    }
  }

  return -1
}

function ensureFrontmatterDate(content: string, field: "updated" | "created", value: string): string {
  if (!content.startsWith("---\n")) {
    return content
  }

  const endIndex = content.indexOf("\n---", 4)
  if (endIndex === -1) {
    return content
  }

  const frontmatter = content.slice(4, endIndex)
  const body = content.slice(endIndex + 4)
  const lines = frontmatter.split("\n")
  let found = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line?.startsWith(`${field}:`)) {
      lines[index] = `${field}: ${value}`
      found = true
      break
    }
  }

  if (!found) {
    lines.push(`${field}: ${value}`)
  }

  return `---\n${lines.join("\n")}\n---${body}`
}

async function updateMemoryAndUserWithMainAgent(options: MainAgentDocUpdateOptions): Promise<void> {
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
    `- Target path: ${options.targetPath}`,
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

function summarizeProviders(batchResults: BatchExtractionResult[]): string {
  const counts = new Map<"chatgpt" | "claude" | "grok", number>()
  for (const result of batchResults) {
    if (result.conversationRefs.length > 0) {
      for (const ref of result.conversationRefs) {
        counts.set(ref.provider, (counts.get(ref.provider) ?? 0) + 1)
      }
      continue
    }

    const fallbackProvider = result.providers[0]
    if (!fallbackProvider) {
      continue
    }
    counts.set(fallbackProvider, (counts.get(fallbackProvider) ?? 0) + result.conversationCount)
  }

  const summary = [...counts.entries()].map(([provider, count]) => `${PROVIDER_LABELS[provider]} (${count})`).join(", ")
  return summary.length > 0 ? summary : "n/a"
}

function collectSessionRefs(batchResults: BatchExtractionResult[]): string[] {
  const refs = new Set<string>()
  for (const result of batchResults) {
    const conversationRefs =
      result.conversationRefs.length > 0
        ? result.conversationRefs
        : result.conversationIds.map((id) => ({
            provider: result.providers[0] ?? "chatgpt",
            id,
            timestamp: undefined as string | undefined,
          }))
    for (const conversationRef of conversationRefs) {
      const normalized = conversationRef.id.trim()
      if (normalized.length === 0) {
        continue
      }

      const timestamp = conversationRef.timestamp?.trim() || "unknown"
      refs.add(`${conversationRef.provider}:${normalized} — ${timestamp}`)
    }
  }

  return [...refs].sort((left, right) => left.localeCompare(right))
}

function formatInlineList(title: string, values: string[]): string {
  if (values.length === 0) {
    return `${title}: n/a`
  }

  return `${title}: ${values.slice(0, 25).join("; ")}`
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []

  for (const value of values) {
    const normalized = value.trim()
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

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }

  return true
}

function cleanJournalBullets(values: string[]): string[] {
  return uniqueStrings(
    values
      .map((value) => stripInlineSignalPrefix(value))
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )
}

function stripInlineSignalPrefix(value: string): string {
  let output = value.trim()
  while (true) {
    const next = output.replace(/^(preference|project|fact|decision|interest|person|open)\s*:\s*/i, "").trim()
    if (next === output) {
      return output
    }
    output = next
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function formatProviderList(providers: BatchExtractionResult["providers"]): string {
  if (providers.length === 0) {
    return "unknown-provider"
  }

  return providers.map((provider) => PROVIDER_LABELS[provider]).join("+")
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
