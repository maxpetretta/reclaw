import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  confirm as clackConfirm,
  intro as clackIntro,
  isCancel as clackIsCancel,
  log as clackLog,
  outro as clackOutro,
  select as clackSelect,
  spinner as clackSpinner,
  text as clackText,
} from "@clack/prompts";
import { runPluginCommandWithTimeout, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { generateBriefing } from "../briefing/generate";
import { LAST_HANDOFF_BEGIN_MARKER, LAST_HANDOFF_END_MARKER } from "../memory/handoff";
import { ensureManagedBlock } from "../memory/managed-block";
import {
  DEFAULT_IMPORT_JOBS,
  DEFAULT_IMPORT_MIN_MESSAGES,
  DEFAULT_IMPORT_MODEL,
  type ReclawImportSummary,
  runReclawImport,
} from "../import/run";
import type { ImportPlatform } from "../import/types";
import { parseChatGptConversations } from "../import/adapters/chatgpt";
import { parseClaudeConversations } from "../import/adapters/claude";
import { parseGrokConversations } from "../import/adapters/grok";
import { queryLog, searchLog } from "../log/query";
import type { EntryType, LogEntry } from "../log/schema";
import { ensureSubject, readRegistry, renameSubject, writeRegistry } from "../subjects/registry";
import { writeState } from "../state";

export const BRIEFING_BEGIN_MARKER = "<!-- BEGIN GENERATED BRIEFING -->";
export const BRIEFING_END_MARKER = "<!-- END GENERATED BRIEFING -->";
export { LAST_HANDOFF_BEGIN_MARKER, LAST_HANDOFF_END_MARKER };
export const AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER = "<!-- BEGIN ZETTELCLAW MEMORY GUIDANCE -->";
export const AGENTS_MEMORY_GUIDANCE_END_MARKER = "<!-- END ZETTELCLAW MEMORY GUIDANCE -->";
export const MEMORY_NOTICE_BEGIN_MARKER = "<!-- BEGIN ZETTELCLAW MEMORY NOTICE -->";
export const MEMORY_NOTICE_END_MARKER = "<!-- END ZETTELCLAW MEMORY NOTICE -->";

const POST_INIT_EVENT_PROMPT = "post-init-system-event.md";
const AGENTS_MEMORY_PROMPT = "agents-memory-guidance.md";
const MEMORY_NOTICE_PROMPT = "memory-zettelclaw-notice.md";

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(flag: string, description?: string, defaultValue?: unknown): CommandLike;
  argument(spec: string, description?: string): CommandLike;
  action(handler: (...args: unknown[]) => unknown): CommandLike;
}

interface InitPaths {
  logDir: string;
  logPath: string;
  subjectsPath: string;
  statePath: string;
  cronJobsPath: string;
  openClawConfigPath: string;
  agentsMdPath: string;
  memoryMdPath: string;
}

export interface GuidanceEventResult {
  sent: boolean;
  message?: string;
}

interface InitDeps {
  fireGuidanceEvent?: (paths: InitPaths) => Promise<GuidanceEventResult>;
}

export interface InitResult {
  paths: InitPaths;
  guidanceEvent: GuidanceEventResult;
}

interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  paths: InitPaths;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function toObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function resolveOpenClawHome(): string {
  const override = process.env.OPENCLAW_HOME?.trim();
  if (override) {
    return override;
  }

  return join(homedir(), ".openclaw");
}

function resolvePaths(config: PluginConfig, workspaceDir?: string): InitPaths {
  const openClawHome = resolveOpenClawHome();
  const resolvedWorkspaceDir = workspaceDir?.trim() || process.cwd();

  return {
    logDir: config.logDir,
    logPath: join(config.logDir, "log.jsonl"),
    subjectsPath: join(config.logDir, "subjects.json"),
    statePath: join(config.logDir, "state.json"),
    cronJobsPath: join(openClawHome, "cron", "jobs.json"),
    openClawConfigPath: join(openClawHome, "openclaw.json"),
    agentsMdPath: join(resolvedWorkspaceDir, "AGENTS.md"),
    memoryMdPath: join(resolvedWorkspaceDir, "MEMORY.md"),
  };
}

function parseEntryType(raw: unknown): EntryType | undefined {
  if (raw === "task" || raw === "fact" || raw === "decision" || raw === "question" || raw === "handoff") {
    return raw;
  }

  return undefined;
}

function parseStatus(raw: unknown): "open" | "done" | undefined {
  if (raw === "open" || raw === "done") {
    return raw;
  }

  return undefined;
}

function parseImportPlatform(raw: unknown): ImportPlatform | undefined {
  if (raw === "chatgpt" || raw === "claude" || raw === "grok" || raw === "openclaw") {
    return raw;
  }

  return undefined;
}

function readGatewayPort(config: unknown): number | null {
  if (!isObject(config)) {
    return null;
  }

  const gateway = config.gateway;
  if (!isObject(gateway)) {
    return null;
  }

  return typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : null;
}

function readGatewayToken(config: unknown): string | undefined {
  if (!isObject(config)) {
    return undefined;
  }

  const gateway = config.gateway;
  if (!isObject(gateway)) {
    return undefined;
  }

  const auth = gateway.auth;
  if (!isObject(auth)) {
    return undefined;
  }

  return typeof auth.token === "string" && auth.token.trim().length > 0 ? auth.token : undefined;
}

function resolveApiBaseUrl(config: unknown): string {
  const port = readGatewayPort(config) ?? 18789;
  return `http://127.0.0.1:${port}`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatEntry(entry: LogEntry): string {
  const subject = entry.subject ? ` (${entry.subject})` : "";
  const base = `[${formatTimestamp(entry.timestamp)}] [${entry.type}]${subject} ${entry.content}`;
  if (entry.detail) {
    return `${base}\n  ${entry.detail}`;
  }

  return base;
}

function readNumberOption(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return fallback;
}

function buildTimestampSuffix(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function isDirectoryErrorMessage(path: string): string {
  return `openclaw import path must be a directory: ${path}`;
}

export async function backupDirectoryWithTimestamp(sourceDir: string): Promise<string> {
  const sourceStat = await stat(sourceDir);
  if (!sourceStat.isDirectory()) {
    throw new Error(isDirectoryErrorMessage(sourceDir));
  }

  const backupPath = `${sourceDir}.backup-${buildTimestampSuffix()}`;
  await cp(sourceDir, backupPath, {
    recursive: true,
    errorOnExist: true,
  });
  return backupPath;
}

export async function clearDirectoryContents(directory: string): Promise<void> {
  const sourceStat = await stat(directory);
  if (!sourceStat.isDirectory()) {
    throw new Error(isDirectoryErrorMessage(directory));
  }

  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry.name);
      await rm(absolutePath, { recursive: true, force: true });
    }),
  );
}

async function chooseFileBackupPath(sourcePath: string): Promise<string> {
  const sourceName = basename(sourcePath);
  const sourceDir = dirname(sourcePath);

  for (let index = 0; index < 10_000; index += 1) {
    const label = index === 0 ? `${sourceName}.bak` : `${sourceName}.bak.${index}`;
    const backupPath = join(sourceDir, label);
    try {
      await stat(backupPath);
    } catch (error) {
      if (isEnoent(error)) {
        return backupPath;
      }
      throw error;
    }
  }

  throw new Error(`Could not find an available backup path for ${sourcePath}`);
}

