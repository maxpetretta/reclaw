import { describe, expect, it } from "bun:test"

import type { BatchExtractionResult } from "../contracts"
import {
  collectResultSessionEntries,
  collectSessionEntries,
  collectSessionRefs,
  formatProviderList,
  summarizeProviders,
} from "../sessionRefs"

describe("sessionRefs", () => {
  it("summarizes provider counts using conversation refs and fallback counts", () => {
    const results = [
      batch({
        providers: ["chatgpt"],
        conversationRefs: [
          { provider: "chatgpt", id: "a1" },
          { provider: "chatgpt", id: "a2" },
        ],
      }),
      batch({
        providers: ["grok"],
        conversationRefs: [],
        conversationIds: ["g1"],
        conversationCount: 1,
      }),
    ]

    expect(summarizeProviders(results)).toBe("ChatGPT (2), Grok (1)")
  })

  it("collects unique session refs and normalizes unknown timestamps", () => {
    const refs = collectSessionRefs([
      batch({
        providers: ["claude"],
        conversationRefs: [{ provider: "claude", id: "  c-1  ", timestamp: "2026-02-22T10:00:00.000Z" }],
      }),
      batch({
        providers: ["claude"],
        conversationRefs: [{ provider: "claude", id: "c-1", timestamp: "" }],
      }),
      batch({
        providers: ["chatgpt"],
        conversationRefs: [],
        conversationIds: ["cg-1"],
      }),
    ])

    expect(refs).toEqual(["chatgpt:cg-1 — unknown", "claude:c-1 — 2026-02-22T10:00:00.000Z", "claude:c-1 — unknown"])
  })

  it("prefers timestamped entries when collecting session entries", () => {
    const results = [
      batch({
        providers: ["chatgpt"],
        conversationRefs: [
          { provider: "chatgpt", id: "x", timestamp: "" },
          { provider: "chatgpt", id: "y", timestamp: "2026-02-22T09:00:00.000Z" },
        ],
      }),
      batch({
        providers: ["chatgpt"],
        conversationRefs: [{ provider: "chatgpt", id: "x", timestamp: "2026-02-22T08:00:00.000Z" }],
      }),
    ]

    expect(collectSessionEntries(results)).toEqual([
      { id: "chatgpt:x", timestamp: "2026-02-22T08:00:00.000Z" },
      { id: "chatgpt:y", timestamp: "2026-02-22T09:00:00.000Z" },
    ])
  })

  it("falls back to conversationIds when no conversationRefs are present", () => {
    const result = batch({
      providers: ["grok"],
      conversationRefs: [],
      conversationIds: ["g-1", "  ", "g-1"],
    })
    expect(collectResultSessionEntries(result)).toEqual([{ id: "grok:g-1" }])
  })

  it("formats provider list safely", () => {
    expect(formatProviderList(["chatgpt", "claude"])).toBe("ChatGPT+Claude")
    expect(formatProviderList([])).toBe("unknown-provider")
  })
})

function batch(overrides: Partial<BatchExtractionResult>): BatchExtractionResult {
  return {
    batchId: "b1",
    providers: overrides.providers ?? ["chatgpt"],
    date: "2026-02-22",
    conversationIds: overrides.conversationIds ?? ["id-1"],
    conversationRefs: overrides.conversationRefs ?? [{ provider: "chatgpt", id: "id-1" }],
    conversationCount: overrides.conversationCount ?? 1,
    extraction: { summary: overrides.extraction?.summary ?? "" },
  }
}
