#!/usr/bin/env bun

import { join, resolve } from "node:path"

import { cancel, confirm, intro, isCancel, log, multiselect, note, outro, select, spinner, text } from "@clack/prompts"

import { parseCliArgs, printHelp } from "./cli/args"
import {
  ALL_PROVIDERS,
  DEFAULT_EXTRACTS_PATH,
  DEFAULT_OPENCLAW_WORKSPACE_PATH,
  DEFAULT_PARALLEL_JOBS,
  DEFAULT_STATE_PATH,
  DEFAULT_ZETTELCLAW_VAULT_PATH,
  type Provider,
  providerLabels,
} from "./cli/constants"
import { prepareInputSources } from "./cli/inputDiscovery"
import { resolveHomePath } from "./cli/pathUtils"
import type { BackupMode, ExtractionMode } from "./extract/contracts"
import { type ProviderConversations, planExtractionBatches, runExtractionPipeline } from "./extract/pipeline"
import { uniqueStrings } from "./lib/collections"
import { promptModelSelect, readModelsFromOpenClaw } from "./lib/models"
import {
  importLegacySessionsToOpenClawHistory,
  type LegacySessionImportResult,
  type LegacySessionMode,
} from "./lib/openclawSessions"
import { parseChatGptConversations } from "./providers/chatgpt"
import { parseClaudeConversations } from "./providers/claude"
import { parseGrokConversations } from "./providers/grok"
import type { NormalizedConversation } from "./types"

