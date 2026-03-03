import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk";

export interface GuidanceEventResult {
  sent: boolean;
  message?: string;
}

export async function dispatchPostInitGuidanceEvent(eventText: string): Promise<GuidanceEventResult> {
  if (!eventText) {
    return { sent: false, message: "Could not build init event text: empty output" };
  }

  const attempts: string[][] = [
    ["openclaw", "system", "event", "--text", eventText, "--mode", "now"],
    ["openclaw", "system", "event", "--text", eventText],
  ];

  let lastErrorMessage = "unknown error";
  for (const argv of attempts) {
    try {
      const result = await runPluginCommandWithTimeout({
        argv,
        timeoutMs: 10_000,
      });

      if (result.code === 0) {
        return { sent: true };
      }

      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      lastErrorMessage =
        stderr || stdout || `command exited with code ${String(result.code)}`;
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    sent: false,
    message: `Could not fire post-init system event: ${lastErrorMessage}`,
  };
}
