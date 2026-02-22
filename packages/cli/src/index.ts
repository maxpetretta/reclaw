#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { cancel, confirm, intro, isCancel, log, multiselect, note, outro, select, spinner, text } from "@clack/prompts"
import type { BackupMode, ExtractionMode } from "./extract/contracts"
import { type ProviderConversations, planExtractionBatches, runExtractionPipeline } from "./extract/pipeline"
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

const providerLabels = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
} as const

type Provider = keyof typeof providerLabels
const ALL_PROVIDERS: Provider[] = ["chatgpt", "claude", "grok"]
const ZIP_SCAN_MAX_DEPTH = 3

interface PreparedInputSources {
  detectedProviders: Provider[]
  parseCandidatesByProvider: Record<Provider, string[]>
  extractedArchiveCount: number
  extractionRootPath?: string
}

interface CliArgs {
  mode?: ExtractionMode
  model?: string
  provider?: Provider
  input?: string
  workspace?: string
  targetPath?: string
  statePath?: string
  legacySessions?: LegacySessionMode
  subagentBatchSize?: number
  parallelJobs?: number
  timestampedBackups: boolean
  yes: boolean
  dryRun: boolean
  help: boolean
}

interface ParsedProviderResult {
  conversations: NormalizedConversation[]
  sourcePath: string
}

const DEFAULT_EXTRACTS_PATH = "~/Desktop"
const DEFAULT_OPENCLAW_WORKSPACE_PATH = "~/.openclaw/workspace"
const DEFAULT_ZETTELCLAW_VAULT_PATH = "~/zettelclaw"
const DEFAULT_PARALLEL_JOBS = 5
const DEFAULT_STATE_PATH = ".reclaw-state.json"

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
  const legacySessionMode = resolveLegacySessionMode(cliArgs.legacySessions, mode)
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

function resolveHomePath(value: string): string {
  if (value === "~") {
    return homedir()
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2))
  }

  return resolve(value)
}

function resolveDefaultModel(models: ReturnType<typeof readModelsFromOpenClaw>) {
  const selected = models.find((model) => model.isDefault) ?? models[0]
  if (!selected) {
    throw new Error("OpenClaw returned no models")
  }

  return selected
}

async function prepareInputSources(inputPath: string): Promise<PreparedInputSources> {
  const detected = new Set<Provider>()
  const parseCandidatesByProvider: Record<Provider, string[]> = {
    chatgpt: [],
    claude: [],
    grok: [],
  }

  const addDetectedProvider = (provider: Provider) => {
    detected.add(provider)
  }
  const addParseCandidate = (provider: Provider, candidate: string) => {
    const existing = parseCandidatesByProvider[provider]
    if (!existing.includes(candidate)) {
      existing.push(candidate)
    }
  }

  let extractedArchiveCount = 0
  let extractionRootPath: string | undefined

  if (await isFilePath(inputPath)) {
    const providerFromFile = await detectProviderFromFile(inputPath)
    if (providerFromFile) {
      addDetectedProvider(providerFromFile)
      addParseCandidate(providerFromFile, inputPath)
    }

    if (isZipPath(inputPath)) {
      const zipProviders = detectProvidersFromZipEntries(listZipEntries(inputPath))
      if (zipProviders.length > 0) {
        extractionRootPath = await mkdtemp(join(tmpdir(), "reclaw-extracts-"))
        const extractedPath = await extractZipArchive(inputPath, extractionRootPath, 0)
        extractedArchiveCount += 1
        for (const provider of zipProviders) {
          addDetectedProvider(provider)
          addParseCandidate(provider, extractedPath)
        }
      }
    }
  } else {
    const providersFromDirectory = await detectProvidersFromDirectory(inputPath)
    for (const provider of providersFromDirectory) {
      addDetectedProvider(provider)
      addParseCandidate(provider, inputPath)
    }

    const zipFiles = await findZipFilesInTree(inputPath, ZIP_SCAN_MAX_DEPTH)
    if (zipFiles.length > 0) {
      const zipDetections = zipFiles.map((zipPath) => ({
        zipPath,
        providers: detectProvidersFromZipEntries(listZipEntries(zipPath)),
      }))

      const missingProviders = ALL_PROVIDERS.filter((provider) => !detected.has(provider))
      const archivesWithKnownProviders = zipDetections.filter(
        (entry) =>
          entry.providers.length > 0 && entry.providers.some((provider) => missingProviders.includes(provider)),
      )
      if (archivesWithKnownProviders.length > 0) {
        extractionRootPath = await mkdtemp(join(tmpdir(), "reclaw-extracts-"))
        let index = 0
        for (const archive of archivesWithKnownProviders) {
          const extractedPath = await extractZipArchive(archive.zipPath, extractionRootPath, index)
          extractedArchiveCount += 1
          index += 1
          for (const provider of archive.providers) {
            addDetectedProvider(provider)
            addParseCandidate(provider, extractedPath)
          }
        }
      }
    }
  }

  for (const provider of ALL_PROVIDERS) {
    if (parseCandidatesByProvider[provider].length === 0) {
      parseCandidatesByProvider[provider].push(inputPath)
    }
  }

  const prepared: PreparedInputSources = {
    detectedProviders: ALL_PROVIDERS.filter((provider) => detected.has(provider)),
    parseCandidatesByProvider,
    extractedArchiveCount,
  }

  if (extractionRootPath) {
    prepared.extractionRootPath = extractionRootPath
  }

  return prepared
}

