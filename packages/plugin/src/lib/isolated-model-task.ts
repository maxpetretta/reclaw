import {
  type CronCompletionResult,
  OpenClawCronError,
  removeCronJob,
  runCronJobNow,
  scheduleSubagentCronJob,
  waitForCronResult,
} from "./openclaw-cron";
import { findTranscriptFile, readTranscript, type TranscriptMessage } from "./transcript";

const DEFAULT_REMINDER =
  "Return only the requested output. Do not include markdown fences or commentary.";

export interface IsolatedModelTaskOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  sessionName: string;
  timeoutSeconds?: number;
  waitTimeoutMs?: number;
  errorPrefix?: string;
  outputReminder?: string;
}

export interface IsolatedModelTaskDeps {
  scheduleSubagentCronJob: typeof scheduleSubagentCronJob;
  runCronJobNow: typeof runCronJobNow;
  waitForCronResult: typeof waitForCronResult;
  removeCronJob: typeof removeCronJob;
  findTranscriptFile: typeof findTranscriptFile;
  readTranscript: typeof readTranscript;
}

const DEFAULT_DEPS: IsolatedModelTaskDeps = {
  scheduleSubagentCronJob,
  runCronJobNow,
  waitForCronResult,
  removeCronJob,
  findTranscriptFile,
  readTranscript,
};

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const normalized = normalizeNonEmpty(sessionKey);
  if (!normalized || !normalized.startsWith("agent:")) {
    return undefined;
  }

  const parts = normalized.split(":");
  if (parts.length < 2) {
    return undefined;
  }

  return normalizeNonEmpty(parts[1]);
}

function getAssistantTranscriptOutput(messages: TranscriptMessage[]): string {
  if (messages.length === 0) {
    return "";
  }

  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  const assistantAfterLatestUser = messages
    .slice(lastUserIndex + 1)
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);

  if (assistantAfterLatestUser.length > 0) {
    return assistantAfterLatestUser.join("\n\n");
  }

  const allAssistantMessages = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);

  return allAssistantMessages.join("\n\n");
}

async function readTranscriptOutput(
  result: CronCompletionResult,
  deps: Pick<IsolatedModelTaskDeps, "findTranscriptFile" | "readTranscript">,
): Promise<string | undefined> {
  const sessionId = normalizeNonEmpty(result.sessionId);
  if (!sessionId) {
    return undefined;
  }

  const candidateAgentIds = new Set<string>();
  const agentIdFromKey = parseAgentIdFromSessionKey(result.sessionKey);
  if (agentIdFromKey) {
    candidateAgentIds.add(agentIdFromKey);
  }
  candidateAgentIds.add("main");

  for (const agentId of candidateAgentIds) {
    const transcriptFile = await deps.findTranscriptFile(agentId, sessionId);
    if (!transcriptFile) {
      continue;
    }

    const messages = await deps.readTranscript(transcriptFile);
    const transcriptOutput = getAssistantTranscriptOutput(messages);
    if (transcriptOutput.trim().length > 0) {
      return transcriptOutput;
    }
  }

  return undefined;
}

function buildIsolatedTaskMessage(opts: IsolatedModelTaskOptions): string {
  return [
    "You are running an isolated one-shot task.",
    "Follow the instructions exactly.",
    "",
    "## System Prompt",
    opts.systemPrompt.trim(),
    "",
    "## User Prompt",
    opts.userPrompt.trim(),
    "",
    opts.outputReminder?.trim() || DEFAULT_REMINDER,
  ].join("\n");
}

function formatModelTaskError(prefix: string, error: unknown): Error {
  if (error instanceof OpenClawCronError) {
    if (error.details && error.details.trim().length > 0) {
      return new Error(`${prefix}: ${error.message} (${error.details})`);
    }
    return new Error(`${prefix}: ${error.message}`);
  }

  return new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

export async function runIsolatedModelTask(
  opts: IsolatedModelTaskOptions,
  deps: Partial<IsolatedModelTaskDeps> = {},
): Promise<string> {
  const resolvedDeps: IsolatedModelTaskDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const scheduled = await resolvedDeps.scheduleSubagentCronJob({
    message: buildIsolatedTaskMessage(opts),
    model: opts.model,
    sessionName: opts.sessionName,
    timeoutSeconds: opts.timeoutSeconds,
    disabled: true,
  });

  try {
    await resolvedDeps.runCronJobNow(scheduled.jobId, opts.waitTimeoutMs ?? 1_900_000);
    const completion = await resolvedDeps.waitForCronResult(scheduled.jobId, 60_000);

    try {
      const transcriptOutput = await readTranscriptOutput(completion, {
        findTranscriptFile: resolvedDeps.findTranscriptFile,
        readTranscript: resolvedDeps.readTranscript,
      });
      if (transcriptOutput) {
        return transcriptOutput;
      }
    } catch {
      // Fall back to cron summary if transcript lookup is unavailable.
    }

    return completion.summary;
  } catch (error) {
    throw formatModelTaskError(opts.errorPrefix ?? "LLM call failed", error);
  } finally {
    await resolvedDeps.removeCronJob(scheduled.jobId);
  }
}
