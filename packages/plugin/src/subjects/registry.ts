import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeSubjectType, parseSubjectType, type SubjectType } from "../log/schema";

export interface Subject {
  display: string;
  type: SubjectType;
}

export type SubjectRegistry = Record<string, Subject>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug);
}

const LIKELY_FIRST_NAME_TOKENS = new Set([
  "adam",
  "alex",
  "andrew",
  "anthony",
  "ben",
  "brandon",
  "brian",
  "chris",
  "dan",
  "david",
  "eric",
  "ethan",
  "evan",
  "jack",
  "jake",
  "james",
  "jason",
  "jeremy",
  "john",
  "jon",
  "jordan",
  "josh",
  "justin",
  "kevin",
  "kyle",
  "mark",
  "max",
  "matt",
  "michael",
  "mike",
  "nick",
  "noah",
  "patrick",
  "paul",
  "peter",
  "ryan",
  "sam",
  "scott",
  "steve",
  "thomas",
  "tim",
  "tyler",
  "will",
  "zach",
]);

const NON_PERSON_TRAILING_TOKENS = new Set([
  "agent",
  "analysis",
  "api",
  "app",
  "benchmark",
  "bot",
  "cli",
  "client",
  "code",
  "dashboard",
  "export",
  "hook",
  "import",
  "memory",
  "model",
  "pipeline",
  "platform",
  "plugin",
  "project",
  "report",
  "research",
  "sdk",
  "search",
  "server",
  "service",
  "shell",
  "system",
  "task",
  "test",
  "tool",
  "workflow",
]);

function inferSubjectTypeFromSlug(slug: string): SubjectType | undefined {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!isValidSlug(normalizedSlug)) {
    return undefined;
  }

  const tokens = normalizedSlug.split("-");
  if (tokens.length < 2 || tokens.length > 3) {
    return undefined;
  }

  const [firstToken, ...trailingTokens] = tokens;
  if (!LIKELY_FIRST_NAME_TOKENS.has(firstToken)) {
    return undefined;
  }

  const hasInvalidTrailingToken = trailingTokens.some(
    (token) =>
      !/^[a-z]+$/u.test(token) ||
      token.length < 2 ||
      NON_PERSON_TRAILING_TOKENS.has(token),
  );

  if (hasInvalidTrailingToken) {
    return undefined;
  }

  return "person";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRegistry(raw: unknown): SubjectRegistry {
  if (!isObject(raw)) {
    return {};
  }

  const normalized: SubjectRegistry = {};

  for (const [slug, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      continue;
    }

    if (!isNonEmptyString(value.display)) {
      continue;
    }

    normalized[slug] = {
      display: value.display,
      type: normalizeSubjectType(value.type),
    };
  }

  return normalized;
}

export function slugToDisplay(slug: string): string {
  return slug
    .split(/[-_]+/g)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

export async function readRegistry(path: string): Promise<SubjectRegistry> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return {};
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  return normalizeRegistry(parsed);
}

export async function writeRegistry(path: string, registry: SubjectRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export async function ensureSubject(
  path: string,
  slug: string,
  inferredType?: string,
): Promise<void> {
  const normalizedSlug = typeof slug === "string" ? slug.trim() : "";
  if (!isNonEmptyString(normalizedSlug)) {
    throw new Error("slug must be a non-empty string");
  }
  if (!isValidSlug(normalizedSlug)) {
    throw new Error(`invalid slug "${normalizedSlug}" (expected lowercase kebab-case)`);
  }

  const registry = await readRegistry(path);
  if (registry[normalizedSlug]) {
    return;
  }

  const hintedType = parseSubjectType(inferredType);
  const inferredFromSlug = inferSubjectTypeFromSlug(normalizedSlug);
  registry[normalizedSlug] = {
    display: slugToDisplay(normalizedSlug),
    type: hintedType ?? inferredFromSlug ?? normalizeSubjectType(inferredType),
  };

  await writeRegistry(path, registry);
}

export async function upsertSubjectFromExtraction(
  path: string,
  slug: string,
  inferredType?: string,
): Promise<void> {
  const normalizedSlug = typeof slug === "string" ? slug.trim() : "";
  if (!isNonEmptyString(normalizedSlug)) {
    throw new Error("slug must be a non-empty string");
  }
  if (!isValidSlug(normalizedSlug)) {
    throw new Error(`invalid slug "${normalizedSlug}" (expected lowercase kebab-case)`);
  }

  const registry = await readRegistry(path);
  const existing = registry[normalizedSlug];
  const hintedType = parseSubjectType(inferredType);
  const inferredFromSlug = inferSubjectTypeFromSlug(normalizedSlug);

  if (!existing) {
    registry[normalizedSlug] = {
      display: slugToDisplay(normalizedSlug),
      type: hintedType ?? inferredFromSlug ?? normalizeSubjectType(inferredType),
    };
    await writeRegistry(path, registry);
    return;
  }

  if (!hintedType) {
    if (!inferredFromSlug || existing.type === inferredFromSlug) {
      return;
    }

    registry[normalizedSlug] = {
      ...existing,
      type: inferredFromSlug,
    };
    await writeRegistry(path, registry);
    return;
  }

  if (existing.type === hintedType) {
    return;
  }

  registry[normalizedSlug] = {
    ...existing,
    type: hintedType,
  };
  await writeRegistry(path, registry);
}

export async function renameSubject(
  registryPath: string,
  logPath: string,
  oldSlug: string,
  newSlug: string,
): Promise<void> {
  const normalizedOldSlug = typeof oldSlug === "string" ? oldSlug.trim() : "";
  const normalizedNewSlug = typeof newSlug === "string" ? newSlug.trim() : "";

  if (!isNonEmptyString(normalizedOldSlug) || !isNonEmptyString(normalizedNewSlug)) {
    throw new Error("oldSlug and newSlug must be non-empty strings");
  }
  if (!isValidSlug(normalizedNewSlug)) {
    throw new Error(`invalid slug "${normalizedNewSlug}" (expected lowercase kebab-case)`);
  }

  if (normalizedOldSlug === normalizedNewSlug) {
    return;
  }

  const registry = await readRegistry(registryPath);
  let registryChanged = false;

  const oldSubject = registry[normalizedOldSlug];
  if (oldSubject) {
    if (!registry[normalizedNewSlug]) {
      registry[normalizedNewSlug] = oldSubject;
    }

    delete registry[normalizedOldSlug];
    registryChanged = true;
  }

  if (registryChanged) {
    await writeRegistry(registryPath, registry);
  }

  let logContent: string;
  try {
    logContent = await readFile(logPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }

    throw error;
  }

  const pattern = new RegExp(`(\\"subject\\"\\s*:\\s*\\")${escapeRegex(normalizedOldSlug)}(\\")`, "g");
  const updated = logContent.replace(pattern, `$1${normalizedNewSlug}$2`);

  if (updated !== logContent) {
    await writeFile(logPath, updated, "utf8");
  }
}
