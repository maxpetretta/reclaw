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

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function formatImportJobLine(job: ImportJobState): string {
  const progress = resolveImportJobProgress(job);
  const progressText = progress ? formatImportProgress(progress) : "-";
  const entriesText = progress ? `${progress.entriesWritten} entries` : "";
  const errorText = job.error ? `  error: ${job.error}` : "";

  return `  ${padEnd(job.id, 10)}  ${padEnd(job.status, 10)}  ${padEnd(job.platform, 10)}  ${padEnd(progressText, 14)}  ${entriesText}${errorText}`;
}

export function formatImportJobStatusDetail(job: ImportJobState): string {
  const progress = resolveImportJobProgress(job);
  const lines = [
    `  Job:       ${job.id}`,
    `  Status:    ${job.status}`,
    `  Platform:  ${job.platform}`,
    `  Attempts:  ${job.attempts}`,
    `  Updated:   ${job.updatedAt}`,
    `  Source:    ${job.filePath}`,
  ];

  if (progress) {
    lines.push(
      `  Progress:  ${formatImportProgress(progress)}`,
      `  Entries:   ${progress.entriesWritten}`,
      `  Subjects:  ${progress.subjectsCreated}`,
    );
  }

  if (job.error) {
    lines.push(`  Error:     ${job.error}`);
  }

  return lines.join("\n");
}
