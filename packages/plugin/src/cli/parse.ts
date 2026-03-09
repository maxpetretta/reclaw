import { isNonEmptyString, isObject } from "../lib/guards";

export function toObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

export function readOptionalPositiveNumberOption(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return undefined;
}

export function readPositiveNumberOption(value: unknown, fallback: number): number {
  return readOptionalPositiveNumberOption(value) ?? fallback;
}

export function readTrimmedStringOption(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

export function parseIsoDateInput(raw: unknown): string | undefined {
  const trimmed = readTrimmedStringOption(raw);
  if (!trimmed) {
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}
