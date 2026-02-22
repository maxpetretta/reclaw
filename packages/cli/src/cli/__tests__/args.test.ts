import { describe, expect, it } from "bun:test"

import { parseCliArgs, printHelp } from "../args"

describe("parseCliArgs", () => {
  it("parses core flags and aliases", () => {
    const parsed = parseCliArgs([
      "--mode",
      "openclaw",
      "--provider",
      "chatgpt",
      "--input",
      "./exports",
      "--workspace",
      "./workspace",
      "--target-path",
      "./target",
      "--model",
      "gpt-5",
      "--state-path",
      "./state.json",
      "--parallel-jobs",
      "4",
      "--legacy-sessions",
      "required",
      "--timestamped-backups",
      "--dry-run",
      "-y",
      "-h",
    ])

    expect(parsed).toEqual({
      mode: "openclaw",
      provider: "chatgpt",
      input: "./exports",
      workspace: "./workspace",
      targetPath: "./target",
      model: "gpt-5",
      statePath: "./state.json",
      parallelJobs: 4,
      legacySessions: "required",
      timestampedBackups: true,
      yes: true,
      dryRun: true,
      help: true,
    })
  })

  it("supports equals syntax", () => {
    const parsed = parseCliArgs(["--mode=zettelclaw", "--provider=CLAUDE", "--parallel-jobs=2"])

    expect(parsed.mode).toBe("zettelclaw")
    expect(parsed.provider).toBe("claude")
    expect(parsed.parallelJobs).toBe(2)
  })

  it("rejects invalid provider values", () => {
    expect(() => parseCliArgs(["--provider", "openai"])).toThrow(
      "Invalid --provider value 'openai'. Expected 'chatgpt', 'claude', or 'grok'.",
    )
  })

  it("rejects non-positive parallel jobs", () => {
    expect(() => parseCliArgs(["--parallel-jobs", "0"])).toThrow(
      "Invalid --parallel-jobs value. Expected a positive integer.",
    )
  })

  it("rejects unknown options", () => {
    expect(() => parseCliArgs(["--not-a-real-flag"])).toThrow("Unknown option '--not-a-real-flag'.")
  })

  it("rejects unknown short options", () => {
    expect(() => parseCliArgs(["-x"])).toThrow("Unknown option '-x'.")
  })

  it("rejects missing and empty values", () => {
    expect(() => parseCliArgs(["--mode"])).toThrow("Missing value for --mode")
    expect(() => parseCliArgs(["--model", "   "])).toThrow("Empty value for --model")
  })

  it("rejects invalid mode and legacy-session values", () => {
    expect(() => parseCliArgs(["--mode", "invalid"])).toThrow("Invalid --mode value 'invalid'")
    expect(() => parseCliArgs(["--legacy-sessions", "sometimes"])).toThrow(
      "Invalid --legacy-sessions value 'sometimes'",
    )
  })

  it("rejects invalid deprecated subagent batch size", () => {
    expect(() => parseCliArgs(["--subagent-batch-size", "nope"])).toThrow(
      "Invalid --subagent-batch-size value. Expected a positive integer.",
    )
  })

  it("ignores non-option argv tokens", () => {
    const parsed = parseCliArgs(["positional"])
    expect(parsed).toEqual({
      timestampedBackups: false,
      yes: false,
      dryRun: false,
      help: false,
    })
  })

  it("prints help text", () => {
    const originalLog = console.log
    let output = ""
    console.log = (value: unknown) => {
      output += String(value)
    }
    try {
      printHelp()
    } finally {
      console.log = originalLog
    }

    expect(output).toContain("Usage:")
    expect(output).toContain("--provider <chatgpt|claude|grok>")
  })
})
