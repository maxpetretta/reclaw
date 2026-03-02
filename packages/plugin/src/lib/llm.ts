import { runIsolatedModelTask } from "./isolated-model-task";
import type { LogEntry } from "../log/schema";
import type { SubjectRegistry } from "../subjects/registry";
import {
  buildExtractionUserPrompt,
  loadExtractionPrompt,
} from "../extraction/prompt";

const EXTRACTION_MODEL_SESSION_NAME = "zettelclaw-extraction-model";
const EXTRACTION_MODEL_TIMEOUT_SECONDS = 1_800;
const EXTRACTION_MODEL_WAIT_TIMEOUT_MS = 1_900_000;

export async function extractFromTranscript(opts: {
  transcript: string;
  subjects: SubjectRegistry;
  existingEntries?: LogEntry[];
  model: string;
  apiBaseUrl?: string;
  apiToken?: string;
}): Promise<string> {
  const prompt = await loadExtractionPrompt();
  const userPrompt = buildExtractionUserPrompt({
    transcript: opts.transcript,
    subjects: opts.subjects,
    existingEntries: opts.existingEntries,
  });
  return await runIsolatedModelTask({
    model: opts.model,
    sessionName: EXTRACTION_MODEL_SESSION_NAME,
    timeoutSeconds: EXTRACTION_MODEL_TIMEOUT_SECONDS,
    waitTimeoutMs: EXTRACTION_MODEL_WAIT_TIMEOUT_MS,
    systemPrompt: prompt,
    userPrompt,
    errorPrefix: "extraction LLM call failed",
    outputReminder: "Return JSONL only, one object per line, no markdown fences or commentary.",
  });
}
