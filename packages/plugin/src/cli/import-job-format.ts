import type { ImportJobProgressState, ImportJobState } from "../state";

function clampProgress(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > total) {
    return total;
  }

  return value;
}

function buildProgressFromSummary(job: ImportJobState): ImportJobProgressState | undefined {
  if (!job.summary) {
    return undefined;
  }

  return {
    total: job.summary.selected,
    completed: job.summary.imported + job.summary.failed,
    imported: job.summary.imported,
    failed: job.summary.failed,
    entriesWritten: job.summary.entriesWritten,
    subjectsCreated: job.summary.subjectsCreated,
  };
}

function resolveImportJobProgress(job: ImportJobState): ImportJobProgressState | undefined {
  const fromSummary = buildProgressFromSummary(job);
  const source = job.progress ?? fromSummary;
  if (!source) {
    return undefined;
  }

  const total = Math.max(0, source.total);
  const completed = clampProgress(source.completed, total);

  return {
    total,
    completed,
    imported: Math.max(0, source.imported),
    failed: Math.max(0, source.failed),
    entriesWritten: Math.max(0, source.entriesWritten),
    subjectsCreated: Math.max(0, source.subjectsCreated),
  };
}

function formatImportProgress(progress: ImportJobProgressState): string {
  const percentage = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return `${progress.completed}/${progress.total} (${percentage}%)`;
}

export function formatImportJobLine(job: ImportJobState): string {
  const pieces = [
    `${job.id}`,
    `status=${job.status}`,
    `platform=${job.platform}`,
    `attempts=${job.attempts}`,
    `updated=${job.updatedAt}`,
  ];
  const progress = resolveImportJobProgress(job);

  if (progress) {
    pieces.push(
      `progress=${formatImportProgress(progress)}`,
      `events=${progress.entriesWritten}`,
      `subjects=${progress.subjectsCreated}`,
    );
  }

  if (job.error) {
    pieces.push(`error=${job.error}`);
  }

  return pieces.join(" | ");
}

export function formatImportJobStatusDetail(job: ImportJobState): string {
  const lines = [
    `status=${job.status}`,
    `platform=${job.platform}`,
    `attempts=${job.attempts}`,
    `updated=${job.updatedAt}`,
  ];

  const progress = resolveImportJobProgress(job);
  if (progress) {
    lines.push(
      `progress=${formatImportProgress(progress)}`,
      `events=${progress.entriesWritten}`,
      `subjects=${progress.subjectsCreated}`,
    );
  }

  lines.push(`source=${job.filePath}`);

  if (job.error) {
    lines.push(`error=${job.error}`);
  }

  return lines.join(" | ");
}
