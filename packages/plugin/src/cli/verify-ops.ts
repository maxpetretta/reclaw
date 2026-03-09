import { readFile, stat } from "node:fs/promises";
import { log as clackLog } from "@clack/prompts";
import type { PluginConfig } from "../config";
import { isEnoent, isObject } from "../lib/guards";
import { listQmdCollections, RECLAW_QMD_COLLECTION_NAME } from "../lib/qmd";
import {
  AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER,
  AGENTS_MEMORY_GUIDANCE_END_MARKER,
  BRIEFING_BEGIN_MARKER,
  BRIEFING_END_MARKER,
  LAST_SESSION_SUMMARY_BEGIN_MARKER,
  LAST_SESSION_SUMMARY_END_MARKER,
  MEMORY_NOTICE_BEGIN_MARKER,
  MEMORY_NOTICE_END_MARKER,
} from "../memory/markers";
import {
  readCronJobName,
  readCronJobsDocument,
} from "../lib/cron-jobs-store";
import { toObject } from "./parse";
import { type InitPaths, resolvePaths } from "./paths";
import { BRIEFING_CRON_NAME } from "./setup-ops";

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  paths: InitPaths;
}

function summarizeQmdIssue(message: string | undefined, missingBinary: boolean | undefined): string {
  if (missingBinary) {
    return "qmd not installed";
  }

  if (!message) {
    return "qmd unavailable";
  }

  if (message.includes("ERR_DLOPEN_FAILED") || message.includes("better_sqlite3.node")) {
    return "QMD native module failed to load; reinstall QMD for the current Node version";
  }

  const firstLine = message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? "qmd unavailable";
}

