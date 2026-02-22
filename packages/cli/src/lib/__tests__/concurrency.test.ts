import { describe, expect, it } from "bun:test"

import { runWithConcurrency } from "../concurrency"

describe("runWithConcurrency", () => {
  it("processes all items and preserves each index mapping", async () => {
    const items = ["a", "b", "c", "d", "e"]
    const seen: Array<{ item: string; index: number }> = []

    await runWithConcurrency(items, 3, (item, index) => {
      seen.push({ item, index })
      return Promise.resolve()
    })

    expect(seen).toHaveLength(items.length)
    for (const [index, item] of items.entries()) {
      expect(seen.some((entry) => entry.item === item && entry.index === index)).toBeTrue()
    }
  })

  it("normalizes invalid concurrency to at least one worker", async () => {
    const order: number[] = []
    await runWithConcurrency([10, 20], 0, (_, index) => {
      order.push(index)
      return Promise.resolve()
    })

    expect(order.sort((left, right) => left - right)).toEqual([0, 1])
  })

  it("returns immediately for empty input", async () => {
    let calls = 0
    await runWithConcurrency<string>([], 5, () => {
      calls += 1
      return Promise.resolve()
    })
    expect(calls).toBe(0)
  })
})
