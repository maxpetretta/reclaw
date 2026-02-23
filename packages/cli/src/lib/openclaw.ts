import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { parseJson as parseJsonWithError } from "./json"

interface OpenClawCommandOptions {
  timeoutMs?: number
  allowFailure?: boolean
}

interface OpenClawCommandResult {
  status: number
  stdout: string
  stderr: string
}

interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

interface CronAddResponse {
  id: string
}

interface CronRunsResponse {
  entries?: CronRunEntry[]
}

interface CronRunEntry {
  action?: string
  status?: string
  summary?: string
  error?: string
  ts?: number
}

type OpenClawErrorCode =
  | "CLI_NOT_FOUND"
  | "COMMAND_FAILED"
  | "INVALID_JSON"
  | "SCHEDULING_FAILED"
  | "JOB_FAILED"
  | "TIMEOUT"

export class OpenClawError extends Error {
  code: OpenClawErrorCode
  details?: string

  constructor(code: OpenClawErrorCode, message: string, details?: string) {
    super(`[${code}] ${message}`)
    this.name = "OpenClawError"
    this.code = code
    if (details !== undefined) {
      this.details = details
    }
  }
}

export interface ScheduleSubagentParams {
  message: string
  model?: string
  sessionName?: string
  timeoutSeconds?: number
}

export interface ScheduledSubagent {
  jobId: string
  mode: "legacy" | "compatible"
}

export interface ExtractionConcurrencyPatchResult {
  changed: boolean
  cronMaxConcurrentRuns?: number
  agentMaxConcurrent?: number
  message?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value)
    return normalized > 0 ? normalized : undefined
  }

  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim())
    const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : 0
    return normalized > 0 ? normalized : undefined
  }

  return undefined
}

export async function ensureExtractionConcurrencyConfig(
  openclawDir: string,
  minimumConcurrent: number,
): Promise<ExtractionConcurrencyPatchResult> {
  const configPath = join(openclawDir, "openclaw.json")
  const normalizedMinimum = Number.isFinite(minimumConcurrent) ? Math.max(1, Math.floor(minimumConcurrent)) : 1

  try {
    const raw = await readFile(configPath, "utf8")
    const config = asRecord(JSON.parse(raw))
    let changed = false

    const cron = asRecord(config.cron)
    config.cron = cron
    const agents = asRecord(config.agents)
    config.agents = agents
    const defaults = asRecord(agents.defaults)
    agents.defaults = defaults

    const currentCronMaxConcurrentRuns = readPositiveInteger(cron.maxConcurrentRuns)
    const currentAgentMaxConcurrent = readPositiveInteger(defaults.maxConcurrent)

    const targetCronMaxConcurrentRuns = Math.max(currentCronMaxConcurrentRuns ?? 0, normalizedMinimum)
    const targetAgentMaxConcurrent = Math.max(currentAgentMaxConcurrent ?? 0, normalizedMinimum)

    if (currentCronMaxConcurrentRuns !== targetCronMaxConcurrentRuns || typeof cron.maxConcurrentRuns !== "number") {
      cron.maxConcurrentRuns = targetCronMaxConcurrentRuns
      changed = true
    }

    if (currentAgentMaxConcurrent !== targetAgentMaxConcurrent || typeof defaults.maxConcurrent !== "number") {
      defaults.maxConcurrent = targetAgentMaxConcurrent
      changed = true
    }

    if (changed) {
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    }

    return {
      changed,
      cronMaxConcurrentRuns: targetCronMaxConcurrentRuns,
      agentMaxConcurrent: targetAgentMaxConcurrent,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      changed: false,
      message: `Could not configure extraction concurrency in ${configPath}: ${message}`,
    }
  }
}

