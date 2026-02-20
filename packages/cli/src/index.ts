#!/usr/bin/env bun

import { homedir } from "node:os"
import { resolve } from "node:path"

import { cancel, confirm, intro, isCancel, log, multiselect, note, outro, select, spinner, text } from "@clack/prompts"
import type { ExtractionMode } from "./extract/contracts"
import { type ProviderConversations, planExtractionBatches, runExtractionPipeline } from "./extract/pipeline"
import { promptModelSelect, readModelsFromOpenClaw } from "./lib/models"
import { parseChatGptConversations } from "./providers/chatgpt"
import { parseClaudeConversations } from "./providers/claude"
import { parseGrokConversations } from "./providers/grok"
import type { NormalizedConversation } from "./types"

const providerLabels = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
} as const

type Provider = keyof typeof providerLabels

interface CliArgs {
  mode?: ExtractionMode
  model?: string
}

const DEFAULT_EXTRACTS_PATH = "~/Desktop/extracts"
const DEFAULT_OPENCLAW_WORKSPACE_PATH = "~/.openclaw/workspace"
const DEFAULT_ZETTELCLAW_VAULT_PATH = "~/zettelclaw"

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2))

  intro("reclaw - Phase 2 extraction pipeline")

  const selectedProviders = await multiselect({
    message: "Select providers to import",
    options: [
      { value: "chatgpt", label: providerLabels.chatgpt },
      { value: "claude", label: providerLabels.claude },
      { value: "grok", label: providerLabels.grok },
    ],
    required: true,
    initialValues: ["chatgpt", "claude", "grok"],
  })

  if (isCancel(selectedProviders)) {
    cancel("Cancelled")
    process.exit(0)
  }

  const extractsInput = await text({
    message: "Path to extracts directory",
    defaultValue: DEFAULT_EXTRACTS_PATH,
    validate: (value) => {
      const normalizedValue = typeof value === "string" ? value : ""
      return normalizedValue.trim().length === 0 ? "Path is required" : undefined
    },
  })

  if (isCancel(extractsInput)) {
    cancel("Cancelled")
    process.exit(0)
  }

  const extractsDir = resolveHomePath(extractsInput)
  log.info(`Extracts: ${extractsDir}`)

  const selected = selectedProviders as Provider[]
  const providerConversations: ProviderConversations = {
    chatgpt: [],
    claude: [],
    grok: [],
  }

  const successfulProviders: Provider[] = []
  let totalConversations = 0
  let totalMessages = 0

  for (const provider of selected) {
    const parsed = await parseProvider(provider, extractsDir)
    if (!parsed) {
      continue
    }

    providerConversations[provider] = parsed
    successfulProviders.push(provider)

    const providerMessages = parsed.reduce((sum, conversation) => sum + conversation.messageCount, 0)
    totalConversations += parsed.length
    totalMessages += providerMessages

    log.success(
      `Found ${parsed.length} conversations from ${providerLabels[provider]} (${providerMessages} messages total)`,
    )
    printConversationList(parsed)
  }

  if (successfulProviders.length === 0) {
    log.error("No providers were parsed successfully.")
    return
  }

  const mode = await chooseOutputMode(cliArgs.mode)

  const modelSpin = spinner()
  modelSpin.start("Loading available models")
  const models = readModelsFromOpenClaw()
  modelSpin.stop("Model list loaded")

  note(
    "Recommended for this workload: Gemini Flash (fast, high context window, good for bulk summarization).",
    "Model Tip",
  )

  const selectedModel = await promptModelSelect(models, cliArgs.model)
  const selectedModelLabel = selectedModel.alias
    ? `${selectedModel.name} (${selectedModel.alias})`
    : `${selectedModel.name} (${selectedModel.key})`
  log.info(`Using model: ${selectedModelLabel}`)

  const targetPath = await promptTargetPath(mode)
  const extractionPlan = planExtractionBatches({
    providerConversations,
    selectedProviders: successfulProviders,
  })

  log.message(
    `Will process ${extractionPlan.conversationCount} conversations in ${extractionPlan.batches.length} batches from ${successfulProviders.length} providers using ${selectedModel.key}.`,
  )

  const shouldProceed = await confirm({
    message: "Proceed with extraction/summarization now?",
    initialValue: true,
  })

  if (isCancel(shouldProceed) || !shouldProceed) {
    cancel("Cancelled")
    process.exit(0)
  }

  const extractionSpin = spinner()
  extractionSpin.start("Running extraction pipeline")

  const result = await runExtractionPipeline({
    providerConversations,
    selectedProviders: successfulProviders,
    mode,
    model: selectedModel.key,
    targetPath,
    statePath: resolve(".reclaw-state.json"),
    batchSize: 12,
    onProgress: (message) => extractionSpin.message(message),
  })

  extractionSpin.stop("Extraction pipeline complete")

  log.success(
    `Batches processed: ${result.processedBatches}, resumed/skipped: ${result.skippedBatches}, total: ${result.totalBatches}`,
  )
  log.success(`Output files created: ${result.artifacts.outputFiles.length}`)

  for (const filePath of result.artifacts.outputFiles) {
    log.step(filePath)
  }

  log.message(
    [
      `Summary: ${result.artifacts.insights.summary || "No summary captured."}`,
      `Projects: ${formatPreview(result.artifacts.insights.projects)}`,
      `Interests: ${formatPreview(result.artifacts.insights.interests)}`,
      `Facts: ${formatPreview(result.artifacts.insights.facts)}`,
      `Preferences: ${formatPreview(result.artifacts.insights.preferences)}`,
      `People: ${formatPreview(result.artifacts.insights.people)}`,
      `Updated: ${result.artifacts.memoryFilePath}`,
      `Updated: ${result.artifacts.userFilePath}`,
      `State: ${result.statePath}`,
    ].join("\n"),
  )

  outro(
    `Done. Parsed ${totalConversations} conversations (${totalMessages} messages) and extracted durable memory artifacts.`,
  )
}

