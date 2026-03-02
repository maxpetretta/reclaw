import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isEnoent, isObject } from "../lib/guards";
import { removeCronJobByIdOrName, upsertCronJobByName } from "../lib/cron-jobs-store";
import type { ImportJobState } from "../state";

const IMPORT_WORKER_NAME_PREFIX = "zettelclaw-import-worker-";
const IMPORT_WORKER_TIMEOUT_SECONDS = 60 * 60;
const IMPORT_WORKER_EXEC_TIMEOUT_SECONDS = 2 * 60 * 60;
const IMPORT_WORKER_SCHEDULE_DELAY_MS = 2_000;

function buildImportWorkerCronName(jobId: string): string {
  return `${IMPORT_WORKER_NAME_PREFIX}${jobId}`;
}

function buildImportWorkerCronJob(
  jobId: string,
  existing: Record<string, unknown> | undefined,
): { job: Record<string, unknown>; nextRunAt: string } {
  const now = Date.now();
  const nextRunAt = new Date(now + IMPORT_WORKER_SCHEDULE_DELAY_MS).toISOString();
  const createdAtMs =
    typeof existing?.createdAtMs === "number" && Number.isFinite(existing.createdAtMs)
      ? existing.createdAtMs
      : now;
  const id = typeof existing?.id === "string" ? existing.id : randomUUID();
  const name = buildImportWorkerCronName(jobId);

  return {
    nextRunAt,
    job: {
      ...existing,
      id,
      name,
      description: `Zettelclaw async import worker (${jobId})`,
      enabled: true,
      deleteAfterRun: true,
      createdAtMs,
      updatedAtMs: now,
      schedule: {
        kind: "at",
        at: nextRunAt,
      },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: [
          "Execute exactly one command using the exec tool.",
          `Set exec timeout to ${IMPORT_WORKER_EXEC_TIMEOUT_SECONDS} seconds and wait for completion (do not background it).`,
          `Command: openclaw zettelclaw import-worker --job ${jobId}`,
          "After it completes, return a concise success/failure summary.",
        ].join("\n"),
        timeoutSeconds: IMPORT_WORKER_TIMEOUT_SECONDS,
      },
      delivery: {
        mode: "none",
        channel: "last",
      },
      state: isObject(existing?.state) ? existing.state : {},
    },
  };
}

export async function scheduleImportWorkerCron(
  cronJobsPath: string,
  jobId: string,
): Promise<{ cronJobId: string; cronJobName: string; nextRunAt: string }> {
  const cronJobName = buildImportWorkerCronName(jobId);
  const job = await upsertCronJobByName(cronJobsPath, cronJobName, (existing) =>
    buildImportWorkerCronJob(jobId, existing).job,
  );
  const nextRunAt =
    isObject(job.schedule) && typeof job.schedule.at === "string"
      ? job.schedule.at
      : new Date(Date.now() + IMPORT_WORKER_SCHEDULE_DELAY_MS).toISOString();
  const cronJobId = typeof job.id === "string" ? job.id : randomUUID();

  return {
    cronJobId,
    cronJobName,
    nextRunAt,
  };
}

export async function unscheduleImportWorkerCron(
  cronJobsPath: string,
  job: Pick<ImportJobState, "id" | "cronJobId" | "cronJobName">,
): Promise<boolean> {
  const expectedName = job.cronJobName?.trim() || buildImportWorkerCronName(job.id);
  const expectedId = job.cronJobId?.trim();

  return await removeCronJobByIdOrName(cronJobsPath, {
    id: expectedId,
    name: expectedName,
  });
}

export async function hasFinishedCronRun(cronRunsDir: string, cronJobId: string): Promise<boolean> {
  const runPath = join(cronRunsDir, `${cronJobId}.jsonl`);
  let raw = "";
  try {
    raw = await readFile(runPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    try {
      const parsed = JSON.parse(line) as { action?: unknown };
      if (parsed.action === "finished") {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}
