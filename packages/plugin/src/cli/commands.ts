import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEnoent, isObject } from "../lib/guards";
import { runPluginCommandWithTimeout, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { normalizeCliInputPath } from "../lib/path";
import { ensureManagedBlock } from "../memory/managed-block";
import {
  AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER,
  AGENTS_MEMORY_GUIDANCE_END_MARKER,
  BRIEFING_BEGIN_MARKER,
  BRIEFING_END_MARKER,
  LAST_HANDOFF_BEGIN_MARKER,
  LAST_HANDOFF_END_MARKER,
  MEMORY_NOTICE_BEGIN_MARKER,
  MEMORY_NOTICE_END_MARKER,
} from "../memory/markers";
import {
  detectImportSources,
  resolveImportPathForPlatform,
} from "./import-detect";
import { ensureStoreFiles } from "../store/files";
import type { CommandLike } from "./command-like";
import { updateOpenClawConfigForInit, updateOpenClawConfigForUninit } from "./openclaw-config";
import { type InitPaths, resolvePaths } from "./paths";
import { registerBriefingCommands } from "./register-briefing-commands";
import { registerImportCommands } from "./register-import-commands";
import { buildTraceReport, registerLogCommands } from "./register-log-commands";
import { registerSetupCommands } from "./register-setup-commands";
import { registerSubjectCommands } from "./register-subject-commands";
import {
  readCronJobName,
  readCronJobsDocument,
  removeCronJobsByName,
  writeCronJobsDocument,
} from "../lib/cron-jobs-store";
import { parseInteractiveImportJobs } from "./import-ui";

const POST_INIT_EVENT_PROMPT = "post-init-system-event.md";
const AGENTS_MEMORY_PROMPT = "agents-memory-guidance.md";
const MEMORY_NOTICE_PROMPT = "memory-zettelclaw-notice.md";

export interface GuidanceEventResult {
  sent: boolean;
  message?: string;
}

interface InitDeps {
  fireGuidanceEvent?: (paths: InitPaths) => Promise<GuidanceEventResult>;
}

export interface InitResult {
  paths: InitPaths;
  guidanceEvent: GuidanceEventResult;
}

interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  paths: InitPaths;
}

function toObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
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

  if (!eventText) {
    return { sent: false, message: "Could not build init event text: empty output" };
  }

  const attempts: string[][] = [
    ["openclaw", "system", "event", "--text", eventText, "--mode", "now"],
    ["openclaw", "system", "event", "--text", eventText],
  ];

  let lastErrorMessage = "unknown error";
  for (const argv of attempts) {
    try {
      const result = await runPluginCommandWithTimeout({
        argv,
        timeoutMs: 10_000,
      });

      if (result.code === 0) {
        return { sent: true };
      }

      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      lastErrorMessage =
        stderr || stdout || `command exited with code ${String(result.code)}`;
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    sent: false,
    message: `Could not fire post-init system event: ${lastErrorMessage}`,
  };
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
  const withHandoff = ensureManagedBlock(withBriefing, LAST_HANDOFF_BEGIN_MARKER, LAST_HANDOFF_END_MARKER);
  if (withHandoff === content) {
    return;
  }

  await mkdir(dirname(memoryMdPath), { recursive: true });
  await writeFile(memoryMdPath, withHandoff, "utf8");
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

const BRIEFING_CRON_NAME = "zettelclaw-briefing";
const LEGACY_CRON_NAMES = ["zettelclaw-reset", "zettelclaw-nightly"] as const;

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
    description: "Nightly Zettelclaw MEMORY.md memory snapshot refresh",
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
      message: "Run: openclaw zettelclaw briefing generate",
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
  await removeCronJobsByName(paths.cronJobsPath, [BRIEFING_CRON_NAME]);
}

export async function runInit(
  config: PluginConfig,
  workspaceDir?: string,
  deps: InitDeps = {},
): Promise<InitResult> {
  const paths = resolvePaths(config, workspaceDir);

  await ensureLogStoreFiles(paths);
  await updateOpenClawConfigForInit(paths.openClawConfigPath);
  await ensureMemoryMarkers(paths.memoryMdPath);
  await ensureBriefingCron(paths, config);

  const fireGuidanceEvent = deps.fireGuidanceEvent ?? firePostInitGuidanceEvent;
  const guidanceEvent = await fireGuidanceEvent(paths);

  return {
    paths,
    guidanceEvent,
  };
}

