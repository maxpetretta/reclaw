import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { isDirectoryPath, isFilePath } from "../lib/fs"
import { ALL_PROVIDERS, type Provider, ZIP_SCAN_MAX_DEPTH } from "./constants"

export interface PreparedInputSources {
  detectedProviders: Provider[]
  parseCandidatesByProvider: Record<Provider, string[]>
  extractedArchiveCount: number
  warnings: string[]
  extractionRootPath?: string
}

export async function prepareInputSources(inputPath: string): Promise<PreparedInputSources> {
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
  const warnings: string[] = []
  let extractionRootPath: string | undefined

  if (await isFilePath(inputPath)) {
    const providerFromFile = await detectProviderFromFile(inputPath)
    if (providerFromFile) {
      addDetectedProvider(providerFromFile)
      addParseCandidate(providerFromFile, inputPath)
    }

    if (isZipPath(inputPath)) {
      const zipProviders = detectProvidersFromArchive(inputPath, warnings)
      if (zipProviders.length > 0) {
        try {
          extractionRootPath = await mkdtemp(join(tmpdir(), "reclaw-extracts-"))
          const extractedPath = await extractZipArchive(inputPath, extractionRootPath, 0)
          extractedArchiveCount += 1
          for (const provider of zipProviders) {
            addDetectedProvider(provider)
            addParseCandidate(provider, extractedPath)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          warnings.push(`Skipping archive '${inputPath}': ${message}`)
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
      const zipDetections = zipFiles
        .map((zipPath) => ({
          zipPath,
          providers: detectProvidersFromArchive(zipPath, warnings),
        }))
        .filter((entry) => entry.providers.length > 0)

      const missingProviders = ALL_PROVIDERS.filter((provider) => !detected.has(provider))
      const archivesWithKnownProviders = zipDetections.filter((entry) =>
        entry.providers.some((provider) => missingProviders.includes(provider)),
      )
      if (archivesWithKnownProviders.length > 0) {
        extractionRootPath = await mkdtemp(join(tmpdir(), "reclaw-extracts-"))
        let index = 0
        for (const archive of archivesWithKnownProviders) {
          try {
            const extractedPath = await extractZipArchive(archive.zipPath, extractionRootPath, index)
            extractedArchiveCount += 1
            index += 1
            for (const provider of archive.providers) {
              addDetectedProvider(provider)
              addParseCandidate(provider, extractedPath)
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            warnings.push(`Skipping archive '${archive.zipPath}': ${message}`)
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
    warnings,
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
  const files = await findFilesInTree(rootPath, maxDepth, (entryName) => isZipPath(entryName))
  return files.sort((left, right) => left.localeCompare(right))
}

async function findFileInTree(rootPath: string, targetFile: string, maxDepth: number): Promise<boolean> {
  const files = await findFilesInTree(rootPath, maxDepth, (entryName) => entryName === targetFile, true)
  return files.length > 0
}

async function findFilesInTree(
  rootPath: string,
  maxDepth: number,
  matcher: (entryName: string) => boolean,
  stopOnFirst = false,
): Promise<string[]> {
  if (!(await isDirectoryPath(rootPath))) {
    return []
  }

  const matches: string[] = []
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
      if (entry.isFile() && matcher(entryName)) {
        matches.push(entryPath)
        if (stopOnFirst) {
          return matches
        }
        continue
      }

      if (entry.isDirectory()) {
        stack.push({ path: entryPath, depth: current.depth + 1 })
      }
    }
  }

  return matches
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

function detectProvidersFromArchive(zipPath: string, warnings: string[]): Provider[] {
  let entries: string[] = []
  try {
    entries = listZipEntries(zipPath)
    assertSafeZipEntries(entries, zipPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(`Skipping archive '${zipPath}': ${message}`)
    return []
  }

  return detectProvidersFromZipEntries(entries)
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

function assertSafeZipEntries(entries: string[], zipPath: string): void {
  for (const entry of entries) {
    if (isUnsafeZipEntryPath(entry)) {
      throw new Error(`archive contains unsafe path '${entry}'`)
    }
  }

  if (entries.length === 0) {
    throw new Error(`archive has no readable entries (${zipPath})`)
  }
}

function isUnsafeZipEntryPath(entry: string): boolean {
  const normalized = normalizePath(entry).replaceAll(/\/+/g, "/")
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
    return true
  }

  const segments = normalized.split("/")
  return segments.includes("..")
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

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase()
}

function isZipPath(path: string): boolean {
  return normalizePath(path).endsWith(".zip")
}
