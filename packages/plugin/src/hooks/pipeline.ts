import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { dirname } from "node:path";
import type { PluginConfig } from "../config";
import { normalizeError } from "../lib/guards";
import {
  DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  findMentionedSubjects,
  parseExtractionJsonl,
  type ParsedExtractionEntry,
} from "../extraction/shared";
import { queryByIds, queryExtractionContext } from "../log/query";
import { appendEntry, finalizeEntry, type LogEntry } from "../log/schema";
import { applyLastHandoffBlock } from "../memory/handoff";
import { refreshSubjectProjections } from "../projections/subjects";
import {
  compareTranscriptWatermarks,
  getExtractedSessionWatermark,
  getFailedSessionWatermark,
  incrementEventUsage,
  markExtracted,
  markFailed,
  pruneState,
  readState,
  shouldRetry,
} from "../state";
import { readRegistry, upsertSubjectFromExtraction } from "../subjects/registry";
import { formatTranscript, type TranscriptMessage } from "../lib/transcript";
import { extractFromTranscript, type ExtractionModelResult } from "../lib/llm";

export interface ExtractionPaths {
  logPath: string;
  subjectsPath: string;
  statePath: string;
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

const EVENT_ID_LENGTH = 12;
const TRANSCRIPT_EVENT_ID_PATTERN = /\[([A-Za-z0-9_-]{12})\]/gu;

function extractReferencedEventIds(transcript: string): string[] {
  if (!transcript.trim()) {
    return [];
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const tryPush = (candidate: string): void => {
    if (candidate.length !== EVENT_ID_LENGTH || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    ids.push(candidate);
  };

  const bracketMatches = transcript.matchAll(TRANSCRIPT_EVENT_ID_PATTERN);
  for (const match of bracketMatches) {
    if (match[1]) {
      tryPush(match[1]);
    }
  }

  return ids;
}

async function recordTranscriptCitationUsage(statePath: string, logPath: string, transcript: string): Promise<void> {
  const transcriptEventIds = extractReferencedEventIds(transcript);
  if (transcriptEventIds.length === 0) {
    return;
  }

  const existingCitedEntries = await queryByIds(logPath, transcriptEventIds);
  if (existingCitedEntries.length === 0) {
    return;
  }

  const citedIds = [...new Set(existingCitedEntries.map((entry) => entry.id))];
  await incrementEventUsage(statePath, citedIds, "citation");
}

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

function toOutputRecord(output: string | ExtractionModelResult): ExtractionModelResult {
  return typeof output === "string" ? { output } : output;
}

function describeLiveOutputIssue(parsedEntries: ParsedExtractionEntry[]): string | undefined {
  const handoffCount = parsedEntries.filter((entry) => entry.entry.type === "handoff").length;
  if (handoffCount !== 1) {
    return `live extraction output must contain exactly one handoff event; found ${handoffCount}`;
  }

  const lastEntry = parsedEntries[parsedEntries.length - 1];
  if (!lastEntry || lastEntry.entry.type !== "handoff") {
    return "live extraction output must end with the handoff event";
  }

  return undefined;
}

async function validateLiveExtractionOutput(params: {
  sessionId: string;
  transcript: string;
  subjects: Awaited<ReturnType<typeof readRegistry>>;
  existingEntries: LogEntry[];
  outputRecord: ExtractionModelResult;
  deps: ExtractionPipelineDeps;
  model: string;
  logger: OpenClawPluginApi["logger"];
  apiBaseUrl: string;
  apiToken?: string;
}): Promise<{ parsedEntries: ParsedExtractionEntry[]; invalidLineCount: number; outputRecord: ExtractionModelResult }> {
  let outputRecord = params.outputRecord;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = parseExtractionJsonl(outputRecord.output);
    const issue = describeLiveOutputIssue(parsed.entries);
    if (!issue) {
      return {
        parsedEntries: parsed.entries,
        invalidLineCount: parsed.invalidLineCount,
        outputRecord,
      };
    }

    if (attempt > 0) {
      throw new Error(`extraction repair failed: ${issue}`);
    }

    params.logger.warn(`reclaw extraction for ${params.sessionId}: repairing output (${issue})`);
    outputRecord = toOutputRecord(await params.deps.repairExtractionOutput({
      transcript: params.transcript,
      subjects: params.subjects,
      existingEntries: params.existingEntries,
      invalidOutput: outputRecord.output,
      issue,
      model: params.model,
      apiBaseUrl: params.apiBaseUrl,
      apiToken: params.apiToken,
    }));
  }

  throw new Error("extraction repair failed");
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
    await recordTranscriptCitationUsage(params.paths.statePath, params.paths.logPath, transcript);

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
    const initialOutputRecord = toOutputRecord(extractionModelResult);
    workerSessionId = initialOutputRecord.workerSessionId;
    workerSessionKey = initialOutputRecord.workerSessionKey;
    const validatedOutput = await validateLiveExtractionOutput({
      sessionId: params.sessionId,
      transcript,
      subjects,
      existingEntries,
      outputRecord: initialOutputRecord,
      deps: params.deps,
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
    const parsedEntries: ParsedExtractionEntry[] = validatedOutput.parsedEntries;

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
    if (finalHandoff?.type === "handoff") {
      try {
        const memoryContent = await params.deps.readMemoryFile(params.memoryMdPath);
        const updatedMemory = applyLastHandoffBlock(memoryContent, finalHandoff, {
          sessionKey: params.sourceSessionKey,
        });
        await params.deps.writeMemoryFile(params.memoryMdPath, updatedMemory);
      } catch (error) {
        params.logger.warn(`reclaw handoff write failed for ${params.sessionId}: ${normalizeError(error)}`);
      }
    }

    if (touchedSubjects.size > 0) {
      try {
        await refreshSubjectProjections({
          workspaceDir: dirname(params.memoryMdPath),
          logPath: params.paths.logPath,
          subjectsPath: params.paths.subjectsPath,
          subjects: [...touchedSubjects],
        });
      } catch (error) {
        params.logger.warn(`reclaw subject projection refresh failed for ${params.sessionId}: ${normalizeError(error)}`);
      }
    }

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
