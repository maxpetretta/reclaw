import { spawnSync } from "node:child_process"

interface OpenClawCommandOptions {
  timeoutMs?: number
  allowFailure?: boolean
}

interface OpenClawCommandResult {
  status: number
  stdout: string
  stderr: string
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
  ts?: number
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

export function runOpenClaw(args: string[], options: OpenClawCommandOptions = {}): OpenClawCommandResult {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
  })

  if (result.error) {
    throw new Error(`openclaw ${args.join(" ")} failed: ${result.error.message}`)
  }

  const status = result.status ?? 1
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""

  if (status !== 0 && !options.allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${status}`
    throw new Error(`openclaw ${args.join(" ")} failed: ${detail}`)
  }

  return {
    status,
    stdout,
    stderr,
  }
}

export function scheduleSubagentCronJob(params: ScheduleSubagentParams): ScheduledSubagent {
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
    "--announce",
    "--delete-after-run",
    "--timeout-seconds",
    String(timeoutSeconds),
    "--json",
  ]

  if (params.model) {
    legacyArgs.push("--model", params.model)
  }

  const legacyResult = runOpenClaw(legacyArgs, { allowFailure: true, timeoutMs: 60_000 })
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
    "--announce",
    "--delete-after-run",
    "--timeout-seconds",
    String(timeoutSeconds),
    "--json",
  ]

  if (params.model) {
    compatibleArgs.push("--model", params.model)
  }

  const compatibleResult = runOpenClaw(compatibleArgs, { allowFailure: true, timeoutMs: 60_000 })
  if (compatibleResult.status !== 0) {
    const legacyError = legacyResult.stderr.trim() || legacyResult.stdout.trim() || String(legacyResult.status)
    const compatibleError =
      compatibleResult.stderr.trim() || compatibleResult.stdout.trim() || String(compatibleResult.status)
    throw new Error(
      `Could not schedule subagent via cron add (legacy + compatibility attempts failed): ${legacyError}; ${compatibleError}`,
    )
  }

  return {
    jobId: parseCronAddJobId(compatibleResult.stdout),
    mode: "compatible",
  }
}

export async function waitForCronSummary(jobId: string, timeoutMs = 1_900_000): Promise<string> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const result = runOpenClaw(["cron", "runs", "--id", jobId, "--limit", "20"], {
      allowFailure: true,
      timeoutMs: 30_000,
    })

    if (result.status === 0) {
      const parsed = parseJson<CronRunsResponse>(result.stdout)
      const entries = Array.isArray(parsed.entries) ? parsed.entries : []
      const finishedEntry = entries
        .filter((entry) => entry.action === "finished")
        .sort((left, right) => (right.ts ?? 0) - (left.ts ?? 0))[0]

      if (finishedEntry) {
        if (finishedEntry.status && finishedEntry.status !== "ok") {
          throw new Error(
            `Subagent job ${jobId} failed with status ${finishedEntry.status}: ${finishedEntry.summary ?? "no summary"}`,
          )
        }

        return finishedEntry.summary ?? ""
      }
    }

    await sleep(3_000)
  }

  throw new Error(`Timed out waiting for subagent result for cron job ${jobId}`)
}

export function removeCronJob(jobId: string): void {
  runOpenClaw(["cron", "rm", jobId], { allowFailure: true, timeoutMs: 15_000 })
}

function parseCronAddJobId(stdout: string): string {
  const parsed = parseJson<CronAddResponse>(stdout)
  const id = typeof parsed.id === "string" ? parsed.id : ""
  if (id.length === 0) {
    throw new Error(`openclaw cron add did not return a job id: ${stdout}`)
  }

  return id
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not parse OpenClaw JSON output: ${message}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
