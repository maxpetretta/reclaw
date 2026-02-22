import { describe, expect, it } from "bun:test"

import { uniqueStrings } from "../collections"

describe("uniqueStrings", () => {
  it("deduplicates case-insensitively and trims values", () => {
    expect(uniqueStrings(["  Alpha ", "alpha", "BETA", "beta  ", "  ", "Gamma"])).toEqual(["Alpha", "BETA", "Gamma"])
  })
})
