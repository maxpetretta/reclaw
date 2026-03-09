import { escapeRegex, isObject } from "../lib/guards";
import {
  GENERAL_SUBJECT_SLUG,
  parseSubjectType,
  validateLlmOutput,
  type LogEntry,
} from "../log/schema";
import type { SubjectRegistry } from "../subjects/registry";

export const DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT = 50;

export interface ParsedExtractionEntry {
  entry: Omit<LogEntry, "id" | "timestamp" | "session">;
  subjectTypeHint?: string;
  timestampHint?: string;
}

export interface ParsedExtractionOutput {
  entries: ParsedExtractionEntry[];
  nonEmptyLines: number;
  invalidLineCount: number;
  processableLines: number;
}

function buildSubjectMatchPattern(candidate: string): RegExp | undefined {
  const normalizedCandidate = candidate.trim().toLowerCase();
  if (!normalizedCandidate) {
    return undefined;
  }

  const tokenPattern = normalizedCandidate
    .split(/[-_\s]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => escapeRegex(token))
    .join("[-_\\s]*");
  if (!tokenPattern) {
    return undefined;
  }

  return new RegExp(`(^|[^a-z0-9])${tokenPattern}([^a-z0-9]|$)`, "u");
}

export function findMentionedSubjects(transcript: string, subjects: SubjectRegistry): string[] {
  if (!transcript.trim()) {
    return [];
  }

  const transcriptLower = transcript.toLowerCase();
  const matched: string[] = [];

  for (const slug of Object.keys(subjects)) {
    const normalizedSlug = slug.trim().toLowerCase();
    if (!normalizedSlug) {
      continue;
    }

    const subject = subjects[slug];
    const patterns = [
      buildSubjectMatchPattern(normalizedSlug),
      buildSubjectMatchPattern(normalizedSlug.replace(/[-_]+/gu, " ")),
      buildSubjectMatchPattern(subject?.display ?? ""),
    ].filter((pattern): pattern is RegExp => pattern instanceof RegExp);

    if (patterns.some((pattern) => pattern.test(transcriptLower))) {
      matched.push(slug);
    }
  }

  return matched;
}

export function readSubjectTypeHint(raw: unknown): string | undefined {
  if (!isObject(raw)) {
    return undefined;
  }

  return parseSubjectType(raw.subjectType ?? raw.subject_type);
}

function readTimestampHint(raw: unknown): string | undefined {
  if (!isObject(raw) || typeof raw.timestamp !== "string") {
    return undefined;
  }

  const trimmed = raw.timestamp.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function stripExtractionAuxFields(
  raw: unknown,
  opts: {
    stripTimestamp?: boolean;
  } = {},
): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const candidate = { ...raw };
  delete candidate.subjectType;
  delete candidate.subject_type;

  if (opts.stripTimestamp === true) {
    delete candidate.timestamp;
    delete candidate.date;
    delete candidate.dateHint;
    delete candidate.date_hint;
  }

  return candidate;
}

export function applyRequiredSubjectFallback(raw: unknown): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const candidate: Record<string, unknown> = { ...raw };
  const type = typeof candidate.type === "string" ? candidate.type : undefined;
  const subject = typeof candidate.subject === "string" ? candidate.subject.trim() : "";

  if (type !== "session_summary" && subject.length === 0) {
    candidate.subject = GENERAL_SUBJECT_SLUG;
    return candidate;
  }

  if (subject.length > 0) {
    candidate.subject = subject;
  }

  return candidate;
}

export function parseExtractionJsonl(
  rawOutput: string,
  opts: {
    includeTimestampHint?: boolean;
    dropSessionSummary?: boolean;
  } = {},
): ParsedExtractionOutput {
  const entries: ParsedExtractionEntry[] = [];
  let nonEmptyLines = 0;
  let invalidLineCount = 0;
  let processableLines = 0;

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    nonEmptyLines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      invalidLineCount += 1;
      processableLines += 1;
      continue;
    }

    const subjectTypeHint = readSubjectTypeHint(parsed);
    const timestampHint = opts.includeTimestampHint ? readTimestampHint(parsed) : undefined;
    const normalizedCandidate = applyRequiredSubjectFallback(
      stripExtractionAuxFields(parsed, { stripTimestamp: opts.includeTimestampHint === true }),
    );
    const validated = validateLlmOutput(normalizedCandidate);
    if (!validated.ok) {
      invalidLineCount += 1;
      processableLines += 1;
      continue;
    }

    if (opts.dropSessionSummary && validated.entry.type === "session_summary") {
      continue;
    }

    processableLines += 1;
    entries.push({
      entry: validated.entry,
      ...(subjectTypeHint ? { subjectTypeHint } : {}),
      ...(timestampHint ? { timestampHint } : {}),
    });
  }

  return {
    entries,
    nonEmptyLines,
    invalidLineCount,
    processableLines,
  };
}
