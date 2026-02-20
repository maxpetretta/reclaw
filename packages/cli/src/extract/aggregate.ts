import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { AggregatedInsights, BatchExtractionResult, ExtractionArtifacts, ExtractionMode } from "./contracts"

interface WriteArtifactsOptions {
  mode: ExtractionMode
  targetPath: string
  model: string
}

export async function writeExtractionArtifacts(
  batchResults: BatchExtractionResult[],
  options: WriteArtifactsOptions,
): Promise<ExtractionArtifacts> {
  const insights = aggregateInsights(batchResults)
  const outputFiles =
    options.mode === "openclaw"
      ? await writeOpenClawMemoryFiles(batchResults, options.targetPath)
      : await writeZettelclawNotes(batchResults, options.targetPath)

  const memoryFilePath = join(options.targetPath, "MEMORY.md")
  const userFilePath = join(options.targetPath, "USER.md")
  await updateMemoryDoc(memoryFilePath, insights, options.model)
  await updateUserDoc(userFilePath, insights, options.model)

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

    interests.push(...result.extraction.interests)
    projects.push(...result.extraction.projects)
    facts.push(...result.extraction.facts)
    preferences.push(...result.extraction.preferences)
    people.push(...result.extraction.people)
    decisions.push(...result.extraction.decisions)
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
    const key = `${batchResult.provider}:${batchResult.date}`
    const existing = groups.get(key)
    if (existing) {
      existing.push(batchResult)
    } else {
      groups.set(key, [batchResult])
    }
  }

  const outputFiles: string[] = []
  for (const [key, group] of groups.entries()) {
    const [provider, date] = key.split(":") as [string, string]
    const filePath = join(memoryDir, `reclaw-${provider}-${date}.md`)
    const content = buildOpenClawMemoryContent(provider, date, group)
    await writeFile(filePath, content, "utf8")
    outputFiles.push(filePath)
  }

  return outputFiles.sort((left, right) => left.localeCompare(right))
}

function buildOpenClawMemoryContent(provider: string, date: string, batchResults: BatchExtractionResult[]): string {
  const summaries = uniqueStrings(batchResults.map((entry) => entry.extraction.summary))
  const interests = uniqueStrings(batchResults.flatMap((entry) => entry.extraction.interests))
  const projects = uniqueStrings(batchResults.flatMap((entry) => entry.extraction.projects))
  const facts = uniqueStrings(batchResults.flatMap((entry) => entry.extraction.facts))
  const preferences = uniqueStrings(batchResults.flatMap((entry) => entry.extraction.preferences))
  const people = uniqueStrings(batchResults.flatMap((entry) => entry.extraction.people))
  const decisions = uniqueStrings(batchResults.flatMap((entry) => entry.extraction.decisions))

  const lines = [
    `# ReClaw Memory - ${provider} - ${date}`,
    "",
    `Source conversations: ${batchResults.reduce((sum, entry) => sum + entry.conversationCount, 0)}`,
    "",
  ]

  appendSection(lines, "## Summary", summaries)
  appendSection(lines, "## Projects", projects)
  appendSection(lines, "## Interests", interests)
  appendSection(lines, "## Preferences", preferences)
  appendSection(lines, "## Facts", facts)
  appendSection(lines, "## People", people)
  appendSection(lines, "## Key Decisions", decisions)

  const batchMarkdown = batchResults
    .map((entry) => entry.extraction.memory_markdown.trim())
    .filter((entry) => entry.length > 0)
    .join("\n\n---\n\n")

  if (batchMarkdown.length > 0) {
    lines.push("", "## Batch Notes", batchMarkdown)
  }

  return `${lines.join("\n").trimEnd()}\n`
}

async function writeZettelclawNotes(batchResults: BatchExtractionResult[], vaultPath: string): Promise<string[]> {
  const inboxPath = join(vaultPath, "Inbox")
  await mkdir(inboxPath, { recursive: true })

  const candidates = collectNoteCandidates(batchResults)
  const usedFilenames = new Set<string>()
  const writtenFiles: string[] = []

  for (const candidate of candidates) {
    const baseFilename = slugifyTitle(candidate.title)
    let filename = `${baseFilename}.md`
    let suffix = 2

    while (usedFilenames.has(filename)) {
      filename = `${baseFilename}-${suffix}.md`
      suffix += 1
    }

    usedFilenames.add(filename)
    const filePath = join(inboxPath, filename)
    const content = buildZettelclawNoteContent(candidate)
    await writeFile(filePath, content, "utf8")
    writtenFiles.push(filePath)
  }

  return writtenFiles.sort((left, right) => left.localeCompare(right))
}

interface NoteCandidate {
  title: string
  summary: string
  category: string
  source: string
  created: string
}

