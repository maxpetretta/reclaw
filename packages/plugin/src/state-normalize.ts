import { isObject } from "./lib/guards";
import type {
  CompactionExtractionStatus,
  CompactionSessionState,
  EventUsageState,
  ExtractedSession,
  FailedSession,
  ImportJobOptionsState,
  ImportJobProgressState,
  ImportJobState,
  ImportJobStatus,
  ImportJobSummaryState,
  ImportedConversationState,
  ReclawState,
  SnapshotRunState,
  SnapshotRunStatus,
} from "./state/types";

const IMPORTED_PLATFORM_SET = new Set(["chatgpt", "claude", "grok", "openclaw"]);
const IMPORT_JOB_STATUS_SET: ReadonlySet<ImportJobStatus> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
]);
const COMPACTION_STATUS_SET: ReadonlySet<CompactionExtractionStatus> = new Set([
  "observed",
  "extracted",
  "failed",
  "skipped",
]);
const SNAPSHOT_STATUS_SET: ReadonlySet<SnapshotRunStatus> = new Set(["success", "failed"]);

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeInt(value: unknown): number | undefined {
  const n = readFiniteNumber(value);
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined;
}

function readTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  const n = readFiniteNumber(value);
  return n !== undefined && n > 0 ? Math.floor(n) : undefined;
}

function assignDefined<T extends Record<string, unknown>, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function normalizeImportJobOptions(raw: unknown): ImportJobOptionsState {
  if (!isObject(raw)) {
    return {};
  }

  const options: ImportJobOptionsState = {};
  assignDefined(options, "after", readTimestamp(raw.after));
  assignDefined(options, "before", readTimestamp(raw.before));
  assignDefined(options, "minMessages", readPositiveInt(raw.minMessages));
  assignDefined(options, "jobs", readPositiveInt(raw.jobs));
  assignDefined(options, "model", readTrimmedString(raw.model));
  assignDefined(options, "force", readBoolean(raw.force));
  assignDefined(options, "transcripts", readBoolean(raw.transcripts));
  assignDefined(options, "verbose", readBoolean(raw.verbose));
  assignDefined(options, "keepSource", readBoolean(raw.keepSource));
  assignDefined(options, "backupMemoryDocs", readBoolean(raw.backupMemoryDocs));

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

  const subjectsCreatedRaw = raw.subjectsCreated;
  const subjectsCreated =
    typeof subjectsCreatedRaw === "number" && Number.isFinite(subjectsCreatedRaw) && subjectsCreatedRaw >= 0
      ? subjectsCreatedRaw
      : 0;

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
    subjectsCreated,
    transcriptsWritten: raw.transcriptsWritten,
    dryRun: raw.dryRun,
  };
}

function normalizeImportJobProgress(raw: unknown): ImportJobProgressState | undefined {
  if (!isObject(raw)) {
    return undefined;
  }

  const total = readNonNegativeInt(raw.total);
  const completed = readNonNegativeInt(raw.completed);
  const imported = readNonNegativeInt(raw.imported);
  const failed = readNonNegativeInt(raw.failed);
  const entriesWritten = readNonNegativeInt(raw.entriesWritten);
  const subjectsCreated = readNonNegativeInt(raw.subjectsCreated);

  if (
    total === undefined ||
    completed === undefined ||
    imported === undefined ||
    failed === undefined ||
    entriesWritten === undefined ||
    subjectsCreated === undefined
  ) {
    return undefined;
  }

  return { total, completed, imported, failed, entriesWritten, subjectsCreated };
}

function normalizeRecord<T>(
  raw: unknown,
  parse: (value: unknown, key: string) => T | undefined,
): Record<string, T> {
  if (!isObject(raw)) {
    return {};
  }

  const normalized: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parse(value, key);
    if (parsed !== undefined) {
      normalized[key] = parsed;
    }
  }
  return normalized;
}

