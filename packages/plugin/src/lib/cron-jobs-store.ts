import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoent, isObject } from "./guards";

export interface CronJobsDocument {
  version: number;
  jobs: Array<Record<string, unknown>>;
}

export function normalizeCronJobsDocument(raw: unknown): CronJobsDocument {
  if (!isObject(raw)) {
    return { version: 1, jobs: [] };
  }

  const version = typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : 1;
  const jobs = Array.isArray(raw.jobs)
    ? raw.jobs.filter((job): job is Record<string, unknown> => isObject(job))
    : [];

  return { version, jobs };
}

export async function readCronJobsDocument(cronJobsPath: string): Promise<CronJobsDocument> {
  try {
    const raw = await readFile(cronJobsPath, "utf8");
    return normalizeCronJobsDocument(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isEnoent(error)) {
      return { version: 1, jobs: [] };
    }

    return { version: 1, jobs: [] };
  }
}

export async function writeCronJobsDocument(cronJobsPath: string, doc: CronJobsDocument): Promise<void> {
  await mkdir(dirname(cronJobsPath), { recursive: true });
  await writeFile(cronJobsPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

export function readCronJobName(job: Record<string, unknown>): string | undefined {
  return typeof job.name === "string" ? job.name : undefined;
}

export async function removeCronJobsByName(cronJobsPath: string, names: readonly string[]): Promise<void> {
  const doc = await readCronJobsDocument(cronJobsPath);
  const filteredJobs = doc.jobs.filter((job) => {
    const name = readCronJobName(job);
    return !name || !names.includes(name);
  });

  if (filteredJobs.length === doc.jobs.length) {
    return;
  }

  await writeCronJobsDocument(cronJobsPath, {
    ...doc,
    jobs: filteredJobs,
  });
}

export async function upsertCronJobByName(
  cronJobsPath: string,
  name: string,
  createJob: (existing?: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const doc = await readCronJobsDocument(cronJobsPath);
  const existingIndex = doc.jobs.findIndex((entry) => readCronJobName(entry) === name);
  const existing = existingIndex >= 0 ? doc.jobs[existingIndex] : undefined;
  const job = createJob(existing);
  const nextJobs = [...doc.jobs];

  if (existingIndex >= 0) {
    nextJobs[existingIndex] = job;
  } else {
    nextJobs.push(job);
  }

  await writeCronJobsDocument(cronJobsPath, {
    ...doc,
    jobs: nextJobs,
  });

  return job;
}

export async function removeCronJobByIdOrName(
  cronJobsPath: string,
  options: { id?: string; name?: string },
): Promise<boolean> {
  const expectedId = options.id?.trim();
  const expectedName = options.name?.trim();
  if (!expectedId && !expectedName) {
    return false;
  }

  const doc = await readCronJobsDocument(cronJobsPath);
  const nextJobs = doc.jobs.filter((entry) => {
    if (expectedId) {
      const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
      if (entryId === expectedId) {
        return false;
      }
    }

    if (expectedName) {
      const entryName = readCronJobName(entry);
      if (entryName && entryName.trim() === expectedName) {
        return false;
      }
    }

    return true;
  });

  if (nextJobs.length === doc.jobs.length) {
    return false;
  }

  await writeCronJobsDocument(cronJobsPath, {
    ...doc,
    jobs: nextJobs,
  });

  return true;
}
