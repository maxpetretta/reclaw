import { updateState } from "./store";
import type { ReclawState, TranscriptWatermark } from "./types";
import { assignDefined } from "../lib/optional-fields";

export interface SessionTrackingUpdateOptions {
  lastMessageAt?: string;
  messageCount?: number;
  sourceSessionKey?: string;
  workerSessionId?: string;
  workerSessionKey?: string;
}

function readNonEmptyTrimmedString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNonNegativeInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

export function buildSessionTrackingUpdate(
  opts: SessionTrackingUpdateOptions = {},
): SessionTrackingUpdateOptions {
  const normalized: SessionTrackingUpdateOptions = {};
  assignDefined(normalized, "lastMessageAt", readNonEmptyTrimmedString(opts.lastMessageAt));
  assignDefined(normalized, "messageCount", readNonNegativeInt(opts.messageCount));
  assignDefined(normalized, "sourceSessionKey", readNonEmptyTrimmedString(opts.sourceSessionKey));
  assignDefined(normalized, "workerSessionId", readNonEmptyTrimmedString(opts.workerSessionId));
  assignDefined(normalized, "workerSessionKey", readNonEmptyTrimmedString(opts.workerSessionKey));
  return normalized;
}

export function createTranscriptWatermark(input: TranscriptWatermark = {}): TranscriptWatermark {
  const watermark: TranscriptWatermark = {};
  assignDefined(watermark, "lastMessageAt", readNonEmptyTrimmedString(input.lastMessageAt));
  assignDefined(watermark, "messageCount", readNonNegativeInt(input.messageCount));
  return watermark;
}

export async function markExtracted(
  path: string,
  sessionId: string,
  entryCount: number,
  opts: SessionTrackingUpdateOptions = {},
): Promise<void> {
  await updateState(path, (state) => {
    state.extractedSessions[sessionId] = {
      at: new Date().toISOString(),
      entries: entryCount,
      ...buildSessionTrackingUpdate(opts),
    };
    delete state.failedSessions[sessionId];
  });
}

export async function markFailed(
  path: string,
  sessionId: string,
  error: string,
  opts: SessionTrackingUpdateOptions = {},
): Promise<void> {
  await updateState(path, (state) => {
    const previous = state.failedSessions[sessionId];
    state.failedSessions[sessionId] = {
      at: new Date().toISOString(),
      error,
      retries: (previous?.retries ?? 0) + 1,
      ...buildSessionTrackingUpdate(opts),
    };
  });
}

export function isExtracted(state: ReclawState, sessionId: string): boolean {
  return Boolean(state.extractedSessions[sessionId]);
}

function readRecordWatermark(
  record: { at: string; lastMessageAt?: string; messageCount?: number } | undefined,
): TranscriptWatermark | undefined {
  if (!record) {
    return undefined;
  }

  return createTranscriptWatermark({
    lastMessageAt: record.lastMessageAt ?? record.at,
    messageCount: record.messageCount,
  });
}

function parseWatermarkTimestamp(value: string | undefined): number | undefined {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function compareTranscriptWatermarks(
  left: TranscriptWatermark | undefined,
  right: TranscriptWatermark | undefined,
): number {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return -1;
  }

  if (!right) {
    return 1;
  }

  const leftTimestampMs = parseWatermarkTimestamp(left.lastMessageAt);
  const rightTimestampMs = parseWatermarkTimestamp(right.lastMessageAt);

  if (leftTimestampMs !== undefined && rightTimestampMs !== undefined && leftTimestampMs !== rightTimestampMs) {
    return leftTimestampMs - rightTimestampMs;
  }

  if (leftTimestampMs !== undefined && rightTimestampMs === undefined) {
    return 1;
  }

  if (leftTimestampMs === undefined && rightTimestampMs !== undefined) {
    return -1;
  }

  const leftCount =
    typeof left.messageCount === "number" && Number.isFinite(left.messageCount)
      ? Math.max(0, Math.floor(left.messageCount))
      : -1;
  const rightCount =
    typeof right.messageCount === "number" && Number.isFinite(right.messageCount)
      ? Math.max(0, Math.floor(right.messageCount))
      : -1;

  if (leftCount !== rightCount) {
    return leftCount - rightCount;
  }

  return 0;
}

export function hasTranscriptAdvanced(
  current: TranscriptWatermark | undefined,
  previous: TranscriptWatermark | undefined,
): boolean {
  return compareTranscriptWatermarks(current, previous) > 0;
}

export function getExtractedSessionWatermark(
  state: ReclawState,
  sessionId: string,
): TranscriptWatermark | undefined {
  return readRecordWatermark(state.extractedSessions[sessionId]);
}

export function getFailedSessionWatermark(
  state: ReclawState,
  sessionId: string,
): TranscriptWatermark | undefined {
  return readRecordWatermark(state.failedSessions[sessionId]);
}

export function isImportedConversation(state: ReclawState, conversationKey: string): boolean {
  return Boolean(state.importedConversations[conversationKey]);
}

export function shouldRetry(state: ReclawState, sessionId: string): boolean {
  return (state.failedSessions[sessionId]?.retries ?? 0) < 2;
}