async function detectProvidersFromDirectory(rootPath: string): Promise<Provider[]> {
  const [hasChatGpt, hasClaude, hasGrok] = await Promise.all([
    hasChatGptExport(rootPath),
    hasClaudeExport(rootPath),
    hasGrokExport(rootPath),
  ])

  const providers: Provider[] = []
  if (hasChatGpt) {
    providers.push("chatgpt")
  }
  if (hasClaude) {
    providers.push("claude")
  }
  if (hasGrok) {
    providers.push("grok")
  }

  return providers
}

async function hasChatGptExport(rootPath: string): Promise<boolean> {
  const candidates = [join(rootPath, "chatgpt", "conversations.json"), join(rootPath, "conversations.json")]
  for (const candidate of candidates) {
    const provider = await detectProviderFromFile(candidate)
    if (provider === "chatgpt") {
      return true
    }
  }

  return false
}

async function hasClaudeExport(rootPath: string): Promise<boolean> {
  const candidates = [join(rootPath, "claude", "conversations.json"), join(rootPath, "conversations.json")]
  for (const candidate of candidates) {
    const provider = await detectProviderFromFile(candidate)
    if (provider === "claude") {
      return true
    }
  }

  return false
}

async function hasGrokExport(rootPath: string): Promise<boolean> {
  const directGrokRoot = join(rootPath, "grok")
  if (await findFileInTree(directGrokRoot, "prod-grok-backend.json", 8)) {
    return true
  }

  if (basename(rootPath).toLowerCase().includes("grok")) {
    return findFileInTree(rootPath, "prod-grok-backend.json", 8)
  }

  return await isFilePath(join(rootPath, "prod-grok-backend.json"))
}

async function findZipFilesInTree(rootPath: string, maxDepth: number): Promise<string[]> {
  if (!(await isDirectoryPath(rootPath))) {
    return []
  }

  const zipFiles: string[] = []
  const stack: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }

    if (current.depth > maxDepth) {
      continue
    }

    let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> = []
    try {
      entries = await readdir(current.path, { withFileTypes: true, encoding: "utf8" })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryName = String(entry.name)
      if (entryName === ".DS_Store") {
        continue
      }

      const entryPath = join(current.path, entryName)
      if (entry.isFile() && isZipPath(entryName)) {
        zipFiles.push(entryPath)
        continue
      }

      if (entry.isDirectory()) {
        stack.push({ path: entryPath, depth: current.depth + 1 })
      }
    }
  }

  return zipFiles.sort((left, right) => left.localeCompare(right))
}