async function chooseOutputMode(preselected: ExtractionMode | undefined): Promise<ExtractionMode> {
  if (preselected) {
    return preselected
  }

  const selectedMode = await select({
    message: "Select output mode",
    initialValue: "openclaw",
    options: [
      { value: "openclaw", label: "OpenClaw" },
      { value: "zettelclaw", label: "Zettelclaw" },
    ],
  })

  if (isCancel(selectedMode)) {
    cancel("Cancelled")
    process.exit(0)
  }

  return selectedMode as ExtractionMode
}

async function promptTargetPath(mode: ExtractionMode): Promise<string> {
  const defaultValue = mode === "openclaw" ? DEFAULT_OPENCLAW_WORKSPACE_PATH : DEFAULT_ZETTELCLAW_VAULT_PATH
  const message =
    mode === "openclaw" ? "OpenClaw workspace path" : "Zettelclaw vault path (Inbox/ will receive output notes)"

  const value = await text({
    message,
    defaultValue,
    validate: (entry) => {
      const normalized = typeof entry === "string" ? entry.trim() : ""
      return normalized.length === 0 ? "Path is required" : undefined
    },
  })

  if (isCancel(value)) {
    cancel("Cancelled")
    process.exit(0)
  }

  return resolveHomePath(value)
}

async function parseProvider(provider: Provider, extractsDir: string): Promise<NormalizedConversation[] | null> {
  const spin = spinner()
  spin.start(`Parsing ${providerLabels[provider]} export...`)

  try {
    const result = await getProviderParser(provider)(extractsDir)
    spin.stop(`Parsed ${providerLabels[provider]} export`)
    return result
  } catch (error) {
    spin.stop(`Failed to parse ${providerLabels[provider]} export`)
    const message = error instanceof Error ? error.message : String(error)
    log.error(message)
    return null
  }
}

function getProviderParser(provider: Provider) {
  switch (provider) {
    case "chatgpt":
      return parseChatGptConversations
    case "claude":
      return parseClaudeConversations
    case "grok":
      return parseGrokConversations
  }
}

function printConversationList(conversations: NormalizedConversation[]) {
  for (const conversation of conversations) {
    const date = conversation.createdAt.slice(0, 10)
    const paddedCount = String(conversation.messageCount).padStart(4, " ")
    console.log(`${date} | ${paddedCount} msgs | ${conversation.title}`)
  }
}

function resolveHomePath(value: string): string {
  if (value === "~") {
    return homedir()
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2))
  }

  return resolve(value)
}

function formatPreview(values: string[]): string {
  if (values.length === 0) {
    return "n/a"
  }

  return values.slice(0, 6).join("; ")
}

function parseCliArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (typeof arg !== "string") {
      continue
    }

    if (arg === "--mode") {
      const value = args[index + 1]
      if (value === "openclaw" || value === "zettelclaw") {
        parsed.mode = value
        index += 1
      }
      continue
    }

    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length)
      if (value === "openclaw" || value === "zettelclaw") {
        parsed.mode = value
      }
      continue
    }

    if (arg === "--model") {
      const value = args[index + 1]
      if (typeof value === "string" && value.trim().length > 0) {
        parsed.model = value.trim()
        index += 1
      }
      continue
    }

    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length)
      if (value.trim().length > 0) {
        parsed.model = value.trim()
      }
    }
  }

  return parsed
}

await main()
