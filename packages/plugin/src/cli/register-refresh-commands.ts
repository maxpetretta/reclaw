import { intro as clackIntro, log as clackLog, outro as clackOutro, spinner as clackSpinner } from "@clack/prompts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { refreshSessionSummaryProjections } from "../projections/session-summaries";
import { refreshSubjectProjections } from "../projections/subjects";
import { refreshTranscriptProjections } from "../projections/transcripts";
import {
  backfillSessionSummaries,
  type SessionSummaryBackfillProgress,
} from "../session-summary/backfill";
import {
  finishSessionSummaryRewrite,
  readState,
  startSessionSummaryRewrite,
  updateSessionSummaryRewriteProgress,
} from "../state";
import type { CommandLike } from "./command-like";
import { toObject } from "./parse";
import { resolvePaths } from "./paths";
import { runSessionSummaryRefresh, runSnapshotRefresh } from "./register-briefing-commands";
import { RECLAW_BANNER } from "./ui";

export type RefreshScope = "subjects" | "sessions" | "transcripts" | "summary" | "snapshot";

const ALL_REFRESH_SCOPES: RefreshScope[] = [
  "subjects",
  "sessions",
  "transcripts",
  "summary",
  "snapshot",
];

const REFRESH_SCOPE_ALIASES: Record<string, RefreshScope | "all"> = {
  all: "all",
  subjects: "subjects",
  subject: "subjects",
  memory: "subjects",
  sessions: "sessions",
  session: "sessions",
  transcripts: "transcripts",
  transcript: "transcripts",
  summary: "summary",
  snapshot: "snapshot",
};

function normalizeRefreshScopeToken(token: string): RefreshScope | "all" | undefined {
  return REFRESH_SCOPE_ALIASES[token.trim().toLowerCase()];
}

export function parseRefreshScopes(raw: unknown): RefreshScope[] {
  if (raw === undefined || raw === null || raw === "") {
    return [...ALL_REFRESH_SCOPES];
  }

  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
    if (typeof value !== "string") {
      return [];
    }

    return value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  });

  if (parts.length === 0) {
    return [...ALL_REFRESH_SCOPES];
  }

  const scopes: RefreshScope[] = [];
  for (const part of parts) {
    const normalized = normalizeRefreshScopeToken(part);
    if (!normalized) {
      throw new Error(
        `Unknown refresh scope "${part}". Expected one of: all, subjects, sessions, transcripts, summary, snapshot.`,
      );
    }

    if (normalized === "all") {
      return [...ALL_REFRESH_SCOPES];
    }

    if (!scopes.includes(normalized)) {
      scopes.push(normalized);
    }
  }

  return scopes;
}

export interface RunRefreshResult {
  scopes: RefreshScope[];
  subjectCount?: number;
  removedSubjectCount?: number;
  sessionSummaryBackfilled?: number;
  sessionSummaryCleared?: number;
  sessionSummaryUpdated?: boolean;
  memoryMdPath?: string;
}

const DEFAULT_SESSION_SUMMARY_REWRITE_CONCURRENCY = 4;

function parseSessionSummaryConcurrency(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SESSION_SUMMARY_REWRITE_CONCURRENCY;
  }

  const normalized =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error("session summary concurrency must be a positive integer");
  }

  return Math.floor(normalized);
}

