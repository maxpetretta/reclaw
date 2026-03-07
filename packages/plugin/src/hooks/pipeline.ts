import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { normalizeError } from "../lib/guards";
import {
  DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  findMentionedSubjects,
} from "../extraction/shared";
import { queryExtractionContext } from "../log/query";
import { appendEntry, finalizeEntry, type LogEntry } from "../log/schema";
import {
  compareTranscriptWatermarks,
  getExtractedSessionWatermark,
  getFailedSessionWatermark,
  markExtracted,
  markFailed,
  pruneState,
  readState,
  shouldRetry,
} from "../state";
import { readRegistry, upsertSubjectFromExtraction } from "../subjects/registry";
import { formatTranscript, type TranscriptMessage } from "../lib/transcript";
import { extractFromTranscript, type ExtractionModelResult } from "../lib/llm";
import { validateLiveExtractionOutput } from "./pipeline-output";
import {
  recordTranscriptCitationUsage,
  refreshTouchedSubjectProjections,
  writeLatestHandoff,
} from "./pipeline-side-effects";

export interface ExtractionPaths {
  logPath: string;
  subjectsPath: string;
  statePath: string;
  projectionDir: string;
}

export interface ExtractionPipelineDeps {
  extractFromTranscript: (opts: {
    transcript: string;
    subjects: Awaited<ReturnType<typeof readRegistry>>;
    existingEntries?: LogEntry[];
    model: string;
    apiBaseUrl?: string;
    apiToken?: string;
  }) => Promise<string | ExtractionModelResult>;
  repairExtractionOutput: (opts: {
    transcript: string;
    subjects: Awaited<ReturnType<typeof readRegistry>>;
    existingEntries?: LogEntry[];
    invalidOutput: string;
    issue: string;
    model: string;
    apiBaseUrl?: string;
    apiToken?: string;
  }) => Promise<string | ExtractionModelResult>;
  readMemoryFile: (path: string) => Promise<string>;
  writeMemoryFile: (path: string, content: string) => Promise<void>;
}

interface ExtractionPipelineParams {
  sessionId: string;
  messages: TranscriptMessage[];
  paths: ExtractionPaths;
  memoryMdPath: string;
  config: PluginConfig;
  deps: ExtractionPipelineDeps;
  logger: OpenClawPluginApi["logger"];
  apiBaseUrl: string;
  apiToken?: string;
  sourceSessionKey?: string;
  transcriptMessageCount?: number;
}

export type ExtractionPipelineResult =
  | { status: "skipped"; reason: "up_to_date" | "retry_cap" }
  | { status: "extracted"; entries: number }
  | { status: "failed"; error: string };

function findLatestMessageTimestamp(messages: TranscriptMessage[]): string | undefined {
  let latestTimestampMs = Number.NEGATIVE_INFINITY;

  for (const message of messages) {
    const timestampMs = Date.parse(message.timestamp);
    if (Number.isFinite(timestampMs) && timestampMs > latestTimestampMs) {
      latestTimestampMs = timestampMs;
    }
  }

  return Number.isFinite(latestTimestampMs) ? new Date(latestTimestampMs).toISOString() : undefined;
}

