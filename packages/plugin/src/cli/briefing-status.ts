import type { LogEntry } from "../log/schema";
import type {
  CompactionSessionState,
  ExtractedSession,
  FailedSession,
  ReclawState,
  SnapshotRunState,
} from "../state";

export interface ExtractionStatusRow {
  sessionId: string;
  at: string;
  atMs: number;
  extractionStatus: "success" | "failed" | "none";
  extracted?: ExtractedSession;
  failed?: FailedSession;
  compaction?: CompactionSessionState;
  sourceSessionKey?: string;
  workerSessionKey?: string;
  workerSessionId?: string;
  lastMessageAt?: string;
}

export function formatStatusTimestamp(iso: string): string {
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

export function truncateStatusText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, Math.max(1, max - 1))}...`;
}

function parseTimestampOrZero(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatSnapshotRunLine(run: SnapshotRunState, prefix = ""): string {
  const detail = run.error ? ` | error=${run.error}` : "";
  const workerSessionKey = run.workerSessionKey ? ` | workerSessionKey=${run.workerSessionKey}` : "";
  const workerSessionId = run.workerSessionId ? ` | workerSessionId=${run.workerSessionId}` : "";
  return `${prefix}[${formatStatusTimestamp(run.at)}] status=${run.status} memory=${run.memoryMdPath}${detail}${workerSessionKey}${workerSessionId}`;
}

export function formatLatestSnapshotRunLine(run?: SnapshotRunState): string {
  if (!run) {
    return "Latest snapshot run: none";
  }

  const latestDetail = run.error ? ` error=${run.error}` : "";
  const workerSessionKey = run.workerSessionKey ? ` workerSessionKey=${run.workerSessionKey}` : "";
  const workerSessionId = run.workerSessionId ? ` workerSessionId=${run.workerSessionId}` : "";
  return `Latest snapshot run: ${formatStatusTimestamp(run.at)} (${run.status})${latestDetail}${workerSessionKey}${workerSessionId}`;
}

export function buildExtractionStatusRows(state: ReclawState): ExtractionStatusRow[] {
  const extractionSessionIds = [...new Set([
    ...Object.keys(state.extractedSessions),
    ...Object.keys(state.failedSessions),
    ...Object.keys(state.compactionSessions),
  ])];

  return extractionSessionIds
    .map((sessionId) => {
      const extracted = state.extractedSessions[sessionId];
      const failed = state.failedSessions[sessionId];
      const compaction = state.compactionSessions[sessionId];

      const extractedAtMs = extracted ? parseTimestampOrZero(extracted.at) : Number.NEGATIVE_INFINITY;
      const failedAtMs = failed ? parseTimestampOrZero(failed.at) : Number.NEGATIVE_INFINITY;
      const compactionAtMs = compaction ? parseTimestampOrZero(compaction.at) : Number.NEGATIVE_INFINITY;
      const latestAtMs = Math.max(extractedAtMs, failedAtMs, compactionAtMs);

      const latestAt = latestAtMs === extractedAtMs && extracted
        ? extracted.at
        : latestAtMs === failedAtMs && failed
          ? failed.at
          : compaction?.at ?? extracted?.at ?? failed?.at ?? new Date(0).toISOString();

      const latestWasFailure = failedAtMs > extractedAtMs;
      const extractionStatus = extracted || failed
        ? latestWasFailure ? "failed" : "success"
        : "none";

      const latestSourceSessionKey = latestWasFailure ? failed?.sourceSessionKey : extracted?.sourceSessionKey;
      const sourceSessionKey = latestSourceSessionKey ?? extracted?.sourceSessionKey ?? failed?.sourceSessionKey;
      const latestWorkerSessionKey = latestWasFailure ? failed?.workerSessionKey : extracted?.workerSessionKey;
      const workerSessionKey = latestWorkerSessionKey ?? extracted?.workerSessionKey ?? failed?.workerSessionKey;
      const latestWorkerSessionId = latestWasFailure ? failed?.workerSessionId : extracted?.workerSessionId;
      const workerSessionId = latestWorkerSessionId ?? extracted?.workerSessionId ?? failed?.workerSessionId;
      const lastMessageAt = latestWasFailure ? failed?.lastMessageAt : extracted?.lastMessageAt;

      return {
        sessionId,
        at: latestAt,
        atMs: latestAtMs,
        extractionStatus,
        extracted,
        failed,
        compaction,
        sourceSessionKey,
        workerSessionKey,
        workerSessionId,
        lastMessageAt,
      };
    })
    .sort((left, right) => right.atMs - left.atMs);
}

function resolveSourceSessionKey(
  state: ReclawState,
  sessionId: string,
  sessionKeyLookup: Map<string, string | undefined>,
): string | undefined {
  return (
    state.extractedSessions[sessionId]?.sourceSessionKey ??
    state.failedSessions[sessionId]?.sourceSessionKey ??
    sessionKeyLookup.get(sessionId)
  );
}

export function formatExtractionStatusRow(
  row: ExtractionStatusRow,
  sessionKeyLookup: Map<string, string | undefined>,
): string {
  const lastMessage = row.lastMessageAt ? ` | lastMessage=${formatStatusTimestamp(row.lastMessageAt)}` : "";
  const sourceSessionKey = row.sourceSessionKey ?? sessionKeyLookup.get(row.sessionId);
  const sourceSessionKeyText = ` | sourceSessionKey=${sourceSessionKey ?? "n/a"}`;
  const workerSessionKeyText = ` | workerSessionKey=${row.workerSessionKey ?? "n/a"}`;
  const workerSessionIdText = row.workerSessionId ? ` | workerSessionId=${row.workerSessionId}` : "";
  const compactionStatus = row.compaction?.status ?? "n/a";
  const compactionDetail = row.compaction?.reason ?? row.compaction?.error;
  const compactionDetailText = compactionDetail
    ? ` | compactionDetail=${truncateStatusText(compactionDetail, 120)}`
    : "";
  const resultText = row.extractionStatus === "success"
    ? `result=success entries=${row.extracted?.entries ?? 0}`
    : row.extractionStatus === "failed"
      ? `result=failed retries=${row.failed?.retries ?? 0}`
      : "result=none";
  const failureErrorText = row.extractionStatus === "failed" && row.failed?.error
    ? ` | error=${truncateStatusText(row.failed.error, 120)}`
    : "";

  return `- [${formatStatusTimestamp(row.at)}] session=${row.sessionId} ${resultText} compaction=${compactionStatus}${sourceSessionKeyText}${workerSessionKeyText}${workerSessionIdText}${failureErrorText}${compactionDetailText}${lastMessage}`;
}

export function formatSessionSummaryListLine(entry: LogEntry, state: ReclawState): string {
  const compactStatus = state.compactionSessions[entry.session]?.status ?? "n/a";
  return `[${formatStatusTimestamp(entry.timestamp)}] session=${entry.session} compact=${compactStatus} ${truncateStatusText(entry.content)}`;
}

export function formatUnifiedSessionSummaryRow(
  summary: LogEntry,
  state: ReclawState,
  sessionKeyLookup: Map<string, string | undefined>,
): string {
  const compactionStatus = state.compactionSessions[summary.session]?.status ?? "n/a";
  const sourceSessionKeyText = ` | sourceSessionKey=${resolveSourceSessionKey(state, summary.session, sessionKeyLookup) ?? "n/a"}`;
  return `- [${formatStatusTimestamp(summary.timestamp)}] session=${summary.session} compact=${compactionStatus} ${truncateStatusText(summary.content, 90)}${sourceSessionKeyText}`;
}
