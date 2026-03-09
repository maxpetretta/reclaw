import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { intro as clackIntro, log as clackLog, outro as clackOutro, spinner as clackSpinner } from "@clack/prompts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { generateBriefing } from "../briefing/generate";
import type { PluginConfig } from "../config";
import { listSessionCandidates } from "../hooks/session-discovery";
import { isEnoent, isObject } from "../lib/guards";
import { getLastSessionSummary, queryLog } from "../log/query";
import { applyLastSessionSummaryBlock } from "../memory/session-summary";
import { appendSnapshotRun, readState, type SnapshotRunState } from "../state";
import {
  buildExtractionStatusRows,
  formatExtractionStatusRow,
  formatLatestSnapshotRunLine,
  formatSessionSummaryListLine,
  formatSnapshotRunLine,
  formatStatusTimestamp,
  formatUnifiedSessionSummaryRow,
  truncateStatusText,
} from "./briefing-status";
import { readPositiveNumberOption, toObject } from "./parse";
import { resolvePaths } from "./paths";
import type { CommandLike } from "./command-like";
import { RECLAW_BANNER } from "./ui";

interface SnapshotGenerateParams {
  config: PluginConfig;
  api: OpenClawPluginApi;
  workspaceDir?: string;
}

interface SessionSummaryRefreshParams {
  config: PluginConfig;
  workspaceDir?: string;
}

interface SessionSummaryRefreshResult {
  updated: boolean;
  memoryMdPath: string;
}

interface SnapshotStatusSummary {
  latestRun?: SnapshotRunState;
  extractedTodayCount: number;
  extractedTodayEntries: number;
  failedTodayCount: number;
  compactedTodayCount: number;
}

function getStartOfTodayIso(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

function isAtOrAfter(iso: string, cutoffIso: string): boolean {
  const valueMs = Date.parse(iso);
  const cutoffMs = Date.parse(cutoffIso);
  return Number.isFinite(valueMs) && Number.isFinite(cutoffMs) && valueMs >= cutoffMs;
}

function pickPrimarySessionKey(keys: string[]): string | undefined {
  if (keys.length === 0) {
    return undefined;
  }

  const mainCandidate = keys.find((key) => /^agent:[^:]+:main(?:$|:)/u.test(key));
  return mainCandidate ?? keys[0];
}

async function resolveSessionKeyLookup(sessionIds: string[]): Promise<Map<string, string | undefined>> {
  const uniqueIds = [...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter((sessionId) => sessionId.length > 0))];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const keyCandidatesBySessionId = new Map<string, Set<string>>();
  for (const sessionId of uniqueIds) {
    keyCandidatesBySessionId.set(sessionId, new Set());
  }

  for (const candidate of await listSessionCandidates()) {
    if (!keyCandidatesBySessionId.has(candidate.sessionId) || !candidate.sessionKey) {
      continue;
    }

    keyCandidatesBySessionId.get(candidate.sessionId)?.add(candidate.sessionKey);
  }

  const lookup = new Map<string, string | undefined>();
  for (const sessionId of uniqueIds) {
    const keySet = keyCandidatesBySessionId.get(sessionId);
    const keys = keySet ? [...keySet] : [];
    lookup.set(sessionId, pickPrimarySessionKey(keys));
  }

  return lookup;
}