async function backupFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) {
      return undefined;
    }
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }

  const backupPath = await chooseFileBackupPath(filePath);
  await cp(filePath, backupPath, {
    errorOnExist: true,
  });
  return backupPath;
}

export async function ensureImportStoreFiles(paths: InitPaths, statePath: string): Promise<void> {
  await mkdir(paths.logDir, { recursive: true });

  try {
    await readFile(paths.logPath, "utf8");
  } catch {
    await writeFile(paths.logPath, "", "utf8");
  }

  try {
    await readFile(paths.subjectsPath, "utf8");
  } catch {
    await writeFile(paths.subjectsPath, "{}\n", "utf8");
  }

  try {
    await readFile(statePath, "utf8");
  } catch {
    await writeState(statePath, {
      extractedSessions: {},
      failedSessions: {},
      importedConversations: {},
    });
  }
}

function shouldClearLegacyMemoryDir(summary: ReclawImportSummary): boolean {
  if (summary.failed > 0) {
    return false;
  }

  return summary.selected > 0 || summary.skippedAlreadyImported > 0;
}

interface ImportCommandDeps {
  ensureImportStoreFiles: (paths: InitPaths, statePath: string) => Promise<void>;
  runReclawImport: typeof runReclawImport;
  backupDirectory: (sourceDir: string) => Promise<string>;
  backupFileIfExists: (filePath: string) => Promise<string | undefined>;
  clearDirectory: (sourceDir: string) => Promise<void>;
}

interface ImportProgressLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface RunImportCommandOptions {
  config: PluginConfig;
  workspaceDir?: string;
  apiConfig: unknown;
  platform: ImportPlatform;
  filePath: string;
  opts: unknown;
  logger?: ImportProgressLogger;
}

export interface RunImportCommandResult {
  summary: ReclawImportSummary;
  statePath: string;
  legacyBackupPath?: string;
  memoryDocBackupPath?: string;
  userDocBackupPath?: string;
  legacyMemoryCleared: boolean;
}

const DEFAULT_IMPORT_DEPS: ImportCommandDeps = {
  ensureImportStoreFiles,
  runReclawImport,
  backupDirectory: backupDirectoryWithTimestamp,
  backupFileIfExists,
  clearDirectory: clearDirectoryContents,
};

export async function runImportCommand(
  input: RunImportCommandOptions,
  deps: Partial<ImportCommandDeps> = {},
): Promise<RunImportCommandResult> {
  const options = toObject(input.opts);
  const runtimeDeps: ImportCommandDeps = {
    ...DEFAULT_IMPORT_DEPS,
    ...deps,
  };
  const paths = resolvePaths(input.config, input.workspaceDir);
  const importPath = input.filePath.trim();
  const dryRun = options.dryRun === true;
  const isOpenClawMigration = input.platform === "openclaw";
  const defaultMinMessages = isOpenClawMigration ? 1 : DEFAULT_IMPORT_MIN_MESSAGES;
  const statePath = paths.statePath;
  const keepSource = options.keepSource === true;
  const backupMemoryDocs = options.backupMemoryDocs === true;

  if (isOpenClawMigration) {
    const metadata = await stat(importPath);
    if (!metadata.isDirectory()) {
      throw new Error(isDirectoryErrorMessage(importPath));
    }
  }

  if (!dryRun) {
    await runtimeDeps.ensureImportStoreFiles(paths, statePath);
  }

  let legacyBackupPath: string | undefined;
  let memoryDocBackupPath: string | undefined;
  let userDocBackupPath: string | undefined;
  if (isOpenClawMigration && !dryRun) {
    legacyBackupPath = await runtimeDeps.backupDirectory(importPath);
    if (backupMemoryDocs) {
      memoryDocBackupPath = await runtimeDeps.backupFileIfExists(paths.memoryMdPath);
      userDocBackupPath = await runtimeDeps.backupFileIfExists(join(dirname(paths.memoryMdPath), "USER.md"));
    }
  }

  const summary = await runtimeDeps.runReclawImport(
    {
      platform: input.platform,
      filePath: importPath,
      logPath: paths.logPath,
      subjectsPath: paths.subjectsPath,
      statePath,
      dryRun,
      after: typeof options.after === "string" ? options.after : undefined,
      before: typeof options.before === "string" ? options.before : undefined,
      minMessages: readNumberOption(options.minMessages, defaultMinMessages),
      jobs: readNumberOption(options.jobs, DEFAULT_IMPORT_JOBS),
      model: typeof options.model === "string" ? options.model : DEFAULT_IMPORT_MODEL,
      force: options.force === true,
      transcripts: options.transcripts !== false,
      verbose: options.verbose === true,
      apiBaseUrl: resolveApiBaseUrl(input.apiConfig),
      apiToken: readGatewayToken(input.apiConfig),
      openClawHome: resolveOpenClawHome(),
    },
    {},
    input.logger,
  );

  let legacyMemoryCleared = false;
  if (isOpenClawMigration && !dryRun && !keepSource && shouldClearLegacyMemoryDir(summary)) {
    await runtimeDeps.clearDirectory(importPath);
    legacyMemoryCleared = true;
  }

  return {
    summary,
    statePath,
    ...(legacyBackupPath ? { legacyBackupPath } : {}),
    ...(memoryDocBackupPath ? { memoryDocBackupPath } : {}),
    ...(userDocBackupPath ? { userDocBackupPath } : {}),
    legacyMemoryCleared,
  };
}

interface ImportDetection {
  platform: ImportPlatform;
  path: string;
  detail: string;
  score: number;
}

export interface ImportDetections {
  chatgpt: ImportDetection[];
  claude: ImportDetection[];
  grok: ImportDetection[];
  openclaw: ImportDetection[];
}

interface ImportSelection {
  platform: ImportPlatform;
  filePath: string;
  interactive: boolean;
}

interface ImportModelInfo {
  key: string;
  name: string;
  alias?: string;
  isDefault: boolean;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function normalizePathList(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function normalizeModelOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isDailyMemoryFile(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.md$/u.test(fileName);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"] as const;
  let remaining = value;
  let unitIndex = 0;
  while (remaining >= 1024 && unitIndex < units.length - 1) {
    remaining /= 1024;
    unitIndex += 1;
  }

  const formatted = unitIndex === 0 ? `${Math.floor(remaining)}` : remaining.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

interface OpenClawMemoryPreflight {
  markdownFiles: number;
  dailyFiles: number;
  otherFiles: number;
  dateRange: string;
  sourceSizeBytes: number;
}

async function readOpenClawMemoryPreflight(memoryPath: string): Promise<OpenClawMemoryPreflight> {
  const stack = [memoryPath];
  let markdownFiles = 0;
  let dailyFiles = 0;
  let sourceSizeBytes = 0;
  const dailyDates: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!(entry.isFile() && entry.name.toLowerCase().endsWith(".md"))) {
        continue;
      }

      markdownFiles += 1;
      const metadata = await stat(absolutePath);
      sourceSizeBytes += metadata.size;

      if (isDailyMemoryFile(entry.name)) {
        dailyFiles += 1;
        dailyDates.push(entry.name.slice(0, 10));
      }
    }
  }

