export const providerLabels = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
} as const

export type Provider = keyof typeof providerLabels

export const ALL_PROVIDERS: Provider[] = ["chatgpt", "claude", "grok"]
export const ZIP_SCAN_MAX_DEPTH = 3
export const DEFAULT_EXTRACTS_PATH = "~/Desktop"
export const DEFAULT_OPENCLAW_WORKSPACE_PATH = "~/.openclaw/workspace"
export const DEFAULT_ZETTELCLAW_VAULT_PATH = "~/zettelclaw"
export const DEFAULT_PARALLEL_JOBS = 5
export const DEFAULT_STATE_PATH = ".reclaw-state.json"
