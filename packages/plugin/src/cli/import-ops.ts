import { dirname, join } from "node:path";
import type { PluginConfig } from "../config";
import {
  DEFAULT_IMPORT_JOBS,
  DEFAULT_IMPORT_MIN_MESSAGES,
  DEFAULT_IMPORT_MODEL,
  IMPORT_STOP_REQUESTED_ERROR,
  type ReclawImportProgress,
  type ReclawImportSummary,
  runReclawImport,
} from "../import/run";
import type { ImportPlatform } from "../import/types";
import { readGatewayToken, resolveApiBaseUrlFromConfig, resolveOpenClawHome } from "../lib/runtime-env";
import {
  readState,
  type ImportJobProgressState,
  type ImportJobState,
  type ImportJobStatus,
} from "../state";
import type { InitPaths } from "./paths";
import { resolvePaths } from "./paths";
import {
  createImportJobRecord,
  readNumberOption,
  sanitizeImportOptionsForJob,
  toObject,
} from "./import-job-options";
import { hasFinishedCronRun, scheduleImportWorkerCron, unscheduleImportWorkerCron } from "./import-job-cron";
import { createImportJob, readImportJob, updateImportJob } from "./import-job-store";
import {
  assertDirectory,
  backupDirectoryWithTimestamp,
  backupFileIfExists,
  clearDirectoryContents,
  ensureImportStoreFiles,
} from "./import-file-ops";

interface ImportCommandDeps {
  ensureImportStoreFiles: (paths: InitPaths, statePath: string) => Promise<void>;
  runReclawImport: typeof runReclawImport;
  backupDirectory: (sourceDir: string) => Promise<string>;
  backupFileIfExists: (filePath: string) => Promise<string | undefined>;
  clearDirectory: (sourceDir: string) => Promise<void>;
}

export interface ImportProgressLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface RunImportCommandOptions {
  config: PluginConfig;
  workspaceDir?: string;
  apiConfig: unknown;
  platform: ImportPlatform;
  filePath: string;
  opts: unknown;
  logger?: ImportProgressLogger;
  shouldStop?: () => Promise<boolean>;
  onProgress?: (progress: ReclawImportProgress) => void | Promise<void>;
}

export interface RunImportCommandResult {
  summary: ReclawImportSummary;
  statePath: string;
  legacyBackupPath?: string;
  memoryDocBackupPath?: string;
  userDocBackupPath?: string;
  legacyMemoryCleared: boolean;
}

export interface QueueImportJobResult {
  job: ImportJobState;
  statePath: string;
  cronJobId: string;
  cronJobName: string;
  nextRunAt: string;
}

export interface ResumeImportJobsResult {
  statePath: string;
  resumedJobIds: string[];
  skippedJobIds: string[];
  schedulingErrors: Array<{ jobId: string; error: string }>;
}

export interface StopImportJobsResult {
  statePath: string;
  stoppedJobIds: string[];
  skippedJobIds: string[];
  unscheduledJobIds: string[];
  unscheduleErrors: Array<{ jobId: string; error: string }>;
}

const IMPORT_STOP_REQUESTED_DISPLAY = "Stop requested by user";
const IMPORT_STOPPED_DISPLAY = "Stopped by user";

function shouldClearLegacyMemoryDir(summary: ReclawImportSummary): boolean {
  if (summary.failed > 0) {
    return false;
  }

  return summary.selected > 0 || summary.skippedAlreadyImported > 0;
}

const DEFAULT_IMPORT_DEPS: ImportCommandDeps = {
  ensureImportStoreFiles,
  runReclawImport,
  backupDirectory: backupDirectoryWithTimestamp,
  backupFileIfExists,
  clearDirectory: clearDirectoryContents,
};