export async function runUninstall(config: PluginConfig, workspaceDir?: string): Promise<InitPaths> {
  const paths = resolvePaths(config, workspaceDir);

  await updateOpenClawConfigForUninit(paths.openClawConfigPath);
  await removeGeneratedBriefingBlock(paths.memoryMdPath);
  await removeBriefingCron(paths);

  return paths;
}

export async function verifySetup(config: PluginConfig, workspaceDir?: string): Promise<VerifyResult> {
  const paths = resolvePaths(config, workspaceDir);
  const checks: VerifyCheck[] = [];
  const addCheck = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // log.jsonl
  try {
    await readFile(paths.logPath, "utf8");
    addCheck("log.jsonl", true, "ok");
  } catch (error) {
    addCheck("log.jsonl", false, isEnoent(error) ? "missing" : String(error));
  }

  // subjects.json
  try {
    const subjectsRaw = await readFile(paths.subjectsPath, "utf8");
    const parsed = JSON.parse(subjectsRaw) as unknown;
    addCheck("subjects.json", isObject(parsed), isObject(parsed) ? "ok" : "expected JSON object");
  } catch (error) {
    const detail = isEnoent(error) ? "missing" : `invalid JSON or unreadable: ${String(error)}`;
    addCheck("subjects.json", false, detail);
  }

  // state.json
  try {
    const stateRaw = await readFile(paths.statePath, "utf8");
    const parsed = JSON.parse(stateRaw) as unknown;
    if (!isObject(parsed)) {
      addCheck("state.json", false, "expected JSON object");
    } else {
      const hasCoreKeys =
        isObject(parsed.extractedSessions) &&
        isObject(parsed.failedSessions) &&
        isObject(parsed.importedConversations);
      const hasValidEventUsage = parsed.eventUsage === undefined || isObject(parsed.eventUsage);
      const hasValidImportJobs = parsed.importJobs === undefined || isObject(parsed.importJobs);
      const isLegacyState = parsed.eventUsage === undefined;

      const hasExpectedKeys = hasCoreKeys && hasValidEventUsage && hasValidImportJobs;
      if (!hasExpectedKeys) {
        const issues: string[] = [];
        if (!hasCoreKeys) {
          issues.push("missing core state keys");
        }
        if (!hasValidEventUsage) {
          issues.push("eventUsage is not an object");
        }
        if (!hasValidImportJobs) {
          issues.push("importJobs is not an object");
        }
        addCheck("state.json", false, issues.join("; "));
      } else {
        addCheck("state.json", true, isLegacyState ? "ok (legacy state without eventUsage)" : "ok");
      }
    }
  } catch (error) {
    const detail = isEnoent(error) ? "missing" : `invalid JSON or unreadable: ${String(error)}`;
    addCheck("state.json", false, detail);
  }

  // openclaw.json + required config values
  try {
    const configRaw = await readFile(paths.openClawConfigPath, "utf8");
    const parsed = JSON.parse(configRaw) as unknown;
    const configRoot = toObject(parsed);
    const plugins = toObject(configRoot.plugins);
    const slots = toObject(plugins.slots);
    const slotValue = typeof slots.memory === "string" ? slots.memory : undefined;

    const agents = toObject(configRoot.agents);
    const defaults = toObject(agents.defaults);
    const compaction = toObject(defaults.compaction);
    const memoryFlush = compaction.memoryFlush;
    const memoryFlushDisabled = isObject(memoryFlush) && memoryFlush.enabled === false;
    const hooks = toObject(configRoot.hooks);
    const internalHooks = toObject(hooks.internal);
    const hookEntries = toObject(internalHooks.entries);
    const sessionMemoryHook = toObject(hookEntries["session-memory"]);
    const sessionMemoryDisabled = sessionMemoryHook.enabled === false;

    if (slotValue === "zettelclaw" && memoryFlushDisabled && sessionMemoryDisabled) {
      addCheck("openclaw.json", true, "ok");
    } else {
      const issues: string[] = [];
      if (slotValue !== "zettelclaw") {
        issues.push(`plugins.slots.memory=${slotValue ? `"${slotValue}"` : "missing"}`);
      }
      if (!memoryFlushDisabled) {
        if (isObject(memoryFlush)) {
          issues.push(`memoryFlush.enabled=${String(memoryFlush.enabled)}`);
        } else {
          issues.push("memoryFlush missing");
        }
      }
      if (!sessionMemoryDisabled) {
        issues.push("hooks.internal.entries.session-memory.enabled is not false");
      }
      addCheck("openclaw.json", false, issues.join("; "));
    }
  } catch (error) {
    const detail = isEnoent(error) ? "missing" : `invalid JSON or unreadable: ${String(error)}`;
    addCheck("openclaw.json", false, detail);
  }

  // AGENTS.md zettelclaw guidance markers
  try {
    const agentsContent = await readFile(paths.agentsMdPath, "utf8");
    const hasGuidanceMarkers =
      agentsContent.includes(AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER) &&
      agentsContent.includes(AGENTS_MEMORY_GUIDANCE_END_MARKER);
    addCheck(
      "AGENTS.md",
      hasGuidanceMarkers,
      hasGuidanceMarkers ? "ok" : "missing zettelclaw guidance markers",
    );
  } catch (error) {
    addCheck("AGENTS.md", false, isEnoent(error) ? "missing" : String(error));
  }

  // MEMORY.md markers + zettelclaw notice
  try {
    const memoryContent = await readFile(paths.memoryMdPath, "utf8");
    const hasBriefingMarkers =
      memoryContent.includes(BRIEFING_BEGIN_MARKER) && memoryContent.includes(BRIEFING_END_MARKER);
    const hasHandoffMarkers =
      memoryContent.includes(LAST_HANDOFF_BEGIN_MARKER) &&
      memoryContent.includes(LAST_HANDOFF_END_MARKER);
    const hasNoticeMarkers =
      memoryContent.includes(MEMORY_NOTICE_BEGIN_MARKER) &&
      memoryContent.includes(MEMORY_NOTICE_END_MARKER);

    if (hasBriefingMarkers && hasHandoffMarkers && hasNoticeMarkers) {
      addCheck("MEMORY.md", true, "ok");
    } else {
      const issues: string[] = [];
      if (!hasBriefingMarkers) {
        issues.push("missing generated memory snapshot markers");
      }
      if (!hasHandoffMarkers) {
        issues.push("missing last handoff markers");
      }
      if (!hasNoticeMarkers) {
        issues.push("missing zettelclaw memory notice");
      }
      addCheck("MEMORY.md", false, issues.join("; "));
    }
  } catch (error) {
    addCheck("MEMORY.md", false, isEnoent(error) ? "missing" : String(error));
  }

  // briefing cron
  try {
    const doc = await readCronJobsDocument(paths.cronJobsPath);
    const briefingJob = doc.jobs.find((job) => readCronJobName(job) === BRIEFING_CRON_NAME);
    if (!briefingJob) {
      addCheck(`cron:${BRIEFING_CRON_NAME}`, false, "missing");
    } else {
      const enabled = briefingJob.enabled === true;
      addCheck(`cron:${BRIEFING_CRON_NAME}`, enabled, enabled ? "ok" : "disabled");
    }
  } catch (error) {
    addCheck(`cron:${BRIEFING_CRON_NAME}`, false, String(error));
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    paths,
  };
}

