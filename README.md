# Reclaw 🦞

**Reclaim your AI conversations.**

Export your ChatGPT, Claude, and Grok history — normalize to markdown, bootstrap your agent's memory.

Outputs to:
- **OpenClaw** (`memory/`, `MEMORY.md`, `USER.md`)
- **Zettelclaw** (`03 Journal/`, plus `MEMORY.md` and `USER.md`)

## Install / Run

```bash
npx reclaw
```

See all flags:

```bash
npx reclaw --help
```

Check current resumable run state:

```bash
npx reclaw status
npx reclaw status --json
```

## Key Behavior (Current)

- Subagent extraction runs **one merged batch per day** (all same-day conversations are processed together).
- `--subagent-batch-size` is deprecated and ignored.
- Subagent jobs run in parallel by default (`--parallel-jobs 5`).
- Individual batch failures do not stop the run; successful batches continue and failed batches are reported at the end.
- Subagents return strict JSON with one field: `summary`.
- The main process synthesizes memory signals from those summaries.

Before updating root memory files, Reclaw writes backups:
- `MEMORY.md.bak`
- `USER.md.bak`

Then a dedicated main synthesis agent updates `MEMORY.md` and `USER.md` using tools.

For repeated test runs, enable timestamped backups:
- `--timestamped-backups` -> `MEMORY.md.bak.<timestamp>`, `USER.md.bak.<timestamp>`

For scripted/non-interactive runs:
- `--workspace <path>` is the OpenClaw output workspace in openclaw mode.
- In zettelclaw mode, `--workspace <path>` sets where legacy sessions are imported (defaults to `~/.openclaw/workspace`).
- `--target-path <path>` remains available for explicit output roots.
- `--yes` auto-accepts defaults and execution confirmation.

## Modes

### `--mode openclaw` (default)

- Writes daily memory files: `memory/YYYY-MM-DD.md`
- Daily format includes:
  - `## Decisions`
  - `## Facts`
  - `## Interests`
  - `## Open`
  - `---`
  - `## Sessions` (`provider:conversationId — timestamp`)
- Imports legacy sessions into OpenClaw history by default (`--legacy-sessions on`).

### `--mode zettelclaw`

- Writes daily journals: `03 Journal/YYYY-MM-DD.md`
- Journal format includes:
  - `## Decisions`
  - `## Facts`
  - `## Interests`
  - `## Open`
  - `---`
  - `## Sessions` (`provider:conversationId — HH:MM`)
- Does not create inbox notes.
- Imports legacy sessions into OpenClaw history by default (`--legacy-sessions on`) using `--workspace` or `~/.openclaw/workspace`.

## Useful Flags

- `--provider <chatgpt|claude|grok>`
- `--input <path>`
- `--state-path <path>`
- `--mode <openclaw|zettelclaw>`
- `--workspace <path>` (OpenClaw output path in openclaw mode; legacy import target in zettelclaw mode)
- `--target-path <path>`
- `--model <model-id>`
- `--yes`
- `--subagent-batch-size <n>` (deprecated; ignored)
- `--parallel-jobs <n>`
- `--timestamped-backups`
- `--legacy-sessions <on|off|required>` (default: `on`)
- `--dry-run` / `--plan`
- `reclaw status [--state-path <path>] [--json]`

## Resumability

Runs are resumable using `.reclaw-state.json`.

If interrupted, rerun the same command to continue.
