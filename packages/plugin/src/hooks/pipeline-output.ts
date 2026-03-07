import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ExtractionModelResult } from "../lib/llm";
import type { LogEntry } from "../log/schema";
import { readRegistry } from "../subjects/registry";
import { parseExtractionJsonl, type ParsedExtractionEntry } from "../extraction/shared";

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

export async function validateLiveExtractionOutput(params: {
  sessionId: string;
  transcript: string;
  subjects: Awaited<ReturnType<typeof readRegistry>>;
  existingEntries: LogEntry[];
  outputRecord: ExtractionModelResult;
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
  model: string;
  logger: OpenClawPluginApi["logger"];
  apiBaseUrl: string;
  apiToken?: string;
}): Promise<{
  parsedEntries: ParsedExtractionEntry[];
  invalidLineCount: number;
  outputRecord: ExtractionModelResult;
}> {
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
    outputRecord = toOutputRecord(await params.repairExtractionOutput({
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
