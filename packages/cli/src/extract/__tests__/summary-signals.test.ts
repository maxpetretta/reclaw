import { describe, expect, it } from "bun:test"

import { extractSummarySignals } from "../summary-signals"

describe("extractSummarySignals", () => {
  it("extracts tagged categories and falls back unknown lines to facts", () => {
    const signals = extractSummarySignals(`
- project: Reclaw v1
- interest: Observability
- preference: strict provider
- person: Max
- decision: Keep local time
- follow-up: Add docs
- misc line without tag
`)

    expect(signals.projects).toEqual(["Reclaw v1"])
    expect(signals.interests).toEqual(["Observability"])
    expect(signals.preferences).toEqual(["strict provider"])
    expect(signals.people).toEqual(["Max"])
    expect(signals.decisions).toEqual(["Keep local time"])
    expect(signals.todo).toEqual(["Add docs"])
    expect(signals.facts).toEqual(["misc line without tag"])
  })

  it("splits semicolon chunks and deduplicates cleanly", () => {
    const signals = extractSummarySignals("fact: One; fact: one; 2. interest: Bun test")
    expect(signals.facts).toEqual(["One"])
    expect(signals.interests).toEqual(["Bun test"])
  })

  it("returns empty arrays for blank input", () => {
    expect(extractSummarySignals("   ")).toEqual({
      interests: [],
      projects: [],
      facts: [],
      preferences: [],
      people: [],
      decisions: [],
      todo: [],
    })
  })
})