async function detectProviderFromFile(filePath: string): Promise<Provider | undefined> {
  if (!(await isFilePath(filePath))) {
    return undefined
  }

  const normalizedPath = normalizePath(filePath)
  if (normalizedPath.endsWith("/prod-grok-backend.json")) {
    return "grok"
  }

  if (normalizedPath.includes("/chatgpt/") && normalizedPath.endsWith("/conversations.json")) {
    return "chatgpt"
  }

  if (normalizedPath.includes("/claude/") && normalizedPath.endsWith("/conversations.json")) {
    return "claude"
  }

  if (normalizedPath.endsWith("/conversations.json")) {
    return inferProviderFromConversationJson(filePath)
  }

  return undefined
}

async function inferProviderFromConversationJson(filePath: string): Promise<Provider | undefined> {
  try {
    const content = await readFile(filePath, "utf8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) {
      return undefined
    }

    const firstRecord = parsed.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    if (!firstRecord || typeof firstRecord !== "object" || Array.isArray(firstRecord)) {
      return undefined
    }

    const typedRecord = firstRecord as Record<string, unknown>
    if ("mapping" in typedRecord || "current_node" in typedRecord || "default_model_slug" in typedRecord) {
      return "chatgpt"
    }

    if ("chat_messages" in typedRecord || "uuid" in typedRecord) {
      return "claude"
    }

    return undefined
  } catch {
    return undefined
  }
}

function detectProvidersFromZipEntries(entries: string[]): Provider[] {
  const normalizedEntries = entries.map((entry) => normalizePath(entry.replaceAll("//", "/")))
  const hasConversationsJson = normalizedEntries.some((entry) => entry.endsWith("/conversations.json"))
  const hasGrokBackend = normalizedEntries.some((entry) => entry.endsWith("/prod-grok-backend.json"))
  const hasChatGptHints = normalizedEntries.some(
    (entry) =>
      entry.endsWith("/chat.html") ||
      entry.endsWith("/message_feedback.json") ||
      entry.endsWith("/shared_conversations.json"),
  )
  const hasClaudeHints = normalizedEntries.some(
    (entry) => entry.endsWith("/memories.json") || entry.endsWith("/projects.json") || entry.endsWith("/users.json"),
  )
  const hasChatGptPathHints = normalizedEntries.some((entry) => entry.includes("/chatgpt/"))
  const hasClaudePathHints = normalizedEntries.some((entry) => entry.includes("/claude/"))

  const providers: Provider[] = []
  if (hasGrokBackend) {
    providers.push("grok")
  }

  if (hasChatGptPathHints || hasChatGptHints) {
    providers.push("chatgpt")
  }

  if (hasClaudePathHints || hasClaudeHints) {
    providers.push("claude")
  }

  if (hasConversationsJson && !providers.includes("chatgpt") && !providers.includes("claude")) {
    // Fall back to most common provider-specific sidecars.
    if (hasClaudeHints) {
      providers.push("claude")
    } else if (hasChatGptHints) {
      providers.push("chatgpt")
    }
  }

  return providers
}

function listZipEntries(zipPath: string): string[] {
  const result = spawnSync("unzip", ["-Z", "-1", zipPath], {
    encoding: "utf8",
    timeout: 30_000,
  })

  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined
    if (code === "ENOENT") {
      throw new Error("Could not inspect zip archives because `unzip` was not found on PATH.")
    }

    const message = result.error.message || "unknown unzip error"
    throw new Error(`Could not inspect zip archive '${zipPath}': ${message}`)
  }

  if ((result.status ?? 1) !== 0) {
    const detail = (result.stderr || result.stdout || "").trim()
    throw new Error(`Could not inspect zip archive '${zipPath}': ${detail || `exit code ${result.status}`}`)
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

async function extractZipArchive(zipPath: string, extractionRoot: string, index: number): Promise<string> {
  const baseName = basename(zipPath, ".zip")
  const safeBaseName =
    baseName
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 72) || `archive-${index + 1}`
  const targetDir = join(extractionRoot, `${String(index + 1).padStart(2, "0")}-${safeBaseName}`)
  await mkdir(targetDir, { recursive: true })

  const result = spawnSync("unzip", ["-oq", zipPath, "-d", targetDir], {
    encoding: "utf8",
    timeout: 180_000,
  })

  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined
    if (code === "ENOENT") {
      throw new Error("Could not extract zip archives because `unzip` was not found on PATH.")
    }

    const message = result.error.message || "unknown unzip error"
    throw new Error(`Could not extract zip archive '${zipPath}': ${message}`)
  }

  if ((result.status ?? 1) !== 0) {
    const detail = (result.stderr || result.stdout || "").trim()
    throw new Error(`Could not extract zip archive '${zipPath}': ${detail || `exit code ${result.status}`}`)
  }

  return targetDir
}

