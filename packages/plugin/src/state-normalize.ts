import { isObject } from "./lib/guards";
import type {
  EventUsageState,
  ExtractedSession,
  FailedSession,
  ImportJobOptionsState,
  ImportJobProgressState,
  ImportJobState,
  ImportJobStatus,
  ImportJobSummaryState,
  ImportedConversationState,
  ZettelclawState,
} from "./state";

const IMPORTED_PLATFORM_SET = new Set(["chatgpt", "claude", "grok", "openclaw"]);
const IMPORT_JOB_STATUS_SET: ReadonlySet<ImportJobStatus> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
]);

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

function normalizeImportJobOptions(raw: unknown): ImportJobOptionsState {
  if (!isObject(raw)) {
    return {};
  }

  const options: ImportJobOptionsState = {};

  const after = readTimestamp(raw.after);
  if (after !== undefined) options.after = after;

  const before = readTimestamp(raw.before);
  if (before !== undefined) options.before = before;

  const minMessages = readPositiveInt(raw.minMessages);
  if (minMessages !== undefined) options.minMessages = minMessages;

  const jobs = readPositiveInt(raw.jobs);
  if (jobs !== undefined) options.jobs = jobs;

  const model = readTrimmedString(raw.model);
  if (model !== undefined) options.model = model;

  const force = readBoolean(raw.force);
  if (force !== undefined) options.force = force;

  const transcripts = readBoolean(raw.transcripts);
  if (transcripts !== undefined) options.transcripts = transcripts;

  const verbose = readBoolean(raw.verbose);
  if (verbose !== undefined) options.verbose = verbose;

  const keepSource = readBoolean(raw.keepSource);
  if (keepSource !== undefined) options.keepSource = keepSource;

  const backupMemoryDocs = readBoolean(raw.backupMemoryDocs);
  if (backupMemoryDocs !== undefined) options.backupMemoryDocs = backupMemoryDocs;

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

    return { at, entries };
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

    return {
      at,
      error: sessionValue.error,
      retries: sessionValue.retries,
    };
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

    const title = readTrimmedString(conversationValue.title);
    return {
      at,
      updatedAt,
      sessionId,
      entries,
      ...(title !== undefined ? { title } : {}),
    };
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

    const workspaceDir = readTrimmedString(jobValue.workspaceDir);
    if (workspaceDir !== undefined) normalized.workspaceDir = workspaceDir;

    const startedAt = readTimestamp(jobValue.startedAt);
    if (startedAt !== undefined) normalized.startedAt = startedAt;

    const finishedAt = readTimestamp(jobValue.finishedAt);
    if (finishedAt !== undefined) normalized.finishedAt = finishedAt;

    const stopRequestedAt = readTimestamp(jobValue.stopRequestedAt);
    if (stopRequestedAt !== undefined) normalized.stopRequestedAt = stopRequestedAt;

    const error = readTrimmedString(jobValue.error);
    if (error !== undefined) normalized.error = error;

    const summary = normalizeImportJobSummary(jobValue.summary);
    if (summary) normalized.summary = summary;

    const progress = normalizeImportJobProgress(jobValue.progress);
    if (progress) normalized.progress = progress;

    const cronJobId = readTrimmedString(jobValue.cronJobId);
    if (cronJobId !== undefined) normalized.cronJobId = cronJobId;

    const cronJobName = readTrimmedString(jobValue.cronJobName);
    if (cronJobName !== undefined) normalized.cronJobName = cronJobName;

    importJobs[jobId] = normalized;
  }

  return importJobs;
}

export function normalizeState(
  raw: unknown,
  createEmptyState: () => ZettelclawState,
): ZettelclawState {
  if (!isObject(raw)) {
    return createEmptyState();
  }

  return {
    extractedSessions: normalizeExtractedSessions(raw.extractedSessions),
    failedSessions: normalizeFailedSessions(raw.failedSessions),
    importedConversations: normalizeImportedConversations(raw.importedConversations),
    eventUsage: normalizeEventUsage(raw.eventUsage),
    importJobs: normalizeImportJobs(raw.importJobs),
  };
}