export function runOpenClaw(args: string[], options: OpenClawCommandOptions = {}): OpenClawCommandResult {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
  })

  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined
    if (code === "ENOENT") {
      throw new OpenClawError("CLI_NOT_FOUND", "openclaw CLI was not found on PATH.")
    }

    throw new OpenClawError(
      "COMMAND_FAILED",
      `openclaw ${args.join(" ")} failed before execution.`,
      result.error.message,
    )
  }

  const status = result.status ?? 1
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""

  if (status !== 0 && !options.allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${status}`
    throw new OpenClawError("COMMAND_FAILED", `openclaw ${args.join(" ")} failed.`, detail)
  }

  return {
    status,
    stdout,
    stderr,
  }
}

export async function scheduleSubagentCronJob(params: ScheduleSubagentParams): Promise<ScheduledSubagent> {
  const sessionName = params.sessionName ?? "reclaw-extract"
  const timeoutSeconds = params.timeoutSeconds ?? 1800

  const legacyArgs = [
    "cron",
    "add",
    "--at",
    "+0s",
    "--session",
    sessionName,
    "--name",
    sessionName,
    "--message",
    params.message,
    "--no-deliver",
    "--delete-after-run",
    "--timeout-seconds",
    String(timeoutSeconds),
    "--json",
  ]

  if (params.model) {
    legacyArgs.push("--model", params.model)
  }

  const legacyResult = await runOpenClawWithRetries(legacyArgs, {
    allowFailure: true,
    timeoutMs: 60_000,
    retries: {
      attempts: 3,
      baseDelayMs: 900,
      maxDelayMs: 6_000,
    },
  })

  if (legacyResult.status === 0) {
    return {
      jobId: parseCronAddJobId(legacyResult.stdout),
      mode: "legacy",
    }
  }

  const compatibleArgs = [
    "cron",
    "add",
    "--at",
    new Date().toISOString(),
    "--session",
    "isolated",
    "--name",
    sessionName,
    "--message",
    params.message,
    "--no-deliver",
    "--delete-after-run",
    "--timeout-seconds",
    String(timeoutSeconds),
    "--json",
  ]

  if (params.model) {
    compatibleArgs.push("--model", params.model)
  }

  const compatibleResult = await runOpenClawWithRetries(compatibleArgs, {
    allowFailure: true,
    timeoutMs: 60_000,
    retries: {
      attempts: 3,
      baseDelayMs: 900,
      maxDelayMs: 6_000,
    },
  })

  if (compatibleResult.status !== 0) {
    const legacyError = legacyResult.stderr.trim() || legacyResult.stdout.trim() || String(legacyResult.status)
    const compatibleError =
      compatibleResult.stderr.trim() || compatibleResult.stdout.trim() || String(compatibleResult.status)
    throw new OpenClawError(
      "SCHEDULING_FAILED",
      "Could not schedule subagent via `openclaw cron add` (legacy + compatibility attempts failed).",
      `${legacyError}; ${compatibleError}`,
    )
  }

  return {
    jobId: parseCronAddJobId(compatibleResult.stdout),
    mode: "compatible",
  }
}

export async function waitForCronSummary(jobId: string, timeoutMs = 1_900_000): Promise<string> {
  const startedAt = Date.now()
  let transientFailures = 0

  while (Date.now() - startedAt < timeoutMs) {
    let result: OpenClawCommandResult
    try {
      result = runOpenClaw(["cron", "runs", "--id", jobId, "--limit", "20"], {
        allowFailure: true,
        timeoutMs: 30_000,
      })
    } catch (error) {
      const wrapped = toOpenClawError(error)
      if (wrapped.code === "CLI_NOT_FOUND") {
        throw wrapped
      }

      transientFailures += 1
      if (transientFailures >= 5) {
        throw new OpenClawError(
          "COMMAND_FAILED",
          `openclaw cron runs failed repeatedly while waiting for job ${jobId}.`,
          wrapped.details ?? wrapped.message,
        )
      }

      await sleep(backoffDelayMs(transientFailures, 1_000, 8_000))
      continue
    }

    if (result.status !== 0) {
      transientFailures += 1
      if (transientFailures >= 5) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`
        throw new OpenClawError(
          "COMMAND_FAILED",
          `openclaw cron runs failed repeatedly while waiting for job ${jobId}.`,
          detail,
        )
      }

      await sleep(backoffDelayMs(transientFailures, 1_000, 8_000))
      continue
    }

    let parsed: CronRunsResponse
    try {
      parsed = parseJson<CronRunsResponse>(result.stdout)
    } catch (error) {
      const wrapped = toOpenClawError(error)
      transientFailures += 1
      if (transientFailures >= 5) {
        throw new OpenClawError(
          "INVALID_JSON",
          `openclaw cron runs returned invalid JSON repeatedly for job ${jobId}.`,
          wrapped.details ?? wrapped.message,
        )
      }

      await sleep(backoffDelayMs(transientFailures, 1_000, 8_000))
      continue
    }

    transientFailures = 0
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []
    const finishedEntry = entries
      .filter((entry) => entry.action === "finished")
      .sort((left, right) => (right.ts ?? 0) - (left.ts ?? 0))[0]

    if (finishedEntry) {
      if (finishedEntry.status && finishedEntry.status !== "ok") {
        const errorText =
          typeof finishedEntry.error === "string" && finishedEntry.error.trim().length > 0
            ? finishedEntry.error.trim()
            : ""
        const summaryText =
          typeof finishedEntry.summary === "string" && finishedEntry.summary.trim().length > 0
            ? finishedEntry.summary
            : ""
        const normalizedError = errorText.toLowerCase()
        const isDeliveryFailure =
          normalizedError.includes("cron delivery target is missing") ||
          normalizedError.includes("cron announce delivery failed")

        if (isDeliveryFailure && summaryText.length > 0) {
          return summaryText
        }

        const detail =
          (errorText.length > 0 ? errorText : undefined) ??
          (summaryText.length > 0 ? summaryText : undefined) ??
          "no summary"
        throw new OpenClawError(
          "JOB_FAILED",
          `Subagent job ${jobId} finished with status '${finishedEntry.status}'.`,
          detail,
        )
      }

      return finishedEntry.summary ?? ""
    }

    await sleep(3_000)
  }

  throw new OpenClawError("TIMEOUT", `Timed out waiting for subagent result for cron job ${jobId}.`)
}

