# reclaw

Reclaw imports ChatGPT, Claude, and Grok exports into durable memory artifacts for:
- OpenClaw (`memory/`, `MEMORY.md`, `USER.md`)
- Zettelclaw (`03 Journal/`, `00 Inbox/`, plus `MEMORY.md` and `USER.md`)

## Install / Run

```bash
npx reclaw
# or
bunx reclaw
```

See all flags:

```bash
npx reclaw --help
```

## Key Behavior (Current)

- Subagent extraction defaults to **1 conversation per subagent task**.
- Override with `--subagent-batch-size <n>`.
- Subagents return strict JSON with one field: `summary`.
- The main process synthesizes memory signals from those summaries.

Before updating root memory files, Reclaw writes backups:
- `MEMORY.md.bak`
- `USER.md.bak`

Then a dedicated main synthesis agent updates `MEMORY.md` and `USER.md` using tools.

## Modes

### `--mode openclaw` (default)

- Writes daily memory files: `memory/YYYY-MM-DD.md`
- Daily format includes:
  - `## Done`
  - `## Decisions`
  - `## Facts`
  - `## Open`
  - `---`
  - `## Sessions` (`provider:conversationId — timestamp`)
- Optionally imports legacy sessions into OpenClaw history (`--legacy-sessions`).

### `--mode zettelclaw`

- Writes daily journals: `03 Journal/YYYY-MM-DD.md`
- Journal format includes:
  - `## Done`
  - `## Decisions`
  - `## Facts`
  - `## Open`
  - `---`
  - `## Sessions` (`provider:conversationId — HH:MM`)
- Writes inbox drafts to `00 Inbox/`.

## Useful Flags

- `--provider <chatgpt|claude|grok>`
- `--input <path>`
- `--mode <openclaw|zettelclaw>`
- `--model <model-id>`
- `--subagent-batch-size <n>`
- `--legacy-sessions <on|off|required>` (OpenClaw mode only)
- `--dry-run` / `--plan`

## Resumability

Runs are resumable using `.reclaw-state.json`.

If interrupted, rerun the same command to continue.
