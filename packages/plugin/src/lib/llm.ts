import { callGatewayChatCompletion } from "./chat-completions";
import { resolveGatewayBaseUrl } from "./gateway";
import type { LogEntry } from "../log/schema";
import type { SubjectRegistry } from "../subjects/registry";
import {
  buildExtractionUserPrompt,
  loadExtractionPrompt,
} from "../extraction/prompt";

export async function extractFromTranscript(opts: {
  transcript: string;
  subjects: SubjectRegistry;
  existingEntries?: LogEntry[];
  model: string;
  apiBaseUrl?: string;
  apiToken?: string;
}): Promise<string> {
  const prompt = await loadExtractionPrompt();
  const baseUrl = resolveGatewayBaseUrl(opts.apiBaseUrl);
  const userPrompt = buildExtractionUserPrompt(opts);

  return await callGatewayChatCompletion({
    baseUrl,
    model: opts.model,
    systemPrompt: prompt,
    userPrompt,
    apiToken: opts.apiToken,
    errorPrefix: "extraction LLM call failed",
  });
}
