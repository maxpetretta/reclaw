import { describe, expect, it } from "bun:test"

import { parseJson } from "../json"

describe("parseJson", () => {
  it("parses valid JSON", () => {
    const value = parseJson<{ ok: boolean }>('{"ok":true}', (message) => new Error(message))
    expect(value).toEqual({ ok: true })
  })

  it("wraps parse errors using onError", () => {
    expect(() => parseJson("{bad-json}", (message) => new Error(`wrapped:${message.split(":")[0] ?? ""}`))).toThrow(
      "wrapped",
    )
  })
})
