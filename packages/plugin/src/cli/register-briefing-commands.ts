import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { intro as clackIntro, log as clackLog, outro as clackOutro, spinner as clackSpinner } from "@clack/prompts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { generateBriefing } from "../briefing/generate";
import type { PluginConfig } from "../config";
import { listSessionCandidates } from "../hooks/session-discovery";
import { isEnoent, isObject } from "../lib/guards";
import { getLastHandoff, queryLog } from "../log/query";
import { applyLastHandoffBlock } from "../memory/handoff";
import { appendSnapshotRun, readState, type SnapshotRunState } from "../state";
import { readPositiveNumberOption, toObject } from "./parse";
import { resolvePaths } from "./paths";
import type { CommandLike } from "./command-like";

interface SnapshotGenerateParams {
  config: PluginConfig;
  api: OpenClawPluginApi;
  workspaceDir?: string;
}

interface SessionHandoffRefreshParams {
  config: PluginConfig;
  workspaceDir?: string;
}

interface SessionHandoffRefreshResult {
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

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function truncateText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, Math.max(1, max - 1))}...`;
}

function parseTimestampOrZero(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
      ...(generationResult?.workerSessionId ? { workerSessionId: generationResult.workerSessionId } : {}),
      ...(generationResult?.workerSessionKey ? { workerSessionKey: generationResult.workerSessionKey } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendSnapshotRun(paths.statePath, {
      status: "failed",
      memoryMdPath: paths.memoryMdPath,
      error: message,
      ...(generationResult?.workerSessionId ? { workerSessionId: generationResult.workerSessionId } : {}),
      ...(generationResult?.workerSessionKey ? { workerSessionKey: generationResult.workerSessionKey } : {}),
    });
    throw error;
  }

  return paths.memoryMdPath;
}

export async function runSnapshotGenerate(params: SnapshotGenerateParams): Promise<string> {
  return await runSnapshotRefresh(params);
}

export async function runSessionHandoffRefresh(
  params: SessionHandoffRefreshParams,
): Promise<SessionHandoffRefreshResult> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const [latestHandoff, state] = await Promise.all([
    getLastHandoff(paths.logPath),
    readState(paths.statePath),
  ]);
  if (!latestHandoff) {
    return {
      updated: false,
      memoryMdPath: paths.memoryMdPath,
    };
  }

  let sourceSessionKey =
    state.extractedSessions[latestHandoff.session]?.sourceSessionKey ??
    state.failedSessions[latestHandoff.session]?.sourceSessionKey;
  if (!sourceSessionKey) {
    sourceSessionKey = (await resolveSessionKeyLookup([latestHandoff.session])).get(latestHandoff.session);
  }

  let memoryContent = "";
  try {
    memoryContent = await readFile(paths.memoryMdPath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const updatedMemory = applyLastHandoffBlock(memoryContent, latestHandoff, {
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
    const detail = run.error ? ` | error=${run.error}` : "";
    const workerSessionKey = run.workerSessionKey ? ` | workerSessionKey=${run.workerSessionKey}` : "";
    const workerSessionId = run.workerSessionId ? ` | workerSessionId=${run.workerSessionId}` : "";
    console.log(
      `[${formatTimestamp(run.at)}] status=${run.status} memory=${run.memoryMdPath}${detail}${workerSessionKey}${workerSessionId}`,
    );
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
  if (!status.latestRun) {
    console.log("Latest snapshot run: none");
  } else {
    const latestDetail = status.latestRun.error ? ` error=${status.latestRun.error}` : "";
    const workerSessionKey = status.latestRun.workerSessionKey
      ? ` workerSessionKey=${status.latestRun.workerSessionKey}`
      : "";
    const workerSessionId = status.latestRun.workerSessionId
      ? ` workerSessionId=${status.latestRun.workerSessionId}`
      : "";
    console.log(
      `Latest snapshot run: ${formatTimestamp(status.latestRun.at)} (${status.latestRun.status})${latestDetail}${workerSessionKey}${workerSessionId}`,
    );
  }

  console.log(`Today extracted sessions: ${status.extractedTodayCount} (${status.extractedTodayEntries} entries)`);
  console.log(`Today failed extractions: ${status.failedTodayCount}`);
  console.log(`Today compactions observed: ${status.compactedTodayCount}`);
}

async function printHandoffList(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
  limit: number,
): Promise<void> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const [state, handoffs] = await Promise.all([
    readState(paths.statePath),
    queryLog(paths.logPath, { type: "handoff" }),
  ]);

  const selected = handoffs.slice(0, limit);
  if (selected.length === 0) {
    console.log("No handoff entries.");
    return;
  }

  for (const entry of selected) {
    const compact = state.compactionSessions[entry.session];
    const compactStatus = compact ? compact.status : "n/a";
    console.log(
      `[${formatTimestamp(entry.timestamp)}] session=${entry.session} compact=${compactStatus} ${truncateText(entry.content)}`,
    );
  }
}

async function printHandoffStatus(
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
  sessionId?: string,
): Promise<void> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const [state, latestHandoff] = await Promise.all([
    readState(paths.statePath),
    getLastHandoff(paths.logPath),
  ]);

  const normalizedSessionId = sessionId?.trim();
  if (normalizedSessionId) {
    const handoffEntries = await queryLog(paths.logPath, {
      type: "handoff",
      session: normalizedSessionId,
    });

    const compaction = state.compactionSessions[normalizedSessionId];
    const extracted = state.extractedSessions[normalizedSessionId];
    const failed = state.failedSessions[normalizedSessionId];
    const latestForSession = handoffEntries[0];

    console.log(`Handoff status for session=${normalizedSessionId}`);
    if (compaction) {
      const compactionDetail = compaction.reason ?? compaction.error ?? "";
      console.log(
        `Compaction: ${compaction.status} at ${formatTimestamp(compaction.at)} (compacted=${compaction.compactedCount}, remaining=${compaction.messageCount})${compactionDetail ? ` | ${compactionDetail}` : ""}`,
      );
    } else {
      console.log("Compaction: not observed");
    }

    if (extracted) {
      console.log(`Extraction: success at ${formatTimestamp(extracted.at)} (${extracted.entries} entries)`);
    } else if (failed) {
      console.log(`Extraction: failed at ${formatTimestamp(failed.at)} (${failed.error})`);
    } else {
      console.log("Extraction: no record");
    }

    if (latestForSession) {
      console.log(`Handoff: yes at ${formatTimestamp(latestForSession.timestamp)} (${truncateText(latestForSession.content, 90)})`);
    } else {
      console.log("Handoff: no handoff entry for this session");
    }

    return;
  }

  const startOfDay = getStartOfTodayIso();
  const extractedToday = Object.values(state.extractedSessions)
    .filter((session) => isAtOrAfter(session.at, startOfDay));
  const handoffsToday = (await queryLog(paths.logPath, { type: "handoff" }))
    .filter((entry) => isAtOrAfter(entry.timestamp, startOfDay));

  console.log("Handoff status");
  if (!latestHandoff) {
    console.log("Latest handoff: none");
  } else {
    console.log(
      `Latest handoff: ${formatTimestamp(latestHandoff.timestamp)} session=${latestHandoff.session} ${truncateText(latestHandoff.content, 90)}`,
    );
  }

  console.log(`Today handoffs: ${handoffsToday.length}`);
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
  const [state, handoffs] = await Promise.all([
    readState(paths.statePath),
    queryLog(paths.logPath, { type: "handoff" }),
  ]);

  const extractionSessionIds = [...new Set([
    ...Object.keys(state.extractedSessions),
    ...Object.keys(state.failedSessions),
    ...Object.keys(state.compactionSessions),
  ])];

  const extractionRows = extractionSessionIds
    .map((sessionId) => {
      const extracted = state.extractedSessions[sessionId];
      const failed = state.failedSessions[sessionId];
      const compaction = state.compactionSessions[sessionId];

      const extractedAtMs = extracted ? parseTimestampOrZero(extracted.at) : Number.NEGATIVE_INFINITY;
      const failedAtMs = failed ? parseTimestampOrZero(failed.at) : Number.NEGATIVE_INFINITY;
      const compactionAtMs = compaction ? parseTimestampOrZero(compaction.at) : Number.NEGATIVE_INFINITY;
      const latestAtMs = Math.max(extractedAtMs, failedAtMs, compactionAtMs);

      const latestAt = latestAtMs === extractedAtMs && extracted
        ? extracted.at
        : latestAtMs === failedAtMs && failed
          ? failed.at
          : compaction?.at ?? extracted?.at ?? failed?.at ?? new Date(0).toISOString();

      const latestWasFailure = failedAtMs > extractedAtMs;
      const extractionStatus = extracted || failed
        ? latestWasFailure ? "failed" : "success"
        : "none";

      const latestSourceSessionKey = latestWasFailure ? failed?.sourceSessionKey : extracted?.sourceSessionKey;
      const sourceSessionKey = latestSourceSessionKey ?? extracted?.sourceSessionKey ?? failed?.sourceSessionKey;
      const latestWorkerSessionKey = latestWasFailure ? failed?.workerSessionKey : extracted?.workerSessionKey;
      const workerSessionKey = latestWorkerSessionKey ?? extracted?.workerSessionKey ?? failed?.workerSessionKey;
      const latestWorkerSessionId = latestWasFailure ? failed?.workerSessionId : extracted?.workerSessionId;
      const workerSessionId = latestWorkerSessionId ?? extracted?.workerSessionId ?? failed?.workerSessionId;
      const lastMessageAt = latestWasFailure ? failed?.lastMessageAt : extracted?.lastMessageAt;

      return {
        sessionId,
        at: latestAt,
        atMs: latestAtMs,
        extractionStatus,
        extracted,
        failed,
        compaction,
        sourceSessionKey,
        workerSessionKey,
        workerSessionId,
        lastMessageAt,
      };
    })
    .sort((left, right) => right.atMs - left.atMs)
    .slice(0, maxItems);

  const snapshotRuns = state.snapshotRuns.slice(0, maxItems);
  const handoffRows = handoffs.slice(0, maxItems);
  const sessionKeyLookup = await resolveSessionKeyLookup([
    ...extractionRows.map((row) => row.sessionId),
    ...handoffRows.map((entry) => entry.session),
  ]);

  console.log(opts.showAll ? "Reclaw status (all)" : `Reclaw status (recent ${limit})`);
  console.log("");
  console.log("Snapshots");
  if (snapshotRuns.length === 0) {
    console.log("- none");
  } else {
    for (const run of snapshotRuns) {
      const detail = run.error ? ` | error=${run.error}` : "";
      const workerSessionKey = run.workerSessionKey
        ? ` | workerSessionKey=${run.workerSessionKey}`
        : "";
      const workerSessionId = run.workerSessionId
        ? ` | workerSessionId=${run.workerSessionId}`
        : "";
      console.log(
        `- [${formatTimestamp(run.at)}] status=${run.status} memory=${run.memoryMdPath}${detail}${workerSessionKey}${workerSessionId}`,
      );
    }
  }

  console.log("");
  console.log("Extractions");
  if (extractionRows.length === 0) {
    console.log("- none");
  } else {
    for (const row of extractionRows) {
      const lastMessage = row.lastMessageAt
        ? ` | lastMessage=${formatTimestamp(row.lastMessageAt)}`
        : "";
      const sourceSessionKey = row.sourceSessionKey ?? sessionKeyLookup.get(row.sessionId);
      const sourceSessionKeyText = ` | sourceSessionKey=${sourceSessionKey ?? "n/a"}`;
      const workerSessionKeyText = ` | workerSessionKey=${row.workerSessionKey ?? "n/a"}`;
      const workerSessionIdText = row.workerSessionId
        ? ` | workerSessionId=${row.workerSessionId}`
        : "";
      const compactionStatus = row.compaction?.status ?? "n/a";
      const compactionDetail = row.compaction?.reason ?? row.compaction?.error;
      const compactionDetailText = compactionDetail ? ` | compactionDetail=${truncateText(compactionDetail, 120)}` : "";
      const resultText = row.extractionStatus === "success"
        ? `result=success entries=${row.extracted?.entries ?? 0}`
        : row.extractionStatus === "failed"
          ? `result=failed retries=${row.failed?.retries ?? 0}`
          : "result=none";
      const failureErrorText = row.extractionStatus === "failed" && row.failed?.error
        ? ` | error=${truncateText(row.failed.error, 120)}`
        : "";
      console.log(
        `- [${formatTimestamp(row.at)}] session=${row.sessionId} ${resultText} compaction=${compactionStatus}${sourceSessionKeyText}${workerSessionKeyText}${workerSessionIdText}${failureErrorText}${compactionDetailText}${lastMessage}`,
      );
    }
  }

  console.log("");
  console.log("Handoffs");
  if (handoffRows.length === 0) {
    console.log("- none");
  } else {
    for (const handoff of handoffRows) {
      const compactionStatus = state.compactionSessions[handoff.session]?.status ?? "n/a";
      const sourceSessionKey = state.extractedSessions[handoff.session]?.sourceSessionKey ??
        state.failedSessions[handoff.session]?.sourceSessionKey ??
        sessionKeyLookup.get(handoff.session);
      const sourceSessionKeyText = ` | sourceSessionKey=${sourceSessionKey ?? "n/a"}`;
      console.log(
        `- [${formatTimestamp(handoff.timestamp)}] session=${handoff.session} compact=${compactionStatus} ${truncateText(handoff.content, 90)}${sourceSessionKeyText}`,
      );
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
  const BANNER = "🦞 Reclaw - Reclaim your AI conversations";

  const runSnapshotRefreshAction = async (): Promise<void> => {
    clackIntro(BANNER);
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

  const runHandoffRefresh = async (): Promise<void> => {
    clackIntro(BANNER);
    const result = await runSessionHandoffRefresh({
      config: params.config,
      workspaceDir: params.workspaceDir,
    });

    if (result.updated) {
      clackLog.step("Session handoff refreshed");
      clackOutro("MEMORY.md handoff block updated.");
      return;
    }

    clackOutro("No handoff entries found. MEMORY.md unchanged.");
  };

  const snapshot = reclaw.command("snapshot").description("Memory snapshot helpers");
  snapshot
    .command("refresh")
    .description("Refresh and write MEMORY.md memory snapshot block")
    .action(runSnapshotRefreshAction);

  snapshot
    .command("generate")
    .description("Alias for `snapshot refresh`")
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

  const handoff = reclaw.command("handoff").description("Reclaw session handoff helpers");
  handoff
    .command("refresh")
    .description("Force-refresh MEMORY.md session handoff block from latest handoff event")
    .action(runHandoffRefresh);

  handoff
    .command("list")
    .description("List recent handoff entries with compaction status")
    .option("--limit <n>", "Max handoffs to print", 10)
    .action(async (opts: unknown) => {
      const options = toObject(opts);
      await printHandoffList(
        {
          config: params.config,
          workspaceDir: params.workspaceDir,
        },
        readPositiveNumberOption(options.limit, 10),
      );
    });

  handoff
    .command("status [sessionId]")
    .description("Show handoff/extraction/compaction status (optionally for a specific session)")
    .action(async (sessionId: unknown) => {
      await printHandoffStatus(
        {
          config: params.config,
          workspaceDir: params.workspaceDir,
        },
        typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : undefined,
      );
    });

  reclaw
    .command("status")
    .description("List recent snapshots, extractions (success/failed), and handoffs")
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
