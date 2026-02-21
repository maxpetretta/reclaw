#!/usr/bin/env bun

import { homedir } from "node:os"
import { join, resolve } from "node:path"

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
  provider?: Provider
  input?: string
  dryRun: boolean
  help: boolean
}

const DEFAULT_EXTRACTS_PATH = "~/Desktop/extracts"
const DEFAULT_OPENCLAW_WORKSPACE_PATH = "~/.openclaw/workspace"
const DEFAULT_ZETTELCLAW_VAULT_PATH = "~/zettelclaw"

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2))
  if (cliArgs.help) {
    printHelp()
    return
  }

  intro("reclaw - Phase 2 extraction pipeline")

  const selected = await chooseProviders(cliArgs.provider)
  if (cliArgs.provider) {
    log.info(`Provider: ${providerLabels[cliArgs.provider]}`)
  }

  const extractsDir = await chooseInputPath(cliArgs.input)
  log.info(`Input: ${extractsDir}`)

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
    process.exit(1)
  }

  const mode = await chooseOutputMode(cliArgs.mode)
  const targetPath = await promptTargetPath(mode)
  const extractionPlan = planExtractionBatches({
    providerConversations,
    selectedProviders: successfulProviders,
  })
  const statePath = resolve(".reclaw-state.json")

  if (cliArgs.dryRun) {
    const dryRunOptions: {
      mode: ExtractionMode
      targetPath: string
      providerConversations: ProviderConversations
      selectedProviders: Provider[]
      plan: ReturnType<typeof planExtractionBatches>
      statePath: string
      model?: string
    } = {
      mode,
      targetPath,
      providerConversations,
      selectedProviders: successfulProviders,
      plan: extractionPlan,
      statePath,
    }
    if (cliArgs.model) {
      dryRunOptions.model = cliArgs.model
    }

    printDryRunPlan(dryRunOptions)
    outro(
      `Dry run complete. Parsed ${totalConversations} conversations (${totalMessages} messages); no extraction was executed.`,
    )
    return
  }

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
    statePath,
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

async function chooseProviders(preselected: Provider | undefined): Promise<Provider[]> {
  if (preselected) {
    return [preselected]
  }

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

  return selectedProviders as Provider[]
}