interface ParsedProviderResult {
  conversations: NormalizedConversation[]
  sourcePath: string
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2))
  if (cliArgs.help) {
    printHelp()
    return
  }

  intro("reclaw - Phase 2 extraction pipeline")

  const extractsDir = await chooseInputPath(cliArgs.input, cliArgs.yes)
  log.info(`Input: ${extractsDir}`)
  const preparedInput = await prepareInputSources(extractsDir)
  for (const warning of preparedInput.warnings) {
    log.error(warning)
  }
  const detectedProviders = preparedInput.detectedProviders

  if (preparedInput.extractedArchiveCount > 0) {
    const destination = preparedInput.extractionRootPath ?? "temporary workspace"
    log.info(`Auto-extracted ${preparedInput.extractedArchiveCount} archive(s) into ${destination}`)
  }

  if (!cliArgs.provider && detectedProviders.length > 0) {
    log.info(
      `Auto-detected provider exports: ${detectedProviders.map((provider) => providerLabels[provider]).join(", ")}`,
    )
  }

  const selected = await chooseProviders(cliArgs.provider, detectedProviders, cliArgs.yes)
  if (cliArgs.provider) {
    log.info(`Provider: ${providerLabels[cliArgs.provider]}`)
  }

  const providerConversations: ProviderConversations = {
    chatgpt: [],
    claude: [],
    grok: [],
  }
  const providerSourcePaths: Partial<Record<Provider, string>> = {}

  const successfulProviders: Provider[] = []
  let totalConversations = 0
  let totalMessages = 0

  for (const provider of selected) {
    const parseCandidates = preparedInput.parseCandidatesByProvider[provider]
    const parsed = await parseProvider(provider, parseCandidates)
    if (!parsed) {
      continue
    }

    providerConversations[provider] = parsed.conversations
    providerSourcePaths[provider] = parsed.sourcePath
    successfulProviders.push(provider)

    const providerMessages = parsed.conversations.reduce((sum, conversation) => sum + conversation.messageCount, 0)
    totalConversations += parsed.conversations.length
    totalMessages += providerMessages

    log.success(
      `Found ${parsed.conversations.length} conversations from ${providerLabels[provider]} (${providerMessages} messages total)`,
    )
  }

  if (successfulProviders.length === 0) {
    log.error("No providers were parsed successfully.")
    process.exit(1)
  }

  const modeFromWorkspace = cliArgs.workspace && !cliArgs.mode ? "openclaw" : cliArgs.mode
  const mode = await chooseOutputMode(modeFromWorkspace, cliArgs.yes)
  if (mode === "openclaw" && cliArgs.workspace && cliArgs.targetPath) {
    const workspacePath = resolveHomePath(cliArgs.workspace)
    const explicitTargetPath = resolveHomePath(cliArgs.targetPath)
    if (workspacePath !== explicitTargetPath) {
      throw new Error("Cannot combine --workspace and --target-path with different values.")
    }
  }

  const preselectedTargetPath = mode === "openclaw" ? (cliArgs.workspace ?? cliArgs.targetPath) : cliArgs.targetPath
  const targetPath = await promptTargetPath(mode, preselectedTargetPath, cliArgs.yes)
  const legacySessionMode = resolveLegacySessionMode(cliArgs.legacySessions)
  const legacyWorkspacePath =
    mode === "openclaw" ? targetPath : resolveHomePath(cliArgs.workspace ?? DEFAULT_OPENCLAW_WORKSPACE_PATH)
  if (typeof cliArgs.subagentBatchSize === "number" && cliArgs.subagentBatchSize !== 1) {
    log.info("Ignoring --subagent-batch-size; Reclaw now runs one merged extraction batch per day.")
  }
  const parallelJobs = cliArgs.parallelJobs ?? DEFAULT_PARALLEL_JOBS
  const backupMode: BackupMode = cliArgs.timestampedBackups ? "timestamped" : "overwrite"

  const extractionPlan = planExtractionBatches({
    providerConversations,
    selectedProviders: successfulProviders,
  })
  const statePath = cliArgs.statePath ? resolveHomePath(cliArgs.statePath) : resolve(DEFAULT_STATE_PATH)

  if (cliArgs.dryRun) {
    const dryRunOptions: {
      mode: ExtractionMode
      targetPath: string
      legacyWorkspacePath: string
      providerConversations: ProviderConversations
      selectedProviders: Provider[]
      plan: ReturnType<typeof planExtractionBatches>
      statePath: string
      legacySessionMode: LegacySessionMode
      parallelJobs: number
      backupMode: BackupMode
      model?: string
    } = {
      mode,
      targetPath,
      legacyWorkspacePath,
      providerConversations,
      selectedProviders: successfulProviders,
      plan: extractionPlan,
      statePath,
      legacySessionMode,
      parallelJobs,
      backupMode,
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

  note("Recommended: Claude Haiku, Gemini Flash.", "Model Tip")

  const selectedModel =
    cliArgs.yes && !cliArgs.model ? resolveDefaultModel(models) : await promptModelSelect(models, cliArgs.model)
  const selectedModelLabel = selectedModel.alias
    ? `${selectedModel.name} (${selectedModel.alias})`
    : `${selectedModel.name} (${selectedModel.key})`
  log.info(`Using model: ${selectedModelLabel}`)

  log.message(
    `Will process ${extractionPlan.conversationCount} conversations in ${extractionPlan.batches.length} day-grouped batches from ${successfulProviders.length} providers using ${selectedModel.key} (${parallelJobs} parallel job(s)).`,
  )

  if (!cliArgs.yes) {
    const shouldProceed = await confirm({
      message: "Proceed with extraction/summarization now?",
      initialValue: true,
    })

    if (isCancel(shouldProceed) || !shouldProceed) {
      cancel("Cancelled")
      process.exit(0)
    }
  } else {
    log.info("Auto-confirm enabled (--yes); proceeding without prompt.")
  }

  let legacyImportResult: LegacySessionImportResult | undefined
  if (legacySessionMode !== "off") {
    const sessionImportSpin = spinner()
    sessionImportSpin.start("Importing legacy sessions into OpenClaw history")
    try {
      legacyImportResult = await importLegacySessionsToOpenClawHistory({
        workspacePath: legacyWorkspacePath,
        providers: successfulProviders.map((provider) => ({
          provider,
          sourcePath: providerSourcePaths[provider] ?? extractsDir,
          conversations: providerConversations[provider],
        })),
      })
      sessionImportSpin.stop(
        `Legacy sessions synced (${legacyImportResult.imported} imported, ${legacyImportResult.updated} updated, ${legacyImportResult.skipped} skipped, ${legacyImportResult.failed} failed)`,
      )
    } catch (error) {
      sessionImportSpin.stop("Legacy session import failed")
      const message = error instanceof Error ? error.message : String(error)
      if (legacySessionMode === "required") {
        throw new Error(`Legacy session import failed (--legacy-sessions=required): ${message}`)
      }

      log.error(`Legacy session import failed (continuing): ${message}`)
    }
  }

  if (legacyImportResult && legacyImportResult.failed > 0) {
    for (const failure of legacyImportResult.errors.slice(0, 8)) {
      log.error(
        `Legacy import failed for ${providerLabels[failure.provider]} '${failure.conversationTitle}' (${failure.conversationId}): ${failure.reason}`,
      )
    }

    if (legacyImportResult.errors.length > 8) {
      log.error(`...and ${legacyImportResult.errors.length - 8} more legacy import error(s).`)
    }

    if (legacySessionMode === "required") {
      throw new Error(
        `Legacy session import failed for ${legacyImportResult.failed}/${legacyImportResult.attempted} sessions.`,
      )
    }
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
    backupMode,
    maxParallelJobs: parallelJobs,
    onProgress: (message) => extractionSpin.message(message),
  })

  extractionSpin.stop("Extraction pipeline complete")

  const batchSummaryLine = `Batches processed: ${result.processedBatches}, failed: ${result.failedBatches}, resumed/skipped: ${result.skippedBatches}, total: ${result.totalBatches}`
  if (result.failedBatches > 0) {
    log.error(batchSummaryLine)
  } else {
    log.success(batchSummaryLine)
  }

  if (result.failedBatchErrors.length > 0) {
    for (const failure of result.failedBatchErrors.slice(0, 8)) {
      log.error(failure)
    }
    if (result.failedBatchErrors.length > 8) {
      log.error(`...and ${result.failedBatchErrors.length - 8} more batch failure(s).`)
    }
  }

  log.success(`Output files created: ${result.artifacts.outputFiles.length}`)

  const summaryLines = [
    `Summary: ${clipLogText(result.artifacts.insights.summary || "No summary captured.", 220)}`,
    `Insight counts: projects=${result.artifacts.insights.projects.length}, interests=${result.artifacts.insights.interests.length}, facts=${result.artifacts.insights.facts.length}, preferences=${result.artifacts.insights.preferences.length}, people=${result.artifacts.insights.people.length}`,
  ]

  if (result.artifacts.memoryFilePath) {
    summaryLines.push(`Updated: ${result.artifacts.memoryFilePath}`)
  }

  if (result.artifacts.userFilePath) {
    summaryLines.push(`Updated: ${result.artifacts.userFilePath}`)
  }

  summaryLines.push(`State: ${result.statePath}`)
  summaryLines.push(
    legacyImportResult
      ? `Legacy sessions: ${legacyImportResult.imported} imported, ${legacyImportResult.updated} updated, ${legacyImportResult.skipped} skipped, ${legacyImportResult.failed} failed (${legacyImportResult.sessionStorePath})`
      : "Legacy sessions: disabled",
  )

  log.message(summaryLines.join("\n"))

  outro(
    `Done. Parsed ${totalConversations} conversations (${totalMessages} messages) and extracted durable memory artifacts.`,
  )
}

