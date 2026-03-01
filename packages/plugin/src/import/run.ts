import { readFile } from "node:fs/promises";
import { appendEntry, type LogEntry } from "../log/schema";
import {
  readState,
  type ImportedConversationState,
  type ZettelclawState,
  writeState,
} from "../state";
import { upsertSubjectFromExtraction } from "../subjects/registry";
import { parseChatGptConversations } from "./adapters/chatgpt";
import { parseClaudeConversations } from "./adapters/claude";
import { parseGrokConversations } from "./adapters/grok";
import { loadOpenClawImportSource, parseOpenClawConversations } from "./adapters/openclaw";
import { extractImportedConversation, type ExtractedImportedEntry } from "./extract";
import { writeImportedSession } from "./sessions";
import type { ImportPlatform, ImportedConversation } from "./types";

export const DEFAULT_IMPORT_MIN_MESSAGES = 4;
export const DEFAULT_IMPORT_JOBS = 3;
export const DEFAULT_IMPORT_MODEL = "anthropic/claude-haiku-4-5";

export interface ReclawImportOptions {
  platform: ImportPlatform;
  filePath: string;
  logPath: string;
  subjectsPath: string;
  statePath: string;
  dryRun?: boolean;
  after?: string;
  before?: string;
  minMessages?: number;
  jobs?: number;
  model?: string;
  force?: boolean;
  transcripts?: boolean;
  verbose?: boolean;
  apiBaseUrl?: string;
  apiToken?: string;
  openClawHome?: string;
  agentId?: string;
}

export interface ReclawImportSummary {
  platform: ImportPlatform;
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

interface CandidateConversation {
  key: string;
  conversation: ImportedConversation;
}

interface ImportLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

interface ReclawImportDeps {
  readImportFile: (params: {
    platform: ImportPlatform;
    filePath: string;
    openClawHome?: string;
    agentId?: string;
  }) => Promise<unknown>;
  parseConversations: (platform: ImportPlatform, raw: unknown) => ImportedConversation[];
  extractConversation: (params: {
    conversation: ImportedConversation;
    sessionId: string;
    subjectsPath: string;
    logPath: string;
    model: string;
    apiBaseUrl?: string;
    apiToken?: string;
  }) => Promise<Array<LogEntry | ExtractedImportedEntry>>;
  upsertSubject: (path: string, slug: string, inferredType?: string) => Promise<void>;
  appendEntry: (logPath: string, entry: LogEntry) => Promise<void>;
  readState: (path: string) => Promise<ZettelclawState>;
  writeState: (path: string, state: ZettelclawState) => Promise<void>;
  writeImportedSession: typeof writeImportedSession;
}

const DEFAULT_LOGGER: ImportLogger = {
  info(message) {
    console.log(message);
  },
  warn(message) {
    console.warn(message);
  },
};

const DEFAULT_DEPS: ReclawImportDeps = {
  async readImportFile(params) {
    if (params.platform === "openclaw") {
      return await loadOpenClawImportSource(params.filePath, {
        openClawHome: params.openClawHome,
        preferredAgentId: params.agentId,
      });
    }

    const rawText = await readFile(params.filePath, "utf8");
    try {
      return JSON.parse(rawText) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse import JSON: ${reason}`);
    }
  },
  parseConversations(platform, raw) {
    if (platform === "chatgpt") {
      return parseChatGptConversations(raw);
    }

    if (platform === "claude") {
      return parseClaudeConversations(raw);
    }

    if (platform === "openclaw") {
      return parseOpenClawConversations(raw);
    }

    return parseGrokConversations(raw);
  },
  async extractConversation(params) {
    return await extractImportedConversation({
      conversation: params.conversation,
      sessionId: params.sessionId,
      subjectsPath: params.subjectsPath,
      logPath: params.logPath,
      model: params.model,
      apiBaseUrl: params.apiBaseUrl,
      apiToken: params.apiToken,
      ensureSubjects: false,
    });
  },
  upsertSubject: upsertSubjectFromExtraction,
  appendEntry,
  readState,
  writeState,
  writeImportedSession,
};

function normalizeExtractedImportEntry(
  value: LogEntry | ExtractedImportedEntry,
): ExtractedImportedEntry {
  if (
    value &&
    typeof value === "object" &&
    "entry" in value &&
    value.entry &&
    typeof value.entry === "object"
  ) {
    return value as ExtractedImportedEntry;
  }

  return { entry: value as LogEntry };
}

function parseConversationTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function parseBoundary(raw: string | undefined, optionName: "--after" | "--before"): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${optionName} value: ${raw}`);
  }

  return parsed;
}

function createConversationKey(platform: ImportPlatform, conversationId: string): string {
  return `${platform}:${conversationId}`;
}

function buildSessionId(platform: ImportPlatform, conversationId: string): string {
  return `reclaw:${platform}:${conversationId}`;
}

function resolveHistoricalTimestamp(conversation: ImportedConversation): string {
  const updatedAtMs = Date.parse(conversation.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    throw new Error(`conversation ${conversation.conversationId} has invalid updatedAt`);
  }

  return new Date(updatedAtMs).toISOString();
}

function normalizeImportedEntryTimestamp(rawTimestamp: unknown, fallback: string): string {
  if (typeof rawTimestamp !== "string" || rawTimestamp.trim().length === 0) {
    return fallback;
  }

  const parsed = Date.parse(rawTimestamp);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return new Date(parsed).toISOString();
}

function countExtractableMessages(conversation: ImportedConversation): number {
  return conversation.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  ).length;
}

