import { describe, expect, it } from "bun:test"

import { formatLocalDate, toIsoTimestamp, toLocalDateKey } from "../timestamps"

describe("timestamps", () => {
  it("normalizes epoch seconds and milliseconds", () => {
    expect(toIsoTimestamp(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z")
    expect(toIsoTimestamp(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z")
    expect(toIsoTimestamp("1700000000")).toBe("2023-11-14T22:13:20.000Z")
  })

  it("normalizes mongo-style date objects", () => {
    expect(toIsoTimestamp({ $date: { $numberLong: "1700000000000" } })).toBe("2023-11-14T22:13:20.000Z")
  })

  it("returns undefined for invalid values", () => {
    expect(toIsoTimestamp("")).toBeUndefined()
    expect(toIsoTimestamp("not-a-date")).toBeUndefined()
    expect(toIsoTimestamp({ nope: true })).toBeUndefined()
  })

  it("falls back to YYYY-MM-DD prefix when local date parsing fails", () => {
    expect(toLocalDateKey("2026-01-02-not-iso")).toBe("2026-01-02")
  })

  it("formats local date with zero padding", () => {
    expect(formatLocalDate(new Date(2026, 0, 2))).toBe("2026-01-02")
  })
})
