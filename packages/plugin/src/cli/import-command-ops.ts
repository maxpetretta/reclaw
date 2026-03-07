import { dirname, join } from "node:path";
import type { PluginConfig } from "../config";
import {
  DEFAULT_IMPORT_JOBS,
  DEFAULT_IMPORT_MIN_MESSAGES,
  DEFAULT_IMPORT_MODEL,
  type ReclawImportProgress,
  type ReclawImportSummary,
  runReclawImport,
} from "../import/run";
import type { ImportPlatform } from "../import/types";
import { readGatewayToken, resolveApiBaseUrlFromConfig, resolveOpenClawHome } from "../lib/runtime-env";
import type { InitPaths } from "./paths";
import { resolvePaths } from "./paths";
import {
  assertDirectory,
  backupDirectoryWithTimestamp,
  backupFileIfExists,
  clearDirectoryContents,
  ensureImportStoreFiles,
} from "./import-file-ops";
import { readNumberOption, toObject } from "./import-job-options";
import { refreshSubjectProjections } from "../projections/subjects";

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

  if (!dryRun) {
    try {
      await refreshSubjectProjections({
        projectionDir: paths.projectionDir,
        logPath: paths.logPath,
        subjectsPath: paths.subjectsPath,
      });
    } catch (error) {
      input.logger?.warn?.(
        `projection refresh failed after import: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

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