export async function queueImportJob(
  input: RunImportCommandOptions,
): Promise<QueueImportJobResult> {
  const options = toObject(input.opts);
  if (options.dryRun === true) {
    throw new Error("`--dry-run` cannot be combined with `--async`");
  }

  const paths = resolvePaths(input.config, input.workspaceDir);
  const importPath = input.filePath.trim();
  const isOpenClawMigration = input.platform === "openclaw";

  if (isOpenClawMigration) {
    await assertDirectory(importPath);
  }

  await ensureImportStoreFiles(paths, paths.statePath);
  const job = createImportJobRecord({
    platform: input.platform,
    filePath: importPath,
    options: sanitizeImportOptionsForJob(options),
    workspaceDir: input.workspaceDir,
  });
  await createImportJob(paths.statePath, job);

  try {
    const scheduled = await scheduleImportWorkerCron(paths.cronJobsPath, job.id);
    const persisted = await updateImportJob(paths.statePath, job.id, (record) => {
      record.cronJobId = scheduled.cronJobId;
      record.cronJobName = scheduled.cronJobName;
      record.updatedAt = new Date().toISOString();
    });
    if (!persisted) {
      throw new Error(`failed to persist queued job ${job.id}`);
    }

    return {
      job: persisted,
      statePath: paths.statePath,
      ...scheduled,
    };
  } catch (error) {
    await updateImportJob(paths.statePath, job.id, (record) => {
      const finishedAt = new Date().toISOString();
      record.status = "failed";
      record.error = `failed to schedule worker: ${error instanceof Error ? error.message : String(error)}`;
      record.finishedAt = finishedAt;
      record.updatedAt = finishedAt;
    });
    throw error;
  }
}

export async function runImportWorker(
  input: {
    config: PluginConfig;
    apiConfig: unknown;
    jobId: string;
    workspaceDir?: string;
  },
  deps: {
    runImportCommand?: typeof runImportCommand;
  } = {},
): Promise<RunImportCommandResult | null> {
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new Error("job id is required");
  }

  const paths = resolvePaths(input.config, input.workspaceDir);
  await ensureImportStoreFiles(paths, paths.statePath);

  const job = await readImportJob(paths.statePath, jobId);
  if (!job) {
    throw new Error(`import job not found: ${jobId}`);
  }

  if (job.status === "completed") {
    return null;
  }

  if (job.stopRequestedAt) {
    await updateImportJob(paths.statePath, jobId, (record) => {
      const stoppedAt = new Date().toISOString();
      record.status = "failed";
      record.updatedAt = stoppedAt;
      record.finishedAt = stoppedAt;
      record.error = IMPORT_STOPPED_DISPLAY;
    });
    return null;
  }

  const runningJob = await updateImportJob(paths.statePath, jobId, (record) => {
    const startIso = new Date().toISOString();
    record.status = "running";
    record.updatedAt = startIso;
    record.startedAt = startIso;
    record.attempts += 1;
    record.progress = {
      total: 0,
      completed: 0,
      imported: 0,
      failed: 0,
      entriesWritten: 0,
      subjectsCreated: 0,
    };
    delete record.finishedAt;
    delete record.error;
    delete record.summary;
    delete record.stopRequestedAt;
  });
  if (!runningJob) {
    throw new Error(`import job not found: ${jobId}`);
  }

  let stopRequested = false;
  let lastStopCheckAt = 0;
  const shouldStop = async (): Promise<boolean> => {
    if (stopRequested) {
      return true;
    }

    const now = Date.now();
    if (now - lastStopCheckAt < 500) {
      return false;
    }
    lastStopCheckAt = now;

    const latestJob = await readImportJob(paths.statePath, jobId);
    stopRequested = Boolean(latestJob?.stopRequestedAt);
    return stopRequested;
  };
  const markStoppedState = async (): Promise<void> => {
    await updateImportJob(paths.statePath, jobId, (record) => {
      const stoppedAt = new Date().toISOString();
      record.status = "failed";
      record.updatedAt = stoppedAt;
      record.finishedAt = stoppedAt;
      record.error = IMPORT_STOPPED_DISPLAY;
    });
  };
  const normalizeProgress = (next: ReclawImportProgress): ImportJobProgressState => ({
    total: Math.max(0, Math.floor(next.total)),
    completed: Math.max(0, Math.floor(next.completed)),
    imported: Math.max(0, Math.floor(next.imported)),
    failed: Math.max(0, Math.floor(next.failed)),
    entriesWritten: Math.max(0, Math.floor(next.entriesWritten)),
    subjectsCreated: Math.max(0, Math.floor(next.subjectsCreated)),
  });
  let progressPersistQueue: Promise<void> = Promise.resolve();
  const enqueueProgressPersist = (next: ImportJobProgressState): void => {
    progressPersistQueue = progressPersistQueue
      .then(async () => {
        await updateImportJob(paths.statePath, jobId, (record) => {
          if (record.status !== "running") {
            return;
          }
          if (record.stopRequestedAt) {
            stopRequested = true;
            return;
          }

          record.progress = { ...next };
          record.updatedAt = new Date().toISOString();
        });
      })
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`reclaw import progress persist failed for ${jobId}: ${reason}`);
      });
  };

  try {
    const runImport = deps.runImportCommand ?? runImportCommand;
    const result = await runImport({
      config: input.config,
      workspaceDir: runningJob.workspaceDir ?? input.workspaceDir,
      apiConfig: input.apiConfig,
      platform: runningJob.platform,
      filePath: runningJob.filePath,
      opts: {
        ...runningJob.options,
        ...(runningJob.options.jobs === undefined ? { jobs: 1 } : {}),
        async: false,
        dryRun: false,
      },
      shouldStop,
      onProgress(nextProgress) {
        const normalizedProgress = normalizeProgress(nextProgress);
        enqueueProgressPersist(normalizedProgress);
      },
      logger: {
        info(message) {
          console.log(message);
        },
        warn(message) {
          console.warn(message);
        },
      },
    });
    await progressPersistQueue;

    if (await shouldStop()) {
      await markStoppedState();
      return null;
    }

    await updateImportJob(paths.statePath, jobId, (record) => {
      const finishedAt = new Date().toISOString();
      record.status = "completed";
      record.updatedAt = finishedAt;
      record.finishedAt = finishedAt;
      record.summary = result.summary;
      record.progress = {
        total: result.summary.selected,
        completed: result.summary.imported + result.summary.failed,
        imported: result.summary.imported,
        failed: result.summary.failed,
        entriesWritten: result.summary.entriesWritten,
        subjectsCreated: result.summary.subjectsCreated,
      };
      delete record.error;
      delete record.stopRequestedAt;
    });

    return result;
  } catch (error) {
    await progressPersistQueue;
    if (error instanceof Error && error.message === IMPORT_STOP_REQUESTED_ERROR) {
      await markStoppedState();
      return null;
    }

    await updateImportJob(paths.statePath, jobId, (record) => {
      const failedAt = new Date().toISOString();
      record.status = "failed";
      record.updatedAt = failedAt;
      record.finishedAt = failedAt;
      record.error = error instanceof Error ? error.message : String(error);
      delete record.stopRequestedAt;
    });
    throw error;
  }
}

