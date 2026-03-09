import { isCancel as clackIsCancel } from "@clack/prompts";

export const RECLAW_BANNER = "🦞 Reclaw - Long-term memory for your Claw";

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function unwrapPromptValue<T>(value: T | symbol, cancelMessage: string): T {
  if (clackIsCancel(value)) {
    throw new Error(cancelMessage);
  }

  return value;
}