export async function runExtractionPipeline(params: ExtractionPipelineParams): Promise<ExtractionPipelineResult> {
  const state = await readState(params.paths.statePath);
  const lastMessageAt = findLatestMessageTimestamp(params.messages);
  const transcriptMessageCount =
    typeof params.transcriptMessageCount === "number" && Number.isFinite(params.transcriptMessageCount)
      ? Math.max(0, Math.floor(params.transcriptMessageCount))
      : params.messages.length;
  const currentWatermark = {
    ...(lastMessageAt ? { lastMessageAt } : {}),
    messageCount: transcriptMessageCount,
  };
  const extractedWatermark = getExtractedSessionWatermark(state, params.sessionId);
  const failedWatermark = getFailedSessionWatermark(state, params.sessionId);

  if (
    state.failedSessions[params.sessionId] &&
    compareTranscriptWatermarks(currentWatermark, failedWatermark) <= 0 &&
    !shouldRetry(state, params.sessionId)
  ) {
    return { status: "skipped", reason: "retry_cap" };
  }

  if (compareTranscriptWatermarks(currentWatermark, extractedWatermark) <= 0) {
    return { status: "skipped", reason: "up_to_date" };
  }

  const transcript = formatTranscript(params.messages);
  if (!transcript.trim()) {
    await markExtracted(params.paths.statePath, params.sessionId, 0, {
      ...(lastMessageAt ? { lastMessageAt } : {}),
      messageCount: transcriptMessageCount,
    });
    await pruneState(params.paths.statePath);
    return { status: "extracted", entries: 0 };
  }

  let workerSessionId: string | undefined;
  let workerSessionKey: string | undefined;

  try {
    await recordTranscriptCitationUsage({
      statePath: params.paths.statePath,
      logPath: params.paths.logPath,
      transcript,
    });

    const subjects = await readRegistry(params.paths.subjectsPath);
    const transcriptSubjects = findMentionedSubjects(transcript, subjects);
    const existingEntries = await queryExtractionContext(params.paths.logPath, transcriptSubjects, {
      maxPerSubject: DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
    });
    const extractionModelResult = await params.deps.extractFromTranscript({
      transcript,
      subjects,
      existingEntries,
      model: params.config.extraction.model,
      apiBaseUrl: params.apiBaseUrl,
      apiToken: params.apiToken,
    });
    const initialOutputRecord =
      typeof extractionModelResult === "string" ? { output: extractionModelResult } : extractionModelResult;
    workerSessionId = initialOutputRecord.workerSessionId;
    workerSessionKey = initialOutputRecord.workerSessionKey;
    const validatedOutput = await validateLiveExtractionOutput({
      sessionId: params.sessionId,
      transcript,
      subjects,
      existingEntries,
      outputRecord: initialOutputRecord,
      repairExtractionOutput: params.deps.repairExtractionOutput,
      model: params.config.extraction.model,
      logger: params.logger,
      apiBaseUrl: params.apiBaseUrl,
      apiToken: params.apiToken,
    });
    const outputRecord = validatedOutput.outputRecord;
    workerSessionId = outputRecord.workerSessionId;
    workerSessionKey = outputRecord.workerSessionKey;

    let appendedCount = 0;
    const appendedEntries: Array<ReturnType<typeof finalizeEntry>> = [];
    const touchedSubjects = new Set<string>();
    const parsedEntries = validatedOutput.parsedEntries;

    for (const parsedEntry of parsedEntries) {
      const entry = finalizeEntry(parsedEntry.entry, { sessionId: params.sessionId });
      if (entry.subject) {
        await upsertSubjectFromExtraction(params.paths.subjectsPath, entry.subject, parsedEntry.subjectTypeHint);
        touchedSubjects.add(entry.subject);
      }

      await appendEntry(params.paths.logPath, entry);
      appendedEntries.push(entry);
      appendedCount += 1;
    }

    if (validatedOutput.invalidLineCount > 0) {
      params.logger.warn(
        `reclaw extraction for ${params.sessionId}: ignored ${validatedOutput.invalidLineCount} invalid entry line(s)`,
      );
    }

    const finalHandoff = appendedEntries[appendedEntries.length - 1];
    await writeLatestHandoff({
      sessionId: params.sessionId,
      finalHandoff,
      memoryMdPath: params.memoryMdPath,
      sourceSessionKey: params.sourceSessionKey,
      readMemoryFile: params.deps.readMemoryFile,
      writeMemoryFile: params.deps.writeMemoryFile,
      logger: params.logger,
    });
    await refreshTouchedSubjectProjections({
      sessionId: params.sessionId,
      projectionDir: params.paths.projectionDir,
      logPath: params.paths.logPath,
      subjectsPath: params.paths.subjectsPath,
      touchedSubjects,
      logger: params.logger,
    });

    await markExtracted(params.paths.statePath, params.sessionId, appendedCount, {
      ...(lastMessageAt ? { lastMessageAt } : {}),
      messageCount: transcriptMessageCount,
      ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
      ...(workerSessionId ? { workerSessionId } : {}),
      ...(workerSessionKey ? { workerSessionKey } : {}),
    });
    await pruneState(params.paths.statePath);
    return { status: "extracted", entries: appendedCount };
  } catch (error) {
    const message = normalizeError(error);
    params.logger.warn(`reclaw extraction failed for ${params.sessionId}: ${message}`);
    await markFailed(params.paths.statePath, params.sessionId, message, {
      ...(lastMessageAt ? { lastMessageAt } : {}),
      messageCount: transcriptMessageCount,
      ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
      ...(workerSessionId ? { workerSessionId } : {}),
      ...(workerSessionKey ? { workerSessionKey } : {}),
    });
    await pruneState(params.paths.statePath);
    return { status: "failed", error: message };
  }
}
