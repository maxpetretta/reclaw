import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { uniqueStrings } from "../lib/collections"
import { formatLocalDate } from "../lib/timestamps"
import type { BatchExtractionResult } from "./contracts"
import { collectResultSessionEntries, collectSessionEntries } from "./session-refs"
import { extractSummarySignals } from "./summary-signals"

const ZETTELCLAW_JOURNAL_FOLDER = "03 Journal"

interface ContentUpdateResult {
  content: string
  changed: boolean
}

export interface ZettelclawArtifactsResult {
  outputFiles: string[]
}

export interface WriteZettelclawOptions {
  includeSessionFooters?: boolean
}

export async function writeZettelclawArtifacts(
  batchResults: BatchExtractionResult[],
  vaultPath: string,
  options?: WriteZettelclawOptions,
): Promise<ZettelclawArtifactsResult> {
  const journalPath = join(vaultPath, ZETTELCLAW_JOURNAL_FOLDER)
  await mkdir(journalPath, { recursive: true })

  const journalFiles = await writeZettelclawJournalImports(
    batchResults,
    journalPath,
    options?.includeSessionFooters === true,
  )
  return { outputFiles: journalFiles.sort((left, right) => left.localeCompare(right)) }
}

async function writeZettelclawJournalImports(
  batchResults: BatchExtractionResult[],
  journalPath: string,
  includeSessionFooters: boolean,
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

  const todayDate = formatLocalDate(new Date())
  const writtenFiles: string[] = []

  for (const date of [...byDate.keys()].sort((left, right) => left.localeCompare(right))) {
    const dateResults = byDate.get(date)
    if (!dateResults || dateResults.length === 0) {
      continue
    }

    // Skip dates where all extractions produced empty summaries (no signal)
    const hasAnySummary = dateResults.some((result) => result.extraction.summary.trim().length > 0)
    if (!hasAnySummary) {
      continue
    }

    const previewInsights = collectDateInsights(dateResults)
    if (!includeSessionFooters && previewInsights.logItems.length === 0 && previewInsights.todoItems.length === 0) {
      continue
    }

    const filePath = join(journalPath, `${date}.md`)
    let content = await readOrCreateJournalFile(filePath, date, todayDate, includeSessionFooters)
    const ensured = ensureDailyJournalSections(content, includeSessionFooters)
    content = ensured.content
    let changed = ensured.changed

    const normalizedSections = normalizeJournalSections(content)
    content = normalizedSections.content
    changed = changed || normalizedSections.changed

    const sessionIdsToAppend = new Set<string>()
    const footerEntriesToAppend: string[] = []
    if (includeSessionFooters) {
      const existingSessionIds = collectSessionIds(content)
      const sessionEntries = collectSessionEntries(dateResults)
      for (const sessionEntry of sessionEntries) {
        const key = sessionEntry.id.toLowerCase()
        if (existingSessionIds.has(key)) {
          continue
        }

        existingSessionIds.add(key)
        sessionIdsToAppend.add(key)
        footerEntriesToAppend.push(`${sessionEntry.id} — ${formatSessionClock(sessionEntry.timestamp)}`)
      }
    }

    const shouldAppendInsights = includeSessionFooters ? sessionIdsToAppend.size > 0 : true
    if (shouldAppendInsights) {
      const pendingResults = includeSessionFooters
        ? dateResults.filter((result) =>
            collectResultSessionEntries(result).some((entry) => sessionIdsToAppend.has(entry.id.toLowerCase())),
          )
        : dateResults

      const insights = collectDateInsights(pendingResults)
      const cleanedLog = insights.logItems
      const cleanedTodo = insights.todoItems

      const logUpdate = appendUniqueSectionBullets(content, "## Log", cleanedLog, includeSessionFooters)
      content = logUpdate.content
      changed = changed || logUpdate.changed

      const todoUpdate = appendUniqueSectionBullets(content, "## Todo", cleanedTodo, includeSessionFooters)
      content = todoUpdate.content
      changed = changed || todoUpdate.changed

      if (includeSessionFooters) {
        const sessionsUpdate = appendUniqueSectionBullets(content, "## Sessions", footerEntriesToAppend, true)
        content = sessionsUpdate.content
        changed = changed || sessionsUpdate.changed
      }
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

async function readOrCreateJournalFile(
  filePath: string,
  date: string,
  updatedDate: string,
  includeSessionFooters: boolean,
): Promise<string> {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    const template = buildJournalTemplate(date, updatedDate, includeSessionFooters)
    await writeFile(filePath, template, "utf8")
    return template
  }
}

function buildJournalTemplate(date: string, updatedDate: string, includeSessionFooters: boolean): string {
  const lines = ["---", "type: journal", "tags: [journals]", `created: ${date}`, `updated: ${updatedDate}`, "---"]

  if (includeSessionFooters) {
    lines.push("---", "## Sessions", "")
  }

  return lines.join("\n")
}

function ensureDailyJournalSections(content: string, includeSessionFooters: boolean): ContentUpdateResult {
  const lines = content.replaceAll("\r\n", "\n").split("\n")
  let changed = stripBlankLinesAfterFrontmatter(lines)

  const migratedOpen = migrateLegacyOpenSection(lines, includeSessionFooters)
  changed = changed || migratedOpen.changed
  if (includeSessionFooters) {
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

    for (const heading of ["## Log", "## Todo"]) {
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
  } else {
    if (removeSection(lines, "## Sessions")) {
      changed = true
    }
    if (removeTrailingDivider(lines)) {
      changed = true
    }
    for (const heading of ["## Log", "## Todo"]) {
      const bounds = findSectionBounds(lines, heading)
      if (!bounds || sectionHasBullets(lines, bounds)) {
        continue
      }
      removeSection(lines, heading)
      changed = true
    }
  }

  return {
    content: `${lines.join("\n").trimEnd()}\n`,
    changed,
  }
}

function migrateLegacyOpenSection(lines: string[], includeSessionFooters: boolean): { changed: boolean } {
  const legacyOpen = findSectionBounds(lines, "## Open")
  if (!legacyOpen) {
    return { changed: false }
  }

  const legacyValues = lines
    .slice(legacyOpen.start + 1, legacyOpen.end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2))

  removeSection(lines, "## Open")
  if (legacyValues.length === 0) {
    return { changed: true }
  }

  const merged = appendUniqueSectionBullets(`${lines.join("\n")}\n`, "## Todo", legacyValues, includeSessionFooters)
  const mergedLines = merged.content.replaceAll("\r\n", "\n").split("\n")
  lines.length = 0
  lines.push(...mergedLines)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }

  return { changed: true }
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

  for (const heading of ["## Log", "## Todo"]) {
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

function appendUniqueSectionBullets(
  content: string,
  heading: string,
  values: string[],
  includeSessionFooters: boolean,
): ContentUpdateResult {
  const uniqueValues = uniqueStrings(values)
  if (uniqueValues.length === 0) {
    return { content, changed: false }
  }

  const lines = content.replaceAll("\r\n", "\n").split("\n")
  let changed = false
  const ensured = ensureSectionForAppend(lines, heading, includeSessionFooters)
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

function formatSessionClock(timestamp?: string): string {
  if (!timestamp) {
    return "unknown"
  }

  const trimmed = timestamp.trim()
  if (trimmed.length === 0) {
    return "unknown"
  }

  const directMatch = trimmed.match(/^(\d{2}):(\d{2})/)
  if (directMatch?.[1] && directMatch[2]) {
    return `${directMatch[1]}:${directMatch[2]}`
  }

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return "unknown"
  }

  const hours = parsed.getHours().toString().padStart(2, "0")
  const minutes = parsed.getMinutes().toString().padStart(2, "0")
  return `${hours}:${minutes}`
}

function normalizeBulletValue(value: string): string {
  return stripInlineSignalPrefix(value).trim().toLowerCase()
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

function ensureSectionForAppend(
  lines: string[],
  heading: string,
  includeSessionFooters: boolean,
): { changed: boolean } {
  if (findLineIndex(lines, heading) !== -1) {
    return { changed: false }
  }

  let changed = false
  if (heading === "## Sessions") {
    if (!includeSessionFooters) {
      return { changed: false }
    }
    const ensured = ensureSessionsFooter(lines)
    return { changed: ensured.changed }
  }

  if (!includeSessionFooters) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim().length === 0) {
      lines.pop()
    }
    if (lines.length > 0) {
      lines.push("")
    }
    lines.push(heading, "")
    return { changed: true }
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

function removeTrailingDivider(lines: string[]): boolean {
  const frontmatterEnd = findFrontmatterEnd(lines)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim() ?? ""
    if (trimmed.length === 0) {
      continue
    }
    if (trimmed !== "---") {
      return false
    }

    // Never remove the frontmatter closing delimiter
    if (index === frontmatterEnd) {
      return false
    }

    lines.splice(index, 1)
    while (lines.length > 0 && lines[lines.length - 1]?.trim().length === 0) {
      lines.pop()
    }
    return true
  }

  return false
}

function findFrontmatterEnd(lines: string[]): number {
  if (lines.length < 2 || (lines[0]?.trim() ?? "") !== "---") {
    return -1
  }

  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index]?.trim() ?? "") === "---") {
      return index
    }
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

function collectDateInsights(results: BatchExtractionResult[]): { logItems: string[]; todoItems: string[] } {
  const logItems = uniqueStrings(
    results.flatMap((entry) => {
      const signals = extractSummarySignals(entry.extraction.summary, { allowUntaggedFacts: false })
      return [
        ...signals.decisions,
        ...signals.facts,
        ...signals.projects,
        ...signals.people,
        ...signals.preferences,
        ...signals.interests,
      ]
    }),
  )

  const todoItems = uniqueStrings(
    results.flatMap((entry) => extractSummarySignals(entry.extraction.summary, { allowUntaggedFacts: false }).todo),
  )

  return {
    logItems: cleanJournalBullets(logItems),
    todoItems: cleanJournalBullets(todoItems),
  }
}

function cleanJournalBullets(values: string[]): string[] {
  return uniqueStrings(
    values
      .map((value) => stripInlineSignalPrefix(value))
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter((value) => !isBlockedJournalBullet(value))
      .filter((value) => hasBalancedMarkers(value))
      .filter((value) => !isLikelyTruncatedBullet(value))
      .map((value) => value.trim())
      .filter((value) => value.length <= 220)
      .filter((value) => value.length > 0),
  )
}

function stripInlineSignalPrefix(value: string): string {
  let output = value.trim()
  while (true) {
    const next = output
      .replace(
        /^(?:\*\*)?(preference|project|fact|decision|interest|person|open|todo|next|followup|follow-up)(?:\*\*)?\s*:\s*/i,
        "",
      )
      .trim()
    if (next === output) {
      return output
    }
    output = next
  }
}

function isBlockedJournalBullet(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) {
    return true
  }

  if (
    /^(summary|analysis|reason|reasoning|signal distilled|key signal|memory extraction complete|filtered out)\s*:/u.test(
      normalized,
    )
  ) {
    return true
  }

  if (/\/users\/|\.json\b|reclaw-extract-output|\.memory-extract/u.test(normalized)) {
    return true
  }

  return /done\b|saved to|main reclaw process|hard memory filter|would i need to know this person|general knowledge|one-off|no durable user-specific|no user-specific|does not meet.*filter/u.test(
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

function isLikelyTruncatedBullet(value: string): boolean {
  if (/[([{]\s*$/u.test(value)) {
    return true
  }

  if (/\b(prese|approac|decis|criter|integra|signif|durab|proces|answ|req)\s*$/iu.test(value)) {
    return true
  }

  return value.length >= 100 && /\b(and|or|to|for|with|from|in|on|at|by|vs)\s*$/iu.test(value)
}
