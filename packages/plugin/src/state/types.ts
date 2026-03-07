export interface ExtractedSession {
  at: string;
  entries: number;
  /** Latest transcript message timestamp included in the last successful extraction. */
  lastMessageAt?: string;
  /** Number of transcript messages represented by the last successful extraction. */
  messageCount?: number;
  /** OpenClaw source session key the extraction was run for (if resolvable). */
  sourceSessionKey?: string;
  /** Isolated worker session id that produced extraction output. */
  workerSessionId?: string;
  /** Isolated worker session key that produced extraction output. */
  workerSessionKey?: string;
}

export interface FailedSession {
  at: string;
  error: string;
  retries: number;
  /** Latest transcript message timestamp included in the failed extraction attempt. */
  lastMessageAt?: string;
  /** Number of transcript messages represented by the failed extraction attempt. */
  messageCount?: number;
  /** OpenClaw source session key the failed extraction was run for (if resolvable). */
  sourceSessionKey?: string;
  /** Isolated worker session id from the failed extraction attempt (if available). */
  workerSessionId?: string;
  /** Isolated worker session key from the failed extraction attempt (if available). */
  workerSessionKey?: string;
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
  memorySearchCount: number;
  citationCount: number;
  lastAccessAt: string;
}

export interface TranscriptWatermark {
  lastMessageAt?: string;
  messageCount?: number;
}

export type EventUsageKind = "memory_get" | "memory_search" | "citation";

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
  subjectsCreated: number;
  transcriptsWritten: number;
  dryRun: boolean;
}

export interface ImportJobProgressState {
  total: number;
  completed: number;
  imported: number;
  failed: number;
  entriesWritten: number;
  subjectsCreated: number;
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
  stopRequestedAt?: string;
  error?: string;
  summary?: ImportJobSummaryState;
  progress?: ImportJobProgressState;
  cronJobId?: string;
  cronJobName?: string;
}

export type CompactionExtractionStatus = "observed" | "extracted" | "failed" | "skipped";

export interface CompactionSessionState {
  at: string;
  messageCount: number;
  compactedCount: number;
  tokenCount?: number;
  sessionFile?: string;
  status: CompactionExtractionStatus;
  reason?: string;
  error?: string;
  extractedAt?: string;
  entries?: number;
}

export type SnapshotRunStatus = "success" | "failed";

export interface SnapshotRunState {
  at: string;
  status: SnapshotRunStatus;
  memoryMdPath: string;
  error?: string;
  /** Isolated worker session id that produced snapshot output. */
  workerSessionId?: string;
  /** Isolated worker session key that produced snapshot output. */
  workerSessionKey?: string;
}

export interface ReclawState {
  extractedSessions: Record<string, ExtractedSession>;
  failedSessions: Record<string, FailedSession>;
  importedConversations: Record<string, ImportedConversationState>;
  eventUsage: Record<string, EventUsageState>;
  importJobs: Record<string, ImportJobState>;
  compactionSessions: Record<string, CompactionSessionState>;
  snapshotRuns: SnapshotRunState[];
}

export function createEmptyState(): ReclawState {
  return {
    extractedSessions: {},
    failedSessions: {},
    importedConversations: {},
    eventUsage: {},
    importJobs: {},
    compactionSessions: {},
    snapshotRuns: [],
  };
}
