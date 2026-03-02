import { readState, updateState, type ImportJobState, type ZettelclawState } from "../state";

function cloneJob(job: ImportJobState): ImportJobState {
  return {
    ...job,
    options: { ...job.options },
    ...(job.summary ? { summary: { ...job.summary } } : {}),
    ...(job.progress ? { progress: { ...job.progress } } : {}),
  };
}

export async function readImportJob(statePath: string, jobId: string): Promise<ImportJobState | undefined> {
  const state = await readState(statePath);
  const job = state.importJobs[jobId];
  return job ? cloneJob(job) : undefined;
}

export async function createImportJob(statePath: string, job: ImportJobState): Promise<ImportJobState> {
  await updateState(statePath, (state) => {
    state.importJobs[job.id] = job;
  });
  return cloneJob(job);
}

export async function updateImportJob(
  statePath: string,
  jobId: string,
  mutator: (job: ImportJobState, state: ZettelclawState) => void,
): Promise<ImportJobState | undefined> {
  let updated: ImportJobState | undefined;

  await updateState(statePath, (state) => {
    const job = state.importJobs[jobId];
    if (!job) {
      return;
    }

    mutator(job, state);
    state.importJobs[jobId] = job;
    updated = cloneJob(job);
  });

  return updated;
}
