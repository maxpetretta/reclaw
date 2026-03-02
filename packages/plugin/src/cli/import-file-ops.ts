import { cp, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isEnoent } from "../lib/guards";
import { ensureStoreFiles } from "../store/files";
import type { InitPaths } from "./paths";

export function isDirectoryErrorMessage(path: string): string {
  return `openclaw import path must be a directory: ${path}`;
}

export async function assertDirectory(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) {
    throw new Error(isDirectoryErrorMessage(path));
  }
}

function buildTimestampSuffix(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export async function backupDirectoryWithTimestamp(sourceDir: string): Promise<string> {
  await assertDirectory(sourceDir);
  const backupPath = `${sourceDir}.backup-${buildTimestampSuffix()}`;
  await cp(sourceDir, backupPath, {
    recursive: true,
    errorOnExist: true,
  });
  return backupPath;
}

export async function clearDirectoryContents(directory: string): Promise<void> {
  await assertDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry.name);
      await rm(absolutePath, { recursive: true, force: true });
    }),
  );
}

async function chooseFileBackupPath(sourcePath: string): Promise<string> {
  const sourceName = basename(sourcePath);
  const sourceDir = dirname(sourcePath);

  for (let index = 0; index < 10_000; index += 1) {
    const label = index === 0 ? `${sourceName}.bak` : `${sourceName}.bak.${index}`;
    const backupPath = join(sourceDir, label);
    try {
      await stat(backupPath);
    } catch (error) {
      if (isEnoent(error)) {
        return backupPath;
      }
      throw error;
    }
  }

  throw new Error(`Could not find an available backup path for ${sourcePath}`);
}

export async function backupFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) {
      return undefined;
    }
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }

  const backupPath = await chooseFileBackupPath(filePath);
  await cp(filePath, backupPath, {
    errorOnExist: true,
  });
  return backupPath;
}

export async function ensureImportStoreFiles(paths: InitPaths, statePath: string): Promise<void> {
  await ensureStoreFiles({
    logDir: paths.logDir,
    logPath: paths.logPath,
    subjectsPath: paths.subjectsPath,
    statePath,
  });
}
