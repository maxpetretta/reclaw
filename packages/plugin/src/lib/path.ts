import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

export function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return homedir();
  }

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }

  return trimmed;
}

export function normalizeCliInputPath(value: string): string {
  return resolvePath(expandHomePath(value));
}

export function isDailyMemoryFile(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.md$/u.test(fileName);
}
