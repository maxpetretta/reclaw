import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { uniqueStrings } from "../lib/collections"
import { formatLocalDate } from "../lib/timestamps"
import type { BatchExtractionResult } from "./contracts"
import { collectResultSessionEntries, collectSessionEntries } from "./sessionRefs"
import { extractSummarySignals } from "./summarySignals"

const ZETTELCLAW_JOURNAL_FOLDER = "03 Journal"

interface ContentUpdateResult {
  content: string
  changed: boolean
}

export interface ZettelclawArtifactsResult {
  outputFiles: string[]
}

export async function writeZettelclawArtifacts(
  batchResults: BatchExtractionResult[],
  vaultPath: string,
): Promise<ZettelclawArtifactsResult> {
  const journalPath = join(vaultPath, ZETTELCLAW_JOURNAL_FOLDER)
  await mkdir(journalPath, { recursive: true })

  const journalFiles = await writeZettelclawJournalImports(batchResults, journalPath)
  return { outputFiles: journalFiles.sort((left, right) => left.localeCompare(right)) }
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

  const todayDate = formatLocalDate(new Date())
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