export async function runRefresh(params: {
  config: PluginConfig;
  api: OpenClawPluginApi;
  workspaceDir?: string;
  scope?: unknown;
  rewriteExistingSessionSummaries?: boolean;
  sessionSummaryConcurrency?: unknown;
}, deps: {
  backfillSessionSummaries?: typeof backfillSessionSummaries;
  startSessionSummaryRewrite?: typeof startSessionSummaryRewrite;
  updateSessionSummaryRewriteProgress?: typeof updateSessionSummaryRewriteProgress;
  finishSessionSummaryRewrite?: typeof finishSessionSummaryRewrite;
} = {}): Promise<RunRefreshResult> {
  const runtimeDeps = {
    backfillSessionSummaries,
    startSessionSummaryRewrite,
    updateSessionSummaryRewriteProgress,
    finishSessionSummaryRewrite,
    ...deps,
  };
  const paths = resolvePaths(params.config, params.workspaceDir);
  const scopes = parseRefreshScopes(params.scope);
  const sessionSummaryConcurrency = parseSessionSummaryConcurrency(params.sessionSummaryConcurrency);
  const result: RunRefreshResult = {
    scopes,
  };

  for (const scope of scopes) {
    if (scope === "subjects") {
      const subjectResult = await refreshSubjectProjections({
        projectionDir: paths.projectionDir,
        logPath: paths.logPath,
        subjectsPath: paths.subjectsPath,
      });
      result.subjectCount = subjectResult.refreshedSubjects.length;
      result.removedSubjectCount = subjectResult.removedSubjects.length;
      continue;
    }

    if (scope === "sessions") {
      if (params.rewriteExistingSessionSummaries === true) {
        let latestProgress: SessionSummaryBackfillProgress | undefined;
        try {
          const existingState = await readState(paths.statePath);
          const existingRewrite = existingState.sessionSummaryRewrite;
          const resumeRewrite =
            existingRewrite &&
            existingRewrite.mode === "projected" &&
            (existingRewrite.status === "running" || existingRewrite.status === "failed")
              ? existingRewrite
              : undefined;
          await runtimeDeps.startSessionSummaryRewrite(paths.statePath, {
            mode: "projected",
            total: resumeRewrite?.total ?? 0,
            cleared: resumeRewrite?.cleared ?? 0,
            processed: resumeRewrite?.processed ?? 0,
            written: resumeRewrite?.written ?? 0,
            clearApplied: resumeRewrite?.clearApplied === true,
            completedSessionIds: resumeRewrite?.completedSessionIds ?? [],
            writtenSessionIds: resumeRewrite?.writtenSessionIds ?? [],
            startedAt: resumeRewrite?.startedAt,
          });

          const backfillResult = await runtimeDeps.backfillSessionSummaries({
            logPath: paths.logPath,
            projectionDir: paths.sessionSummaryProjectionDir,
            model: params.config.extraction.model,
            mode: "projected",
            clearExisting: true,
            force: true,
            concurrency: sessionSummaryConcurrency,
            ...(resumeRewrite
              ? {
                  resume: {
                    processed: resumeRewrite.processed,
                    written: resumeRewrite.written,
                    cleared: resumeRewrite.cleared,
                    clearApplied: resumeRewrite.clearApplied,
                    completedSessionIds: resumeRewrite.completedSessionIds,
                    writtenSessionIds: resumeRewrite.writtenSessionIds,
                    skipFirstProcessedCount:
                      resumeRewrite.completedSessionIds.length === 0 ? resumeRewrite.processed : 0,
                  },
                }
              : {}),
            onProgress: async (progress) => {
              latestProgress = progress;
              await runtimeDeps.updateSessionSummaryRewriteProgress(paths.statePath, {
                total: progress.total,
                cleared: progress.cleared,
                processed: progress.processed,
                written: progress.written,
                clearApplied: true,
                currentSessionId: progress.currentSessionId,
                completedSessionId: progress.completedSessionId,
                wroteSessionId: progress.wroteSessionId,
              });
            },
          });
          latestProgress = backfillResult;
          await runtimeDeps.finishSessionSummaryRewrite(paths.statePath, {
            status: "completed",
            total: backfillResult.total,
            cleared: backfillResult.cleared,
            processed: backfillResult.processed,
            written: backfillResult.written,
          });
          result.sessionSummaryBackfilled = backfillResult.written;
          result.sessionSummaryCleared = backfillResult.cleared;
        } catch (error) {
          const progress = latestProgress;
          await runtimeDeps.finishSessionSummaryRewrite(paths.statePath, {
            status: "failed",
            total: progress?.total ?? 0,
            cleared: progress?.cleared ?? 0,
            processed: progress?.processed ?? 0,
            written: progress?.written ?? 0,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      } else {
        await refreshSessionSummaryProjections({
          projectionDir: paths.sessionSummaryProjectionDir,
          logPath: paths.logPath,
        });
        result.sessionSummaryBackfilled = 0;
        result.sessionSummaryCleared = 0;
      }
      continue;
    }

    if (scope === "transcripts") {
      await refreshTranscriptProjections({
        projectionDir: paths.transcriptProjectionDir,
      });
      continue;
    }

    if (scope === "summary") {
      const summaryResult = await runSessionSummaryRefresh({
        config: params.config,
        workspaceDir: params.workspaceDir,
      });
      result.sessionSummaryUpdated = summaryResult.updated;
      result.memoryMdPath = summaryResult.memoryMdPath;
      continue;
    }

    const memoryMdPath = await runSnapshotRefresh({
      config: params.config,
      api: params.api,
      workspaceDir: params.workspaceDir,
    });
    result.memoryMdPath = memoryMdPath;
  }

  return result;
}

export function registerRefreshCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    api: OpenClawPluginApi;
    workspaceDir?: string;
  },
): void {
  reclaw
    .command("refresh")
    .description("Refresh generated Reclaw outputs")
    .option(
      "--scope <scope>",
      "Scope to refresh: all, subjects, sessions, transcripts, summary, snapshot. Accepts comma-separated values.",
      "all",
    )
    .option(
      "--rewrite-existing-session-summaries",
      "When refreshing sessions, regenerate imported transcript session_summary events even if one already exists.",
      false,
    )
    .option(
      "--session-summary-concurrency <count>",
      "When rewriting session summaries, run up to this many summary jobs in parallel.",
      String(DEFAULT_SESSION_SUMMARY_REWRITE_CONCURRENCY),
    )
    .action(async (opts: unknown) => {
      const options = toObject(opts);
      const scopes = parseRefreshScopes(options.scope);
      const rewriteSessionSummaries = options.rewriteExistingSessionSummaries === true;
      const sessionSummaryConcurrency = parseSessionSummaryConcurrency(options.sessionSummaryConcurrency);

      clackIntro(RECLAW_BANNER);
      const spin = clackSpinner();
      spin.start(
        rewriteSessionSummaries && scopes.length === 1 && scopes[0] === "sessions"
          ? `Refreshing sessions (0/0 @ ${sessionSummaryConcurrency})...`
          : `Refreshing ${scopes.join(", ")}...`,
      );

      const result = await runRefresh({
        config: params.config,
        api: params.api,
        workspaceDir: params.workspaceDir,
        scope: scopes,
        rewriteExistingSessionSummaries: rewriteSessionSummaries,
        sessionSummaryConcurrency,
      }, {
        async backfillSessionSummaries(backfillParams, deps) {
          return await backfillSessionSummaries({
            ...backfillParams,
            onProgress: async (info) => {
              if (rewriteSessionSummaries && scopes.length === 1 && scopes[0] === "sessions") {
                spin.message(
                  `Refreshing sessions (${info.written}/${info.total} written, ${info.processed} processed @ ${sessionSummaryConcurrency})...`,
                );
              }
              await backfillParams.onProgress?.(info);
            },
          }, deps);
        },
      });

      spin.stop(`Refreshed: ${result.scopes.join(", ")}`);

      if (result.scopes.includes("subjects")) {
        clackLog.step(
          `Subject projections refreshed: ${result.subjectCount ?? 0}${result.removedSubjectCount ? ` (${result.removedSubjectCount} removed)` : ""}`,
        );
      }
      if (result.scopes.includes("sessions")) {
        clackLog.step(
          `Session summary projections refreshed${typeof result.sessionSummaryBackfilled === "number" ? ` (${result.sessionSummaryBackfilled} written` : ""}${typeof result.sessionSummaryCleared === "number" && typeof result.sessionSummaryBackfilled === "number" ? `, ${result.sessionSummaryCleared} cleared` : ""}${typeof result.sessionSummaryBackfilled === "number" ? ")" : ""}.`,
        );
      }
      if (result.scopes.includes("transcripts")) {
        clackLog.step("Transcript projections refreshed.");
      }
      if (result.scopes.includes("summary")) {
        clackLog.step(
          result.sessionSummaryUpdated === false
            ? "No session summary entries found. MEMORY.md unchanged."
            : `Session summary block updated: ${result.memoryMdPath}`,
        );
      }
      if (result.scopes.includes("snapshot")) {
        clackLog.step(`Snapshot block updated: ${result.memoryMdPath}`);
      }

      clackOutro("Reclaw refresh complete.");
    });
}