function normalizeExtractedSessions(raw: unknown): Record<string, ExtractedSession> {
  return normalizeRecord(raw, (sessionValue) => {
    if (!isObject(sessionValue)) {
      return undefined;
    }

    const at = readTimestamp(sessionValue.at);
    const entries = readFiniteNumber(sessionValue.entries);
    if (at === undefined || entries === undefined) {
      return undefined;
    }

    const result: ExtractedSession = { at, entries };
    assignDefined(result, "lastMessageAt", readTimestamp(sessionValue.lastMessageAt));
    assignDefined(result, "messageCount", readNonNegativeInt(sessionValue.messageCount));
    assignDefined(result, "sourceSessionKey", readTrimmedString(sessionValue.sourceSessionKey));
    assignDefined(result, "workerSessionId", readTrimmedString(sessionValue.workerSessionId));
    assignDefined(result, "workerSessionKey", readTrimmedString(sessionValue.workerSessionKey));
    return result;
  });
}

function normalizeFailedSessions(raw: unknown): Record<string, FailedSession> {
  return normalizeRecord(raw, (sessionValue) => {
    if (!isObject(sessionValue)) {
      return undefined;
    }

    const at = readTimestamp(sessionValue.at);
    if (at === undefined || typeof sessionValue.error !== "string" || typeof sessionValue.retries !== "number") {
      return undefined;
    }

    const result: FailedSession = { at, error: sessionValue.error, retries: sessionValue.retries };
    assignDefined(result, "lastMessageAt", readTimestamp(sessionValue.lastMessageAt));
    assignDefined(result, "messageCount", readNonNegativeInt(sessionValue.messageCount));
    assignDefined(result, "sourceSessionKey", readTrimmedString(sessionValue.sourceSessionKey));
    assignDefined(result, "workerSessionId", readTrimmedString(sessionValue.workerSessionId));
    assignDefined(result, "workerSessionKey", readTrimmedString(sessionValue.workerSessionKey));
    return result;
  });
}

function normalizeImportedConversations(raw: unknown): Record<string, ImportedConversationState> {
  return normalizeRecord(raw, (conversationValue) => {
    if (!isObject(conversationValue)) {
      return undefined;
    }

    const at = readTimestamp(conversationValue.at);
    const updatedAt = readTimestamp(conversationValue.updatedAt);
    const sessionId = readTrimmedString(conversationValue.sessionId);
    const entries = readFiniteNumber(conversationValue.entries);

    if (
      at === undefined ||
      updatedAt === undefined ||
      sessionId === undefined ||
      entries === undefined
    ) {
      return undefined;
    }

    const result: ImportedConversationState = { at, updatedAt, sessionId, entries };
    assignDefined(result, "title", readTrimmedString(conversationValue.title));
    return result;
  });
}

function normalizeEventUsage(raw: unknown): Record<string, EventUsageState> {
  return normalizeRecord(raw, (usageValue) => {
    if (!isObject(usageValue)) {
      return undefined;
    }

    const memoryGetCount = readNonNegativeInt(usageValue.memoryGetCount);
    const memorySearchCount = readNonNegativeInt(usageValue.memorySearchCount ?? 0);
    const citationCount = readNonNegativeInt(usageValue.citationCount);
    const lastAccessAt = readTimestamp(usageValue.lastAccessAt);

    if (
      memoryGetCount === undefined ||
      memorySearchCount === undefined ||
      citationCount === undefined ||
      lastAccessAt === undefined
    ) {
      return undefined;
    }

    return { memoryGetCount, memorySearchCount, citationCount, lastAccessAt };
  });
}


function normalizeCompactionSessions(raw: unknown): Record<string, CompactionSessionState> {
  return normalizeRecord(raw, (sessionValue) => {
    if (!isObject(sessionValue)) {
      return undefined;
    }

    const at = readTimestamp(sessionValue.at);
    const messageCount = readNonNegativeInt(sessionValue.messageCount);
    const compactedCount = readNonNegativeInt(sessionValue.compactedCount);
    const status =
      typeof sessionValue.status === "string" && COMPACTION_STATUS_SET.has(sessionValue.status as CompactionExtractionStatus)
        ? (sessionValue.status as CompactionExtractionStatus)
        : undefined;

    if (at === undefined || messageCount === undefined || compactedCount === undefined || status === undefined) {
      return undefined;
    }

    const result: CompactionSessionState = { at, messageCount, compactedCount, status };
    assignDefined(result, "tokenCount", readFiniteNumber(sessionValue.tokenCount));
    assignDefined(result, "sessionFile", readTrimmedString(sessionValue.sessionFile));
    assignDefined(result, "reason", readTrimmedString(sessionValue.reason));
    assignDefined(result, "error", readTrimmedString(sessionValue.error));
    assignDefined(result, "extractedAt", readTimestamp(sessionValue.extractedAt));
    assignDefined(result, "entries", readNonNegativeInt(sessionValue.entries));
    return result;
  });
}

