import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isObject } from "../lib/guards";
import { resolveOpenClawHome } from "../lib/runtime-env";
import { parseSessionIdFromTranscriptFileName } from "../lib/transcript";

export interface SessionCandidate {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
}

function parseSessionStoreCandidates(
  rawStore: unknown,
  agentId: string,
): Array<{ sessionId: string; sessionKey: string }> {
  if (!isObject(rawStore)) {
    return [];
  }

  const candidates: Array<{ sessionId: string; sessionKey: string }> = [];

  for (const [sessionKey, value] of Object.entries(rawStore)) {
    if (!isObject(value)) {
      continue;
    }

    const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
    if (!sessionId) {
      continue;
    }

    const normalizedKey = sessionKey.trim();
    if (normalizedKey.startsWith("agent:")) {
      const parts = normalizedKey.split(":");
      if (parts.length >= 2 && parts[1] && parts[1] !== agentId) {
        continue;
      }
    }

    candidates.push({
      sessionId,
      sessionKey: normalizedKey,
    });
  }

  return candidates;
}

export async function listSessionCandidates(
  openClawHome = resolveOpenClawHome(),
): Promise<SessionCandidate[]> {
  const agentsDir = join(openClawHome, "agents");

  let agentDirs: string[];
  try {
    agentDirs = await readdir(agentsDir);
  } catch {
    return [];
  }

  const discovered = new Set<string>();
  const candidatesByKey = new Map<string, SessionCandidate>();

  for (const agentId of agentDirs) {
    const sessionsDir = join(agentsDir, agentId, "sessions");
    const sessionsStorePath = join(sessionsDir, "sessions.json");

    try {
      const sessionsStoreRaw = await readFile(sessionsStorePath, "utf8");
      const sessionsStore = JSON.parse(sessionsStoreRaw) as unknown;
      const storeCandidates = parseSessionStoreCandidates(sessionsStore, agentId);

      for (const candidate of storeCandidates) {
        const dedupeKey = `${agentId}\u0000${candidate.sessionId}`;
        if (candidatesByKey.has(dedupeKey)) {
          continue;
        }

        candidatesByKey.set(dedupeKey, {
          agentId,
          sessionId: candidate.sessionId,
          sessionKey: candidate.sessionKey,
        });
      }
    } catch {
      // Fall back to transcript file discovery when sessions.json is missing or unreadable.
    }

    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      continue;
    }

    for (const fileName of files) {
      const sessionId = parseSessionIdFromTranscriptFileName(fileName);
      if (!sessionId) {
        continue;
      }

      discovered.add(`${agentId}\u0000${sessionId}`);
    }
  }

  const candidates: SessionCandidate[] = [];
  for (const value of discovered) {
    const [agentId, sessionId] = value.split("\u0000");
    if (!agentId || !sessionId) {
      continue;
    }

    const key = `${agentId}\u0000${sessionId}`;
    const fromStore = candidatesByKey.get(key);
    candidates.push(
      fromStore ?? {
        agentId,
        sessionId,
      },
    );
  }

  for (const [dedupeKey, candidate] of candidatesByKey.entries()) {
    if (discovered.has(dedupeKey)) {
      continue;
    }
    candidates.push(candidate);
  }

  return candidates.sort((left, right) => {
    if (left.agentId !== right.agentId) {
      return left.agentId.localeCompare(right.agentId);
    }

    return left.sessionId.localeCompare(right.sessionId);
  });
}

export async function findSessionKeyForSession(
  agentId: string,
  sessionId: string,
  openClawHome = resolveOpenClawHome(),
): Promise<string | undefined> {
  const sessionsStorePath = join(openClawHome, "agents", agentId, "sessions", "sessions.json");

  let sessionsStoreRaw: string;
  try {
    sessionsStoreRaw = await readFile(sessionsStorePath, "utf8");
  } catch {
    return undefined;
  }

  let parsedStore: unknown;
  try {
    parsedStore = JSON.parse(sessionsStoreRaw);
  } catch {
    return undefined;
  }

  if (!isObject(parsedStore)) {
    return undefined;
  }

  for (const [sessionKey, value] of Object.entries(parsedStore)) {
    if (!isObject(value)) {
      continue;
    }

    if (typeof value.sessionId !== "string" || value.sessionId !== sessionId) {
      continue;
    }

    const normalizedKey = sessionKey.trim();
    return normalizedKey.length > 0 ? normalizedKey : undefined;
  }

  return undefined;
}

function shouldSkipSessionKey(sessionKey: string | undefined, skipPrefixes: string[]): boolean {
  if (!sessionKey) {
    return false;
  }

  return skipPrefixes.some((prefix) => sessionKey.startsWith(prefix));
}

function isMainSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) {
    return false;
  }

  if (/^agent:[^:]+:main(?:$|:)/u.test(sessionKey)) {
    return true;
  }

  if (/^agent:[^:]+$/u.test(sessionKey)) {
    return true;
  }

  if (sessionKey.startsWith("dm:")) {
    return true;
  }

  return false;
}

export function shouldExtractSession(
  sessionKey: string | undefined,
  skipPrefixes: string[],
): boolean {
  if (!sessionKey) {
    return false;
  }

  if (shouldSkipSessionKey(sessionKey, skipPrefixes)) {
    return false;
  }

  return isMainSessionKey(sessionKey);
}
