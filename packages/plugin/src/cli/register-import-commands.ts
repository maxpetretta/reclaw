import {
  confirm as clackConfirm,
  intro as clackIntro,
  log as clackLog,
  outro as clackOutro,
  select as clackSelect,
  spinner as clackSpinner,
  text as clackText,
} from "@clack/prompts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { DEFAULT_IMPORT_MODEL } from "../import/run";
import { readState, type ImportJobStatus } from "../state";
import {
  createSilentImportLogger,
  formatImportJobLine,
  formatImportJobStatusDetail,
  printImportSummary,
  queueImportJob,
  resumeImportJobs,
  runImportCommand,
  runImportWorker,
  stopImportJobs,
} from "./import-ops";
import {
  INTERACTIVE_IMPORT_JOBS_MAX,
  INTERACTIVE_IMPORT_JOBS_MIN,
  formatBytes,
  formatImportModelLabel,
  isInteractiveTerminal,
  listImportModels,
  normalizeModelOption,
  parseInteractiveImportJobs,
  platformLabel,
  readOpenClawMemoryPreflight,
  resolveImportSelection,
  resolveModelByQuery,
} from "./import-ui";
import { resolvePaths } from "./paths";
import type { CommandLike } from "./command-like";
import { toObject } from "./parse";

function unwrapPromptValue<T>(value: T | symbol): T {
  if (typeof value === "symbol") {
    throw new Error("Import canceled");
  }

  return value;
}

