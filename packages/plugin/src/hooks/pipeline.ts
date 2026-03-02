import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { normalizeError } from "../lib/guards";
import {
  DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  findMentionedSubjects,
  parseExtractionJsonl,
  type ParsedExtractionEntry,
} from "../extraction/shared";
import { queryByIds, queryExtractionContext } from "../log/query";
import { appendEntry, finalizeEntry } from "../log/schema";
import { applyLastHandoffBlock } from "../memory/handoff";
import {
  isExtracted,
  incrementEventUsage,
  markExtracted,
  markFailed,
  pruneState,
  readState,
  shouldRetry,
} from "../state";
import { readRegistry, upsertSubjectFromExtraction } from "../subjects/registry";
import { formatTranscript, type TranscriptMessage } from "../lib/transcript";
import { extractFromTranscript } from "../lib/llm";

export interface ExtractionPaths {
  logPath: string;
  subjectsPath: string;
  statePath: string;
}

export interface ExtractionPipelineDeps {
  extractFromTranscript: typeof extractFromTranscript;
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
}

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

export async function runExtractionPipeline(params: ExtractionPipelineParams): Promise<void> {
  const state = await readState(params.paths.statePath);

  if (isExtracted(state, params.sessionId)) {
    return;
  }

  if (state.failedSessions[params.sessionId] && !shouldRetry(state, params.sessionId)) {
    return;
  }

  const transcript = formatTranscript(params.messages);
  if (!transcript.trim()) {
    await markExtracted(params.paths.statePath, params.sessionId, 0);
    await pruneState(params.paths.statePath);
    return;
  }

  try {
    await recordTranscriptCitationUsage(params.paths.statePath, params.paths.logPath, transcript);

    const subjects = await readRegistry(params.paths.subjectsPath);
    const transcriptSubjects = findMentionedSubjects(transcript, subjects);
    const existingEntries = await queryExtractionContext(params.paths.logPath, transcriptSubjects, {
      maxPerSubject: DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
    });
    const rawOutput = await params.deps.extractFromTranscript({
      transcript,
      subjects,
      existingEntries,
      model: params.config.extraction.model,
      apiBaseUrl: params.apiBaseUrl,
      apiToken: params.apiToken,
    });

    let appendedCount = 0;
    const appendedEntries: Array<ReturnType<typeof finalizeEntry>> = [];
    const parsed = parseExtractionJsonl(rawOutput);
    const parsedEntries: ParsedExtractionEntry[] = parsed.entries;

    if (parsed.nonEmptyLines > 0 && parsedEntries.length === 0) {
      throw new Error("extraction model returned non-empty output but no valid entries");
    }

    for (const parsedEntry of parsedEntries) {
      const entry = finalizeEntry(parsedEntry.entry, { sessionId: params.sessionId });
      if (entry.subject) {
        await upsertSubjectFromExtraction(params.paths.subjectsPath, entry.subject, parsedEntry.subjectTypeHint);
      }

      await appendEntry(params.paths.logPath, entry);
      appendedEntries.push(entry);
      appendedCount += 1;
    }

    if (parsed.invalidLineCount > 0) {
      params.logger.warn(
        `zettelclaw extraction for ${params.sessionId}: ignored ${parsed.invalidLineCount} invalid entry line(s)`,
      );
    }

    const latestHandoff = [...appendedEntries].reverse().find((entry) => entry.type === "handoff");
    if (latestHandoff) {
      try {
        const memoryContent = await params.deps.readMemoryFile(params.memoryMdPath);
        const updatedMemory = applyLastHandoffBlock(memoryContent, latestHandoff);
        await params.deps.writeMemoryFile(params.memoryMdPath, updatedMemory);
      } catch (error) {
        params.logger.warn(`zettelclaw handoff write failed for ${params.sessionId}: ${normalizeError(error)}`);
      }
    }

    await markExtracted(params.paths.statePath, params.sessionId, appendedCount);
    await pruneState(params.paths.statePath);
  } catch (error) {
    const message = normalizeError(error);
    params.logger.warn(`zettelclaw extraction failed for ${params.sessionId}: ${message}`);
    await markFailed(params.paths.statePath, params.sessionId, message);
    await pruneState(params.paths.statePath);
  }
}
