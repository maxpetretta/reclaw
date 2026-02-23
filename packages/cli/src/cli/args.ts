import type { ExtractionMode } from "../extract/contracts"
import type { LegacySessionMode } from "../lib/openclaw-sessions"
import type { Provider } from "./constants"

export interface CliArgs {
  command?: "status"
  mode?: ExtractionMode
  model?: string
  provider?: Provider
  input?: string
  workspace?: string
  targetPath?: string
  statePath?: string
  legacySessions?: LegacySessionMode
  subagentBatchSize?: number
  parallelJobs?: number
  json?: boolean
  timestampedBackups: boolean
  yes: boolean
  dryRun: boolean
  help: boolean
}

interface LongOption {
  name: string
  value?: string
}

export function parseCliArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {
    timestampedBackups: false,
    yes: false,
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (typeof arg !== "string") {
      continue
    }

    if (arg === "--help" || arg === "-h") {
      parsed.help = true
      continue
    }

    if (arg === "--dry-run" || arg === "--plan") {
      parsed.dryRun = true
      continue
    }

    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true
      continue
    }

    if (arg === "--timestamped-backups") {
      parsed.timestampedBackups = true
      continue
    }

    if (arg === "--json") {
      parsed.json = true
      continue
    }

    if (arg === "status") {
      parsed.command = "status"
      continue
    }

    if (arg.startsWith("--")) {
      const option = parseLongOption(arg)
      switch (option.name) {
        case "mode": {
          const value = requireValue(args, option, index, "--mode")
          const mode = parseMode(value)
          if (!mode) {
            throw new Error(`Invalid --mode value '${value}'. Expected 'openclaw' or 'zettelclaw'.`)
          }
          parsed.mode = mode
          index = advanceIndex(index, option)
          continue
        }
        case "workspace": {
          const value = requireTrimmedValue(args, option, index, "--workspace")
          parsed.workspace = value
          index = advanceIndex(index, option)
          continue
        }
        case "target-path": {
          const value = requireTrimmedValue(args, option, index, "--target-path")
          parsed.targetPath = value
          index = advanceIndex(index, option)
          continue
        }
        case "state-path": {
          const value = requireTrimmedValue(args, option, index, "--state-path")
          parsed.statePath = value
          index = advanceIndex(index, option)
          continue
        }
        case "subagent-batch-size": {
          const value = requireValue(args, option, index, "--subagent-batch-size")
          const parsedSize = parsePositiveIntegerArg(value)
          if (parsedSize === undefined) {
            throw new Error("Invalid --subagent-batch-size value. Expected a positive integer.")
          }
          parsed.subagentBatchSize = parsedSize
          index = advanceIndex(index, option)
          continue
        }
        case "parallel-jobs": {
          const value = requireValue(args, option, index, "--parallel-jobs")
          const parsedSize = parsePositiveIntegerArg(value)
          if (parsedSize === undefined) {
            throw new Error("Invalid --parallel-jobs value. Expected a positive integer.")
          }
          parsed.parallelJobs = parsedSize
          index = advanceIndex(index, option)
          continue
        }
        case "legacy-sessions": {
          const value = requireValue(args, option, index, "--legacy-sessions")
          const parsedMode = parseLegacySessionModeArg(value)
          if (!parsedMode) {
            throw new Error(`Invalid --legacy-sessions value '${value}'. Expected 'on', 'off', or 'required'.`)
          }
          parsed.legacySessions = parsedMode
          index = advanceIndex(index, option)
          continue
        }
        case "model": {
          const value = requireTrimmedValue(args, option, index, "--model")
          parsed.model = value
          index = advanceIndex(index, option)
          continue
        }
        case "provider": {
          const value = requireValue(args, option, index, "--provider")
          const provider = parseProviderArg(value)
          if (!provider) {
            throw new Error(`Invalid --provider value '${value}'. Expected 'chatgpt', 'claude', or 'grok'.`)
          }
          parsed.provider = provider
          index = advanceIndex(index, option)
          continue
        }
        case "input": {
          const value = requireTrimmedValue(args, option, index, "--input")
          parsed.input = value
          index = advanceIndex(index, option)
          continue
        }
        default:
          throw new Error(`Unknown option '${arg}'. Run 'reclaw --help' for available flags.`)
      }
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option '${arg}'. Run 'reclaw --help' for available flags.`)
    }
  }

  return parsed
}

export function printHelp(): void {
  console.log(
    [
      "🦞 Reclaw - Reclaim your AI conversations",
      "",
      "Usage:",
      "  reclaw [flags]",
      "  reclaw status [--state-path <path>] [--json]",
      "",
      "Core flags:",
      "  --provider <chatgpt|claude|grok>   Parse only one provider",
      "  --input <path>                      Export directory or provider export file path",
      "  --mode <openclaw|zettelclaw>       Output mode",
      "  --workspace <path>                 OpenClaw workspace path (output in OpenClaw mode; legacy import target in Zettelclaw mode)",
      "  --target-path <path>               Output root (OpenClaw workspace or Zettelclaw vault)",
      "  --model <model-id>                 OpenClaw model key/alias/name",
      "  --state-path <path>                Resume state file path (default: ./.reclaw-state.json)",
      "  --subagent-batch-size <n>          Deprecated (ignored; batching is one merged day per job)",
      "  --parallel-jobs <n>                Parallel subagent jobs (default: 8)",
      "  --timestamped-backups              Write MEMORY/USER backups as .bak.<timestamp>",
      "  --legacy-sessions <on|off|required> Import legacy conversations into OpenClaw session history (default: on)",
      "  --yes, -y                          Non-interactive defaults; auto-confirm execution",
      "  --dry-run, --plan                  Parse and preview plan; do not schedule extraction or write files",
      "  --json                             Emit JSON output (for 'status')",
      "  -h, --help                         Show help",
      "",
      "Examples:",
      "  reclaw",
      "  reclaw status",
      "  reclaw status --state-path ./tmp/reclaw-run-1.json --json",
      "  reclaw --provider chatgpt --input ./conversations.json",
      "  reclaw --parallel-jobs 8",
      "  reclaw --state-path ./tmp/reclaw-run-1.json --timestamped-backups",
      "  reclaw --mode openclaw --workspace ~/tmp/openclaw-workspace-clone-20260221-120000/workspace --yes",
      "  reclaw --provider claude --input ./claude-export --mode zettelclaw",
      "  reclaw --dry-run --provider grok --input ./grok-export",
    ].join("\n"),
  )
}

function parseLongOption(arg: string): LongOption {
  const equalsIndex = arg.indexOf("=")
  if (equalsIndex === -1) {
    return {
      name: arg.slice(2),
    }
  }

  return {
    name: arg.slice(2, equalsIndex),
    value: arg.slice(equalsIndex + 1),
  }
}

function requireValue(args: string[], option: LongOption, index: number, flagName: string): string {
  if (typeof option.value === "string") {
    return option.value
  }

  const next = args[index + 1]
  if (typeof next !== "string") {
    throw new Error(`Missing value for ${flagName}`)
  }

  return next
}

function requireTrimmedValue(args: string[], option: LongOption, index: number, flagName: string): string {
  const value = requireValue(args, option, index, flagName).trim()
  if (value.length === 0) {
    throw new Error(`Empty value for ${flagName}`)
  }

  return value
}

function advanceIndex(index: number, option: LongOption): number {
  return option.value === undefined ? index + 1 : index
}

function parseMode(value: string): ExtractionMode | undefined {
  if (value === "openclaw" || value === "zettelclaw") {
    return value
  }

  return undefined
}

function parseProviderArg(value: string): Provider | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "chatgpt" || normalized === "claude" || normalized === "grok") {
    return normalized
  }

  return undefined
}

function parseLegacySessionModeArg(value: string): LegacySessionMode | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "on" || normalized === "off" || normalized === "required") {
    return normalized
  }

  return undefined
}

function parsePositiveIntegerArg(value: string): number | undefined {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) {
    return undefined
  }

  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return undefined
  }

  return parsed
}
