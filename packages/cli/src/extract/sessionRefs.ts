import type { BatchExtractionResult } from "./contracts"

const PROVIDER_LABELS: Record<"chatgpt" | "claude" | "grok", string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
}

export interface SessionEntry {
  id: string
  timestamp?: string
}

export function summarizeProviders(batchResults: BatchExtractionResult[]): string {
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

export function collectSessionRefs(batchResults: BatchExtractionResult[]): string[] {
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

export function collectSessionEntries(results: BatchExtractionResult[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>()

  for (const result of results) {
    for (const entry of collectResultSessionEntries(result)) {
      const existing = byId.get(entry.id)
      if (!existing || (!existing.timestamp && entry.timestamp)) {
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

export function collectResultSessionEntries(result: BatchExtractionResult): SessionEntry[] {
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

export function formatProviderList(providers: BatchExtractionResult["providers"]): string {
  if (providers.length === 0) {
    return "unknown-provider"
  }

  return providers.map((provider) => PROVIDER_LABELS[provider]).join("+")
}