  dailyDates.sort((left, right) => left.localeCompare(right));
  const dateRange =
    dailyDates.length > 0 ? `${dailyDates[0]} -> ${dailyDates[dailyDates.length - 1]}` : "n/a";
  const otherFiles = markdownFiles - dailyFiles;

  return {
    markdownFiles,
    dailyFiles,
    otherFiles,
    dateRange,
    sourceSizeBytes,
  };
}

function parseImportModelsJson(json: string): ImportModelInfo[] {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(json) as unknown;
  } catch {
    return [];
  }

  const root = toObject(parsedValue);
  const rawModels = Array.isArray(root.models) ? root.models : [];
  const models: ImportModelInfo[] = [];

  for (const rawModel of rawModels) {
    const model = toObject(rawModel);
    const key = typeof model.key === "string" ? model.key.trim() : "";
    if (!key) {
      continue;
    }

    const name = typeof model.name === "string" && model.name.trim().length > 0 ? model.name.trim() : key;
    const tags = Array.isArray(model.tags)
      ? model.tags
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    const aliasTag = tags.find((tag) => tag.startsWith("alias:"));

    models.push({
      key,
      name,
      isDefault: tags.includes("default"),
      ...(typeof aliasTag === "string" && aliasTag.slice(6).trim().length > 0
        ? { alias: aliasTag.slice(6).trim() }
        : {}),
    });
  }

  return models;
}

async function listImportModels(): Promise<ImportModelInfo[]> {
  let result;
  try {
    result = await runPluginCommandWithTimeout({
      argv: ["openclaw", "models", "list", "--json"],
      timeoutMs: 10_000,
    });
  } catch {
    return [];
  }

  if (result.code !== 0 || result.stdout.trim().length === 0) {
    return [];
  }

  return parseImportModelsJson(result.stdout);
}

function formatImportModelLabel(model: ImportModelInfo): string {
  return model.alias ? `${model.name} (${model.alias})` : `${model.name} (${model.key})`;
}

function resolveModelByQuery(models: ImportModelInfo[], query: string): ImportModelInfo | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return undefined;
  }

  return models.find((model) => {
    const candidates = [model.key, model.name, model.alias]
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.toLowerCase());
    return candidates.includes(normalizedQuery);
  });
}

function createEmptyDetections(): ImportDetections {
  return {
    chatgpt: [],
    claude: [],
    grok: [],
    openclaw: [],
  };
}

function scorePathHint(platform: ImportPlatform, filePath: string): number {
  const base = filePath.toLowerCase();
  const hints: Record<Exclude<ImportPlatform, "openclaw">, RegExp[]> = {
    chatgpt: [/chatgpt/u, /openai/u, /conversation/u, /conversations/u],
    claude: [/claude/u, /anthropic/u, /conversation/u, /conversations/u],
    grok: [/grok/u, /xai/u, /conversation/u, /conversations/u],
  };

  if (platform === "openclaw") {
    return base.endsWith("/memory") ? 30 : base.includes("/memory/") ? 20 : 0;
  }

  const patterns = hints[platform];
  return patterns.reduce((score, pattern) => (pattern.test(base) ? score + 10 : score), 0);
}

function shouldSkipDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "node_modules" ||
    lower === ".git" ||
    lower === "dist" ||
    lower === "build" ||
    lower === ".next" ||
    lower === ".cache"
  );
}

async function pathType(path: string): Promise<"file" | "dir" | null> {
  try {
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      return "dir";
    }
    if (metadata.isFile()) {
      return "file";
    }
    return null;
  } catch {
    return null;
  }
}

async function countMarkdownFiles(root: string, maxDepth = 3, maxFiles = 1_000): Promise<number> {
  let count = 0;
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (stack.length > 0 && count < maxFiles) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        count += 1;
        if (count >= maxFiles) {
          break;
        }
      } else if (entry.isDirectory() && current.depth < maxDepth && !shouldSkipDirectory(entry.name)) {
        stack.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return count;
}

async function listJsonCandidates(root: string, maxDepth = 3, maxFiles = 300): Promise<string[]> {
  const candidates: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (stack.length > 0 && candidates.length < maxFiles) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = join(current.path, entry.name);

      if (entry.isDirectory() && current.depth < maxDepth && !shouldSkipDirectory(entry.name)) {
        stack.push({ path: absolutePath, depth: current.depth + 1 });
        continue;
      }

      if (!(entry.isFile() && entry.name.toLowerCase().endsWith(".json"))) {
        continue;
      }

      const hint = entry.name.toLowerCase();
      const hinted =
        hint.includes("chatgpt") ||
        hint.includes("claude") ||
        hint.includes("grok") ||
        hint.includes("openai") ||
        hint.includes("conversation") ||
        hint.includes("export");

      if (!hinted && current.depth > 1) {
        continue;
      }

      candidates.push(absolutePath);
      if (candidates.length >= maxFiles) {
        break;
      }
    }
  }

  return candidates;
}

function countParsedConversations(platform: Exclude<ImportPlatform, "openclaw">, raw: unknown): number {
  if (platform === "chatgpt") {
    return parseChatGptConversations(raw).length;
  }

  if (platform === "claude") {
    return parseClaudeConversations(raw).length;
  }

  return parseGrokConversations(raw).length;
}

function sortDetections(detections: ImportDetection[]): ImportDetection[] {
  return detections.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}

export async function detectImportSources(workspaceDir?: string): Promise<ImportDetections> {
  const detections = createEmptyDetections();
  const roots = normalizePathList([
    workspaceDir,
    process.cwd(),
    join(resolveOpenClawHome(), "workspace"),
    join(homedir(), "Downloads"),
    join(homedir(), "Desktop"),
  ]);

  const jsonCandidates = new Set<string>();
  for (const root of roots) {
    if ((await pathType(root)) !== "dir") {
      continue;
    }

    const memoryPath = join(root, "memory");
    if ((await pathType(memoryPath)) === "dir") {
      const markdownCount = await countMarkdownFiles(memoryPath);
      if (markdownCount > 0) {
        detections.openclaw.push({
          platform: "openclaw",
          path: memoryPath,
          detail: `${markdownCount} markdown file${markdownCount === 1 ? "" : "s"}`,
          score: 50 + scorePathHint("openclaw", memoryPath) + Math.min(markdownCount, 50),
        });
      }
    }

    const discoveredJson = await listJsonCandidates(root);
    for (const candidate of discoveredJson) {
      jsonCandidates.add(candidate);
    }
  }

  for (const filePath of jsonCandidates) {
    let rawText = "";
    try {
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > 75 * 1024 * 1024) {
        continue;
      }
      rawText = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      continue;
    }

    for (const platform of ["chatgpt", "claude", "grok"] as const) {
      const parsedCount = countParsedConversations(platform, parsed);
      if (parsedCount <= 0) {
        continue;
      }

      detections[platform].push({
        platform,
        path: filePath,
        detail: `${parsedCount} conversation${parsedCount === 1 ? "" : "s"}`,
        score: parsedCount + scorePathHint(platform, filePath),
      });
    }
  }

  detections.chatgpt = sortDetections(detections.chatgpt);
  detections.claude = sortDetections(detections.claude);
  detections.grok = sortDetections(detections.grok);
  detections.openclaw = sortDetections(detections.openclaw);

  return detections;
}

