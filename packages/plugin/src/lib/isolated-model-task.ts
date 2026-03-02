import {
  OpenClawCronError,
  removeCronJob,
  runCronJobNow,
  scheduleSubagentCronJob,
  waitForCronSummary,
} from "./openclaw-cron";

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

export async function runIsolatedModelTask(opts: IsolatedModelTaskOptions): Promise<string> {
  const scheduled = await scheduleSubagentCronJob({
    message: buildIsolatedTaskMessage(opts),
    model: opts.model,
    sessionName: opts.sessionName,
    timeoutSeconds: opts.timeoutSeconds,
    disabled: true,
  });

  try {
    await runCronJobNow(scheduled.jobId, opts.waitTimeoutMs ?? 1_900_000);
    return await waitForCronSummary(scheduled.jobId, 60_000);
  } catch (error) {
    throw formatModelTaskError(opts.errorPrefix ?? "LLM call failed", error);
  } finally {
    await removeCronJob(scheduled.jobId);
  }
}
