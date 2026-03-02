import type { ParsedExtractionEntry } from "../extraction/shared";
import { normalizeWhitespace } from "../lib/text";
import type { SubjectRegistry } from "../subjects/registry";
import type { ImportedConversation } from "./types";

type QualityIssueSeverity = "moderate" | "severe";

export interface QualityIssue {
  severity: QualityIssueSeverity;
  message: string;
}

export function dedupeParsedEntries(entries: ParsedExtractionEntry[]): ParsedExtractionEntry[] {
  const seen = new Set<string>();
  const deduped: ParsedExtractionEntry[] = [];

  for (const parsedEntry of entries) {
    const statusText =
      parsedEntry.entry.type === "task" ? `:${parsedEntry.entry.status}` : "";
    const subjectText = "subject" in parsedEntry.entry ? parsedEntry.entry.subject : "";
    const detailText = typeof parsedEntry.entry.detail === "string" ? parsedEntry.entry.detail : "";
    const key = [
      parsedEntry.entry.type,
      statusText,
      normalizeWhitespace(subjectText).toLowerCase(),
      normalizeWhitespace(parsedEntry.entry.content).toLowerCase(),
      normalizeWhitespace(detailText).toLowerCase(),
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(parsedEntry);
  }

  return deduped;
}

function estimateCoverageTarget(conversation: ImportedConversation): number {
  const substantiveMessageCount = conversation.messages.filter((message) => {
    if (message.role === "system") {
      return false;
    }

    return message.content.trim().length >= 24;
  }).length;

  if (substantiveMessageCount >= 20) {
    return 4;
  }
  if (substantiveMessageCount >= 8) {
    return 2;
  }

  return 1;
}

export function evaluateImportExtractionQuality(params: {
  parsedEntries: ParsedExtractionEntry[];
  conversation: ImportedConversation;
  subjects: SubjectRegistry;
}): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const { parsedEntries, conversation, subjects } = params;

  if (parsedEntries.length === 0) {
    return issues;
  }

  const coverageTarget = estimateCoverageTarget(conversation);
  const coverageDeficit = coverageTarget - parsedEntries.length;
  if (coverageDeficit >= 2 || (coverageDeficit >= 1 && coverageTarget >= 4)) {
    issues.push({
      severity: "severe",
      message: `Coverage is too sparse for this transcript. Produce around ${coverageTarget} durable entries when justified.`,
    });
  } else if (coverageDeficit === 1 && coverageTarget >= 2) {
    issues.push({
      severity: "moderate",
      message: `Coverage is slightly sparse. Target about ${coverageTarget} durable entries when supported by transcript evidence.`,
    });
  }

  if (parsedEntries.length >= 3) {
    const subjectHintBySlug = new Map<string, string>();
    for (const parsedEntry of parsedEntries) {
      if (parsedEntry.subjectTypeHint && "subject" in parsedEntry.entry) {
        subjectHintBySlug.set(parsedEntry.entry.subject, parsedEntry.subjectTypeHint);
      }
    }

    const subjectCounts = new Map<string, number>();
    for (const parsedEntry of parsedEntries) {
      if (!("subject" in parsedEntry.entry)) {
        continue;
      }
      const current = subjectCounts.get(parsedEntry.entry.subject) ?? 0;
      subjectCounts.set(parsedEntry.entry.subject, current + 1);
    }

    let dominantSubject: string | undefined;
    let dominantCount = 0;
    for (const [subject, count] of subjectCounts.entries()) {
      if (count > dominantCount) {
        dominantSubject = subject;
        dominantCount = count;
      }
    }

    if (dominantSubject && dominantCount / parsedEntries.length >= 0.75) {
      const hintedType = subjectHintBySlug.get(dominantSubject);
      const dominantIsPerson =
        hintedType === "person" || subjects[dominantSubject]?.type === "person";

      if (dominantIsPerson) {
        issues.push({
          severity: "severe",
          message:
            "Too many entries use a person subject as a catch-all. Split entries across topical subjects that describe what was discussed (health, investing, golf, nutrition, career, etc.) — person subjects are only for facts about the person themselves (identity, location, biography).",
        });
      }
    }
  }

  return issues;
}

export function shouldRunImportQualityRepair(issues: QualityIssue[]): boolean {
  return issues.some((issue) => issue.severity === "severe");
}

export function buildInvalidOutputRepairPrompt(baseUserPrompt: string, invalidOutput: string): string {
  return [
    baseUserPrompt,
    "",
    "## Previous Invalid Output",
    invalidOutput,
    "",
    "Rewrite the output as strict JSONL entries only.",
    "Do not add explanations, markdown, or code fences.",
    "Each line must be one JSON object that matches the extraction schema.",
  ].join("\n");
}

export function buildQualityRepairPrompt(
  baseUserPrompt: string,
  priorOutput: string,
  issues: QualityIssue[],
): string {
  return [
    baseUserPrompt,
    "",
    "## Previous Output To Improve",
    priorOutput,
    "",
    "## Quality Issues To Fix",
    ...issues.map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.message}`),
    "",
    "Rewrite the output as strict JSONL entries only.",
    "Do not add explanations, markdown, or code fences.",
    "Each line must be one JSON object that matches the extraction schema.",
    "Keep subjects specific to the thing discussed and use `question` for uncertain statements.",
  ].join("\n");
}