function choosePreferredConversation(current: ImportedConversation, incoming: ImportedConversation): ImportedConversation {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);

  if (Number.isFinite(incomingUpdatedAt) && Number.isFinite(currentUpdatedAt)) {
    if (incomingUpdatedAt > currentUpdatedAt) {
      return incoming;
    }

    if (incomingUpdatedAt < currentUpdatedAt) {
      return current;
    }
  }

  if (countExtractableMessages(incoming) > countExtractableMessages(current)) {
    return incoming;
  }

  return current;
}

function dedupeInputConversations(
  platform: ImportPlatform,
  conversations: ImportedConversation[],
): { conversations: ImportedConversation[]; duplicates: number } {
  const byKey = new Map<string, ImportedConversation>();
  let duplicates = 0;

  for (const conversation of conversations) {
    const key = createConversationKey(platform, conversation.conversationId);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, conversation);
      continue;
    }

    duplicates += 1;
    byKey.set(key, choosePreferredConversation(existing, conversation));
  }

  return {
    conversations: [...byKey.values()],
    duplicates,
  };
}

function createImportedStateRecord(sessionId: string, conversation: ImportedConversation, entries: number): ImportedConversationState {
  return {
    at: new Date().toISOString(),
    updatedAt: conversation.updatedAt,
    sessionId,
    entries,
    title: conversation.title,
  };
}

async function runWithConcurrency<T>(
  items: T[],
  maxJobs: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.floor(maxJobs));
  const workerCount = Math.min(limit, items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex] as T, currentIndex);
      }
    }),
  );
}