function unwrapPromptValue<T>(value: T | symbol): T {
  if (clackIsCancel(value)) {
    throw new Error("Import canceled");
  }
  return value;
}

function platformLabel(platform: ImportPlatform): string {
  if (platform === "chatgpt") {
    return "ChatGPT export";
  }
  if (platform === "claude") {
    return "Claude export";
  }
  if (platform === "grok") {
    return "Grok export";
  }
  return "OpenClaw legacy memory";
}

async function resolveImportSelection(input: {
  platformArg: unknown;
  fileArg: unknown;
  workspaceDir?: string;
}): Promise<ImportSelection> {
  const parsedPlatform = parseImportPlatform(input.platformArg);
  const fileArg = typeof input.fileArg === "string" && input.fileArg.trim().length > 0 ? input.fileArg.trim() : null;

  if (parsedPlatform && fileArg) {
    return {
      platform: parsedPlatform,
      filePath: fileArg,
      interactive: false,
    };
  }

  if (input.platformArg !== undefined && parsedPlatform === undefined) {
    throw new Error('platform must be one of: "chatgpt", "claude", "grok", "openclaw"');
  }

  if (!isInteractiveTerminal()) {
    throw new Error("Import requires interactive TTY when platform/file args are omitted.");
  }

  clackIntro("🦞 Zettelclaw import");
  const detectSpin = clackSpinner();
  detectSpin.start("Auto-detecting import sources");
  const detections = await detectImportSources(input.workspaceDir);
  detectSpin.stop("Auto-detection complete");

  const platform =
    parsedPlatform ??
    unwrapPromptValue(
      await clackSelect({
        message: "Which source do you want to import?",
        options: (["openclaw", "chatgpt", "claude", "grok"] as const).map((value) => {
          const top = detections[value][0];
          return {
            value,
            label: top ? `${platformLabel(value)} (detected)` : platformLabel(value),
            hint: top ? `${top.path} • ${top.detail}` : "No source auto-detected",
          };
        }),
      }),
    );

  const platformDetections = detections[platform];

  let selectedPath = fileArg;
  if (!selectedPath) {
    if (platformDetections.length > 0) {
      const selectedCandidate = unwrapPromptValue(
        await clackSelect({
          message: `Choose ${platformLabel(platform)} source`,
          options: [
            ...platformDetections.slice(0, 6).map((detection) => ({
              value: detection.path,
              label: detection.path,
              hint: detection.detail,
            })),
            {
              value: "__manual__",
              label: "Enter a path manually",
              hint: "Use this if your source was not auto-detected",
            },
          ],
        }),
      );

      if (selectedCandidate === "__manual__") {
        selectedPath = unwrapPromptValue(
          await clackText({
            message:
              platform === "openclaw"
                ? "Path to legacy OpenClaw memory directory"
                : `Path to ${platformLabel(platform)} JSON export`,
            placeholder: platform === "openclaw" ? "./memory" : "./export.json",
          }),
        );
      } else {
        selectedPath = selectedCandidate;
      }
    } else {
      selectedPath = unwrapPromptValue(
        await clackText({
          message:
            platform === "openclaw"
              ? "Path to legacy OpenClaw memory directory"
              : `Path to ${platformLabel(platform)} JSON export`,
          placeholder: platform === "openclaw" ? "./memory" : "./export.json",
        }),
      );
    }
  }

  const normalizedPath = selectedPath.trim();
  const detectedType = await pathType(normalizedPath);
  if (platform === "openclaw" && detectedType !== "dir") {
    throw new Error(isDirectoryErrorMessage(normalizedPath));
  }
  if (platform !== "openclaw" && detectedType !== "file") {
    throw new Error(`Import file does not exist: ${normalizedPath}`);
  }

  return {
    platform,
    filePath: normalizedPath,
    interactive: true,
  };
}

function printImportSummary(result: RunImportCommandResult, platform: ImportPlatform): void {
  const summary = result.summary;
  console.log("Reclaw import summary:");
  console.log(`  Parsed: ${summary.parsed}`);
  console.log(`  Deduped in input: ${summary.dedupedInInput}`);
  console.log(`  Selected: ${summary.selected}`);
  console.log(`  Skipped (date): ${summary.skippedByDate}`);
  console.log(`  Skipped (min-messages): ${summary.skippedByMinMessages}`);
  console.log(`  Skipped (already imported): ${summary.skippedAlreadyImported}`);
  console.log(`  Imported: ${summary.imported}`);
  console.log(`  Failed: ${summary.failed}`);
  console.log(`  Entries written: ${summary.entriesWritten}`);
  console.log(`  Transcripts written: ${summary.transcriptsWritten}`);
  console.log(`  State file: ${result.statePath}`);
  if (result.legacyBackupPath) {
    console.log(`  Source backup: ${result.legacyBackupPath}`);
  }
  if (result.memoryDocBackupPath) {
    console.log(`  MEMORY.md backup: ${result.memoryDocBackupPath}`);
  }
  if (result.userDocBackupPath) {
    console.log(`  USER.md backup: ${result.userDocBackupPath}`);
  }
  if (platform === "openclaw" && !summary.dryRun) {
    console.log(`  OpenClaw memory dir cleared: ${result.legacyMemoryCleared ? "yes" : "no"}`);
  }
  if (summary.dryRun) {
    console.log("  Mode: dry-run");
  }
}

function createSilentImportLogger(): ImportProgressLogger {
  return {
    info() {},
    warn() {},
  };
}

function createInteractiveImportLogger(
  progressSpin: ReturnType<typeof clackSpinner>,
  verbose: boolean,
): ImportProgressLogger {
  return {
    info(message) {
      if (/^\[\d+\/\d+\]\s+/u.test(message)) {
        progressSpin.message(message);
        return;
      }

      if (verbose) {
        clackLog.message(message);
      }
    },
    warn(message) {
      progressSpin.message(message);
      clackLog.message(`Warning: ${message}`);
    },
  };
}

function sortRegistryEntries(registry: Record<string, { display: string; type: string }>): Array<[string, { display: string; type: string }]> {
  return Object.entries(registry).sort(([left], [right]) => left.localeCompare(right));
}

function resolvePluginPromptsDir(): string {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  return join(cliDir, "..", "..", "prompts");
}

function substitutePromptTemplate(template: string, values: Record<string, string>): string {
  let output = template;

  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }

  return output;
}

async function readPromptTemplate(name: string): Promise<string> {
  const path = join(resolvePluginPromptsDir(), name);
  return await readFile(path, "utf8");
}

