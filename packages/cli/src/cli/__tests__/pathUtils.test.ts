import { describe, expect, it } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"

import { resolveHomePath } from "../pathUtils"

describe("resolveHomePath", () => {
  it("expands tilde home paths", () => {
    expect(resolveHomePath("~")).toBe(homedir())
    expect(resolveHomePath("~/vault")).toBe(resolve(homedir(), "vault"))
  })

  it("resolves regular paths", () => {
    expect(resolveHomePath("./tmp")).toBe(resolve("./tmp"))
  })
})
