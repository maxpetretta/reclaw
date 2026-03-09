import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ExtractionModelResult } from "../lib/llm";
import type { LogEntry } from "../log/schema";
import { readRegistry } from "../subjects/registry";
import { parseExtractionJsonl, type ParsedExtractionEntry, type ParsedExtractionOutput } from "../extraction/shared";

function toOutputRecord(output: string | ExtractionModelResult): ExtractionModelResult {
  return typeof output === "string" ? { output } : output;
}

function describeLiveOutputIssue(parsed: ParsedExtractionOutput): string | undefined {
  if (parsed.entries.length > 0) {
    return undefined;
  }

  if (parsed.nonEmptyLines > 0 && parsed.invalidLineCount === parsed.nonEmptyLines) {
    return "live extraction output did not contain any valid durable events";
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
    const parsed = parseExtractionJsonl(outputRecord.output, {
      dropSessionSummary: true,
    });
    const issue = describeLiveOutputIssue(parsed);
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
