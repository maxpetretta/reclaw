import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginConfig } from "../config";
import { isEnoent, isObject } from "../lib/guards";
import { ensureManagedBlock } from "../memory/managed-block";
import {
  BRIEFING_BEGIN_MARKER,
  BRIEFING_END_MARKER,
  LAST_SESSION_SUMMARY_BEGIN_MARKER,
  LAST_SESSION_SUMMARY_END_MARKER,
} from "../memory/markers";
import { ensureSessionSummaryProjectionDir } from "../projections/session-summaries";
import { ensureTranscriptProjectionDir } from "../projections/transcripts";
import { ensureSubjectProjectionDir } from "../projections/subjects";
import { ensureStoreFiles } from "../store/files";
import {
  readCronJobName,
  readCronJobsDocument,
  removeCronJobsByName,
  writeCronJobsDocument,
} from "../lib/cron-jobs-store";
import {
  ensureQmdCollection,
  RECLAW_TRANSCRIPT_QMD_COLLECTION_NAME,
  type EnsureQmdCollectionResult,
} from "../lib/qmd";
import { dispatchPostInitGuidanceEvent, type GuidanceEventResult } from "./post-init-guidance-event";
import { updateOpenClawConfigForInit, updateOpenClawConfigForUninstall } from "./openclaw-config";
import { type InitPaths, resolvePaths } from "./paths";

const POST_INIT_EVENT_PROMPT = "post-init-system-event.md";
const AGENTS_MEMORY_PROMPT = "agents-memory-guidance.md";
const MEMORY_NOTICE_PROMPT = "memory-reclaw-notice.md";
export const BRIEFING_CRON_NAME = "reclaw-memory-snapshot";
const LEGACY_CRON_NAMES = [
  "reclaw-briefing",
  "reclaw-reset",
  "reclaw-nightly",
] as const;

interface InitDeps {
  fireGuidanceEvent?: (paths: InitPaths) => Promise<GuidanceEventResult>;
  ensureQmdCollection?: (projectionDir: string) => Promise<EnsureQmdCollectionResult> | EnsureQmdCollectionResult;
}

export interface InitResult {
  paths: InitPaths;
  guidanceEvent: GuidanceEventResult;
  qmd: EnsureQmdCollectionResult;
}

function resolvePluginPromptsDir(): string {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  return join(cliDir, "..", "..", "prompts");
}

function substitutePromptTemplate(template: string, values: Record<string, string>): string {
  let output = template;

  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }

  return output;
}

async function readPromptTemplate(name: string): Promise<string> {
  const path = join(resolvePluginPromptsDir(), name);
  return await readFile(path, "utf8");
}

export async function buildPostInitSystemEventText(paths: InitPaths): Promise<string> {
  const [eventTemplate, agentsExcerpt, memoryExcerpt] = await Promise.all([
    readPromptTemplate(POST_INIT_EVENT_PROMPT),
    readPromptTemplate(AGENTS_MEMORY_PROMPT),
    readPromptTemplate(MEMORY_NOTICE_PROMPT),
  ]);

  return substitutePromptTemplate(eventTemplate, {
    AGENTS_EXCERPT: agentsExcerpt.trim(),
    MEMORY_EXCERPT: memoryExcerpt.trim(),
    AGENTS_MD_PATH: paths.agentsMdPath,
    MEMORY_MD_PATH: paths.memoryMdPath,
  }).trim();
}

export async function firePostInitGuidanceEvent(paths: InitPaths): Promise<GuidanceEventResult> {
  let eventText = "";

  try {
    eventText = await buildPostInitSystemEventText(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sent: false, message: `Could not build init event text: ${message}` };
  }

  return await dispatchPostInitGuidanceEvent(eventText);
}

export async function ensureLogStoreFiles(paths: InitPaths): Promise<void> {
  await ensureStoreFiles({
    logDir: paths.logDir,
    logPath: paths.logPath,
    subjectsPath: paths.subjectsPath,
    statePath: paths.statePath,
  });
}

export async function ensureMemoryMarkers(memoryMdPath: string): Promise<void> {
  let content = "";

  try {
    content = await readFile(memoryMdPath, "utf8");
  } catch {
    content = "";
  }

  const withBriefing = ensureManagedBlock(content, BRIEFING_BEGIN_MARKER, BRIEFING_END_MARKER);
  const withSessionSummary = ensureManagedBlock(
    withBriefing,
    LAST_SESSION_SUMMARY_BEGIN_MARKER,
    LAST_SESSION_SUMMARY_END_MARKER,
  );
  if (withSessionSummary === content) {
    return;
  }

  await mkdir(dirname(memoryMdPath), { recursive: true });
  await writeFile(memoryMdPath, withSessionSummary, "utf8");
}