export function removeCronJob(jobId: string): void {
  try {
    runOpenClaw(["cron", "rm", jobId], { allowFailure: true, timeoutMs: 15_000 })
  } catch {
    // best-effort cleanup
  }
}

function parseCronAddJobId(stdout: string): string {
  const parsed = parseJson<CronAddResponse>(stdout)
  const id = typeof parsed.id === "string" ? parsed.id : ""
  if (id.length === 0) {
    throw new OpenClawError("SCHEDULING_FAILED", "openclaw cron add did not return a job id.", stdout)
  }

  return id
}

function parseJson<T>(value: string): T {
  return parseJsonWithError(
    value,
    (message) => new OpenClawError("INVALID_JSON", "Could not parse OpenClaw JSON output.", message),
  )
}

async function runOpenClawWithRetries(
  args: string[],
  options: OpenClawCommandOptions & { retries?: RetryOptions },
): Promise<OpenClawCommandResult> {
  const attempts = options.retries?.attempts ?? 1
  const baseDelayMs = options.retries?.baseDelayMs ?? 700
  const maxDelayMs = options.retries?.maxDelayMs ?? 5_000
  const safeAttempts = attempts < 1 ? 1 : attempts

  let lastResult: OpenClawCommandResult | null = null
  let lastError: OpenClawError | null = null

  for (let attempt = 1; attempt <= safeAttempts; attempt += 1) {
    try {
      const commandOptions: OpenClawCommandOptions = {}
      if (options.allowFailure !== undefined) {
        commandOptions.allowFailure = options.allowFailure
      }
      if (options.timeoutMs !== undefined) {
        commandOptions.timeoutMs = options.timeoutMs
      }

      const result = runOpenClaw(args, {
        ...commandOptions,
      })

      if (result.status === 0) {
        return result
      }

      lastResult = result
    } catch (error) {
      const wrapped = toOpenClawError(error)
      if (wrapped.code === "CLI_NOT_FOUND") {
        throw wrapped
      }

      lastError = wrapped
    }

    if (attempt < safeAttempts) {
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs))
    }
  }

  if (lastResult) {
    return lastResult
  }

  const detail = lastError?.details ?? lastError?.message
  throw new OpenClawError("COMMAND_FAILED", `openclaw ${args.join(" ")} failed after ${safeAttempts} attempts.`, detail)
}

function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const scale = 2 ** (attempt - 1)
  const next = baseDelayMs * scale
  return next > maxDelayMs ? maxDelayMs : next
}

function toOpenClawError(value: unknown): OpenClawError {
  if (value instanceof OpenClawError) {
    return value
  }

  const message = value instanceof Error ? value.message : String(value)
  return new OpenClawError("COMMAND_FAILED", "Unknown OpenClaw error.", message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