async function findFileInTree(rootPath: string, targetFile: string, maxDepth: number): Promise<boolean> {
  if (!(await isDirectoryPath(rootPath))) {
    return false
  }

  const stack: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }

    if (current.depth > maxDepth) {
      continue
    }

    let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> = []
    try {
      entries = await readdir(current.path, { withFileTypes: true, encoding: "utf8" })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryName = String(entry.name)
      if (entryName === ".DS_Store") {
        continue
      }

      const entryPath = join(current.path, entryName)
      if (entry.isFile() && entryName === targetFile) {
        return true
      }

      if (entry.isDirectory()) {
        stack.push({ path: entryPath, depth: current.depth + 1 })
      }
    }
  }

  return false
}

async function isDirectoryPath(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFilePath(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase()
}

function isZipPath(path: string): boolean {
  return normalizePath(path).endsWith(".zip")
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (normalized.length === 0) {
      continue
    }

    const key = normalized.toLowerCase()
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    output.push(normalized)
  }

  return output
}

function clipLogText(value: string, maxChars: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim()
  if (normalized.length <= maxChars) {
    return normalized
  }

  return `${normalized.slice(0, maxChars)}...`
}

function parseCliArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {
    timestampedBackups: false,
    yes: false,
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

    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true
      continue
    }

    if (arg === "--workspace") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --workspace")
      }

      const normalized = value.trim()
      if (normalized.length === 0) {
        throw new Error("Empty value for --workspace")
      }

      parsed.workspace = normalized
      index += 1
      continue
    }

    if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length).trim()
      if (value.length === 0) {
        throw new Error("Empty value for --workspace")
      }

      parsed.workspace = value
      continue
    }

    if (arg === "--target-path") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --target-path")
      }

      const normalized = value.trim()
      if (normalized.length === 0) {
        throw new Error("Empty value for --target-path")
      }

      parsed.targetPath = normalized
      index += 1
      continue
    }

    if (arg.startsWith("--target-path=")) {
      const value = arg.slice("--target-path=".length).trim()
      if (value.length === 0) {
        throw new Error("Empty value for --target-path")
      }

      parsed.targetPath = value
      continue
    }

    if (arg === "--timestamped-backups") {
      parsed.timestampedBackups = true
      continue
    }

    if (arg === "--state-path") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --state-path")
      }

      const normalized = value.trim()
      if (normalized.length === 0) {
        throw new Error("Empty value for --state-path")
      }

      parsed.statePath = normalized
      index += 1
      continue
    }

    if (arg.startsWith("--state-path=")) {
      const value = arg.slice("--state-path=".length).trim()
      if (value.length === 0) {
        throw new Error("Empty value for --state-path")
      }

      parsed.statePath = value
      continue
    }

    if (arg === "--subagent-batch-size") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --subagent-batch-size")
      }

      const parsedSize = parsePositiveIntegerArg(value)
      if (parsedSize === undefined) {
        throw new Error("Invalid --subagent-batch-size value. Expected a positive integer.")
      }

      parsed.subagentBatchSize = parsedSize
      index += 1
      continue
    }

    if (arg.startsWith("--subagent-batch-size=")) {
      const value = arg.slice("--subagent-batch-size=".length)
      const parsedSize = parsePositiveIntegerArg(value)
      if (parsedSize === undefined) {
        throw new Error("Invalid --subagent-batch-size value. Expected a positive integer.")
      }

      parsed.subagentBatchSize = parsedSize
      continue
    }

    if (arg === "--parallel-jobs") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --parallel-jobs")
      }

      const parsedSize = parsePositiveIntegerArg(value)
      if (parsedSize === undefined) {
        throw new Error("Invalid --parallel-jobs value. Expected a positive integer.")
      }

      parsed.parallelJobs = parsedSize
      index += 1
      continue
    }

    if (arg.startsWith("--parallel-jobs=")) {
      const value = arg.slice("--parallel-jobs=".length)
      const parsedSize = parsePositiveIntegerArg(value)
      if (parsedSize === undefined) {
        throw new Error("Invalid --parallel-jobs value. Expected a positive integer.")
      }

      parsed.parallelJobs = parsedSize
      continue
    }

    if (arg === "--legacy-sessions") {
      const value = args[index + 1]
      if (typeof value !== "string") {
        throw new Error("Missing value for --legacy-sessions")
      }

      const parsedMode = parseLegacySessionModeArg(value)
      if (!parsedMode) {
        throw new Error(`Invalid --legacy-sessions value '${value}'. Expected 'on', 'off', or 'required'.`)
      }

      parsed.legacySessions = parsedMode
      index += 1
      continue
    }

    if (arg.startsWith("--legacy-sessions=")) {
      const value = arg.slice("--legacy-sessions=".length)
      const parsedMode = parseLegacySessionModeArg(value)
      if (!parsedMode) {
        throw new Error(`Invalid --legacy-sessions value '${value}'. Expected 'on', 'off', or 'required'.`)
      }

      parsed.legacySessions = parsedMode
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

function parseLegacySessionModeArg(value: string): LegacySessionMode | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "on" || normalized === "off" || normalized === "required") {
    return normalized
  }

  return undefined
}