export async function runVerify(config: PluginConfig, workspaceDir?: string): Promise<VerifyResult> {
  const result = await verifySetup(config, workspaceDir);

  for (const check of result.checks) {
    console.log(`${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`);
  }

  if (!result.ok) {
    throw new Error("Zettelclaw verify failed");
  }

  console.log("Zettelclaw verify passed.");
  console.log(`Log directory: ${result.paths.logDir}`);
  return result;
}

function registerZettelclawCliCommands(
  program: unknown,
  config: PluginConfig,
  api: OpenClawPluginApi,
  workspaceDir?: string,
): void {
  const root = program as CommandLike;
  const zettelclaw = root.command("zettelclaw").description("Zettelclaw memory management");
  registerSetupCommands(zettelclaw, {
    config,
    workspaceDir,
    runInit,
    runUninstall,
    runVerify,
  });
  registerLogCommands(zettelclaw, {
    config,
    workspaceDir,
  });
  registerImportCommands(zettelclaw, {
    config,
    api,
    workspaceDir,
  });
  registerSubjectCommands(zettelclaw, {
    config,
    workspaceDir,
  });
  registerBriefingCommands(zettelclaw, {
    config,
    api,
    workspaceDir,
  });
}

export function registerZettelclawCli(
  api: OpenClawPluginApi,
  config: PluginConfig,
): void {
  api.registerCli(
    ({ program, workspaceDir }) => {
      registerZettelclawCliCommands(program, config, api, workspaceDir);
    },
    { commands: ["zettelclaw"] },
  );
}

export { detectImportSources };
export { queueImportJob, resumeImportJobs, runImportCommand, runImportWorker, stopImportJobs } from "./import-ops";

export const __cliTestExports = {
  resolvePaths,
  buildTraceReport,
  resolveImportPathForPlatform,
  normalizeCliInputPath,
  parseInteractiveImportJobs,
};
