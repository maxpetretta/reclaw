export function assignDefined<T extends Record<string, unknown>, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function buildWorkerSessionMeta(result: {
  sessionId?: string;
  sessionKey?: string;
}): {
  workerSessionId?: string;
  workerSessionKey?: string;
} {
  const meta: {
    workerSessionId?: string;
    workerSessionKey?: string;
  } = {};

  if (typeof result.sessionId === "string" && result.sessionId.trim().length > 0) {
    meta.workerSessionId = result.sessionId.trim();
  }

  if (typeof result.sessionKey === "string" && result.sessionKey.trim().length > 0) {
    meta.workerSessionKey = result.sessionKey.trim();
  }

  return meta;
}
