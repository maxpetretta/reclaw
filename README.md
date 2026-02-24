# Reclaw 🦞

> Reclaim your AI conversations.

Export your ChatGPT, Claude, and Grok history — normalize to markdown, bootstrap your agent's memory.

## Quick Start

```bash
npx reclaw
```

The interactive wizard walks you through provider selection, export path, model choice, and output mode.

For a direct run:

```bash
npx reclaw --provider chatgpt --input ./conversations.json
```

Check run status or resume an interrupted run:

```bash
npx reclaw status
```

Preview or remove previously imported Reclaw legacy sessions from OpenClaw history:

```bash
npx reclaw cleanup --workspace ~/.openclaw/workspace --dry-run
npx reclaw cleanup --workspace ~/.openclaw/workspace --yes
npx reclaw cleanup --workspace ~/.openclaw/workspace --orphans --dry-run
```

## Output Modes

### OpenClaw (default)

Writes daily memory files to `memory/YYYY-MM-DD.md` with structured sections (`Decisions`, `Facts`, `Interests`, `Open`, `Sessions`). Updates `MEMORY.md` and `USER.md` via a synthesis agent. (OpenClaw mode retains the original section format.)

```bash
npx reclaw --mode openclaw --provider claude --input ./claude-export/
```

### Zettelclaw

Writes Zettelclaw-compatible journal entries to `03 Journal/YYYY-MM-DD.md` matching the vault template (`Log`, `Open`, `Sessions`). Migrates legacy sections automatically. Updates `MEMORY.md` and `USER.md` in the OpenClaw workspace.

```bash
npx reclaw --mode zettelclaw --provider chatgpt --input ./conversations.json --vault ~/zettelclaw
```

## How It Works

1. **Parse** — reads provider export files and normalizes conversations
2. **Extract** — groups conversations by day, runs parallel subagent jobs to distill durable memory (decisions, facts, preferences, project details)
3. **Write** — builds daily files/journals from extraction summaries
4. **Synthesize** — a final agent pass updates `MEMORY.md` and `USER.md`

Reclaw applies a hard content filter: only user-specific information survives extraction. General knowledge, trivia, and anything a general-purpose LLM could answer without user context is dropped.

Runs are resumable — if interrupted, rerun the same command to continue from where it left off.

## Exporting Your Data

- **ChatGPT:** Settings → Data Controls → Export Data → unzip → `conversations.json`
- **Claude:** Settings → Account → Export Data → unzip → `conversations.json`
- **Grok:** Settings → Account → Download Your Data → unzip

## Links

- [GitHub](https://github.com/maxpetretta/reclaw)
- [zettelclaw.com](https://zettelclaw.com)

## License

MIT