function normalizeSnapshotRuns(raw: unknown): SnapshotRunState[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const runs: SnapshotRunState[] = [];

  for (const runValue of raw) {
    if (!isObject(runValue)) {
      continue;
    }

    const at = readTimestamp(runValue.at);
    const status =
      typeof runValue.status === "string" && SNAPSHOT_STATUS_SET.has(runValue.status as SnapshotRunStatus)
        ? (runValue.status as SnapshotRunStatus)
        : undefined;
    const memoryMdPath = readTrimmedString(runValue.memoryMdPath);
    if (at === undefined || status === undefined || memoryMdPath === undefined) {
      continue;
    }

    const run: SnapshotRunState = { at, status, memoryMdPath };
    assignDefined(run, "error", readTrimmedString(runValue.error));
    assignDefined(run, "workerSessionId", readTrimmedString(runValue.workerSessionId));
    assignDefined(run, "workerSessionKey", readTrimmedString(runValue.workerSessionKey));
    runs.push(run);
  }

  return runs.sort((left, right) => right.at.localeCompare(left.at));
}

function normalizeImportJobs(raw: unknown): Record<string, ImportJobState> {
  const importJobs: Record<string, ImportJobState> = {};
  const importJobsRaw = isObject(raw) ? raw : {};

  for (const [jobId, jobValue] of Object.entries(importJobsRaw)) {
    if (!isObject(jobValue)) continue;

    const status =
      typeof jobValue.status === "string" && IMPORT_JOB_STATUS_SET.has(jobValue.status as ImportJobStatus)
        ? (jobValue.status as ImportJobStatus)
        : null;
    const platform = isValidPlatform(jobValue.platform) ? jobValue.platform : null;
    const filePath = readTrimmedString(jobValue.filePath);
    const createdAt = readTimestamp(jobValue.createdAt);
    const updatedAt = readTimestamp(jobValue.updatedAt);
    const queuedAt = readTimestamp(jobValue.queuedAt);
    const attempts = readNonNegativeInt(jobValue.attempts);

    if (!status || !platform || !filePath || !createdAt || !updatedAt || !queuedAt || attempts === undefined) {
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
      attempts,
    };

    assignDefined(normalized, "workspaceDir", readTrimmedString(jobValue.workspaceDir));
    assignDefined(normalized, "startedAt", readTimestamp(jobValue.startedAt));
    assignDefined(normalized, "finishedAt", readTimestamp(jobValue.finishedAt));
    assignDefined(normalized, "stopRequestedAt", readTimestamp(jobValue.stopRequestedAt));
    assignDefined(normalized, "error", readTrimmedString(jobValue.error));
    assignDefined(normalized, "summary", normalizeImportJobSummary(jobValue.summary));
    assignDefined(normalized, "progress", normalizeImportJobProgress(jobValue.progress));
    assignDefined(normalized, "cronJobId", readTrimmedString(jobValue.cronJobId));
    assignDefined(normalized, "cronJobName", readTrimmedString(jobValue.cronJobName));

    importJobs[jobId] = normalized;
  }

  return importJobs;
}

export function normalizeState(
  raw: unknown,
  createEmptyState: () => ReclawState,
): ReclawState {
  if (!isObject(raw)) {
    return createEmptyState();
  }

  return {
    extractedSessions: normalizeExtractedSessions(raw.extractedSessions),
    failedSessions: normalizeFailedSessions(raw.failedSessions),
    importedConversations: normalizeImportedConversations(raw.importedConversations),
    eventUsage: normalizeEventUsage(raw.eventUsage),
    importJobs: normalizeImportJobs(raw.importJobs),
    compactionSessions: normalizeCompactionSessions(raw.compactionSessions),
    snapshotRuns: normalizeSnapshotRuns(raw.snapshotRuns),
  };
}
