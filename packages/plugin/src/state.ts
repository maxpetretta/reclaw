import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ExtractedSession {
  at: string;
  entries: number;
}

export interface FailedSession {
  at: string;
  error: string;
  retries: number;
}

export interface ImportedConversationState {
  at: string;
  updatedAt: string;
  sessionId: string;
  entries: number;
  title?: string;
}

export interface EventUsageState {
  memoryGetCount: number;
  citationCount: number;
  lastAccessAt: string;
}

export type EventUsageKind = "memory_get" | "citation";

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";

export interface ImportJobOptionsState {
  after?: string;
  before?: string;
  minMessages?: number;
  jobs?: number;
  model?: string;
  force?: boolean;
  transcripts?: boolean;
  verbose?: boolean;
  keepSource?: boolean;
  backupMemoryDocs?: boolean;
}

export interface ImportJobSummaryState {
  platform: "chatgpt" | "claude" | "grok" | "openclaw";
  parsed: number;
  dedupedInInput: number;
  selected: number;
  skippedByDate: number;
  skippedByMinMessages: number;
  skippedAlreadyImported: number;
  imported: number;
  failed: number;
  entriesWritten: number;
  transcriptsWritten: number;
  dryRun: boolean;
}

export interface ImportJobState {
  id: string;
  status: ImportJobStatus;
  platform: "chatgpt" | "claude" | "grok" | "openclaw";
  filePath: string;
  options: ImportJobOptionsState;
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  attempts: number;
  workspaceDir?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  summary?: ImportJobSummaryState;
  cronJobId?: string;
  cronJobName?: string;
}

export interface ZettelclawState {
  extractedSessions: Record<string, ExtractedSession>;
  failedSessions: Record<string, FailedSession>;
  importedConversations: Record<string, ImportedConversationState>;
  eventUsage: Record<string, EventUsageState>;
  importJobs: Record<string, ImportJobState>;
}

function createEmptyState(): ZettelclawState {
  return {
    extractedSessions: {},
    failedSessions: {},
    importedConversations: {},
    eventUsage: {},
    importJobs: {},
  };
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

const IMPORTED_PLATFORM_SET = new Set(["chatgpt", "claude", "grok", "openclaw"]);
const IMPORT_JOB_STATUS_SET: ReadonlySet<ImportJobStatus> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
]);

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeImportJobOptions(raw: unknown): ImportJobOptionsState {
  if (!isObject(raw)) {
    return {};
  }

  const options: ImportJobOptionsState = {};

  if (typeof raw.after === "string" && Number.isFinite(Date.parse(raw.after))) {
    options.after = raw.after;
  }

  if (typeof raw.before === "string" && Number.isFinite(Date.parse(raw.before))) {
    options.before = raw.before;
  }

  if (typeof raw.minMessages === "number" && Number.isFinite(raw.minMessages) && raw.minMessages > 0) {
    options.minMessages = Math.floor(raw.minMessages);
  }

  if (typeof raw.jobs === "number" && Number.isFinite(raw.jobs) && raw.jobs > 0) {
    options.jobs = Math.floor(raw.jobs);
  }

  if (typeof raw.model === "string" && raw.model.trim().length > 0) {
    options.model = raw.model.trim();
  }

  if (typeof raw.force === "boolean") {
    options.force = raw.force;
  }

  if (typeof raw.transcripts === "boolean") {
    options.transcripts = raw.transcripts;
  }

  if (typeof raw.verbose === "boolean") {
    options.verbose = raw.verbose;
  }

  if (typeof raw.keepSource === "boolean") {
    options.keepSource = raw.keepSource;
  }

  if (typeof raw.backupMemoryDocs === "boolean") {
    options.backupMemoryDocs = raw.backupMemoryDocs;
  }

  return options;
}

function isValidPlatform(value: unknown): value is ImportJobSummaryState["platform"] {
  return typeof value === "string" && IMPORTED_PLATFORM_SET.has(value);
}

function normalizeImportJobSummary(raw: unknown): ImportJobSummaryState | undefined {
  if (!isObject(raw) || !isValidPlatform(raw.platform)) {
    return undefined;
  }

  const numericKeys = [
    "parsed",
    "dedupedInInput",
    "selected",
    "skippedByDate",
    "skippedByMinMessages",
    "skippedAlreadyImported",
    "imported",
    "failed",
    "entriesWritten",
    "transcriptsWritten",
  ] as const;

  for (const key of numericKeys) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) {
      return undefined;
    }
  }

  if (typeof raw.dryRun !== "boolean") {
    return undefined;
  }

  return {
    platform: raw.platform,
    parsed: raw.parsed,
    dedupedInInput: raw.dedupedInInput,
    selected: raw.selected,
    skippedByDate: raw.skippedByDate,
    skippedByMinMessages: raw.skippedByMinMessages,
    skippedAlreadyImported: raw.skippedAlreadyImported,
    imported: raw.imported,
    failed: raw.failed,
    entriesWritten: raw.entriesWritten,
    transcriptsWritten: raw.transcriptsWritten,
    dryRun: raw.dryRun,
  };
}

