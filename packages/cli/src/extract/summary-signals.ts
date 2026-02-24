import { uniqueStrings } from "../lib/collections"

export interface SummarySignals {
  interests: string[]
  projects: string[]
  facts: string[]
  preferences: string[]
  people: string[]
  decisions: string[]
  todo: string[]
}

const TAG_ALIASES: Record<string, keyof SummarySignals> = {
  interest: "interests",
  interests: "interests",
  project: "projects",
  projects: "projects",
  fact: "facts",
  facts: "facts",
  preference: "preferences",
  preferences: "preferences",
  person: "people",
  people: "people",
  decision: "decisions",
  decisions: "decisions",
  open: "todo",
  next: "todo",
  todo: "todo",
  followup: "todo",
  "follow-up": "todo",
}

export function extractSummarySignals(summary: string): SummarySignals {
  const lines = splitSummaryLines(summary)
  const signals: SummarySignals = {
    interests: [],
    projects: [],
    facts: [],
    preferences: [],
    people: [],
    decisions: [],
    todo: [],
  }

  for (const line of lines) {
    const tagged = parseTaggedLine(line)
    if (!tagged) {
      signals.facts.push(line)
      continue
    }

    signals[tagged.key].push(tagged.value)
  }

  return {
    interests: uniqueStrings(signals.interests),
    projects: uniqueStrings(signals.projects),
    facts: uniqueStrings(signals.facts),
    preferences: uniqueStrings(signals.preferences),
    people: uniqueStrings(signals.people),
    decisions: uniqueStrings(signals.decisions),
    todo: uniqueStrings(signals.todo),
  }
}

function splitSummaryLines(summary: string): string[] {
  const normalized = summary.replaceAll("\r\n", "\n").trim()
  if (normalized.length === 0) {
    return []
  }

  const chunks = normalized.split("\n")
  const lines: string[] = []

  for (const chunk of chunks) {
    const trimmed = stripListPrefix(chunk)
    if (trimmed.length === 0) {
      continue
    }

    if (trimmed.includes(";")) {
      const parts = trimmed
        .split(";")
        .map((entry) => stripListPrefix(entry).trim())
        .filter((entry) => entry.length > 0)
      if (parts.length > 1) {
        lines.push(...parts)
        continue
      }
    }

    lines.push(trimmed)
  }

  return lines
}

function stripListPrefix(value: string): string {
  return value
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim()
}

function parseTaggedLine(line: string): { key: keyof SummarySignals; value: string } | undefined {
  const match = line.match(/^([a-zA-Z-]+)\s*:\s*(.+)$/)
  if (!(match?.[1] && match[2])) {
    return undefined
  }

  const tag = match[1].trim().toLowerCase()
  const key = TAG_ALIASES[tag]
  if (!key) {
    return undefined
  }

  const value = match[2].trim()
  if (value.length === 0) {
    return undefined
  }

  return { key, value }
}
