import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createEmptyState, writeState } from "../state";

export interface StoreFilesPaths {
  logDir: string;
  logPath: string;
  subjectsPath: string;
  statePath: string;
}

async function ensureTextFile(path: string, defaultContent: string): Promise<void> {
  try {
    await readFile(path, "utf8");
  } catch {
    await writeFile(path, defaultContent, "utf8");
  }
}

export async function ensureStoreFiles(paths: StoreFilesPaths): Promise<void> {
  await mkdir(paths.logDir, { recursive: true });

  await ensureTextFile(paths.logPath, "");
  await ensureTextFile(paths.subjectsPath, "{}\n");

  try {
    await readFile(paths.statePath, "utf8");
  } catch {
    await writeState(paths.statePath, createEmptyState());
  }
}
