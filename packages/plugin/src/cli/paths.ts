import { join } from "node:path";
import type { PluginConfig } from "../config";
import { resolveOpenClawHome } from "../lib/runtime-env";
import { SUBJECT_PROJECTION_ROOT_DIRNAME, SUBJECT_PROJECTION_SUBDIR } from "../projections/subjects";

export interface InitPaths {
  logDir: string;
  logPath: string;
  subjectsPath: string;
  statePath: string;
  cronJobsPath: string;
  openClawConfigPath: string;
  agentsMdPath: string;
  memoryMdPath: string;
  projectionRootDir: string;
  subjectProjectionDir: string;
}

export function resolvePaths(config: PluginConfig, workspaceDir?: string): InitPaths {
  const openClawHome = resolveOpenClawHome();
  const resolvedWorkspaceDir = workspaceDir?.trim() || process.cwd();
  const projectionRootDir = join(resolvedWorkspaceDir, SUBJECT_PROJECTION_ROOT_DIRNAME);

  return {
    logDir: config.logDir,
    logPath: join(config.logDir, "log.jsonl"),
    subjectsPath: join(config.logDir, "subjects.json"),
    statePath: join(config.logDir, "state.json"),
    cronJobsPath: join(openClawHome, "cron", "jobs.json"),
    openClawConfigPath: join(openClawHome, "openclaw.json"),
    agentsMdPath: join(resolvedWorkspaceDir, "AGENTS.md"),
    memoryMdPath: join(resolvedWorkspaceDir, "MEMORY.md"),
    projectionRootDir,
    subjectProjectionDir: join(projectionRootDir, SUBJECT_PROJECTION_SUBDIR),
  };
}