export async function removeGeneratedBriefingBlock(memoryMdPath: string): Promise<void> {
  let content = "";

  try {
    content = await readFile(memoryMdPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }

    throw error;
  }

  const start = content.indexOf(BRIEFING_BEGIN_MARKER);
  const end = content.indexOf(BRIEFING_END_MARKER);
  if (start < 0 || end < 0 || end <= start) {
    return;
  }

  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + BRIEFING_END_MARKER.length).trimStart();

  let next = "";
  if (before && after) {
    next = `${before}\n\n${after}`;
  } else if (before) {
    next = `${before}\n`;
  } else if (after) {
    next = after;
  }

  await mkdir(dirname(memoryMdPath), { recursive: true });
  await writeFile(memoryMdPath, next, "utf8");
}

function buildBriefingCronJob(config: PluginConfig, existing?: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  const tz = config.cron.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const existingId = typeof existing?.id === "string" ? existing.id : randomUUID();
  const createdAtMs =
    typeof existing?.createdAtMs === "number" && Number.isFinite(existing.createdAtMs)
      ? existing.createdAtMs
      : now;

  return {
    ...existing,
    id: existingId,
    name: BRIEFING_CRON_NAME,
    description: "Nightly Reclaw MEMORY.md memory snapshot refresh",
    enabled: true,
    createdAtMs,
    updatedAtMs: now,
    schedule: {
      kind: "cron",
      expr: config.cron.schedule,
      tz,
      staggerMs: 0,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Run: openclaw reclaw refresh --scope snapshot",
      timeoutSeconds: 300,
    },
    delivery: {
      mode: "none",
      channel: "last",
    },
    state: isObject(existing?.state) ? existing.state : {},
  };
}

async function ensureBriefingCron(paths: InitPaths, config: PluginConfig): Promise<void> {
  const doc = await readCronJobsDocument(paths.cronJobsPath);
  const jobsWithoutLegacy = doc.jobs.filter((job) => {
    const name = readCronJobName(job);
    return !name || !LEGACY_CRON_NAMES.includes(name);
  });

  const briefingIndexes = jobsWithoutLegacy
    .map((job, index) => ({ index, name: readCronJobName(job) }))
    .filter((entry) => entry.name === BRIEFING_CRON_NAME)
    .map((entry) => entry.index);

  const nextJobs = [...jobsWithoutLegacy];
  if (briefingIndexes.length > 0) {
    const firstIndex = briefingIndexes[0];
    const existing = nextJobs[firstIndex];
    nextJobs[firstIndex] = buildBriefingCronJob(config, existing);

    for (let i = briefingIndexes.length - 1; i >= 1; i -= 1) {
      nextJobs.splice(briefingIndexes[i], 1);
    }
  } else {
    nextJobs.push(buildBriefingCronJob(config));
  }

  await writeCronJobsDocument(paths.cronJobsPath, {
    ...doc,
    jobs: nextJobs,
  });
}

async function removeBriefingCron(paths: InitPaths): Promise<void> {
  await removeCronJobsByName(paths.cronJobsPath, [BRIEFING_CRON_NAME, ...LEGACY_CRON_NAMES]);
}

export async function runInit(
  config: PluginConfig,
  workspaceDir?: string,
  deps: InitDeps = {},
): Promise<InitResult> {
  const paths = resolvePaths(config, workspaceDir);

  await ensureLogStoreFiles(paths);
  await updateOpenClawConfigForInit(paths.openClawConfigPath, [
    paths.projectionDir,
    paths.sessionSummaryProjectionDir,
  ]);
  await ensureMemoryMarkers(paths.memoryMdPath);
  await ensureSubjectProjectionDir(paths.projectionDir);
  await ensureSessionSummaryProjectionDir(paths.sessionSummaryProjectionDir);
  await ensureTranscriptProjectionDir(paths.transcriptProjectionDir);
  const qmd = await (deps.ensureQmdCollection ?? ensureQmdCollection)(paths.projectionDir);
  const transcriptQmd = await (deps.ensureQmdCollection ?? ensureQmdCollection)(
    paths.transcriptProjectionDir,
    RECLAW_TRANSCRIPT_QMD_COLLECTION_NAME,
  );
  await ensureBriefingCron(paths, config);

  const fireGuidanceEvent = deps.fireGuidanceEvent ?? firePostInitGuidanceEvent;
  const guidanceEvent = await fireGuidanceEvent(paths);

  return {
    paths,
    guidanceEvent,
    qmd,
  };
}

export async function runUninstall(config: PluginConfig, workspaceDir?: string): Promise<InitPaths> {
  const paths = resolvePaths(config, workspaceDir);

  await updateOpenClawConfigForUninstall(paths.openClawConfigPath, [
    paths.projectionDir,
    paths.sessionSummaryProjectionDir,
  ]);
  await removeGeneratedBriefingBlock(paths.memoryMdPath);
  await removeBriefingCron(paths);

  return paths;
}