export async function runSnapshotRefresh(params: SnapshotGenerateParams): Promise<string> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const apiToken =
    isObject(params.api.config) &&
    isObject(params.api.config.gateway) &&
    isObject(params.api.config.gateway.auth) &&
    typeof params.api.config.gateway.auth.token === "string" &&
    params.api.config.gateway.auth.token.trim().length > 0
      ? params.api.config.gateway.auth.token
      : undefined;
  let generationResult:
    | {
      workerSessionId?: string;
      workerSessionKey?: string;
    }
    | undefined;

  try {
    generationResult = await generateBriefing({
      logPath: paths.logPath,
      memoryMdPath: paths.memoryMdPath,
      config: params.config,
      apiToken,
    });

    await appendSnapshotRun(paths.statePath, {
      status: "success",
      memoryMdPath: paths.memoryMdPath,
      ...(generationResult ?? {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendSnapshotRun(paths.statePath, {
      status: "failed",
      memoryMdPath: paths.memoryMdPath,
      error: message,
      ...(generationResult ?? {}),
    });
    throw error;
  }

  return paths.memoryMdPath;
}

export async function runSessionSummaryRefresh(
  params: SessionSummaryRefreshParams,
): Promise<SessionSummaryRefreshResult> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const [latestSummary, state] = await Promise.all([
    getLastSessionSummary(paths.logPath),
    readState(paths.statePath),
  ]);
  if (!latestSummary) {
    return {
      updated: false,
      memoryMdPath: paths.memoryMdPath,
    };
  }

  let sourceSessionKey =
    state.extractedSessions[latestSummary.session]?.sourceSessionKey ??
    state.failedSessions[latestSummary.session]?.sourceSessionKey;
  if (!sourceSessionKey) {
    sourceSessionKey = (await resolveSessionKeyLookup([latestSummary.session])).get(latestSummary.session);
  }

  let memoryContent = "";
  try {
    memoryContent = await readFile(paths.memoryMdPath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const updatedMemory = applyLastSessionSummaryBlock(memoryContent, latestSummary, {
    sessionKey: sourceSessionKey,
  });
  await mkdir(dirname(paths.memoryMdPath), { recursive: true });
  await writeFile(paths.memoryMdPath, updatedMemory, "utf8");

  return {
    updated: true,
    memoryMdPath: paths.memoryMdPath,
  };
}

async function listSnapshotRuns(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
  limit: number,
): Promise<SnapshotRunState[]> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const state = await readState(paths.statePath);
  return state.snapshotRuns.slice(0, limit);
}

async function buildSnapshotStatus(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
): Promise<SnapshotStatusSummary> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const state = await readState(paths.statePath);
  const startOfDay = getStartOfTodayIso();

  const extractedToday = Object.values(state.extractedSessions)
    .filter((session) => isAtOrAfter(session.at, startOfDay));

  const failedToday = Object.values(state.failedSessions)
    .filter((session) => isAtOrAfter(session.at, startOfDay));

  const compactedToday = Object.values(state.compactionSessions)
    .filter((session) => isAtOrAfter(session.at, startOfDay));

  return {
    latestRun: state.snapshotRuns[0],
    extractedTodayCount: extractedToday.length,
    extractedTodayEntries: extractedToday.reduce((sum, session) => sum + session.entries, 0),
    failedTodayCount: failedToday.length,
    compactedTodayCount: compactedToday.length,
  };
}

async function printSnapshotList(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
  limit: number,
): Promise<void> {
  const runs = await listSnapshotRuns(params, limit);
  if (runs.length === 0) {
    console.log("No snapshot runs recorded.");
    return;
  }

  for (const run of runs) {
    console.log(formatSnapshotRunLine(run));
  }
}

async function printSnapshotStatus(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
): Promise<void> {
  const status = await buildSnapshotStatus(params);

  console.log("Snapshot status");
  console.log(formatLatestSnapshotRunLine(status.latestRun));

  console.log(`Today extracted sessions: ${status.extractedTodayCount} (${status.extractedTodayEntries} entries)`);
  console.log(`Today failed extractions: ${status.failedTodayCount}`);
  console.log(`Today compactions observed: ${status.compactedTodayCount}`);
}

async function printSessionSummaryList(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
  limit: number,
): Promise<void> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const [state, summaries] = await Promise.all([
    readState(paths.statePath),
    queryLog(paths.logPath, { type: "session_summary" }),
  ]);

  const selected = summaries.slice(0, limit);
  if (selected.length === 0) {
    console.log("No session summary entries.");
    return;
  }

  for (const entry of selected) {
    console.log(formatSessionSummaryListLine(entry, state));
  }
}

async function printSessionSummaryStatus(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
  sessionId?: string,
): Promise<void> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const [state, latestSummary] = await Promise.all([
    readState(paths.statePath),
    getLastSessionSummary(paths.logPath),
  ]);

  const normalizedSessionId = sessionId?.trim();
  if (normalizedSessionId) {
    const sessionSummaryEntries = await queryLog(paths.logPath, {
      type: "session_summary",
      session: normalizedSessionId,
    });

    const compaction = state.compactionSessions[normalizedSessionId];
    const extracted = state.extractedSessions[normalizedSessionId];
    const failed = state.failedSessions[normalizedSessionId];
    const latestForSession = sessionSummaryEntries[0];

    console.log(`Session summary status for session=${normalizedSessionId}`);
    if (compaction) {
      const compactionDetail = compaction.reason ?? compaction.error ?? "";
      console.log(
        `Compaction: ${compaction.status} at ${formatStatusTimestamp(compaction.at)} (compacted=${compaction.compactedCount}, remaining=${compaction.messageCount})${compactionDetail ? ` | ${compactionDetail}` : ""}`,
      );
    } else {
      console.log("Compaction: not observed");
    }

    if (extracted) {
      console.log(`Extraction: success at ${formatStatusTimestamp(extracted.at)} (${extracted.entries} entries)`);
    } else if (failed) {
      console.log(`Extraction: failed at ${formatStatusTimestamp(failed.at)} (${failed.error})`);
    } else {
      console.log("Extraction: no record");
    }

    if (latestForSession) {
      console.log(`Session summary: yes at ${formatStatusTimestamp(latestForSession.timestamp)} (${truncateStatusText(latestForSession.content, 90)})`);
    } else {
      console.log("Session summary: no session summary entry for this session");
    }

    return;
  }

  const startOfDay = getStartOfTodayIso();
  const extractedToday = Object.values(state.extractedSessions)
    .filter((session) => isAtOrAfter(session.at, startOfDay));
  const sessionSummariesToday = (await queryLog(paths.logPath, { type: "session_summary" }))
    .filter((entry) => isAtOrAfter(entry.timestamp, startOfDay));

  console.log("Session summary status");
  if (!latestSummary) {
    console.log("Latest session summary: none");
  } else {
    console.log(
      `Latest session summary: ${formatStatusTimestamp(latestSummary.timestamp)} session=${latestSummary.session} ${truncateStatusText(latestSummary.content, 90)}`,
    );
  }

  console.log(`Today session summaries: ${sessionSummariesToday.length}`);
  console.log(`Today extracted sessions: ${extractedToday.length}`);
}

