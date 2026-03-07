import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoent } from "../lib/guards";
import { normalizeState } from "../state-normalize";
import { createEmptyState, type ReclawState } from "./types";

export async function readState(path: string): Promise<ReclawState> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return createEmptyState();
    }

    throw error;
  }

  return normalizeState(JSON.parse(raw), createEmptyState);
}

export async function writeState(path: string, state: ReclawState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function updateState(
  path: string,
  mutator: (state: ReclawState) => void | Promise<void>,
): Promise<ReclawState> {
  const state = await readState(path);
  await mutator(state);
  await writeState(path, state);
  return state;
}

export async function pruneState(path: string, maxAgeDays = 30): Promise<void> {
  await updateState(path, (state) => {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    for (const [sessionId, extracted] of Object.entries(state.extractedSessions)) {
      if (!Number.isFinite(Date.parse(extracted.at)) || Date.parse(extracted.at) < cutoff) {
        delete state.extractedSessions[sessionId];
      }
    }

    for (const [sessionId, failed] of Object.entries(state.failedSessions)) {
      if (!Number.isFinite(Date.parse(failed.at)) || Date.parse(failed.at) < cutoff) {
        delete state.failedSessions[sessionId];
      }
    }

    for (const [sessionId, compaction] of Object.entries(state.compactionSessions)) {
      if (!Number.isFinite(Date.parse(compaction.at)) || Date.parse(compaction.at) < cutoff) {
        delete state.compactionSessions[sessionId];
      }
    }

    state.snapshotRuns = state.snapshotRuns.filter((run) =>
      Number.isFinite(Date.parse(run.at)) && Date.parse(run.at) >= cutoff,
    );
  });
}