export async function runReclawImport(
  options: ReclawImportOptions,
  deps: Partial<ReclawImportDeps> = {},
  logger: ImportLogger = DEFAULT_LOGGER,
): Promise<ReclawImportSummary> {
  const runtimeDeps: ReclawImportDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const defaultMinMessages = options.platform === "openclaw" ? 1 : DEFAULT_IMPORT_MIN_MESSAGES;
  const minMessages = Math.max(1, Math.floor(options.minMessages ?? defaultMinMessages));
  const jobs = Math.max(1, Math.floor(options.jobs ?? DEFAULT_IMPORT_JOBS));
  const model = options.model?.trim() || DEFAULT_IMPORT_MODEL;
  const transcripts = options.transcripts !== false;
  const dryRun = options.dryRun === true;
  const afterMs = parseBoundary(options.after, "--after");
  const beforeMs = parseBoundary(options.before, "--before");

  const rawImport = await runtimeDeps.readImportFile({
    platform: options.platform,
    filePath: options.filePath,
    openClawHome: options.openClawHome,
    agentId: options.agentId,
  });
  const parsedRaw = runtimeDeps.parseConversations(options.platform, rawImport);
  const deduped = dedupeInputConversations(options.platform, parsedRaw);
  const initialState = await runtimeDeps.readState(options.statePath);

  const summary: ReclawImportSummary = {
    platform: options.platform,
    parsed: parsedRaw.length,
    dedupedInInput: deduped.duplicates,
    selected: 0,
    skippedByDate: 0,
    skippedByMinMessages: 0,
    skippedAlreadyImported: 0,
    imported: 0,
    failed: 0,
    entriesWritten: 0,
    transcriptsWritten: 0,
    dryRun,
  };

  const selected: CandidateConversation[] = [];

  for (const conversation of deduped.conversations) {
    const key = createConversationKey(options.platform, conversation.conversationId);
    const updatedAtMs = Date.parse(conversation.updatedAt);

    if (afterMs !== undefined && Number.isFinite(updatedAtMs) && updatedAtMs < afterMs) {
      summary.skippedByDate += 1;
      if (options.verbose) {
        logger.info(`skip (date<after) ${key}`);
      }
      continue;
    }

    if (beforeMs !== undefined && Number.isFinite(updatedAtMs) && updatedAtMs > beforeMs) {
      summary.skippedByDate += 1;
      if (options.verbose) {
        logger.info(`skip (date>before) ${key}`);
      }
      continue;
    }

    if (countExtractableMessages(conversation) < minMessages) {
      summary.skippedByMinMessages += 1;
      if (options.verbose) {
        logger.info(`skip (min-messages) ${key}`);
      }
      continue;
    }

    if (!options.force && initialState.importedConversations[key]) {
      summary.skippedAlreadyImported += 1;
      if (options.verbose) {
        logger.info(`skip (already-imported) ${key}`);
      }
      continue;
    }

    selected.push({
      key,
      conversation,
    });
  }

  selected.sort((left, right) => {
    const leftTimestamp = parseConversationTimestamp(left.conversation.updatedAt);
    const rightTimestamp = parseConversationTimestamp(right.conversation.updatedAt);
    if (leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp;
    }

    return left.key.localeCompare(right.key);
  });

  summary.selected = selected.length;
  logger.info(
    `Reclaw import ${options.platform}: parsed=${summary.parsed}, selected=${summary.selected}, dryRun=${dryRun}`,
  );

  if (dryRun || selected.length === 0) {
    return summary;
  }

  let commitQueue: Promise<void> = Promise.resolve();
  const withCommitLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const task = commitQueue.then(fn, fn);
    commitQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  };

  let completed = 0;
  await runWithConcurrency(selected, jobs, async (candidate) => {
    const sessionId = buildSessionId(options.platform, candidate.conversation.conversationId);

    try {
      const historicalTimestamp = resolveHistoricalTimestamp(candidate.conversation);
      const extractedEntries = await runtimeDeps.extractConversation({
        conversation: candidate.conversation,
        sessionId,
        subjectsPath: options.subjectsPath,
        logPath: options.logPath,
        model,
        apiBaseUrl: options.apiBaseUrl,
        apiToken: options.apiToken,
      });
      const normalizedExtracted = extractedEntries.map((entry) => normalizeExtractedImportEntry(entry));
      const entries = normalizedExtracted.map((parsedEntry) => {
        const { subject, timestamp, ...rest } = parsedEntry.entry;
        const normalizedSubject = typeof subject === "string" ? subject.trim() : "";

        return {
          subjectTypeHint: parsedEntry.subjectTypeHint,
          ...rest,
          ...(normalizedSubject ? { subject: normalizedSubject } : {}),
          // Preserve import invariants even if extraction dependencies drift.
          session: sessionId,
          timestamp: normalizeImportedEntryTimestamp(timestamp, historicalTimestamp),
        };
      });

      await withCommitLock(async () => {
        for (const entry of entries) {
          if (!entry.subject) {
            continue;
          }

          await runtimeDeps.upsertSubject(
            options.subjectsPath,
            entry.subject,
            entry.subjectTypeHint,
          );
        }

        for (const entry of entries) {
          const { subjectTypeHint, ...logEntry } = entry;
          void subjectTypeHint;
          await runtimeDeps.appendEntry(options.logPath, logEntry);
        }

        if (transcripts) {
          await runtimeDeps.writeImportedSession({
            conversation: candidate.conversation,
            sessionId,
            openClawHome: options.openClawHome,
            agentId: options.agentId,
          });
          summary.transcriptsWritten += 1;
        }

        summary.entriesWritten += entries.length;
        summary.imported += 1;
        const latestState = await runtimeDeps.readState(options.statePath);
        latestState.importedConversations[candidate.key] = createImportedStateRecord(
          sessionId,
          candidate.conversation,
          entries.length,
        );
        await runtimeDeps.writeState(options.statePath, latestState);
      });

      completed += 1;
      logger.info(
        `[${completed}/${summary.selected}] imported ${candidate.key} (${entries.length} entries)`,
      );
    } catch (error) {
      completed += 1;
      summary.failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`[${completed}/${summary.selected}] failed ${candidate.key}: ${reason}`);
    }
  });

  return summary;
}