function parseConversationKey(value: string): { platform: string; conversationId: string } | null {
  const delimiterIndex = value.indexOf(":");
  if (delimiterIndex <= 0 || delimiterIndex >= value.length - 1) {
    return null;
  }

  return {
    platform: value.slice(0, delimiterIndex),
    conversationId: value.slice(delimiterIndex + 1),
  };
}

function hasValidImportedSessionId(conversationKey: string, sessionId: string): boolean {
  const parsedKey = parseConversationKey(conversationKey);
  if (!parsedKey || !IMPORTED_PLATFORM_SET.has(parsedKey.platform)) {
    return false;
  }

  return sessionId === `reclaw:${parsedKey.platform}:${parsedKey.conversationId}`;
}

function normalizeState(raw: unknown): ZettelclawState {
  if (!isObject(raw)) {
    return createEmptyState();
  }

  const extractedSessions: Record<string, ExtractedSession> = {};
  const failedSessions: Record<string, FailedSession> = {};
  const importedConversations: Record<string, ImportedConversationState> = {};
  const eventUsage: Record<string, EventUsageState> = {};
  const importJobs: Record<string, ImportJobState> = {};

  const extractedRaw = isObject(raw.extractedSessions) ? raw.extractedSessions : {};
  const failedRaw = isObject(raw.failedSessions) ? raw.failedSessions : {};
  const importedRaw = isObject(raw.importedConversations) ? raw.importedConversations : {};
  const eventUsageRaw = isObject(raw.eventUsage) ? raw.eventUsage : {};
  const importJobsRaw = isObject(raw.importJobs) ? raw.importJobs : {};

  for (const [sessionId, sessionValue] of Object.entries(extractedRaw)) {
    if (!isObject(sessionValue)) {
      continue;
    }

    if (
      typeof sessionValue.at !== "string" ||
      !Number.isFinite(Date.parse(sessionValue.at)) ||
      typeof sessionValue.entries !== "number"
    ) {
      continue;
    }

    extractedSessions[sessionId] = {
      at: sessionValue.at,
      entries: sessionValue.entries,
    };
  }

  for (const [sessionId, sessionValue] of Object.entries(failedRaw)) {
    if (!isObject(sessionValue)) {
      continue;
    }

    if (
      typeof sessionValue.at !== "string" ||
      !Number.isFinite(Date.parse(sessionValue.at)) ||
      typeof sessionValue.error !== "string" ||
      typeof sessionValue.retries !== "number"
    ) {
      continue;
    }

    failedSessions[sessionId] = {
      at: sessionValue.at,
      error: sessionValue.error,
      retries: sessionValue.retries,
    };
  }

  for (const [conversationKey, conversationValue] of Object.entries(importedRaw)) {
    if (!isObject(conversationValue)) {
      continue;
    }

    const sessionId =
      typeof conversationValue.sessionId === "string" ? conversationValue.sessionId.trim() : "";

    if (
      typeof conversationValue.at !== "string" ||
      !Number.isFinite(Date.parse(conversationValue.at)) ||
      typeof conversationValue.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(conversationValue.updatedAt)) ||
      sessionId.length === 0 ||
      !hasValidImportedSessionId(conversationKey, sessionId) ||
      typeof conversationValue.entries !== "number"
    ) {
      continue;
    }

    importedConversations[conversationKey] = {
      at: conversationValue.at,
      updatedAt: conversationValue.updatedAt,
      sessionId,
      entries: conversationValue.entries,
      ...(typeof conversationValue.title === "string" && conversationValue.title.trim().length > 0
        ? { title: conversationValue.title }
        : {}),
    };
  }

  for (const [entryId, usageValue] of Object.entries(eventUsageRaw)) {
    if (!isObject(usageValue)) {
      continue;
    }

    if (
      typeof usageValue.memoryGetCount !== "number" ||
      usageValue.memoryGetCount < 0 ||
      !Number.isFinite(usageValue.memoryGetCount) ||
      typeof usageValue.citationCount !== "number" ||
      usageValue.citationCount < 0 ||
      !Number.isFinite(usageValue.citationCount) ||
      typeof usageValue.lastAccessAt !== "string" ||
      !Number.isFinite(Date.parse(usageValue.lastAccessAt))
    ) {
      continue;
    }

    eventUsage[entryId] = {
      memoryGetCount: usageValue.memoryGetCount,
      citationCount: usageValue.citationCount,
      lastAccessAt: usageValue.lastAccessAt,
    };
  }

  for (const [jobId, jobValue] of Object.entries(importJobsRaw)) {
    if (!isObject(jobValue)) {
      continue;
    }

    const status =
      typeof jobValue.status === "string" && IMPORT_JOB_STATUS_SET.has(jobValue.status as ImportJobStatus)
        ? (jobValue.status as ImportJobStatus)
        : null;
    const platform = isValidPlatform(jobValue.platform) ? jobValue.platform : null;
    const filePath = typeof jobValue.filePath === "string" ? jobValue.filePath.trim() : "";
    const createdAt = jobValue.createdAt;
    const updatedAt = jobValue.updatedAt;
    const queuedAt = jobValue.queuedAt;
    const attempts = jobValue.attempts;

    if (
      !status ||
      !platform ||
      filePath.length === 0 ||
      !isValidTimestamp(createdAt) ||
      !isValidTimestamp(updatedAt) ||
      !isValidTimestamp(queuedAt) ||
      typeof attempts !== "number" ||
      !Number.isFinite(attempts) ||
      attempts < 0
    ) {
      continue;
    }

    const normalized: ImportJobState = {
      id: jobId,
      status,
      platform,
      filePath,
      options: normalizeImportJobOptions(jobValue.options),
      createdAt,
      updatedAt,
      queuedAt,
      attempts: Math.floor(attempts),
    };

    if (typeof jobValue.workspaceDir === "string" && jobValue.workspaceDir.trim().length > 0) {
      normalized.workspaceDir = jobValue.workspaceDir.trim();
    }

    if (isValidTimestamp(jobValue.startedAt)) {
      normalized.startedAt = jobValue.startedAt;
    }

    if (isValidTimestamp(jobValue.finishedAt)) {
      normalized.finishedAt = jobValue.finishedAt;
    }

    if (typeof jobValue.error === "string" && jobValue.error.trim().length > 0) {
      normalized.error = jobValue.error;
    }

    const summary = normalizeImportJobSummary(jobValue.summary);
    if (summary) {
      normalized.summary = summary;
    }

    if (typeof jobValue.cronJobId === "string" && jobValue.cronJobId.trim().length > 0) {
      normalized.cronJobId = jobValue.cronJobId.trim();
    }

    if (typeof jobValue.cronJobName === "string" && jobValue.cronJobName.trim().length > 0) {
      normalized.cronJobName = jobValue.cronJobName.trim();
    }

    importJobs[jobId] = normalized;
  }

  return {
    extractedSessions,
    failedSessions,
    importedConversations,
    eventUsage,
    importJobs,
  };
}

