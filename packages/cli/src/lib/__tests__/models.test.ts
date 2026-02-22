import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { enqueueSpawnResult, getSpawnCalls, resetSpawnMock } from "../../test/spawnMock"
import type { ModelInfo } from "../models"

let selectResult: string | symbol = "model-default"
let cancelSentinel: symbol = Symbol("cancel")

mock.module("@clack/prompts", () => ({
  select: async () => selectResult,
  isCancel: (value: unknown) => value === cancelSentinel,
}))

let models: typeof import("../models")

describe("models", () => {
  beforeAll(async () => {
    models = await import("../models")
  })

  beforeEach(() => {
    resetSpawnMock()
    selectResult = "model-default"
    cancelSentinel = Symbol("cancel")
  })

  it("parses model JSON and filters missing entries", () => {
    const parsed = models.parseModels(
      JSON.stringify({
        models: [
          { key: "model-default", name: "Default", tags: ["default", "alias:fast"] },
          { key: "model-full", name: "Full", tags: [] },
          { key: "model-missing", name: "Missing", tags: ["missing"] },
          { key: "", name: "Broken", tags: [] },
        ],
      }),
    )

    expect(parsed).toEqual([
      { key: "model-default", name: "Default", alias: "fast", isDefault: true },
      { key: "model-full", name: "Full", isDefault: false },
    ])
  })

  it("throws on invalid model JSON", () => {
    expect(() => models.parseModels("{bad json}")).toThrow("OpenClaw returned invalid model JSON")
  })

  it("reads models from primary openclaw command", () => {
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({ models: [{ key: "k1", name: "n1", tags: ["default"] }] }),
      stderr: "",
    })

    expect(models.readModelsFromOpenClaw()).toEqual([{ key: "k1", name: "n1", isDefault: true }])
    expect(getSpawnCalls().map((entry) => entry.args)).toEqual([["models", "--json"]])
  })

  it("falls back to models list command when primary output is unusable", () => {
    enqueueSpawnResult({
      status: 1,
      stdout: "",
      stderr: "primary failed",
    })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({ models: [{ key: "k2", name: "n2", tags: [] }] }),
      stderr: "",
    })

    expect(models.readModelsFromOpenClaw()).toEqual([{ key: "k2", name: "n2", isDefault: false }])
    expect(getSpawnCalls().map((entry) => entry.args)).toEqual([
      ["models", "--json"],
      ["models", "list", "--json"],
    ])
  })

  it("throws when fallback listing fails", () => {
    enqueueSpawnResult({ status: 1, stdout: "", stderr: "primary failed" })
    enqueueSpawnResult({ status: 1, stdout: "", stderr: "fallback failed" })

    expect(() => models.readModelsFromOpenClaw()).toThrow("fallback failed")
  })

  it("resolves requested model by key/alias/name", async () => {
    const sample = modelSet()
    const [defaultModel, fullModel] = sample
    if (!(defaultModel && fullModel)) {
      throw new Error("test model set is incomplete")
    }

    await expect(models.promptModelSelect(sample, "model-default")).resolves.toBe(defaultModel)
    await expect(models.promptModelSelect(sample, "fast")).resolves.toBe(defaultModel)
    await expect(models.promptModelSelect(sample, "Full Model")).resolves.toBe(fullModel)
  })

  it("throws for unknown requested model", async () => {
    await expect(models.promptModelSelect(modelSet(), "missing-model")).rejects.toThrow("Model not found")
  })

  it("prompts for model when none requested", async () => {
    const sample = modelSet()
    const fullModel = sample[1]
    if (!fullModel) {
      throw new Error("test model set is incomplete")
    }

    selectResult = "model-full"
    const selected = await models.promptModelSelect(sample)
    expect(selected).toEqual(fullModel)
  })

  it("throws when selected key cannot be resolved", async () => {
    selectResult = "unknown-key"
    await expect(models.promptModelSelect(modelSet())).rejects.toThrow("Could not resolve selected model")
  })
})

function modelSet(): ModelInfo[] {
  return [
    { key: "model-default", name: "Default Model", alias: "fast", isDefault: true },
    { key: "model-full", name: "Full Model", isDefault: false },
  ]
}
