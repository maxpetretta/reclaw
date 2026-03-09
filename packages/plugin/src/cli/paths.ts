import { join } from "node:path";
import type { PluginConfig } from "../config";
import { resolveOpenClawHome } from "../lib/runtime-env";
import { SESSION_SUMMARY_PROJECTION_DIRNAME } from "../projections/session-summaries";
import { SUBJECT_PROJECTION_DIRNAME } from "../projections/subjects";

export interface InitPaths {
  logDir: string;
  logPath: string;
  subjectsPath: string;
  statePath: string;
  cronJobsPath: string;
  openClawConfigPath: string;
  agentsMdPath: string;
  memoryMdPath: string;
  projectionDir: string;
  sessionSummaryProjectionDir: string;
}

export function resolvePaths(config: PluginConfig, workspaceDir?: string): InitPaths {
  const openClawHome = resolveOpenClawHome();
  const resolvedWorkspaceDir = workspaceDir?.trim() || process.cwd();
  const projectionDir = join(config.logDir, SUBJECT_PROJECTION_DIRNAME);
  const sessionSummaryProjectionDir = join(config.logDir, SESSION_SUMMARY_PROJECTION_DIRNAME);

  return {
    logDir: config.logDir,
    logPath: join(config.logDir, "log.jsonl"),
    subjectsPath: join(config.logDir, "subjects.json"),
    statePath: join(config.logDir, "state.json"),
    cronJobsPath: join(openClawHome, "cron", "jobs.json"),
    openClawConfigPath: join(openClawHome, "openclaw.json"),
    agentsMdPath: join(resolvedWorkspaceDir, "AGENTS.md"),
    memoryMdPath: join(resolvedWorkspaceDir, "MEMORY.md"),
    projectionDir,
    sessionSummaryProjectionDir,
  };
}