export async function buildPostInitSystemEventText(paths: InitPaths): Promise<string> {
  const [eventTemplate, agentsExcerpt, memoryExcerpt] = await Promise.all([
    readPromptTemplate(POST_INIT_EVENT_PROMPT),
    readPromptTemplate(AGENTS_MEMORY_PROMPT),
    readPromptTemplate(MEMORY_NOTICE_PROMPT),
  ]);

  return substitutePromptTemplate(eventTemplate, {
    AGENTS_EXCERPT: agentsExcerpt.trim(),
    MEMORY_EXCERPT: memoryExcerpt.trim(),
    AGENTS_MD_PATH: paths.agentsMdPath,
    MEMORY_MD_PATH: paths.memoryMdPath,
  }).trim();
}

export async function firePostInitGuidanceEvent(paths: InitPaths): Promise<GuidanceEventResult> {
  let eventText = "";

  try {
    eventText = await buildPostInitSystemEventText(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sent: false, message: `Could not build init event text: ${message}` };
  }

  if (!eventText) {
    return { sent: false, message: "Could not build init event text: empty output" };
  }

  const attempts: string[][] = [
    ["openclaw", "system", "event", "--text", eventText, "--mode", "now"],
    ["openclaw", "system", "event", "--text", eventText],
  ];

  let lastErrorMessage = "unknown error";
  for (const argv of attempts) {
    try {
      const result = await runPluginCommandWithTimeout({
        argv,
        timeoutMs: 10_000,
      });

      if (result.code === 0) {
        return { sent: true };
      }

      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      lastErrorMessage =
        stderr || stdout || `command exited with code ${String(result.code)}`;
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    sent: false,
    message: `Could not fire post-init system event: ${lastErrorMessage}`,
  };
}

export async function ensureLogStoreFiles(paths: InitPaths): Promise<void> {
  await mkdir(paths.logDir, { recursive: true });

  try {
    await readFile(paths.logPath, "utf8");
  } catch {
    await writeFile(paths.logPath, "", "utf8");
  }

  try {
    await readFile(paths.subjectsPath, "utf8");
  } catch {
    await writeFile(paths.subjectsPath, "{}\n", "utf8");
  }

  try {
    await readFile(paths.statePath, "utf8");
  } catch {
    await writeState(paths.statePath, {
      extractedSessions: {},
      failedSessions: {},
      importedConversations: {},
    });
  }
}

export async function updateOpenClawConfigForInit(configPath: string): Promise<void> {
  let current = {};

  try {
    const raw = await readFile(configPath, "utf8");
    current = JSON.parse(raw) as unknown;
  } catch {
    current = {};
  }

  const root = toObject(current);
  const plugins = toObject(root.plugins);
  const slots = toObject(plugins.slots);
  slots.memory = "zettelclaw";
  plugins.slots = slots;
  const allow = Array.isArray(plugins.allow)
    ? plugins.allow
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  if (!allow.includes("zettelclaw")) {
    allow.push("zettelclaw");
  }
  plugins.allow = allow;
  root.plugins = plugins;

  const agents = toObject(root.agents);
  const defaults = toObject(agents.defaults);
  const compaction = toObject(defaults.compaction);
  compaction.memoryFlush = { enabled: false };
  defaults.compaction = compaction;
  agents.defaults = defaults;
  root.agents = agents;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

export async function updateOpenClawConfigForUninit(configPath: string): Promise<void> {
  let root: Record<string, unknown>;

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    root = toObject(parsed);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }

    root = {};
  }

  const plugins = toObject(root.plugins);
  const slots = toObject(plugins.slots);
  delete slots.memory;
  plugins.slots = slots;
  root.plugins = plugins;

  const agents = toObject(root.agents);
  const defaults = toObject(agents.defaults);
  const compaction = toObject(defaults.compaction);
  delete compaction.memoryFlush;
  defaults.compaction = compaction;
  agents.defaults = defaults;
  root.agents = agents;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

export async function ensureMemoryMarkers(memoryMdPath: string): Promise<void> {
  let content = "";

  try {
    content = await readFile(memoryMdPath, "utf8");
  } catch {
    content = "";
  }

  const withBriefing = ensureManagedBlock(content, BRIEFING_BEGIN_MARKER, BRIEFING_END_MARKER);
  const withHandoff = ensureManagedBlock(withBriefing, LAST_HANDOFF_BEGIN_MARKER, LAST_HANDOFF_END_MARKER);
  if (withHandoff === content) {
    return;
  }

  await mkdir(dirname(memoryMdPath), { recursive: true });
  await writeFile(memoryMdPath, withHandoff, "utf8");
}

export async function removeGeneratedBriefingBlock(memoryMdPath: string): Promise<void> {
  let content = "";

  try {
    content = await readFile(memoryMdPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }

    throw error;
  }

  const start = content.indexOf(BRIEFING_BEGIN_MARKER);
  const end = content.indexOf(BRIEFING_END_MARKER);
  if (start < 0 || end < 0 || end <= start) {
    return;
  }

  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + BRIEFING_END_MARKER.length).trimStart();

  let next = "";
  if (before && after) {
    next = `${before}\n\n${after}`;
  } else if (before) {
    next = `${before}\n`;
  } else if (after) {
    next = after;
  }

  await mkdir(dirname(memoryMdPath), { recursive: true });
  await writeFile(memoryMdPath, next, "utf8");
}

const BRIEFING_CRON_NAME = "zettelclaw-briefing";
const LEGACY_CRON_NAMES = ["zettelclaw-reset", "zettelclaw-nightly"] as const;

interface CronJobsDocument {
  version: number;
  jobs: Array<Record<string, unknown>>;
}

function normalizeCronJobsDocument(raw: unknown): CronJobsDocument {
  if (!isObject(raw)) {
    return { version: 1, jobs: [] };
  }

  const version = typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : 1;
  const jobs = Array.isArray(raw.jobs)
    ? raw.jobs.filter((job): job is Record<string, unknown> => isObject(job))
    : [];

  return { version, jobs };
}

async function readCronJobsDocument(cronJobsPath: string): Promise<CronJobsDocument> {
  try {
    const raw = await readFile(cronJobsPath, "utf8");
    return normalizeCronJobsDocument(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isEnoent(error)) {
      return { version: 1, jobs: [] };
    }
    return { version: 1, jobs: [] };
  }
}