async function chooseOutputMode(
  preselected: ExtractionMode | undefined,
  nonInteractive: boolean,
): Promise<ExtractionMode> {
  if (preselected) {
    return preselected
  }

  if (nonInteractive) {
    return "openclaw"
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

async function chooseProviders(
  preselected: Provider | undefined,
  suggestedProviders: Provider[],
  nonInteractive: boolean,
): Promise<Provider[]> {
  if (preselected) {
    return [preselected]
  }

  if (nonInteractive) {
    return suggestedProviders.length > 0 ? suggestedProviders : ALL_PROVIDERS
  }

  const initialValues = suggestedProviders.length > 0 ? suggestedProviders : ALL_PROVIDERS
  const selectedProviders = await multiselect({
    message: "Select providers to import (Space to select, Enter to confirm)",
    options: [
      { value: "chatgpt", label: providerLabels.chatgpt },
      { value: "claude", label: providerLabels.claude },
      { value: "grok", label: providerLabels.grok },
    ],
    required: true,
    initialValues,
  })

  if (isCancel(selectedProviders)) {
    cancel("Cancelled")
    process.exit(0)
  }

  return selectedProviders as Provider[]
}

async function chooseInputPath(preselected: string | undefined, nonInteractive: boolean): Promise<string> {
  if (preselected) {
    return resolveHomePath(preselected)
  }

  if (nonInteractive) {
    return resolveHomePath(DEFAULT_EXTRACTS_PATH)
  }

  const extractsInput = await text({
    message: "Path to extracts directory or export file",
    placeholder: DEFAULT_EXTRACTS_PATH,
    defaultValue: DEFAULT_EXTRACTS_PATH,
  })

  if (isCancel(extractsInput)) {
    cancel("Cancelled")
    process.exit(0)
  }

  const normalizedInput = typeof extractsInput === "string" ? extractsInput.trim() : ""
  return resolveHomePath(normalizedInput.length > 0 ? normalizedInput : DEFAULT_EXTRACTS_PATH)
}

async function promptTargetPath(
  mode: ExtractionMode,
  preselected: string | undefined,
  nonInteractive: boolean,
): Promise<string> {
  if (preselected) {
    return resolveHomePath(preselected)
  }

  const defaultValue = mode === "openclaw" ? DEFAULT_OPENCLAW_WORKSPACE_PATH : DEFAULT_ZETTELCLAW_VAULT_PATH
  const message =
    mode === "openclaw" ? "OpenClaw workspace path" : "Zettelclaw vault path (Journal/ will receive output notes)"

  if (nonInteractive) {
    return resolveHomePath(defaultValue)
  }

  const value = await text({
    message,
    placeholder: defaultValue,
    defaultValue,
  })

  if (isCancel(value)) {
    cancel("Cancelled")
    process.exit(0)
  }

  const normalized = typeof value === "string" ? value.trim() : ""
  return resolveHomePath(normalized.length > 0 ? normalized : defaultValue)
}

async function parseProvider(provider: Provider, parseCandidates: string[]): Promise<ParsedProviderResult | null> {
  const spin = spinner()
  spin.start(`Parsing ${providerLabels[provider]} export...`)

  const parser = getProviderParser(provider)
  const errors: string[] = []
  for (const candidate of parseCandidates) {
    try {
      const result = await parser(candidate)
      spin.stop(`Parsed ${providerLabels[provider]} export`)
      return {
        conversations: result,
        sourcePath: candidate,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message)
    }
  }

  spin.stop(`Failed to parse ${providerLabels[provider]} export`)
  for (const error of uniqueStrings(errors)) {
    log.error(error)
  }

  return null
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

function resolveDefaultModel(models: ReturnType<typeof readModelsFromOpenClaw>) {
  const selected = models.find((model) => model.isDefault) ?? models[0]
  if (!selected) {
    throw new Error("OpenClaw returned no models")
  }

  return selected
}

function resolveLegacySessionMode(requestedMode: LegacySessionMode | undefined): LegacySessionMode {
  if (requestedMode) {
    return requestedMode
  }

  return "on"
}

function clipLogText(value: string, maxChars: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim()
  if (normalized.length <= maxChars) {
    return normalized
  }

  return `${normalized.slice(0, maxChars)}...`
}

function printDryRunPlan(options: {
  mode: ExtractionMode
  targetPath: string
  legacyWorkspacePath: string
  providerConversations: ProviderConversations
  selectedProviders: Provider[]
  plan: ReturnType<typeof planExtractionBatches>
  statePath: string
  legacySessionMode: LegacySessionMode
  parallelJobs: number
  backupMode: BackupMode
  model?: string
}): void {
  const backupPathSuffix = options.backupMode === "timestamped" ? ".bak.<timestamp>" : ".bak"
  const lines = [
    "Dry-run plan (no writes, no subagents):",
    `- Mode: ${options.mode}`,
    `- Target: ${options.targetPath}`,
    `- State file: ${options.statePath}`,
    `- Model: ${options.model ? `${options.model} (provided, not validated)` : "not selected in dry-run"}`,
    "- Batch strategy: one subagent per day (all same-day conversations merged before extraction)",
    `- Parallel subagent jobs: ${options.parallelJobs}`,
    `- Backup mode: ${options.backupMode}`,
    `- Providers: ${options.selectedProviders.map((provider) => providerLabels[provider]).join(", ")}`,
    `- Conversations: ${options.plan.conversationCount}`,
    `- Batches: ${options.plan.batches.length}`,
  ]

  for (const provider of options.selectedProviders) {
    const providerData = options.providerConversations[provider]
    const providerMessages = providerData.reduce((sum, conversation) => sum + conversation.messageCount, 0)
    const providerBatches = options.plan.batches.filter((batch) =>
      batch.conversations.some((conversation) => conversation.source === provider),
    ).length
    lines.push(
      `  - ${providerLabels[provider]}: ${providerData.length} conversations, ${providerMessages} messages, ${providerBatches} batches`,
    )
  }

  if (options.mode === "openclaw") {
    const outputFiles = new Set<string>()
    for (const batch of options.plan.batches) {
      outputFiles.add(join(options.targetPath, "memory", `${batch.date}.md`))
    }

    lines.push(`- OpenClaw memory dir: ${join(options.targetPath, "memory")}`)
    lines.push(`- Planned memory files: ${outputFiles.size}`)
    lines.push(`- Planned main-agent update: ${join(options.targetPath, "MEMORY.md")}`)
    lines.push(`- Planned main-agent update: ${join(options.targetPath, "USER.md")}`)
    lines.push(`- Planned backup: ${join(options.targetPath, `MEMORY.md${backupPathSuffix}`)}`)
    lines.push(`- Planned backup: ${join(options.targetPath, `USER.md${backupPathSuffix}`)}`)
    lines.push(`- Legacy sessions: ${options.legacySessionMode}`)
    if (options.legacySessionMode !== "off") {
      lines.push(`- Planned legacy session imports: ${options.plan.conversationCount}`)
      lines.push(`- Legacy import workspace: ${options.legacyWorkspacePath}`)
      lines.push("- Legacy markers: origin.label=reclaw-legacy-import, customType=reclaw:legacy-source")
    }
  } else {
    lines.push(`- Zettelclaw journal output: ${join(options.targetPath, "03 Journal")}`)
    lines.push("- Zettelclaw inbox notes: none")
    lines.push("- Planned typed-note updates: none (handled by user/nightly agent workflows)")
    lines.push(`- Planned main-agent update: ${join(options.targetPath, "MEMORY.md")}`)
    lines.push(`- Planned main-agent update: ${join(options.targetPath, "USER.md")}`)
    lines.push(`- Planned backup: ${join(options.targetPath, `MEMORY.md${backupPathSuffix}`)}`)
    lines.push(`- Planned backup: ${join(options.targetPath, `USER.md${backupPathSuffix}`)}`)
    lines.push(`- Legacy sessions: ${options.legacySessionMode}`)
    if (options.legacySessionMode !== "off") {
      lines.push(`- Planned legacy session imports: ${options.plan.conversationCount}`)
      lines.push(`- Legacy import workspace: ${options.legacyWorkspacePath}`)
      lines.push("- Legacy markers: origin.label=reclaw-legacy-import, customType=reclaw:legacy-source")
    }
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