function resolveLegacySessionMode(
  requestedMode: LegacySessionMode | undefined,
  _extractionMode: ExtractionMode,
): LegacySessionMode {
  if (requestedMode) {
    return requestedMode
  }

  return "on"
}

function parsePositiveIntegerArg(value: string): number | undefined {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) {
    return undefined
  }

  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return undefined
  }

  return parsed
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
      "  --workspace <path>                 OpenClaw workspace path (output in OpenClaw mode; legacy import target in Zettelclaw mode)",
      "  --target-path <path>               Output root (OpenClaw workspace or Zettelclaw vault)",
      "  --model <model-id>                 OpenClaw model key/alias/name",
      "  --state-path <path>                Resume state file path (default: ./.reclaw-state.json)",
      "  --subagent-batch-size <n>          Deprecated (ignored; batching is one merged day per job)",
      "  --parallel-jobs <n>                Parallel subagent jobs (default: 5)",
      "  --timestamped-backups              Write MEMORY/USER backups as .bak.<timestamp>",
      "  --legacy-sessions <on|off|required> Import legacy conversations into OpenClaw session history (default: on)",
      "  --yes, -y                          Non-interactive defaults; auto-confirm execution",
      "  --dry-run, --plan                  Parse and preview plan; do not schedule extraction or write files",
      "  -h, --help                         Show help",
      "",
      "Examples:",
      "  reclaw",
      "  reclaw --provider chatgpt --input ./conversations.json",
      "  reclaw --parallel-jobs 5",
      "  reclaw --state-path ./tmp/reclaw-run-1.json --timestamped-backups",
      "  reclaw --mode openclaw --workspace ~/tmp/reclaw-workspaces/workspace-20260221-120000 --yes",
      "  reclaw --provider claude --input ./claude-export --mode zettelclaw",
      "  reclaw --dry-run --provider grok --input ./grok-export",
    ].join("\n"),
  )
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
    const providerConversations = options.providerConversations[provider]
    const providerMessages = providerConversations.reduce((sum, conversation) => sum + conversation.messageCount, 0)
    const providerBatches = options.plan.batches.filter((batch) =>
      batch.conversations.some((conversation) => conversation.source === provider),
    ).length
    lines.push(
      `  - ${providerLabels[provider]}: ${providerConversations.length} conversations, ${providerMessages} messages, ${providerBatches} batches`,
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