async function writeCronJobsDocument(cronJobsPath: string, doc: CronJobsDocument): Promise<void> {
  await mkdir(dirname(cronJobsPath), { recursive: true });
  await writeFile(cronJobsPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

function readJobName(job: Record<string, unknown>): string | undefined {
  return typeof job.name === "string" ? job.name : undefined;
}

function buildBriefingCronJob(config: PluginConfig, existing?: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  const tz = config.cron.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const existingId = typeof existing?.id === "string" ? existing.id : randomUUID();
  const createdAtMs =
    typeof existing?.createdAtMs === "number" && Number.isFinite(existing.createdAtMs)
      ? existing.createdAtMs
      : now;

  return {
    ...existing,
    id: existingId,
    name: BRIEFING_CRON_NAME,
    description: "Nightly Zettelclaw MEMORY.md briefing refresh",
    enabled: true,
    createdAtMs,
    updatedAtMs: now,
    schedule: {
      kind: "cron",
      expr: config.cron.schedule,
      tz,
      staggerMs: 0,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Run: openclaw zettelclaw briefing generate",
      timeoutSeconds: 300,
    },
    delivery: {
      mode: "none",
      channel: "last",
    },
    state: isObject(existing?.state) ? existing.state : {},
  };
}

async function removeCronsByName(cronJobsPath: string, names: readonly string[]): Promise<void> {
  const doc = await readCronJobsDocument(cronJobsPath);
  const filteredJobs = doc.jobs.filter((job) => {
    const name = readJobName(job);
    return !name || !names.includes(name);
  });

  if (filteredJobs.length === doc.jobs.length) {
    return;
  }

  await writeCronJobsDocument(cronJobsPath, {
    ...doc,
    jobs: filteredJobs,
  });
}

async function ensureBriefingCron(paths: InitPaths, config: PluginConfig): Promise<void> {
  const doc = await readCronJobsDocument(paths.cronJobsPath);
  const jobsWithoutLegacy = doc.jobs.filter((job) => {
    const name = readJobName(job);
    return !name || !LEGACY_CRON_NAMES.includes(name);
  });

  const briefingIndexes = jobsWithoutLegacy
    .map((job, index) => ({ index, name: readJobName(job) }))
    .filter((entry) => entry.name === BRIEFING_CRON_NAME)
    .map((entry) => entry.index);

  const nextJobs = [...jobsWithoutLegacy];
  if (briefingIndexes.length > 0) {
    const firstIndex = briefingIndexes[0];
    const existing = nextJobs[firstIndex];
    nextJobs[firstIndex] = buildBriefingCronJob(config, existing);

    for (let i = briefingIndexes.length - 1; i >= 1; i -= 1) {
      nextJobs.splice(briefingIndexes[i], 1);
    }
  } else {
    nextJobs.push(buildBriefingCronJob(config));
  }

  await writeCronJobsDocument(paths.cronJobsPath, {
    ...doc,
    jobs: nextJobs,
  });
}

async function removeBriefingCron(paths: InitPaths): Promise<void> {
  await removeCronsByName(paths.cronJobsPath, [BRIEFING_CRON_NAME]);
}

export async function runInit(
  config: PluginConfig,
  workspaceDir?: string,
  deps: InitDeps = {},
): Promise<InitResult> {
  const paths = resolvePaths(config, workspaceDir);

  await ensureLogStoreFiles(paths);
  await updateOpenClawConfigForInit(paths.openClawConfigPath);
  await ensureMemoryMarkers(paths.memoryMdPath);
  await ensureBriefingCron(paths, config);

  const fireGuidanceEvent = deps.fireGuidanceEvent ?? firePostInitGuidanceEvent;
  const guidanceEvent = await fireGuidanceEvent(paths);

  return {
    paths,
    guidanceEvent,
  };
}

export async function runUninstall(config: PluginConfig, workspaceDir?: string): Promise<InitPaths> {
  const paths = resolvePaths(config, workspaceDir);

  await updateOpenClawConfigForUninit(paths.openClawConfigPath);
  await removeGeneratedBriefingBlock(paths.memoryMdPath);
  await removeBriefingCron(paths);

  return paths;
}

export async function verifySetup(config: PluginConfig, workspaceDir?: string): Promise<VerifyResult> {
  const paths = resolvePaths(config, workspaceDir);
  const checks: VerifyCheck[] = [];
  const addCheck = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // log.jsonl
  try {
    await readFile(paths.logPath, "utf8");
    addCheck("log.jsonl", true, "ok");
  } catch (error) {
    addCheck("log.jsonl", false, isEnoent(error) ? "missing" : String(error));
  }

  // subjects.json
  try {
    const subjectsRaw = await readFile(paths.subjectsPath, "utf8");
    const parsed = JSON.parse(subjectsRaw) as unknown;
    addCheck("subjects.json", isObject(parsed), isObject(parsed) ? "ok" : "expected JSON object");
  } catch (error) {
    const detail = isEnoent(error) ? "missing" : `invalid JSON or unreadable: ${String(error)}`;
    addCheck("subjects.json", false, detail);
  }

  // state.json
  try {
    const stateRaw = await readFile(paths.statePath, "utf8");
    const parsed = JSON.parse(stateRaw) as unknown;
    if (!isObject(parsed)) {
      addCheck("state.json", false, "expected JSON object");
    } else {
      const hasExpectedKeys =
        isObject(parsed.extractedSessions) &&
        isObject(parsed.failedSessions) &&
        isObject(parsed.importedConversations);
      addCheck("state.json", hasExpectedKeys, hasExpectedKeys ? "ok" : "missing expected state keys");
    }
  } catch (error) {
    const detail = isEnoent(error) ? "missing" : `invalid JSON or unreadable: ${String(error)}`;
    addCheck("state.json", false, detail);
  }

  // openclaw.json + required config values
  try {
    const configRaw = await readFile(paths.openClawConfigPath, "utf8");
    const parsed = JSON.parse(configRaw) as unknown;
    const configRoot = toObject(parsed);
    const plugins = toObject(configRoot.plugins);
    const slots = toObject(plugins.slots);
    const slotValue = typeof slots.memory === "string" ? slots.memory : undefined;

    const agents = toObject(configRoot.agents);
    const defaults = toObject(agents.defaults);
    const compaction = toObject(defaults.compaction);
    const memoryFlush = compaction.memoryFlush;
    const memoryFlushDisabled = isObject(memoryFlush) && memoryFlush.enabled === false;

    if (slotValue === "zettelclaw" && memoryFlushDisabled) {
      addCheck("openclaw.json", true, "ok");
    } else {
      const issues: string[] = [];
      if (slotValue !== "zettelclaw") {
        issues.push(`plugins.slots.memory=${slotValue ? `"${slotValue}"` : "missing"}`);
      }
      if (!memoryFlushDisabled) {
        if (isObject(memoryFlush)) {
          issues.push(`memoryFlush.enabled=${String(memoryFlush.enabled)}`);
        } else {
          issues.push("memoryFlush missing");
        }
      }
      addCheck("openclaw.json", false, issues.join("; "));
    }
  } catch (error) {
    const detail = isEnoent(error) ? "missing" : `invalid JSON or unreadable: ${String(error)}`;
    addCheck("openclaw.json", false, detail);
  }

  // AGENTS.md zettelclaw guidance markers
  try {
    const agentsContent = await readFile(paths.agentsMdPath, "utf8");
    const hasGuidanceMarkers =
      agentsContent.includes(AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER) &&
      agentsContent.includes(AGENTS_MEMORY_GUIDANCE_END_MARKER);
    addCheck(
      "AGENTS.md",
      hasGuidanceMarkers,
      hasGuidanceMarkers ? "ok" : "missing zettelclaw guidance markers",
    );
  } catch (error) {
    addCheck("AGENTS.md", false, isEnoent(error) ? "missing" : String(error));
  }

  // MEMORY.md markers + zettelclaw notice
  try {
    const memoryContent = await readFile(paths.memoryMdPath, "utf8");
    const hasBriefingMarkers =
      memoryContent.includes(BRIEFING_BEGIN_MARKER) && memoryContent.includes(BRIEFING_END_MARKER);
    const hasHandoffMarkers =
      memoryContent.includes(LAST_HANDOFF_BEGIN_MARKER) &&
      memoryContent.includes(LAST_HANDOFF_END_MARKER);
    const hasNoticeMarkers =
      memoryContent.includes(MEMORY_NOTICE_BEGIN_MARKER) &&
      memoryContent.includes(MEMORY_NOTICE_END_MARKER);

    if (hasBriefingMarkers && hasHandoffMarkers && hasNoticeMarkers) {
      addCheck("MEMORY.md", true, "ok");
    } else {
      const issues: string[] = [];
      if (!hasBriefingMarkers) {
        issues.push("missing generated briefing markers");
      }
      if (!hasHandoffMarkers) {
        issues.push("missing last handoff markers");
      }
      if (!hasNoticeMarkers) {
        issues.push("missing zettelclaw memory notice");
      }
      addCheck("MEMORY.md", false, issues.join("; "));
    }
  } catch (error) {
    addCheck("MEMORY.md", false, isEnoent(error) ? "missing" : String(error));
  }

  // briefing cron
  try {
    const doc = await readCronJobsDocument(paths.cronJobsPath);
    const briefingJob = doc.jobs.find((job) => readJobName(job) === BRIEFING_CRON_NAME);
    if (!briefingJob) {
      addCheck(`cron:${BRIEFING_CRON_NAME}`, false, "missing");
    } else {
      const enabled = briefingJob.enabled === true;
      addCheck(`cron:${BRIEFING_CRON_NAME}`, enabled, enabled ? "ok" : "disabled");
    }
  } catch (error) {
    addCheck(`cron:${BRIEFING_CRON_NAME}`, false, String(error));
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    paths,
  };
}

export async function runVerify(config: PluginConfig, workspaceDir?: string): Promise<VerifyResult> {
  const result = await verifySetup(config, workspaceDir);

  for (const check of result.checks) {
    console.log(`${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`);
  }

  if (!result.ok) {
    throw new Error("Zettelclaw verify failed");
  }

  console.log("Zettelclaw verify passed.");
  console.log(`Log directory: ${result.paths.logDir}`);
  return result;
}

function printEntries(entries: LogEntry[]): void {
  if (entries.length === 0) {
    console.log("No entries.");
    return;
  }

  for (const entry of entries) {
    console.log(formatEntry(entry));
  }
}

function registerZettelclawCliCommands(
  program: unknown,
  config: PluginConfig,
  api: OpenClawPluginApi,
  workspaceDir?: string,
): void {
  const root = program as CommandLike;
  const zettelclaw = root.command("zettelclaw").description("Zettelclaw memory management");

  zettelclaw
    .command("init")
    .description("Initialize zettelclaw memory store and config")
    .action(async () => {
      const initResult = await runInit(config, workspaceDir);
      const paths = initResult.paths;
      console.log("Zettelclaw initialized.");
      console.log(`Log directory: ${paths.logDir}`);
      console.log(`Config updated: ${paths.openClawConfigPath}`);
      console.log(`MEMORY.md markers ensured: ${paths.memoryMdPath}`);
      if (initResult.guidanceEvent.sent) {
        console.log("Main session notified to update AGENTS.md and MEMORY.md guidance.");
      } else {
        console.log(
          `Warning: could not notify main session to update AGENTS.md/MEMORY.md guidance (${initResult.guidanceEvent.message ?? "unknown error"})`,
        );
      }
    });

  zettelclaw
    .command("uninstall")
    .description("Reverse init config and remove generated briefing block")
    .action(async () => {
      const paths = await runUninstall(config, workspaceDir);
      console.log("Zettelclaw uninstalled.");
      console.log(`Config reverted: ${paths.openClawConfigPath}`);
      console.log(`Generated briefing block removed: ${paths.memoryMdPath}`);
      console.log(`Log data preserved in: ${paths.logDir}`);
    });

  zettelclaw
    .command("verify")
    .description("Verify zettelclaw setup and required files")
    .action(async () => {
      await runVerify(config, workspaceDir);
    });

  zettelclaw
    .command("log")
    .description("Print recent log entries")
    .option("--limit <n>", "Max number of entries", 20)
    .option("--type <type>", "Entry type")
    .option("--subject <slug>", "Subject slug")
    .action(async (opts: unknown) => {
      const options = toObject(opts);
      const paths = resolvePaths(config, workspaceDir);
      const limit = readNumberOption(options.limit, 20);

      const entries = await queryLog(paths.logPath, {
        ...(parseEntryType(options.type) ? { type: parseEntryType(options.type) } : {}),
        ...(typeof options.subject === "string" && options.subject.trim()
          ? { subject: options.subject.trim() }
          : {}),
      });

      printEntries(entries.slice(0, limit));
    });

  zettelclaw
    .command("search [query]")
    .description("Search log entries")
    .option("--type <type>", "Entry type")
    .option("--subject <slug>", "Subject slug")
    .option("--status <status>", "Task status")
    .option("--all", "Include replaced entries", false)
    .action(async (query: unknown, opts: unknown) => {
      const options = toObject(opts);
      const paths = resolvePaths(config, workspaceDir);

      const filter = {
        ...(parseEntryType(options.type) ? { type: parseEntryType(options.type) } : {}),
        ...(typeof options.subject === "string" && options.subject.trim()
          ? { subject: options.subject.trim() }
          : {}),
        ...(parseStatus(options.status) ? { status: parseStatus(options.status) } : {}),
        includeReplaced: options.all === true,
      };

      const entries =
        typeof query === "string" && query.trim().length > 0
          ? await searchLog(paths.logPath, query.trim(), filter)
          : await queryLog(paths.logPath, filter);

      printEntries(entries);
    });

  zettelclaw
    .command("import [platform] [file]")
    .description("Import historical data (interactive if args are omitted)")
    .option("--dry-run", "Preview import without writing files", false)
    .option("--after <date>", "Only include conversations updated on/after this date")
    .option("--before <date>", "Only include conversations updated on/before this date")
    .option("--min-messages <n>", "Minimum user/assistant messages per conversation")
    .option("--jobs <n>", "Concurrent import workers")
    .option("--model <model>", "Extraction model")
    .option("--force", "Import even if conversation was imported before", false)
    .option("--keep-source", "Do not clear source files after successful openclaw migration", false)
    .option("--backup-memory-docs", "Back up MEMORY.md and USER.md before openclaw migration", false)
    .option("--no-transcripts", "Do not write OpenClaw transcript sessions")
    .option("--verbose", "Verbose progress output", false)
    .action(async (platform: unknown, file: unknown, opts: unknown) => {
      try {
        const options = toObject(opts);
        const selection = await resolveImportSelection({
          platformArg: platform,
          fileArg: file,
          workspaceDir,
        });

        if (selection.interactive) {
          const importOptions = { ...options };
          const requestedModel = normalizeModelOption(importOptions.model);
          const modelSpin = clackSpinner();
          modelSpin.start("Loading available models");
          const models = await listImportModels();
          modelSpin.stop(models.length > 0 ? "Model list loaded" : "Model list unavailable, using default");

          if (models.length > 0) {
            if (requestedModel) {
              const resolvedRequested = resolveModelByQuery(models, requestedModel);
              if (!resolvedRequested) {
                const available = models.map((model) => model.key).join(", ");
                throw new Error(`Model not found: ${requestedModel}. Available models: ${available}`);
              }
              importOptions.model = resolvedRequested.key;
            } else {
              const defaultModel = models.find((model) => model.isDefault) ?? models[0];
              if (defaultModel) {
                const selectedModelKey = unwrapPromptValue(
                  await clackSelect({
                    message: "Which model should import extraction use?",
                    initialValue: defaultModel.key,
                    options: models.map((model) => ({
                      value: model.key,
                      label: formatImportModelLabel(model),
                      hint: model.key === defaultModel.key ? "default" : undefined,
                    })),
                  }),
                );
                importOptions.model = selectedModelKey;
              }
            }
          } else if (!requestedModel) {
            importOptions.model = DEFAULT_IMPORT_MODEL;
          }

          const paths = resolvePaths(config, workspaceDir);

          clackLog.message(`Source: ${platformLabel(selection.platform)}`);
          clackLog.message(`Path: ${selection.filePath}`);
          clackLog.message(`Model: ${normalizeModelOption(importOptions.model) ?? DEFAULT_IMPORT_MODEL}`);
          clackLog.message(`State file: ${paths.statePath}`);

          if (selection.platform === "openclaw") {
            const preflightSpin = clackSpinner();
            preflightSpin.start("Reading openclaw source stats");
            const preflight = await readOpenClawMemoryPreflight(selection.filePath);
            preflightSpin.stop("Source stats loaded");
            clackLog.message(
              `OpenClaw preflight: files=${preflight.markdownFiles}, daily=${preflight.dailyFiles}, other=${preflight.otherFiles}`,
            );
            clackLog.message(
              `OpenClaw preflight: dateRange=${preflight.dateRange}, size=${formatBytes(preflight.sourceSizeBytes)}`,
            );
            clackLog.message(
              `OpenClaw preflight: source cleanup=${importOptions.keepSource === true ? "disabled" : "enabled"}`,
            );
            clackLog.message(
              `OpenClaw preflight: memory doc backups=${importOptions.backupMemoryDocs === true ? "enabled" : "disabled"}`,
            );
          }

          const previewSpin = clackSpinner();
          previewSpin.start("Running preview (dry-run)");
          const previewResult = await runImportCommand({
            config,
            workspaceDir,
            apiConfig: api.config,
            platform: selection.platform,
            filePath: selection.filePath,
            opts: {
              ...importOptions,
              dryRun: true,
            },
            logger: createSilentImportLogger(),
          });
          previewSpin.stop("Preview complete");
          printImportSummary(previewResult, selection.platform);

          if (options.dryRun === true) {
            clackOutro("Dry-run complete.");
            return;
          }

          const shouldProceed = unwrapPromptValue(
            await clackConfirm({
              message: "Proceed with import and write changes?",
              initialValue: true,
            }),
          );

          if (!shouldProceed) {
            clackOutro("Import canceled.");
            return;
          }

          const runSpin = clackSpinner();
          runSpin.start("Running import");
          const result = await runImportCommand({
            config,
            workspaceDir,
            apiConfig: api.config,
            platform: selection.platform,
            filePath: selection.filePath,
            opts: importOptions,
            logger: createInteractiveImportLogger(runSpin, importOptions.verbose === true),
          });
          runSpin.stop("Import complete");
          printImportSummary(result, selection.platform);
          clackOutro("Import finished.");
          return;
        }

        const result = await runImportCommand({
          config,
          workspaceDir,
          apiConfig: api.config,
          platform: selection.platform,
          filePath: selection.filePath,
          opts: options,
        });
        printImportSummary(result, selection.platform);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Import canceled") {
          if (isInteractiveTerminal()) {
            clackOutro("Import canceled.");
          }
          return;
        }
        if (isInteractiveTerminal()) {
          clackOutro("Import failed.");
        }
        throw error;
      }
    });

  const subjects = zettelclaw.command("subjects").description("Manage subject registry");

  subjects
    .command("list")
    .description("List subjects")
    .action(async () => {
      const paths = resolvePaths(config, workspaceDir);
      const registry = await readRegistry(paths.subjectsPath);
      const items = sortRegistryEntries(registry);

      if (items.length === 0) {
        console.log("No subjects.");
        return;
      }

      for (const [slug, subject] of items) {
        console.log(`${slug}\t${subject.display}\t(${subject.type})`);
      }
    });

  subjects
    .command("add <slug>")
    .description("Add a subject")
    .option("--type <type>", "Subject type", "project")
    .option("--display <display>", "Display name")
    .action(async (slug: unknown, opts: unknown) => {
      if (typeof slug !== "string" || slug.trim().length === 0) {
        throw new Error("slug is required");
      }

      const options = toObject(opts);
      const paths = resolvePaths(config, workspaceDir);
      const normalizedSlug = slug.trim();
      const inferredType = typeof options.type === "string" && options.type.trim() ? options.type.trim() : "project";

      await ensureSubject(paths.subjectsPath, normalizedSlug, inferredType);

      if (typeof options.display === "string" && options.display.trim()) {
        const registry = await readRegistry(paths.subjectsPath);
        const existing = registry[normalizedSlug];
        if (existing) {
          registry[normalizedSlug] = {
            ...existing,
            display: options.display.trim(),
          };
          await writeRegistry(paths.subjectsPath, registry);
        }
      }

      console.log(`Added subject: ${normalizedSlug}`);
    });

  subjects
    .command("rename <oldSlug> <newSlug>")
    .description("Rename a subject")
    .action(async (oldSlug: unknown, newSlug: unknown) => {
      if (
        typeof oldSlug !== "string" ||
        oldSlug.trim().length === 0 ||
        typeof newSlug !== "string" ||
        newSlug.trim().length === 0
      ) {
        throw new Error("oldSlug and newSlug are required");
      }

      const paths = resolvePaths(config, workspaceDir);
      await renameSubject(paths.subjectsPath, paths.logPath, oldSlug.trim(), newSlug.trim());
      console.log(`Renamed subject: ${oldSlug.trim()} -> ${newSlug.trim()}`);
    });

  const briefing = zettelclaw.command("briefing").description("Briefing generation helpers");

  briefing
    .command("generate")
    .description("Generate and write MEMORY.md briefing block")
    .action(async () => {
      const paths = resolvePaths(config, workspaceDir);
      const apiToken =
        isObject(api.config) &&
        isObject(api.config.gateway) &&
        isObject(api.config.gateway.auth) &&
        typeof api.config.gateway.auth.token === "string" &&
        api.config.gateway.auth.token.trim().length > 0
          ? api.config.gateway.auth.token
          : undefined;

      await generateBriefing({
        logPath: paths.logPath,
        memoryMdPath: paths.memoryMdPath,
        config,
        apiToken,
      });

      console.log(`Briefing updated: ${paths.memoryMdPath}`);
    });
}

export function registerZettelclawCli(
  api: OpenClawPluginApi,
  config: PluginConfig,
): void {
  api.registerCli(
    ({ program, workspaceDir }) => {
      registerZettelclawCliCommands(program, config, api, workspaceDir);
    },
    { commands: ["zettelclaw"] },
  );
}

export const __cliTestExports = {
  resolvePaths,
};
