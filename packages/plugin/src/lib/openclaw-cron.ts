import { spawnSync } from "node:child_process";

interface OpenClawCommandOptions {
  timeoutMs?: number;
  allowFailure?: boolean;
}

interface OpenClawCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const CRON_RETRY_SHORT: RetryOptions = {
  attempts: 3,
  baseDelayMs: 900,
  maxDelayMs: 6_000,
};

const CRON_RETRY_MEDIUM: RetryOptions = {
  attempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
};

interface CronAddResponse {
  id?: unknown;
}

interface CronRunsResponse {
  entries?: unknown;
}

interface CronRunEntry {
  action?: unknown;
  status?: unknown;
  summary?: unknown;
  error?: unknown;
  ts?: unknown;
}

interface CronRunResponse {
  ok?: unknown;
  ran?: unknown;
  error?: unknown;
  message?: unknown;
}

export type OpenClawCronErrorCode =
  | "CLI_NOT_FOUND"
  | "COMMAND_FAILED"
  | "INVALID_JSON"
  | "SCHEDULING_FAILED"
  | "JOB_FAILED"
  | "TIMEOUT";

export class OpenClawCronError extends Error {
  code: OpenClawCronErrorCode;
  details?: string;

  constructor(code: OpenClawCronErrorCode, message: string, details?: string) {
    super(`[${code}] ${message}`);
    this.name = "OpenClawCronError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface ScheduleSubagentParams {
  message: string;
  model?: string;
  sessionName?: string;
  timeoutSeconds?: number;
  disabled?: boolean;
}

export interface ScheduledSubagent {
  jobId: string;
}

async function runOpenClawRetryingCommand(
  args: string[],
  options: OpenClawCommandOptions & { retries?: RetryOptions },
): Promise<OpenClawCommandResult> {
  return await runOpenClawWithRetries(args, options);
}

export function runOpenClaw(
  args: string[],
  options: OpenClawCommandOptions = {},
): OpenClawCommandResult {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
  });

  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined;
    if (code === "ENOENT") {
      throw new OpenClawCronError("CLI_NOT_FOUND", "openclaw CLI was not found on PATH.");
    }

    throw new OpenClawCronError(
      "COMMAND_FAILED",
      `openclaw ${args.join(" ")} failed before execution.`,
      result.error.message,
    );
  }

  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (status !== 0 && !options.allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${status}`;
    throw new OpenClawCronError(
      "COMMAND_FAILED",
      `openclaw ${args.join(" ")} failed.`,
      detail,
    );
  }

  return {
    status,
    stdout,
    stderr,
  };
}

export async function scheduleSubagentCronJob(
  params: ScheduleSubagentParams,
): Promise<ScheduledSubagent> {
  const sessionName = params.sessionName?.trim() || "zettelclaw-import-extract";
  const timeoutSeconds = params.timeoutSeconds ?? 1_800;

  const legacyResult = await runOpenClawRetryingCommand(
    buildCronAddArgs({
      at: "+0s",
      session: sessionName,
      sessionName,
      timeoutSeconds,
      params,
    }),
    {
      allowFailure: true,
      timeoutMs: 60_000,
      retries: CRON_RETRY_SHORT,
    },
  );

  if (legacyResult.status === 0) {
    return {
      jobId: parseCronAddJobId(legacyResult.stdout),
    };
  }

  const compatibleResult = await runOpenClawRetryingCommand(
    buildCronAddArgs({
      at: new Date(Date.now() + 3_000).toISOString(),
      session: "isolated",
      sessionName,
      timeoutSeconds,
      params,
    }),
    {
      allowFailure: true,
      timeoutMs: 60_000,
      retries: CRON_RETRY_SHORT,
    },
  );

  if (compatibleResult.status !== 0) {
    const legacyError =
      legacyResult.stderr.trim() || legacyResult.stdout.trim() || String(legacyResult.status);
    const compatibleError =
      compatibleResult.stderr.trim() ||
      compatibleResult.stdout.trim() ||
      String(compatibleResult.status);
    throw new OpenClawCronError(
      "SCHEDULING_FAILED",
      "Could not schedule extraction via `openclaw cron add`.",
      `${legacyError}; ${compatibleError}`,
    );
  }

  return {
    jobId: parseCronAddJobId(compatibleResult.stdout),
  };
}

function buildCronAddArgs(input: {
  at: string;
  session: string;
  sessionName: string;
  timeoutSeconds: number;
  params: ScheduleSubagentParams;
}): string[] {
  const args = [
    "cron",
    "add",
    "--at",
    input.at,
    "--session",
    input.session,
    "--name",
    input.sessionName,
    "--message",
    input.params.message,
    "--no-deliver",
    "--delete-after-run",
    "--timeout-seconds",
    String(input.timeoutSeconds),
    "--json",
  ];

  if (input.params.disabled === true) {
    args.push("--disabled");
  }
  if (input.params.model?.trim()) {
    args.push("--model", input.params.model.trim());
  }

  return args;
}

export async function waitForCronSummary(jobId: string, timeoutMs = 1_900_000): Promise<string> {
  const startedAt = Date.now();
  let transientFailures = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const entries = await readCronRunEntries(jobId);
      transientFailures = 0;
      const finishedEntry = pickLatestFinishedEntry(entries);
      if (finishedEntry) {
        return resolveFinishedCronSummary(jobId, finishedEntry);
      }
    } catch (error) {
      const wrapped = toOpenClawCronError(error);
      if (wrapped.code === "CLI_NOT_FOUND") {
        throw wrapped;
      }

      transientFailures += 1;
      if (transientFailures >= 5) {
        throw buildRepeatedCronRunsError(jobId, wrapped);
      }

      await sleep(backoffDelayMs(transientFailures, 1_000, 8_000));
      continue;
    }

    transientFailures = 0;
    await sleep(3_000);
  }

  throw new OpenClawCronError(
    "TIMEOUT",
    `Timed out waiting for extraction result for cron job ${jobId}.`,
  );
}

async function readCronRunEntries(jobId: string): Promise<ReturnType<typeof toCronRunEntries>> {
  const result = await runOpenClawRetryingCommand(["cron", "runs", "--id", jobId, "--limit", "20"], {
    allowFailure: true,
    timeoutMs: 30_000,
    retries: CRON_RETRY_MEDIUM,
  });

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new OpenClawCronError(
      "COMMAND_FAILED",
      `openclaw cron runs failed for job ${jobId}.`,
      detail,
    );
  }

  const parsed = parseJson<CronRunsResponse>(result.stdout);
  return toCronRunEntries(parsed.entries);
}

function pickLatestFinishedEntry(entries: ReturnType<typeof toCronRunEntries>) {
  return entries
    .filter((entry) => entry.action === "finished")
    .sort((left, right) => right.ts - left.ts)[0];
}

function resolveFinishedCronSummary(jobId: string, finishedEntry: ReturnType<typeof toCronRunEntries>[number]): string {
  if (!finishedEntry.status || finishedEntry.status === "ok") {
    return finishedEntry.summary;
  }

  const errorText = finishedEntry.error;
  const summaryText = finishedEntry.summary;
  const normalizedError = errorText.toLowerCase();
  const isDeliveryFailure =
    normalizedError.includes("cron delivery target is missing") ||
    normalizedError.includes("cron announce delivery failed");
  if (isDeliveryFailure && summaryText.length > 0) {
    return summaryText;
  }

  const detail = errorText || summaryText || "no summary";
  throw new OpenClawCronError(
    "JOB_FAILED",
    `Subagent job ${jobId} finished with status '${finishedEntry.status}'.`,
    detail,
  );
}

function buildRepeatedCronRunsError(jobId: string, error: OpenClawCronError): OpenClawCronError {
  if (error.code === "INVALID_JSON") {
    return new OpenClawCronError(
      "INVALID_JSON",
      `openclaw cron runs returned invalid JSON repeatedly for job ${jobId}.`,
      error.details ?? error.message,
    );
  }

  return new OpenClawCronError(
    "COMMAND_FAILED",
    `openclaw cron runs failed repeatedly while waiting for job ${jobId}.`,
    error.details ?? error.message,
  );
}

export async function runCronJobNow(jobId: string, timeoutMs = 1_900_000): Promise<void> {
  const boundedTimeoutMs = Math.max(30_000, Math.min(Math.floor(timeoutMs), 2_147_000_000));
  const result = await runOpenClawRetryingCommand(
    [
      "cron",
      "run",
      jobId,
      "--expect-final",
      "--timeout",
      String(boundedTimeoutMs),
    ],
    {
      allowFailure: true,
      timeoutMs: boundedTimeoutMs + 30_000,
      retries: CRON_RETRY_MEDIUM,
    },
  );

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new OpenClawCronError(
      "COMMAND_FAILED",
      `openclaw cron run failed for job ${jobId}.`,
      detail,
    );
  }

  let parsed: CronRunResponse | null = null;
  try {
    parsed = parseJson<CronRunResponse>(result.stdout);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object") {
    return;
  }

  if (parsed.ok === false || parsed.ran === false) {
    const detail =
      (typeof parsed.message === "string" && parsed.message.trim()) ||
      (typeof parsed.error === "string" && parsed.error.trim()) ||
      result.stdout.trim() ||
      "cron run returned ran=false";

    throw new OpenClawCronError(
      "JOB_FAILED",
      `Cron job ${jobId} did not execute.`,
      detail,
    );
  }
}

export function removeCronJob(jobId: string): void {
  try {
    runOpenClaw(["cron", "rm", jobId], {
      allowFailure: true,
      timeoutMs: 15_000,
    });
  } catch {
    // best effort cleanup
  }
}

function parseCronAddJobId(stdout: string): string {
  const parsed = parseJson<CronAddResponse>(stdout);
  const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
  if (!id) {
    throw new OpenClawCronError("SCHEDULING_FAILED", "openclaw cron add did not return a job id.", stdout);
  }

  return id;
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new OpenClawCronError(
      "INVALID_JSON",
      "Could not parse OpenClaw JSON output.",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function runOpenClawWithRetries(
  args: string[],
  options: OpenClawCommandOptions & { retries?: RetryOptions },
): Promise<OpenClawCommandResult> {
  const attempts = options.retries?.attempts ?? 1;
  const baseDelayMs = options.retries?.baseDelayMs ?? 700;
  const maxDelayMs = options.retries?.maxDelayMs ?? 5_000;
  const safeAttempts = attempts < 1 ? 1 : attempts;

  let lastResult: OpenClawCommandResult | null = null;
  let lastError: OpenClawCronError | null = null;

  for (let attempt = 1; attempt <= safeAttempts; attempt += 1) {
    try {
      const commandOptions: OpenClawCommandOptions = {};
      if (options.allowFailure !== undefined) {
        commandOptions.allowFailure = options.allowFailure;
      }
      if (options.timeoutMs !== undefined) {
        commandOptions.timeoutMs = options.timeoutMs;
      }

      const result = runOpenClaw(args, commandOptions);
      if (result.status === 0) {
        return result;
      }
      lastResult = result;
    } catch (error) {
      const wrapped = toOpenClawCronError(error);
      if (wrapped.code === "CLI_NOT_FOUND") {
        throw wrapped;
      }

      lastError = wrapped;
    }

    if (attempt < safeAttempts) {
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
    }
  }

  if (lastResult) {
    return lastResult;
  }

  const detail = lastError?.details ?? lastError?.message;
  throw new OpenClawCronError(
    "COMMAND_FAILED",
    `openclaw ${args.join(" ")} failed after ${safeAttempts} attempts.`,
    detail,
  );
}

function toCronRunEntries(value: unknown): Array<{
  action: string;
  status: string;
  summary: string;
  error: string;
  ts: number;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: Array<{
    action: string;
    status: string;
    summary: string;
    error: string;
    ts: number;
  }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const raw = entry as CronRunEntry;
    entries.push({
      action: typeof raw.action === "string" ? raw.action : "",
      status: typeof raw.status === "string" ? raw.status : "",
      summary: typeof raw.summary === "string" ? raw.summary : "",
      error: typeof raw.error === "string" ? raw.error : "",
      ts: typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : 0,
    });
  }

  return entries;
}

function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const scale = 2 ** (attempt - 1);
  const next = baseDelayMs * scale;
  return next > maxDelayMs ? maxDelayMs : next;
}

function toOpenClawCronError(value: unknown): OpenClawCronError {
  if (value instanceof OpenClawCronError) {
    return value;
  }

  const message = value instanceof Error ? value.message : String(value);
  return new OpenClawCronError("COMMAND_FAILED", "Unknown OpenClaw error.", message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