export async function readState(path: string): Promise<ZettelclawState> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return createEmptyState();
    }

    throw error;
  }

  return normalizeState(JSON.parse(raw));
}

export async function writeState(path: string, state: ZettelclawState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function markExtracted(
  path: string,
  sessionId: string,
  entryCount: number,
): Promise<void> {
  const state = await readState(path);

  state.extractedSessions[sessionId] = {
    at: new Date().toISOString(),
    entries: entryCount,
  };

  delete state.failedSessions[sessionId];
  await writeState(path, state);
}

export async function markFailed(path: string, sessionId: string, error: string): Promise<void> {
  const state = await readState(path);
  const previous = state.failedSessions[sessionId];

  state.failedSessions[sessionId] = {
    at: new Date().toISOString(),
    error,
    retries: (previous?.retries ?? 0) + 1,
  };

  await writeState(path, state);
}

export function isExtracted(state: ZettelclawState, sessionId: string): boolean {
  return Boolean(state.extractedSessions[sessionId]);
}

export function isImportedConversation(state: ZettelclawState, conversationKey: string): boolean {
  return Boolean(state.importedConversations[conversationKey]);
}

export function shouldRetry(state: ZettelclawState, sessionId: string): boolean {
  return (state.failedSessions[sessionId]?.retries ?? 0) < 2;
}

export async function incrementEventUsage(
  path: string,
  eventIds: string[],
  kind: EventUsageKind,
): Promise<void> {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return;
  }

  const normalizedIds = [...new Set(
    eventIds
      .map((eventId) => eventId.trim())
      .filter((eventId) => eventId.length > 0),
  )];
  if (normalizedIds.length === 0) {
    return;
  }

  const state = await readState(path);
  const now = new Date().toISOString();

  for (const eventId of normalizedIds) {
    const existing = state.eventUsage[eventId] ?? {
      memoryGetCount: 0,
      citationCount: 0,
      lastAccessAt: now,
    };

    if (kind === "memory_get") {
      existing.memoryGetCount += 1;
    } else {
      existing.citationCount += 1;
    }

    existing.lastAccessAt = now;
    state.eventUsage[eventId] = existing;
  }

  await writeState(path, state);
}

export async function pruneState(path: string, maxAgeDays = 30): Promise<void> {
  const state = await readState(path);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const [sessionId, extracted] of Object.entries(state.extractedSessions)) {
    if (!Number.isFinite(Date.parse(extracted.at)) || Date.parse(extracted.at) < cutoff) {
      delete state.extractedSessions[sessionId];
    }
  }

  for (const [sessionId, failed] of Object.entries(state.failedSessions)) {
    if (!Number.isFinite(Date.parse(failed.at)) || Date.parse(failed.at) < cutoff) {
      delete state.failedSessions[sessionId];
    }
  }

  await writeState(path, state);
}