export function registerImportCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    api: OpenClawPluginApi;
    workspaceDir?: string;
  },
): void {
  const importCommand = reclaw
    .command("import [platform] [file]")
    .description("Import historical data as async worker jobs (interactive if args are omitted)")
    .option("--dry-run", "Preview import without writing files", false)
    .option("--after <date>", "Only include conversations updated on/after this date")
    .option("--before <date>", "Only include conversations updated on/before this date")
    .option("--min-messages <n>", "Minimum user/assistant messages per conversation")
    .option("--jobs <n>", "Concurrent import workers")
    .option("--model <model>", "Extraction model")
    .option("--force", "Import even if conversation was imported before", false)
    .option("--keep-source", "Do not clear source files after successful openclaw migration", false)
    .option("--backup-memory-docs", "Back up MEMORY.md and USER.md before openclaw migration", false)
    .option("--no-transcripts", "Do not write OpenClaw transcript sessions")
    .option("--verbose", "Verbose progress output", false)
    .action(async (platform: unknown, file: unknown, opts: unknown) => {
      try {
        const options = toObject(opts);

        const selection = await resolveImportSelection({
          platformArg: platform,
          fileArg: file,
          workspaceDir: params.workspaceDir,
        });

        if (selection.interactive) {
          const importOptions = { ...options };
          const requestedModel = normalizeModelOption(importOptions.model);
          const modelSpin = clackSpinner();
          modelSpin.start("Loading available models");
          const models = await listImportModels();
          modelSpin.stop(models.length > 0 ? "Model list loaded" : "Model list unavailable, using default");

          if (models.length > 0) {
            if (requestedModel) {
              const resolvedRequested = resolveModelByQuery(models, requestedModel);
              if (!resolvedRequested) {
                const available = models.map((model) => model.key).join(", ");
                throw new Error(`Model not found: ${requestedModel}. Available models: ${available}`);
              }
              importOptions.model = resolvedRequested.key;
            } else {
              const defaultModel = models.find((model) => model.isDefault) ?? models[0];
              if (defaultModel) {
                const selectedModelKey = unwrapPromptValue(
                  await clackSelect({
                    message: "Which model should import extraction use?",
                    initialValue: defaultModel.key,
                    options: models.map((model) => ({
                      value: model.key,
                      label: formatImportModelLabel(model),
                      hint: model.key === defaultModel.key ? "default" : undefined,
                    })),
                  }),
                );
                importOptions.model = selectedModelKey;
              }
            }
          } else if (!requestedModel) {
            importOptions.model = DEFAULT_IMPORT_MODEL;
          }

          const defaultInteractiveJobs = parseInteractiveImportJobs(importOptions.jobs) ?? INTERACTIVE_IMPORT_JOBS_MIN;
          const selectedJobsRaw = unwrapPromptValue(
            await clackText({
              message: `How many parallel import jobs should run? (${INTERACTIVE_IMPORT_JOBS_MIN}-${INTERACTIVE_IMPORT_JOBS_MAX})`,
              initialValue: String(defaultInteractiveJobs),
              placeholder: String(INTERACTIVE_IMPORT_JOBS_MIN),
              validate(value) {
                return parseInteractiveImportJobs(value) === undefined
                  ? `Enter an integer from ${INTERACTIVE_IMPORT_JOBS_MIN} to ${INTERACTIVE_IMPORT_JOBS_MAX}.`
                  : undefined;
              },
            }),
          );
          const selectedJobs = parseInteractiveImportJobs(selectedJobsRaw);
          if (selectedJobs === undefined) {
            throw new Error(
              `parallel jobs must be an integer between ${INTERACTIVE_IMPORT_JOBS_MIN} and ${INTERACTIVE_IMPORT_JOBS_MAX}`,
            );
          }
          importOptions.jobs = selectedJobs;

          const paths = resolvePaths(params.config, params.workspaceDir);

          clackLog.message(
            [
              `Source: ${platformLabel(selection.platform)}`,
              `Path: ${selection.filePath}`,
              `Model: ${normalizeModelOption(importOptions.model) ?? DEFAULT_IMPORT_MODEL}`,
              `Parallel jobs: ${importOptions.jobs}`,
              `State file: ${paths.statePath}`,
            ].join("\n"),
          );

          if (selection.platform === "openclaw") {
            const preflightSpin = clackSpinner();
            preflightSpin.start("Reading openclaw source stats");
            const preflight = await readOpenClawMemoryPreflight(selection.filePath);
            preflightSpin.stop("Source stats loaded");
            clackLog.message(
              [
                `OpenClaw preflight: files=${preflight.markdownFiles}, daily=${preflight.dailyFiles}, other=${preflight.otherFiles}`,
                `OpenClaw preflight: dateRange=${preflight.dateRange}, size=${formatBytes(preflight.sourceSizeBytes)}`,
              ].join("\n"),
            );
          }

          const previewSpin = clackSpinner();
          previewSpin.start("Running preview (dry-run)");
          await runImportCommand({
            config: params.config,
            workspaceDir: params.workspaceDir,
            apiConfig: params.api.config,
            platform: selection.platform,
            filePath: selection.filePath,
            opts: {
              ...importOptions,
              dryRun: true,
            },
            logger: createSilentImportLogger(),
          });
          previewSpin.stop("Preview complete");

          if (options.dryRun === true) {
            clackOutro("Dry-run complete.");
            return;
          }

          const shouldProceed = unwrapPromptValue(
            await clackConfirm({
              message: "Proceed with import and write changes?",
              initialValue: true,
            }),
          );

          if (!shouldProceed) {
            clackOutro("Import canceled.");
            return;
          }

          const queueSpin = clackSpinner();
          queueSpin.start("Queueing async import worker");
          const queued = await queueImportJob({
            config: params.config,
            workspaceDir: params.workspaceDir,
            apiConfig: params.api.config,
            platform: selection.platform,
            filePath: selection.filePath,
            opts: importOptions,
          });
          queueSpin.stop("Import queued");
          clackLog.message(
            [
              `Job: ${queued.job.id}`,
              `Status: ${queued.job.status}`,
              `Next run: ${queued.nextRunAt}`,
              `State file: ${queued.statePath}`,
              `Track with: openclaw reclaw import status ${queued.job.id}`,
            ].join("\n"),
          );
          clackOutro("Async import queued.");
          return;
        }

        if (options.dryRun === true) {
          const result = await runImportCommand({
            config: params.config,
            workspaceDir: params.workspaceDir,
            apiConfig: params.api.config,
            platform: selection.platform,
            filePath: selection.filePath,
            opts: {
              ...options,
              dryRun: true,
            },
          });
          printImportSummary(result, selection.platform);
          return;
        }

        clackIntro("🦞 Reclaw - Reclaim your AI conversations");
        const queued = await queueImportJob({
          config: params.config,
          workspaceDir: params.workspaceDir,
          apiConfig: params.api.config,
          platform: selection.platform,
          filePath: selection.filePath,
          opts: options,
        });
        clackLog.step(
          [
            `Queued import job: ${queued.job.id}`,
            `  Platform: ${selection.platform}`,
            `  Status: ${queued.job.status}`,
            `  Track with: openclaw reclaw import status ${queued.job.id}`,
          ].join("\n"),
        );
        clackOutro("Async import queued.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Import canceled") {
          if (isInteractiveTerminal()) {
            clackOutro("Import canceled.");
          }
          return;
        }
        if (isInteractiveTerminal()) {
          clackOutro("Import failed.");
        }
        throw error;
      }
    });

  importCommand
    .command("status [jobId]")
    .description("Show async import job status")
    .action(async (jobId: unknown) => {
      const paths = resolvePaths(params.config, params.workspaceDir);
      const state = await readState(paths.statePath);
      const requestedJobId = typeof jobId === "string" && jobId.trim().length > 0 ? jobId.trim() : undefined;

      const jobs = Object.values(state.importJobs).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      if (requestedJobId) {
        const match = state.importJobs[requestedJobId];
        if (!match) {
          throw new Error(`import job not found: ${requestedJobId}`);
        }
        console.log(formatImportJobStatusDetail(match));
        return;
      }

      if (jobs.length === 0) {
        console.log("No import jobs.");
        return;
      }

      const counts = {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
      };

      for (const job of jobs) {
        counts[job.status as ImportJobStatus] += 1;
      }

      const parts: string[] = [];
      if (counts.running > 0) parts.push(`${counts.running} running`);
      if (counts.queued > 0) parts.push(`${counts.queued} queued`);
      if (counts.completed > 0) parts.push(`${counts.completed} completed`);
      if (counts.failed > 0) parts.push(`${counts.failed} failed`);

      console.log(`Import jobs: ${jobs.length} total (${parts.join(", ")})`);
      console.log("");
      for (const job of jobs) {
        console.log(formatImportJobLine(job));
      }
    });

  importCommand
    .command("resume [jobId]")
    .description("Re-queue failed/queued async import jobs")
    .action(async (jobId: unknown) => {
      clackIntro("🦞 Reclaw - Reclaim your AI conversations");
      const result = await resumeImportJobs({
        config: params.config,
        workspaceDir: params.workspaceDir,
        jobId: typeof jobId === "string" && jobId.trim().length > 0 ? jobId.trim() : undefined,
      });

      if (result.resumedJobIds.length === 0 && result.skippedJobIds.length === 0) {
        clackOutro("No jobs to resume.");
        return;
      }

      if (result.resumedJobIds.length > 0) {
        clackLog.step(`Resumed jobs (${result.resumedJobIds.length}): ${result.resumedJobIds.join(", ")}`);
      }

      if (result.skippedJobIds.length > 0) {
        clackLog.info(`Skipped jobs (${result.skippedJobIds.length}): ${result.skippedJobIds.join(", ")}`);
      }

      if (result.schedulingErrors.length > 0) {
        for (const failure of result.schedulingErrors) {
          clackLog.warn(`Failed to schedule ${failure.jobId}: ${failure.error}`);
        }
      }

      clackOutro(`${result.resumedJobIds.length} job(s) resumed.`);
    });

  importCommand
    .command("stop [jobId]")
    .description("Stop running/queued async import jobs")
    .action(async (jobId: unknown) => {
      clackIntro("🦞 Reclaw - Reclaim your AI conversations");
      const result = await stopImportJobs({
        config: params.config,
        workspaceDir: params.workspaceDir,
        jobId: typeof jobId === "string" && jobId.trim().length > 0 ? jobId.trim() : undefined,
      });

      if (result.stoppedJobIds.length === 0 && result.skippedJobIds.length === 0) {
        clackOutro("No jobs to stop.");
        return;
      }

      if (result.stoppedJobIds.length > 0) {
        clackLog.step(`Stopped jobs (${result.stoppedJobIds.length}): ${result.stoppedJobIds.join(", ")}`);
      }

      if (result.unscheduledJobIds.length > 0) {
        clackLog.info(`Removed cron jobs (${result.unscheduledJobIds.length}): ${result.unscheduledJobIds.join(", ")}`);
      }

      if (result.skippedJobIds.length > 0) {
        clackLog.info(`Skipped jobs (${result.skippedJobIds.length}): ${result.skippedJobIds.join(", ")}`);
      }

      if (result.unscheduleErrors.length > 0) {
        for (const failure of result.unscheduleErrors) {
          clackLog.warn(`Failed to unschedule ${failure.jobId}: ${failure.error}`);
        }
      }

      clackOutro(`${result.stoppedJobIds.length} job(s) stopped.`);
    });

  importCommand
    .command("run")
    .description("Run one queued import worker job")
    .option("--job <id>", "Import job id")
    .action(async (opts: unknown) => {
      const options = toObject(opts);
      const jobId = typeof options.job === "string" ? options.job.trim() : "";
      if (!jobId) {
        throw new Error("--job is required");
      }

      const result = await runImportWorker({
        config: params.config,
        workspaceDir: params.workspaceDir,
        apiConfig: params.api.config,
        jobId,
      });

      if (result === null) {
        clackLog.info(`Import job ${jobId} did not run (already completed or stopped).`);
        return;
      }

      printImportSummary(result, result.summary.platform);
    });
}
