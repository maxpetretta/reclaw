# Reclaw

> Reclaim your AI conversations.

A durable memory system for [OpenClaw](https://openclaw.com). Reclaw replaces the default `memory-core` plugin with an append-only event log, structured extraction, and a nightly memory snapshot — so your agent remembers what matters across sessions.

## Install

```bash
openclaw plugins install reclaw
openclaw reclaw init
```

`init` creates the log directory, sets the memory slot, registers the nightly snapshot cron, and adds managed blocks to `MEMORY.md`.

## How It Works

```
Session ends  →  Extraction hook reads transcript
                      ↓
              LLM extracts structured entries (facts, decisions, tasks, questions, handoff)
                      ↓
              Entries appended to log.jsonl, subjects upserted in subjects.json
                      ↓
              Handoff block updated in MEMORY.md
                      ↓
Nightly cron  →  Snapshot generator rewrites MEMORY.md generated block
```

All content passes a hard filter: only user-specific knowledge enters the log. General knowledge that any LLM could produce without user context is excluded.

### Entry types

| Type | Purpose |
|---|---|
| `fact` | Something learned or observed about the user or their work |
| `decision` | A choice that was made, with reasoning |
| `task` | Something to do (`open` or `done`) |
| `question` | An open loop that needs an answer |
| `handoff` | Session boundary state — what's active and unresolved |

### Memory tools

Reclaw wraps OpenClaw's builtin `memory_search` and `memory_get` with structured log awareness:

- **`memory_search`** — keyword + structured filters (type, subject, status) over the log, plus semantic search over `MEMORY.md`
- **`memory_get`** — read entries by ID, `MEMORY.md` by path, or transcripts by session ID

### Subjects

Every non-handoff entry is tagged with a subject slug (`kebab-case`). Subjects are tracked in `subjects.json` with a type enum: `project`, `person`, `system`, `topic` (default).

```bash
openclaw reclaw subjects list
openclaw reclaw subjects add auth-migration
openclaw reclaw subjects add alice-chen --type person
openclaw reclaw subjects rename old-slug new-slug
```

## Import

Import conversation history from other platforms:

```bash
openclaw reclaw import chatgpt ~/Downloads/conversations.json
openclaw reclaw import claude ~/Downloads/claude-export.json
openclaw reclaw import grok ~/Downloads/grok-export.json
openclaw reclaw import openclaw   # migrate existing OpenClaw transcripts
```

Imports run as async background jobs. Check status or resume with:

```bash
openclaw reclaw import status <jobId>
openclaw reclaw import resume <jobId>
```

## CLI Reference

```bash
openclaw reclaw init              # set up log directory, memory slot, cron, markers
openclaw reclaw verify            # validate setup (files, config, markers, cron)
openclaw reclaw uninstall         # revert config changes (log data preserved)

openclaw reclaw log               # print recent log entries
openclaw reclaw search            # search with filters (--type, --subject, --status)
openclaw reclaw trace             # trace chronological subject history

openclaw reclaw subjects list     # list all subjects
openclaw reclaw subjects add      # add a subject
openclaw reclaw subjects rename   # rename a subject (updates registry + log)

openclaw reclaw snapshot generate # run snapshot generation now
openclaw reclaw handoff refresh   # refresh handoff block from latest log entry

openclaw reclaw import            # import conversation history
openclaw reclaw import status     # check import job status
openclaw reclaw import resume     # resume an import job
```

## Packages

| Package | Description |
|---|---|
| [`reclaw`](packages/plugin) | OpenClaw memory slot plugin (npm) |
| [`@reclaw/skill`](packages/skill) | Agent skill instructions (ClawHub) |
| [`@reclaw/website`](packages/website) | Landing page — [reclaw.sh](https://reclaw.sh) |

## Architecture

See [docs/SPECIFICATION.md](docs/SPECIFICATION.md) for the full event log architecture spec.

## Releasing

See [docs/RELEASING.md](docs/RELEASING.md) for npm + ClawHub release steps and preflight checks.

## License

MIT