async function printUnifiedStatusList(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
  limit: number,
  opts: {
    showAll?: boolean;
  } = {},
): Promise<void> {
  const maxItems = opts.showAll ? Number.POSITIVE_INFINITY : limit;
  const paths = resolvePaths(params.config, params.workspaceDir);
  const [state, sessionSummaries] = await Promise.all([
    readState(paths.statePath),
    queryLog(paths.logPath, { type: "session_summary" }),
  ]);
  const extractionRows = buildExtractionStatusRows(state).slice(0, maxItems);

  const snapshotRuns = state.snapshotRuns.slice(0, maxItems);
  const sessionSummaryRows = sessionSummaries.slice(0, maxItems);
  const sessionKeyLookup = await resolveSessionKeyLookup([
    ...extractionRows.map((row) => row.sessionId),
    ...sessionSummaryRows.map((entry) => entry.session),
  ]);

  console.log(opts.showAll ? "Reclaw status (all)" : `Reclaw status (recent ${limit})`);
  console.log("");
  console.log("Snapshots");
  if (snapshotRuns.length === 0) {
    console.log("- none");
  } else {
    for (const run of snapshotRuns) {
      console.log(formatSnapshotRunLine(run, "- "));
    }
  }

  console.log("");
  console.log("Extractions");
  if (extractionRows.length === 0) {
    console.log("- none");
  } else {
    for (const row of extractionRows) {
      console.log(formatExtractionStatusRow(row, sessionKeyLookup));
    }
  }

  console.log("");
  console.log("Session summaries");
  if (sessionSummaryRows.length === 0) {
    console.log("- none");
  } else {
    for (const summary of sessionSummaryRows) {
      console.log(formatUnifiedSessionSummaryRow(summary, state, sessionKeyLookup));
    }
  }
}

