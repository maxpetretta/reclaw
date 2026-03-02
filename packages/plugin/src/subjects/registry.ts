import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { escapeRegex, isEnoent, isNonEmptyString, isObject } from "../lib/guards";
import { normalizeSubjectType, parseSubjectType, type SubjectType } from "../log/schema";

export interface Subject {
  display: string;
  type: SubjectType;
}

export type SubjectRegistry = Record<string, Subject>;


function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug);
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

  registry[normalizedSlug] = {
    display: slugToDisplay(normalizedSlug),
    type: normalizeSubjectType(inferredType),
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

  if (!existing) {
    registry[normalizedSlug] = {
      display: slugToDisplay(normalizedSlug),
      type: normalizeSubjectType(inferredType),
    };
    await writeRegistry(path, registry);
    return;
  }

  if (!hintedType || existing.type === hintedType) {
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
