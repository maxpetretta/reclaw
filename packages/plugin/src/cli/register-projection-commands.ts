import { intro as clackIntro, log as clackLog, outro as clackOutro, spinner as clackSpinner } from "@clack/prompts";
import type { PluginConfig } from "../config";
import {
  listSubjectProjectionFiles,
  refreshSubjectProjections,
} from "../projections/subjects";
import type { CommandLike } from "./command-like";
import { resolvePaths } from "./paths";

const BANNER = "🦞 Reclaw - Long-term memory for your Claw";

export async function runProjectionRefresh(params: {
  config: PluginConfig;
  workspaceDir?: string;
  subject?: string;
}): Promise<Awaited<ReturnType<typeof refreshSubjectProjections>>> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  return await refreshSubjectProjections({
    projectionDir: paths.projectionDir,
    logPath: paths.logPath,
    subjectsPath: paths.subjectsPath,
    ...(params.subject ? { subjects: [params.subject] } : {}),
  });
}

export async function printProjectionList(params: {
  config: PluginConfig;
  workspaceDir?: string;
}): Promise<void> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const files = await listSubjectProjectionFiles(paths.projectionDir);
  if (files.length === 0) {
    console.log("No subject projection files.");
    return;
  }

  for (const file of files) {
    console.log(`${file.slug}  ${file.path}`);
  }
}

export function registerProjectionCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
): void {
  const projection = reclaw.command("projection").description("Subject markdown projection helpers");

  const runRefreshAction = async (subject: unknown): Promise<void> => {
    clackIntro(BANNER);
    const spin = clackSpinner();
    spin.start("Refreshing subject projections...");
    const result = await runProjectionRefresh({
      config: params.config,
      workspaceDir: params.workspaceDir,
      subject: typeof subject === "string" && subject.trim().length > 0 ? subject.trim() : undefined,
    });
    spin.stop(`Subject projections refreshed: ${result.refreshedSubjects.length}`);
    if (result.removedSubjects.length > 0) {
      clackLog.step(`Removed stale projections: ${result.removedSubjects.join(", ")}`);
    }
    clackOutro(`Projection directory: ${result.projectionDir}`);
  };

  projection
    .command("refresh [subject]")
    .description("Refresh all subject projection markdown files, or one subject when provided")
    .action(runRefreshAction);

  projection
    .command("list")
    .description("List generated subject projection files")
    .action(async () => {
      await printProjectionList({
        config: params.config,
        workspaceDir: params.workspaceDir,
      });
    });
}
