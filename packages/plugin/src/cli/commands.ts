import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { ensureQmdCollection, installQmdGlobal } from "../lib/qmd";
import type { CommandLike } from "./command-like";
import { detectImportSources } from "./import-detect";
import { registerBriefingCommands } from "./register-briefing-commands";
import { registerImportCommands } from "./register-import-commands";
import { registerLogCommands } from "./register-log-commands";
import { registerProjectionCommands } from "./register-projection-commands";
import { registerSetupCommands } from "./register-setup-commands";
import { registerSubjectCommands } from "./register-subject-commands";
import {
  buildPostInitSystemEventText,
  firePostInitGuidanceEvent,
  runInit,
  runUninstall,
  type InitResult,
} from "./setup-ops";
import {
  runVerify,
  verifySetup,
  type VerifyCheck,
  type VerifyResult,
} from "./verify-ops";

function registerReclawCliCommands(
  program: unknown,
  config: PluginConfig,
  api: OpenClawPluginApi,
  workspaceDir?: string,
): void {
  const root = program as CommandLike;
  const reclaw = root.command("reclaw").description("Reclaw memory management");
  registerSetupCommands(reclaw, {
    config,
    workspaceDir,
    runInit,
    ensureQmdCollection,
    installQmdGlobal,
    runUninstall,
    runVerify,
  });
  registerLogCommands(reclaw, {
    config,
    workspaceDir,
  });
  registerImportCommands(reclaw, {
    config,
    api,
    workspaceDir,
  });
  registerSubjectCommands(reclaw, {
    config,
    workspaceDir,
  });
  registerProjectionCommands(reclaw, {
    config,
    workspaceDir,
  });
  registerBriefingCommands(reclaw, {
    config,
    api,
    workspaceDir,
  });
}

export function registerReclawCli(
  api: OpenClawPluginApi,
  config: PluginConfig,
): void {
  api.registerCli(
    ({ program, workspaceDir }) => {
      registerReclawCliCommands(program, config, api, workspaceDir);
    },
    { commands: ["reclaw"] },
  );
}

export { detectImportSources };
export {
  queueImportJob,
  resumeImportJobs,
  runImportCommand,
  runRestoreTranscriptsCommand,
  runImportWorker,
  stopImportJobs,
} from "./import-ops";
export {
  buildPostInitSystemEventText,
  firePostInitGuidanceEvent,
  runInit,
  runUninstall,
  runVerify,
  verifySetup,
  type InitResult,
  type VerifyCheck,
  type VerifyResult,
};
