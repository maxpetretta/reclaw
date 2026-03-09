import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { normalizeError } from "../lib/guards";
import { queryByIds } from "../log/query";
import { refreshSubjectProjections } from "../projections/subjects";
import { incrementEventUsage } from "../state";

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

export async function recordTranscriptCitationUsage(params: {
  statePath: string;
  logPath: string;
  transcript: string;
}): Promise<void> {
  const transcriptEventIds = extractReferencedEventIds(params.transcript);
  if (transcriptEventIds.length === 0) {
    return;
  }

  const existingCitedEntries = await queryByIds(params.logPath, transcriptEventIds);
  if (existingCitedEntries.length === 0) {
    return;
  }

  const citedIds = [...new Set(existingCitedEntries.map((entry) => entry.id))];
  await incrementEventUsage(params.statePath, citedIds, "citation");
}

export async function refreshTouchedSubjectProjections(params: {
  sessionId: string;
  projectionDir: string;
  logPath: string;
  subjectsPath: string;
  touchedSubjects: Set<string>;
  logger: OpenClawPluginApi["logger"];
}): Promise<void> {
  if (params.touchedSubjects.size === 0) {
    return;
  }

  try {
    await refreshSubjectProjections({
      projectionDir: params.projectionDir,
      logPath: params.logPath,
      subjectsPath: params.subjectsPath,
      subjects: [...params.touchedSubjects],
    });
  } catch (error) {
    params.logger.warn(`reclaw subject projection refresh failed for ${params.sessionId}: ${normalizeError(error)}`);
  }
}
