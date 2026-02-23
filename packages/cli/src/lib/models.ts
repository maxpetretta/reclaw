import { isCancel, select } from "@clack/prompts"

import { runOpenClaw } from "./openclaw"

interface JsonRecord {
  [key: string]: unknown
}

export interface ModelInfo {
  key: string
  name: string
  alias?: string
  isDefault: boolean
}

export function parseModels(json: string): ModelInfo[] {
  let parsedValue: unknown

  try {
    parsedValue = JSON.parse(json)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`OpenClaw returned invalid model JSON: ${message}`)
  }

  const parsed = asRecord(parsedValue)
  const rawModels = Array.isArray(parsed.models) ? parsed.models : []

  return rawModels
    .map((rawModel) => {
      const model = asRecord(rawModel)
      const key = typeof model.key === "string" ? model.key : ""
      const name = typeof model.name === "string" && model.name.length > 0 ? model.name : key
      const tags = asStringArray(model.tags)
      const missing = model.missing === true || tags.includes("missing")
      if (missing || key.length === 0) {
        return null
      }

      const alias = tags.find((tag) => tag.startsWith("alias:"))?.slice(6)
      const result: ModelInfo = {
        key,
        name,
        isDefault: tags.includes("default"),
      }

      if (alias && alias.length > 0) {
        result.alias = alias
      }

      return result
    })
    .filter((model): model is ModelInfo => model !== null)
}

export function readModelsFromOpenClaw(): ModelInfo[] {
  const direct = runOpenClaw(["models", "--json"], { allowFailure: true, timeoutMs: 15_000 })
  if (direct.status === 0 && direct.stdout.trim().length > 0) {
    const models = parseModels(direct.stdout)
    if (models.length > 0) {
      return models
    }
  }

  const fallback = runOpenClaw(["models", "list", "--json"], { allowFailure: true, timeoutMs: 15_000 })
  if (fallback.status !== 0 || fallback.stdout.trim().length === 0) {
    const detail = fallback.stderr.trim() || direct.stderr.trim() || "Could not list models from OpenClaw"
    throw new Error(detail)
  }

  const models = parseModels(fallback.stdout)
  if (models.length === 0) {
    throw new Error("OpenClaw returned no models")
  }

  return models
}

export async function promptModelSelect(models: ModelInfo[], requestedModel?: string): Promise<ModelInfo> {
  if (models.length === 0) {
    throw new Error("OpenClaw returned no models")
  }

  if (requestedModel) {
    const requested = resolveRequestedModel(models, requestedModel)
    if (!requested) {
      const available = models.map((model) => (model.alias ? `${model.key} (${model.alias})` : model.key)).join(", ")
      throw new Error(`Model not found: ${requestedModel}. Available models: ${available}`)
    }

    return requested
  }

  const defaultModel = models.find((model) => model.isDefault) ?? models[0]
  if (!defaultModel) {
    throw new Error("OpenClaw returned no models")
  }

  const selectedKey = unwrapPrompt(
    await select({
      message: "Select model for extraction subagents (Recommended: Claude Haiku 4.5, Gemini 3 Flash)",
      initialValue: defaultModel.key,
      options: models.map((model) => {
        const baseLabel = model.alias ? `${model.name} (${model.alias})` : `${model.name} (${model.key})`
        return {
          value: model.key,
          label: model.key === defaultModel.key ? `${baseLabel} - default` : baseLabel,
        }
      }),
    }),
  )

  const selected = models.find((model) => model.key === selectedKey)
  if (!selected) {
    throw new Error("Could not resolve selected model")
  }

  return selected
}

function resolveRequestedModel(models: ModelInfo[], requested: string): ModelInfo | undefined {
  const normalizedRequest = requested.trim().toLowerCase()

  return models.find((model) => {
    const candidates = [model.key, model.alias, model.name]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.toLowerCase())

    return candidates.includes(normalizedRequest)
  })
}

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    process.exit(0)
  }

  return value as T
}

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord
  }

  return {}
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((entry): entry is string => typeof entry === "string")
}
