import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isDirectoryPath, isFilePath, pathExists } from "../fs"

describe("fs helpers", () => {
  it("detects existing files and directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "reclaw-fs-test-"))
    const dirPath = join(root, "dir")
    const filePath = join(root, "file.txt")
    await mkdir(dirPath, { recursive: true })
    await writeFile(filePath, "hello", "utf8")

    expect(await pathExists(dirPath)).toBeTrue()
    expect(await pathExists(filePath)).toBeTrue()
    expect(await isDirectoryPath(dirPath)).toBeTrue()
    expect(await isDirectoryPath(filePath)).toBeFalse()
    expect(await isFilePath(filePath)).toBeTrue()
    expect(await isFilePath(dirPath)).toBeFalse()
  })

  it("returns false for missing paths", async () => {
    const missingPath = join(tmpdir(), `reclaw-missing-${Date.now()}`, "nothing.txt")
    expect(await pathExists(missingPath)).toBeFalse()
    expect(await isDirectoryPath(missingPath)).toBeFalse()
    expect(await isFilePath(missingPath)).toBeFalse()
  })
})