export function registerBriefingCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    api: OpenClawPluginApi;
    workspaceDir?: string;
  },
): void {
  const runSnapshotRefreshAction = async (): Promise<void> => {
    clackIntro(RECLAW_BANNER);
    const spin = clackSpinner();
    spin.start("Refreshing memory snapshot...");
    const memoryMdPath = await runSnapshotRefresh({
      config: params.config,
      api: params.api,
      workspaceDir: params.workspaceDir,
    });
    spin.stop(`Memory snapshot updated: ${memoryMdPath}`);
    clackOutro("MEMORY.md snapshot block updated.");
  };

  const runSessionSummaryRefreshAction = async (): Promise<void> => {
    clackIntro(RECLAW_BANNER);
    const result = await runSessionSummaryRefresh({
      config: params.config,
      workspaceDir: params.workspaceDir,
    });

    if (result.updated) {
      clackLog.step("Session summary refreshed");
      clackOutro("MEMORY.md session summary block updated.");
      return;
    }

    clackOutro("No session summary entries found. MEMORY.md unchanged.");
  };

  const snapshot = reclaw.command("snapshot").description("Memory snapshot helpers");
  snapshot
    .command("refresh")
    .description("Refresh and write MEMORY.md memory snapshot block")
    .action(runSnapshotRefreshAction);

  snapshot
    .command("list")
    .description("List recent snapshot refresh runs")
    .option("--limit <n>", "Max runs to print", 10)
    .action(async (opts: unknown) => {
      const options = toObject(opts);
      await printSnapshotList(
        {
          config: params.config,
          workspaceDir: params.workspaceDir,
        },
        readPositiveNumberOption(options.limit, 10),
      );
    });

  snapshot
    .command("status")
    .description("Show snapshot refresh status and today extraction totals")
    .action(async () => {
      await printSnapshotStatus({
        config: params.config,
        workspaceDir: params.workspaceDir,
      });
    });

  const summary = reclaw.command("summary").description("Reclaw session summary helpers");
  summary
    .command("refresh")
    .description("Force-refresh MEMORY.md session summary block from latest session summary event")
    .action(runSessionSummaryRefreshAction);

  summary
    .command("list")
    .description("List recent session summary entries with compaction status")
    .option("--limit <n>", "Max session summaries to print", 10)
    .action(async (opts: unknown) => {
      const options = toObject(opts);
      await printSessionSummaryList(
        {
          config: params.config,
          workspaceDir: params.workspaceDir,
        },
        readPositiveNumberOption(options.limit, 10),
      );
    });

  summary
    .command("status [sessionId]")
    .description("Show session-summary/extraction/compaction status (optionally for a specific session)")
    .action(async (sessionId: unknown) => {
      await printSessionSummaryStatus(
        {
          config: params.config,
          workspaceDir: params.workspaceDir,
        },
        typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : undefined,
      );
    });

  reclaw
    .command("status")
    .description("List recent snapshots, extractions (success/failed), and session summaries")
    .option("--limit <n>", "Max items to print per section", 10)
    .option("--all", "Show all items in each section", false)
    .action(async (opts: unknown) => {
      const options = toObject(opts);
      const showAll = options.all === true || options.all === "true";
      await printUnifiedStatusList(
        {
          config: params.config,
          workspaceDir: params.workspaceDir,
        },
        readPositiveNumberOption(options.limit, 10),
        {
          showAll,
        },
      );
    });
}