function collectNoteCandidates(batchResults: BatchExtractionResult[]): NoteCandidate[] {
  const candidates: NoteCandidate[] = []

  for (const result of batchResults) {
    const source = `reclaw:${result.provider}:${result.date}`
    const created = `${result.date}`

    appendCandidate(candidates, result.extraction.interests, "interest", source, created)
    appendCandidate(candidates, result.extraction.projects, "project", source, created)
    appendCandidate(candidates, result.extraction.facts, "fact", source, created)
    appendCandidate(candidates, result.extraction.preferences, "preference", source, created)
    appendCandidate(candidates, result.extraction.people, "person", source, created)
    appendCandidate(candidates, result.extraction.decisions, "decision", source, created)
  }

  return dedupeCandidates(candidates)
}

function appendCandidate(
  candidates: NoteCandidate[],
  values: string[],
  category: string,
  source: string,
  created: string,
): void {
  for (const value of values) {
    const summary = value.trim()
    if (summary.length === 0) {
      continue
    }

    candidates.push({
      title: toTitleCase(summary.slice(0, 80)),
      summary,
      category,
      source,
      created,
    })
  }
}

function dedupeCandidates(candidates: NoteCandidate[]): NoteCandidate[] {
  const seen = new Set<string>()
  const output: NoteCandidate[] = []

  for (const candidate of candidates) {
    const key = `${candidate.category}:${candidate.summary.toLowerCase()}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    output.push(candidate)
  }

  return output
}

function buildZettelclawNoteContent(candidate: NoteCandidate): string {
  const escapedSummary = candidate.summary.replaceAll('"', '\\"')
  const escapedSource = candidate.source.replaceAll('"', '\\"')
  const lines = [
    "---",
    'type: "note"',
    `tags: ["reclaw", "${candidate.category}", "memories"]`,
    `summary: "${escapedSummary}"`,
    `source: "${escapedSource}"`,
    `created: "${candidate.created}"`,
    `updated: "${candidate.created}"`,
    "---",
    "",
    `# ${candidate.title}`,
    "",
    candidate.summary,
    "",
    "## Context",
    `- Source: ${candidate.source}`,
    "- Generated by reclaw extraction pipeline.",
    "",
  ]

  return lines.join("\n")
}

async function updateMemoryDoc(filePath: string, insights: AggregatedInsights, model: string): Promise<void> {
  const content = [
    `Updated: ${new Date().toISOString()}`,
    `Model: ${model}`,
    "",
    `Summary: ${insights.summary || "No summary captured."}`,
    "",
    formatInlineList("Projects", insights.projects),
    formatInlineList("Interests", insights.interests),
    formatInlineList("Facts", insights.facts),
    formatInlineList("Preferences", insights.preferences),
    formatInlineList("People", insights.people),
    formatInlineList("Decisions", insights.decisions),
  ].join("\n")

  await upsertManagedSection(filePath, "reclaw-memory", content)
}

async function updateUserDoc(filePath: string, insights: AggregatedInsights, model: string): Promise<void> {
  const content = [
    `Updated: ${new Date().toISOString()}`,
    `Model: ${model}`,
    "",
    "High-priority durable user context:",
    formatBullets(insights.interests.slice(0, 20)),
    formatBullets(insights.projects.slice(0, 20)),
    formatBullets(insights.facts.slice(0, 20)),
    formatBullets(insights.preferences.slice(0, 20)),
    formatBullets(insights.people.slice(0, 20)),
  ].join("\n")

  await upsertManagedSection(filePath, "reclaw-user", content)
}

async function upsertManagedSection(filePath: string, sectionName: string, content: string): Promise<void> {
  const start = `<!-- ${sectionName}:start -->`
  const end = `<!-- ${sectionName}:end -->`
  const block = `${start}\n${content.trim()}\n${end}`

  let existing = ""
  try {
    existing = await readFile(filePath, "utf8")
  } catch {
    existing = ""
  }

  const startIndex = existing.indexOf(start)
  const endIndex = existing.indexOf(end)

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const replaced = `${existing.slice(0, startIndex)}${block}${existing.slice(endIndex + end.length)}`
    await writeFile(filePath, `${replaced.trimEnd()}\n`, "utf8")
    return
  }

  const combined = [existing.trimEnd(), block].filter((chunk) => chunk.length > 0).join("\n\n")
  await writeFile(filePath, `${combined.trimEnd()}\n`, "utf8")
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

function formatInlineList(title: string, values: string[]): string {
  if (values.length === 0) {
    return `${title}: n/a`
  }

  return `${title}: ${values.slice(0, 25).join("; ")}`
}

function formatBullets(values: string[]): string {
  if (values.length === 0) {
    return "- n/a"
  }

  return values.map((value) => `- ${value}`).join("\n")
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

function slugifyTitle(value: string): string {
  const base = value
    .normalize("NFKD")
    .replaceAll(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .toLowerCase()

  return base.length > 0 ? base : "reclaw-note"
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => `${chunk.slice(0, 1).toUpperCase()}${chunk.slice(1)}`)
    .join(" ")
}
