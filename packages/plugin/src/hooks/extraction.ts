import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { normalizeError } from "../lib/guards";
import { readGatewayToken } from "../lib/runtime-env";
import { findSessionKeyForSession, listSessionCandidates } from "./session-discovery";
import { createExtractionHookDeps, type ExtractionHookDeps, resolveExtractionPaths } from "./extraction-common";
import {
  runCompactionExtraction,
  type CompactionHookContext,
  type CompactionHookEvent,
} from "./extraction-compaction";
import {
  runBeforeResetExtraction,
  runGatewayStartSweep,
  runSessionEndExtraction,
} from "./extraction-live";

export { listSessionCandidates, findSessionKeyForSession };

export function registerExtractionHooks(
  api: OpenClawPluginApi,
  config: PluginConfig,
  deps: Partial<ExtractionHookDeps> = {},
): void {
  const paths = resolveExtractionPaths(config);
  const runtimeDeps = createExtractionHookDeps(deps);
  const apiToken = readGatewayToken(api.config);

  const launchCompactionExtraction = (
    event: CompactionHookEvent,
    ctx: CompactionHookContext,
  ): void => {
    void runCompactionExtraction({
      hookName: "after_compaction",
      event,
      ctx,
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
    }).catch((error) => {
      api.logger.warn(`reclaw after_compaction background extraction failed: ${normalizeError(error)}`);
    });
  };

  api.on("session_end", async (event, ctx) => {
    await runSessionEndExtraction({
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
      event,
      ctx,
    });
  });

  api.on("before_reset", async (event, ctx) => {
    await runBeforeResetExtraction({
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
      event,
      ctx,
    });
  });

  api.on("after_compaction", (event, ctx) => {
    launchCompactionExtraction(event, ctx);
  });

  api.on("gateway_start", async (event) => {
    await runGatewayStartSweep({
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
      event,
    });
  });
}