async function chooseInputPath(preselected: string | undefined): Promise<string> {
  if (preselected) {
    return resolveHomePath(preselected)
  }

  const extractsInput = await text({
    message: "Path to extracts directory or export file",
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

  return resolveHomePath(extractsInput)
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
  const parsed: CliArgs = {
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (typeof arg !== "string") {
      continue
    }

    if (arg === "--mode") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --mode")
      }
      if (value === "openclaw" || value === "zettelclaw") {
        parsed.mode = value
        index += 1
        continue
      }

      throw new Error(`Invalid --mode value '${value}'. Expected 'openclaw' or 'zettelclaw'.`)
    }

    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length)
      if (value === "openclaw" || value === "zettelclaw") {
        parsed.mode = value
        continue
      }

      throw new Error(`Invalid --mode value '${value}'. Expected 'openclaw' or 'zettelclaw'.`)
    }

    if (arg === "--help" || arg === "-h") {
      parsed.help = true
      continue
    }

    if (arg === "--dry-run" || arg === "--plan") {
      parsed.dryRun = true
      continue
    }

    if (arg === "--model") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --model")
      }
      if (typeof value === "string" && value.trim().length > 0) {
        parsed.model = value.trim()
        index += 1
        continue
      }

      throw new Error("Empty value for --model")
    }

    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length)
      if (value.trim().length > 0) {
        parsed.model = value.trim()
        continue
      }

      throw new Error("Empty value for --model")
    }

    if (arg === "--provider") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --provider")
      }

      const provider = parseProviderArg(value)
      if (!provider) {
        throw new Error(`Invalid --provider value '${value}'. Expected 'chatgpt', 'claude', or 'grok'.`)
      }

      parsed.provider = provider
      index += 1
      continue
    }

    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length)
      const provider = parseProviderArg(value)
      if (!provider) {
        throw new Error(`Invalid --provider value '${value}'. Expected 'chatgpt', 'claude', or 'grok'.`)
      }

      parsed.provider = provider
      continue
    }

    if (arg === "--input") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --input")
      }

      const normalized = value.trim()
      if (normalized.length === 0) {
        throw new Error("Empty value for --input")
      }

      parsed.input = normalized
      index += 1
      continue
    }

    if (arg.startsWith("--input=")) {
      const value = arg.slice("--input=".length).trim()
      if (value.length === 0) {
        throw new Error("Empty value for --input")
      }

      parsed.input = value
      continue
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option '${arg}'. Run 'reclaw --help' for available flags.`)
    }
  }

  return parsed
}

function parseProviderArg(value: string): Provider | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "chatgpt" || normalized === "claude" || normalized === "grok") {
    return normalized
  }

  return undefined
}

function printHelp(): void {
  console.log(
    [
      "reclaw — extract durable memory from AI chat exports",
      "",
      "Usage:",
      "  reclaw [flags]",
      "",
      "Core flags:",
      "  --provider <chatgpt|claude|grok>   Parse only one provider",
      "  --input <path>                      Export directory or provider export file path",
      "  --mode <openclaw|zettelclaw>       Output mode",
      "  --model <model-id>                 OpenClaw model key/alias/name",
      "  --dry-run, --plan                  Parse and preview plan; do not schedule extraction or write files",
      "  -h, --help                         Show help",
      "",
      "Examples:",
      "  reclaw",
      "  reclaw --provider chatgpt --input ./conversations.json",
      "  reclaw --provider claude --input ./claude-export --mode zettelclaw",
      "  reclaw --dry-run --provider grok --input ./grok-export",
    ].join("\n"),
  )
}

function printDryRunPlan(options: {
  mode: ExtractionMode
  targetPath: string
  providerConversations: ProviderConversations
  selectedProviders: Provider[]
  plan: ReturnType<typeof planExtractionBatches>
  statePath: string
  model?: string
}): void {
  const lines = [
    "Dry-run plan (no writes, no subagents):",
    `- Mode: ${options.mode}`,
    `- Target: ${options.targetPath}`,
    `- State file: ${options.statePath}`,
    `- Model: ${options.model ? `${options.model} (provided, not validated)` : "not selected in dry-run"}`,
    `- Providers: ${options.selectedProviders.map((provider) => providerLabels[provider]).join(", ")}`,
    `- Conversations: ${options.plan.conversationCount}`,
    `- Batches: ${options.plan.batches.length}`,
  ]

  for (const provider of options.selectedProviders) {
    const providerConversations = options.providerConversations[provider]
    const providerMessages = providerConversations.reduce((sum, conversation) => sum + conversation.messageCount, 0)
    const providerBatches = options.plan.batches.filter((batch) => batch.provider === provider).length
    lines.push(
      `  - ${providerLabels[provider]}: ${providerConversations.length} conversations, ${providerMessages} messages, ${providerBatches} batches`,
    )
  }

  if (options.mode === "openclaw") {
    const outputFiles = new Set<string>()
    for (const batch of options.plan.batches) {
      outputFiles.add(join(options.targetPath, "memory", `reclaw-${batch.provider}-${batch.date}.md`))
    }

    lines.push(`- OpenClaw memory dir: ${join(options.targetPath, "memory")}`)
    lines.push(`- Planned memory files: ${outputFiles.size}`)
    lines.push(`- Planned update: ${join(options.targetPath, "MEMORY.md")}`)
    lines.push(`- Planned update: ${join(options.targetPath, "USER.md")}`)
  } else {
    lines.push(`- Zettelclaw note output: ${join(options.targetPath, "Inbox")}`)
    lines.push(`- Planned update: ${join(options.targetPath, "MEMORY.md")}`)
    lines.push(`- Planned update: ${join(options.targetPath, "USER.md")}`)
  }

  log.message(lines.join("\n"))
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  log.error(message)
  process.exit(1)
}