export async function verifySetup(config: PluginConfig, workspaceDir?: string): Promise<VerifyResult> {
  const paths = resolvePaths(config, workspaceDir);
  const checks: VerifyCheck[] = [];
  const addCheck = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  try {
    await readFile(paths.logPath, "utf8");
    addCheck("log.jsonl", true, "ok");
  } catch (error) {
    addCheck("log.jsonl", false, isEnoent(error) ? "missing" : String(error));
  }

  try {
    const subjectsRaw = await readFile(paths.subjectsPath, "utf8");
    const parsed = JSON.parse(subjectsRaw) as unknown;
    addCheck("subjects.json", isObject(parsed), isObject(parsed) ? "ok" : "expected JSON object");
  } catch (error) {
    const detail = isEnoent(error) ? "missing" : `invalid JSON or unreadable: ${String(error)}`;
    addCheck("subjects.json", false, detail);
  }

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

  try {
    const configRaw = await readFile(paths.openClawConfigPath, "utf8");
    const parsed = JSON.parse(configRaw) as unknown;
    const configRoot = toObject(parsed);
    const plugins = toObject(configRoot.plugins);
    const slots = toObject(plugins.slots);
    const slotValue = typeof slots.memory === "string" ? slots.memory : undefined;

    const agents = toObject(configRoot.agents);
    const defaults = toObject(agents.defaults);
    const memorySearch = toObject(defaults.memorySearch);
    const extraPaths = Array.isArray(memorySearch.extraPaths)
      ? memorySearch.extraPaths.filter((entry): entry is string => typeof entry === "string")
      : [];
    const compaction = toObject(defaults.compaction);
    const memoryFlush = compaction.memoryFlush;
    const memoryFlushDisabled = isObject(memoryFlush) && memoryFlush.enabled === false;
    const session = toObject(configRoot.session);
    const maintenance = toObject(session.maintenance);
    const pruneDisabled = maintenance.pruneAfter === "36500d";
    const maxEntriesHigh = typeof maintenance.maxEntries === "number" && maintenance.maxEntries >= 100_000;
    const resetArchiveDisabled = maintenance.resetArchiveRetention === false;
    const hooks = toObject(configRoot.hooks);
    const internalHooks = toObject(hooks.internal);
    const hookEntries = toObject(internalHooks.entries);
    const sessionMemoryHook = toObject(hookEntries["session-memory"]);
    const sessionMemoryDisabled = sessionMemoryHook.enabled === false;
    const hasProjectionMemoryPath = extraPaths.includes(paths.projectionDir);
    const hasSessionSummaryProjectionPath = extraPaths.includes(paths.sessionSummaryProjectionDir);

    if (
      slotValue === "reclaw" &&
      memoryFlushDisabled &&
      sessionMemoryDisabled &&
      pruneDisabled &&
      maxEntriesHigh &&
      resetArchiveDisabled &&
      hasProjectionMemoryPath &&
      hasSessionSummaryProjectionPath
    ) {
      addCheck("openclaw.json", true, "ok");
    } else {
      const issues: string[] = [];
      if (slotValue !== "reclaw") {
        issues.push(`plugins.slots.memory=${slotValue ? `"${slotValue}"` : "missing"}`);
      }
      if (!memoryFlushDisabled) {
        if (isObject(memoryFlush)) {
          issues.push(`memoryFlush.enabled=${String(memoryFlush.enabled)}`);
        } else {
          issues.push("memoryFlush missing");
        }
      }
      if (!pruneDisabled) {
        issues.push("session.maintenance.pruneAfter is not \"36500d\" (sessions will be pruned)");
      }
      if (!maxEntriesHigh) {
        issues.push("session.maintenance.maxEntries is below 100000 (sessions will be capped)");
      }
      if (!resetArchiveDisabled) {
        issues.push("session.maintenance.resetArchiveRetention is not false (reset archives will be deleted)");
      }
      if (!sessionMemoryDisabled) {
        issues.push("hooks.internal.entries.session-memory.enabled is not false");
      }
      if (!hasProjectionMemoryPath) {
        issues.push(`agents.defaults.memorySearch.extraPaths is missing "${paths.projectionDir}"`);
      }
      if (!hasSessionSummaryProjectionPath) {
        issues.push(`agents.defaults.memorySearch.extraPaths is missing "${paths.sessionSummaryProjectionDir}"`);
      }
      addCheck("openclaw.json", false, issues.join("; "));
    }
  } catch (error) {
    const detail = isEnoent(error) ? "missing" : `invalid JSON or unreadable: ${String(error)}`;
    addCheck("openclaw.json", false, detail);
  }

  try {
    const agentsContent = await readFile(paths.agentsMdPath, "utf8");
    const hasGuidanceMarkers =
      agentsContent.includes(AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER) &&
      agentsContent.includes(AGENTS_MEMORY_GUIDANCE_END_MARKER);
    addCheck(
      "AGENTS.md",
      hasGuidanceMarkers,
      hasGuidanceMarkers ? "ok" : "missing reclaw guidance markers",
    );
  } catch (error) {
    addCheck("AGENTS.md", false, isEnoent(error) ? "missing" : String(error));
  }

  try {
    const memoryContent = await readFile(paths.memoryMdPath, "utf8");
    const hasBriefingMarkers =
      memoryContent.includes(BRIEFING_BEGIN_MARKER) && memoryContent.includes(BRIEFING_END_MARKER);
    const hasSessionSummaryMarkers =
      memoryContent.includes(LAST_SESSION_SUMMARY_BEGIN_MARKER) &&
      memoryContent.includes(LAST_SESSION_SUMMARY_END_MARKER);
    const hasNoticeMarkers =
      memoryContent.includes(MEMORY_NOTICE_BEGIN_MARKER) &&
      memoryContent.includes(MEMORY_NOTICE_END_MARKER);

    if (hasBriefingMarkers && hasSessionSummaryMarkers && hasNoticeMarkers) {
      addCheck("MEMORY.md", true, "ok");
    } else {
      const issues: string[] = [];
      if (!hasBriefingMarkers) {
        issues.push("missing generated memory snapshot markers");
      }
      if (!hasSessionSummaryMarkers) {
        issues.push("missing reclaw session summary markers");
      }
      if (!hasNoticeMarkers) {
        issues.push("missing reclaw memory notice");
      }
      addCheck("MEMORY.md", false, issues.join("; "));
    }
  } catch (error) {
    addCheck("MEMORY.md", false, isEnoent(error) ? "missing" : String(error));
  }

  try {
    const projectionDirStat = await stat(paths.projectionDir);
    addCheck(
      "reclaw projection dir",
      projectionDirStat.isDirectory(),
      projectionDirStat.isDirectory() ? "ok" : "not a directory",
    );
  } catch (error) {
    addCheck("reclaw projection dir", false, isEnoent(error) ? "missing" : String(error));
  }

  try {
    const projectionDirStat = await stat(paths.sessionSummaryProjectionDir);
    addCheck(
      "reclaw session summary projection dir",
      projectionDirStat.isDirectory(),
      projectionDirStat.isDirectory() ? "ok" : "not a directory",
    );
  } catch (error) {
    addCheck("reclaw session summary projection dir", false, isEnoent(error) ? "missing" : String(error));
  }

  const qmdCollections = listQmdCollections();
  if (!qmdCollections.ok) {
    addCheck(`qmd:${RECLAW_QMD_COLLECTION_NAME}`, false, summarizeQmdIssue(qmdCollections.message, qmdCollections.missingBinary));
  } else {
    const hasReclawCollection = qmdCollections.names.includes(RECLAW_QMD_COLLECTION_NAME);
    addCheck(
      `qmd:${RECLAW_QMD_COLLECTION_NAME}`,
      hasReclawCollection,
      hasReclawCollection ? "ok" : `missing collection "${RECLAW_QMD_COLLECTION_NAME}"`,
    );
  }

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

  clackLog.message(
    result.checks
      .map((check) => `${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`)
      .join("\n"),
  );

  if (!result.ok) {
    throw new Error("Reclaw verify failed");
  }

  return result;
}
