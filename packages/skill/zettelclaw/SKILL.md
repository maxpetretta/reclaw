---
name: zettelclaw
description: "Use when accessing memory, recording information, searching prior context, or managing subjects."
read_when:
  - You need to find something from a previous session
  - You want to record a decision, fact, task, or question
  - You're asked about what you remember or know
  - You need to check or update the subject registry
---

# Zettelclaw Memory System

Zettelclaw is an append-only event log that replaces daily memory files. All memory lives in `log.jsonl` as structured entries. Extraction happens automatically at session end — you don't write to the log directly. Your job is to state information clearly in conversation so the extraction hook captures it.

## How Memory Works

1. **MEMORY.md** is auto-loaded into every session. It has a manual section (goals, preferences) and a generated Zettelclaw memory snapshot updated nightly.
2. **Zettelclaw session handoff** is written into MEMORY.md after each session extraction.
3. **`memory_search`** finds entries by keyword, type, subject, or status.
4. **`memory_get`** retrieves a specific entry by ID, reads MEMORY.md, or fetches a full session transcript.

Start with what's already in context (steps 1-2). Only call tools when you need something specific.

## Entry Types

| Type | What it captures | Key detail |
|---|---|---|
| `task` | Action items, follow-ups | Has `status`: `open` or `done` |
| `fact` | User-specific information learned | Preferences, events, observations, milestones |
| `decision` | A choice with reasoning | Use `detail` for the "why" |
| `question` | An unresolved open loop | Resolved by later entries on the same subject |
| `handoff` | Session boundary state | One per session, summarizes what's in-flight |

## Subjects

Every non-handoff entry has a `subject` — a kebab-case slug like `auth-migration` or `zettelclaw`. Subjects are tracked in a registry with a type: `project`, `person`, `system`, or `topic` (default).

When discussing something new, use a clear kebab-case slug. The extraction hook auto-creates subjects it hasn't seen. To explicitly manage subjects:

```bash
# List all subjects
openclaw zettelclaw subjects list

# Add a subject with a type
openclaw zettelclaw subjects add auth-migration --type project
openclaw zettelclaw subjects add alice-chen --type person

# Rename a subject (updates registry and all log entries)
openclaw zettelclaw subjects rename old-slug new-slug
```

## Using `memory_search`

Combines structured log filters with keyword search and MEMORY.md semantic search.

```
# Keyword search
memory_search({"query": "webhook retries"})

# Structured filters
memory_search({"type": "decision", "subject": "auth-migration"})
memory_search({"type": "task", "status": "open"})
memory_search({"type": "question"})

# Combined
memory_search({"query": "backoff", "type": "fact", "subject": "auth-migration"})
```

At least one of `query`, `type`, `subject`, or `status` is required.

## Using `memory_get`

Three lookup modes based on the `path` value:

```
# By entry ID (12-char nanoid from search results)
memory_get({"path": "r7Wp3nKx_mZe"})

# By session transcript (from an entry's session field)
memory_get({"path": "session:abc123def456"})

# By file path
memory_get({"path": "MEMORY.md"})
```

Reading an entry by ID increments its usage score, which helps it persist in the nightly memory snapshot.

## Citations

When referencing a prior event in conversation, cite it as `[<12-char-id>]` (e.g., `[r7Wp3nKx_mZe]`). This format is tracked for usage scoring — cited entries are more likely to appear in future memory snapshots.

## Corrections and Updates

The log is append-only. To correct something:
- State the correction clearly in conversation. Extraction writes a new entry on the same subject.
- To mark a task done, say so explicitly. Extraction emits a new `task` entry with `status: "done"`.
- To answer a question, discuss the resolution. Extraction captures the answer as a `fact` or `decision`.

Old entries are never modified. Current state is reconstructed by reading a subject's entries chronologically.

## Hard Filter

Only user-specific information belongs in the log. Ask: "Would I need to know this person to know this?" If a general-purpose LLM could produce the content without user context, it should not be extracted. No generic knowledge, no dependency lists, no boilerplate.

## CLI Commands

```bash
# Recent log entries
openclaw zettelclaw log
openclaw zettelclaw log --type decision --subject auth-migration --limit 10

# Search with filters
openclaw zettelclaw search "webhook"
openclaw zettelclaw search --type task --status open
openclaw zettelclaw search --subject auth-migration --from 2026-02-01 --to 2026-03-01

# Trace a subject's chronological history
openclaw zettelclaw trace
openclaw zettelclaw trace --subject auth-migration
openclaw zettelclaw trace <entry-id>

# Subject management
openclaw zettelclaw subjects list
openclaw zettelclaw subjects add <slug> --type <project|person|system|topic>
openclaw zettelclaw subjects rename <old-slug> <new-slug>

# Regenerate the MEMORY.md memory snapshot now
openclaw zettelclaw snapshot generate

# Force-refresh MEMORY.md session handoff block from log
openclaw zettelclaw handoff refresh

# Import historical conversations
openclaw zettelclaw import <chatgpt|claude|grok|openclaw> <file>
openclaw zettelclaw import status
openclaw zettelclaw import resume <jobId>

# Setup
openclaw zettelclaw init
openclaw zettelclaw verify
openclaw zettelclaw uninstall
```