export async function resumeImportJobs(
  input: {
    config: PluginConfig;
    workspaceDir?: string;
    jobId?: string;
  },
): Promise<ResumeImportJobsResult> {
  const paths = resolvePaths(input.config, input.workspaceDir);
  await ensureImportStoreFiles(paths, paths.statePath);
  const state = await readState(paths.statePath);
  const cronRunsDir = join(dirname(paths.cronJobsPath), "runs");

  for (const runningJob of Object.values(state.importJobs)) {
    if (
      runningJob.status !== "running" ||
      typeof runningJob.cronJobId !== "string" ||
      runningJob.cronJobId.trim().length === 0
    ) {
      continue;
    }

    if (!(await hasFinishedCronRun(cronRunsDir, runningJob.cronJobId.trim()))) {
      continue;
    }

    await updateImportJob(paths.statePath, runningJob.id, (job) => {
      const now = new Date().toISOString();
      job.status = "failed";
      job.error = "import worker run ended before writing terminal state (marked failed by resume)";
      job.finishedAt = now;
      job.updatedAt = now;
    });
  }

  const refreshedState = await readState(paths.statePath);
  const requestedJobId = input.jobId?.trim();
  const candidates = requestedJobId
    ? [requestedJobId]
    : Object.values(refreshedState.importJobs)
        .filter((job) => job.status === "queued" || job.status === "failed")
        .map((job) => job.id);

  const resumedJobIds: string[] = [];
  const skippedJobIds: string[] = [];
  const schedulingErrors: Array<{ jobId: string; error: string }> = [];

  for (const jobId of candidates) {
    const job = await readImportJob(paths.statePath, jobId);
    if (!job) {
      skippedJobIds.push(jobId);
      continue;
    }

    if (job.status === "completed" || job.status === "running") {
      skippedJobIds.push(jobId);
      continue;
    }

    await updateImportJob(paths.statePath, jobId, (record) => {
      const queuedAt = new Date().toISOString();
      record.status = "queued";
      record.queuedAt = queuedAt;
      record.updatedAt = queuedAt;
      delete record.finishedAt;
      delete record.error;
      delete record.stopRequestedAt;
    });

    try {
      const scheduled = await scheduleImportWorkerCron(paths.cronJobsPath, jobId);
      await updateImportJob(paths.statePath, jobId, (record) => {
        record.cronJobId = scheduled.cronJobId;
        record.cronJobName = scheduled.cronJobName;
        record.updatedAt = new Date().toISOString();
      });
      resumedJobIds.push(jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateImportJob(paths.statePath, jobId, (record) => {
        const finishedAt = new Date().toISOString();
        record.status = "failed";
        record.error = `failed to schedule worker: ${message}`;
        record.finishedAt = finishedAt;
        record.updatedAt = finishedAt;
      });
      schedulingErrors.push({ jobId, error: message });
    }
  }

  return {
    statePath: paths.statePath,
    resumedJobIds,
    skippedJobIds,
    schedulingErrors,
  };
}

export async function stopImportJobs(
  input: {
    config: PluginConfig;
    workspaceDir?: string;
    jobId?: string;
  },
): Promise<StopImportJobsResult> {
  const paths = resolvePaths(input.config, input.workspaceDir);
  await ensureImportStoreFiles(paths, paths.statePath);
  const state = await readState(paths.statePath);

  const requestedJobId = input.jobId?.trim();
  const candidates = requestedJobId
    ? [requestedJobId]
    : Object.values(state.importJobs)
        .filter((job) => job.status === "queued" || job.status === "running")
        .map((job) => job.id);

  const stoppedJobIds: string[] = [];
  const skippedJobIds: string[] = [];
  const unscheduledJobIds: string[] = [];
  const unscheduleErrors: Array<{ jobId: string; error: string }> = [];

  for (const jobId of candidates) {
    const job = await readImportJob(paths.statePath, jobId);
    if (!job) {
      skippedJobIds.push(jobId);
      continue;
    }

    if (job.status === "completed" || job.status === "failed") {
      skippedJobIds.push(jobId);
      continue;
    }

    const now = new Date().toISOString();
    await updateImportJob(paths.statePath, jobId, (record) => {
      record.stopRequestedAt = now;
      record.updatedAt = now;
      record.error = IMPORT_STOP_REQUESTED_DISPLAY;
    });

    try {
      const unscheduled = await unscheduleImportWorkerCron(paths.cronJobsPath, job);
      if (unscheduled) {
        unscheduledJobIds.push(jobId);
        await updateImportJob(paths.statePath, jobId, (record) => {
          delete record.cronJobId;
          delete record.cronJobName;
        });
      }
    } catch (error) {
      unscheduleErrors.push({
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (job.status === "queued") {
      await updateImportJob(paths.statePath, jobId, (record) => {
        record.status = "failed";
        record.finishedAt = now;
        record.error = IMPORT_STOPPED_DISPLAY;
      });
    }

    stoppedJobIds.push(jobId);
  }

  return {
    statePath: paths.statePath,
    stoppedJobIds,
    skippedJobIds,
    unscheduledJobIds,
    unscheduleErrors,
  };
}

export async function runImportCommand(
  input: RunImportCommandOptions,
  deps: Partial<ImportCommandDeps> = {},
): Promise<RunImportCommandResult> {
  const options = toObject(input.opts);
  const runtimeDeps: ImportCommandDeps = {
    ...DEFAULT_IMPORT_DEPS,
    ...deps,
  };
  const paths = resolvePaths(input.config, input.workspaceDir);
  const importPath = input.filePath.trim();
  const dryRun = options.dryRun === true;
  const isOpenClawMigration = input.platform === "openclaw";
  const defaultMinMessages = isOpenClawMigration ? 1 : DEFAULT_IMPORT_MIN_MESSAGES;
  const defaultJobs = isOpenClawMigration ? 1 : DEFAULT_IMPORT_JOBS;
  const statePath = paths.statePath;
  const keepSource = options.keepSource === true;
  const backupMemoryDocs = options.backupMemoryDocs === true;

  if (isOpenClawMigration) {
    await assertDirectory(importPath);
  }

  if (!dryRun) {
    await runtimeDeps.ensureImportStoreFiles(paths, statePath);
  }

  let legacyBackupPath: string | undefined;
  let memoryDocBackupPath: string | undefined;
  let userDocBackupPath: string | undefined;
  if (isOpenClawMigration && !dryRun) {
    legacyBackupPath = await runtimeDeps.backupDirectory(importPath);
    if (backupMemoryDocs) {
      memoryDocBackupPath = await runtimeDeps.backupFileIfExists(paths.memoryMdPath);
      userDocBackupPath = await runtimeDeps.backupFileIfExists(join(dirname(paths.memoryMdPath), "USER.md"));
    }
  }

  const summary = await runtimeDeps.runReclawImport(
    {
      platform: input.platform,
      filePath: importPath,
      logPath: paths.logPath,
      subjectsPath: paths.subjectsPath,
      statePath,
      dryRun,
      after: typeof options.after === "string" ? options.after : undefined,
      before: typeof options.before === "string" ? options.before : undefined,
      minMessages: readNumberOption(options.minMessages, defaultMinMessages),
      jobs: readNumberOption(options.jobs, defaultJobs),
      model: typeof options.model === "string" ? options.model : DEFAULT_IMPORT_MODEL,
      force: options.force === true,
      transcripts: options.transcripts !== false,
      verbose: options.verbose === true,
      shouldStop: input.shouldStop,
      apiBaseUrl: resolveApiBaseUrlFromConfig(input.apiConfig),
      apiToken: readGatewayToken(input.apiConfig),
      openClawHome: resolveOpenClawHome(),
      onProgress: input.onProgress,
    },
    {},
    input.logger,
  );

  let legacyMemoryCleared = false;
  if (isOpenClawMigration && !dryRun && !keepSource && shouldClearLegacyMemoryDir(summary)) {
    await runtimeDeps.clearDirectory(importPath);
    legacyMemoryCleared = true;
  }

  return {
    summary,
    statePath,
    ...(legacyBackupPath ? { legacyBackupPath } : {}),
    ...(memoryDocBackupPath ? { memoryDocBackupPath } : {}),
    ...(userDocBackupPath ? { userDocBackupPath } : {}),
    legacyMemoryCleared,
  };
}

export function printImportSummary(result: RunImportCommandResult, platform: ImportPlatform): void {
  const s = result.summary;
  const mode = s.dryRun ? " (dry-run)" : "";
  const failedSuffix = s.failed > 0 ? `, ${s.failed} failed` : "";

  console.log(`Import ${s.dryRun ? "preview" : "complete"} (${platform})${mode}`);
  console.log("");
  console.log(`  Conversations  ${s.parsed} parsed → ${s.selected} selected → ${s.imported} imported${failedSuffix}`);
  console.log(`  Entries        ${s.entriesWritten} written, ${s.subjectsCreated} subjects created`);
  console.log(`  Transcripts    ${s.transcriptsWritten} written`);

  if (result.legacyBackupPath) {
    console.log(`  Source backup  ${result.legacyBackupPath}`);
  }
  if (result.memoryDocBackupPath) {
    console.log(`  MEMORY.md bak  ${result.memoryDocBackupPath}`);
  }
  if (result.userDocBackupPath) {
    console.log(`  USER.md bak    ${result.userDocBackupPath}`);
  }
  if (platform === "openclaw" && !s.dryRun) {
    console.log(`  Source cleared  ${result.legacyMemoryCleared ? "yes" : "no"}`);
  }
}

export function createSilentImportLogger(): ImportProgressLogger {
  return {
    info() {},
    warn() {},
  };
}

export { formatImportJobLine, formatImportJobStatusDetail } from "./import-job-format";
