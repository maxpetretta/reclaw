# Zettelclaw V3: Event Log Architecture

Status: Implementation contract
Last updated: 2026-03-01
Scope: `packages/plugin` (OpenClaw memory slot plugin)

## 1. System Contract

Zettelclaw is the single active memory system when installed and initialized:
- Source of truth: append-only event log (`log.jsonl`) + subject registry (`subjects.json`) + plugin state (`state.json`).
- Memory slot ownership: `plugins.slots.memory = "zettelclaw"` (replaces `memory-core`).
- Persistence path: extraction hooks write structured events from transcripts.
- Recall path: wrapped `memory_search` and `memory_get`.
- Curation path: nightly briefing job rewrites only the managed generated block in `MEMORY.md`.

Legacy memory behaviors are disabled by init:
- `memory/YYYY-MM-DD.md` usage is not part of this system.
- `session-memory` bundled hook is disabled.
- pre-compaction `memoryFlush` is disabled.

## 2. Design Constraints

1. Log writes are append-only; corrections use `replaces` and never mutate prior entries.
2. Event identity fields (`id`, `timestamp`, `session`) are hook-injected, not model-authored.
3. Extraction and briefing are separate: extraction captures, briefing summarizes.
4. The hard extraction filter is mandatory: only user-specific information is stored.
5. Query surfaces must prefer current entries by default (`includeReplaced=false`) and expose full history when requested.
6. Subject slugs are registry-backed (`kebab-case`) with constrained type enum and `topic` fallback.
7. Main-session scope only for extraction (`agent:*:main`, `agent:*`, `dm:*`), with skip prefixes for non-interactive traffic.
8. Managed-block writes are isolated: briefing and handoff writers only edit their own marker regions.

## 3. Event Log

### 3.1 File Layout

```
~/.openclaw/zettelclaw/log.jsonl
~/.openclaw/zettelclaw/subjects.json
~/.openclaw/zettelclaw/state.json
```

`log.jsonl` is a single append-only file. The extraction hook appends entries at session end. Ripgrep searches it directly. Git tracks it for history. One file is simpler than one-per-day — no date-based file routing, no glob patterns for queries, no directory to manage. A year of daily use produces a few thousand lines. Ripgrep handles millions.

`subjects.json` is a registry of known subject slugs. The extraction agent reads it before writing to ensure consistent slugs across sessions.

`state.json` is a record of extraction/import bookkeeping, including session extraction status, failed retries, and imported-conversation dedupe metadata.

```json
{
  "auth-migration": { "display": "Auth Migration", "type": "project" },
  "whisper-stt": { "display": "Whisper STT", "type": "system" },
  "max": { "display": "Max", "type": "person" }
}
```

#### Subject type enum

| Type | For | Examples |
|---|---|---|
| `person` | People | max, contacts |
| `project` | Things being built | zettelclaw, safeshell, bracky |
| `system` | Infrastructure, services, tools | openclaw, telegram, tts |
| `topic` | Recurring themes that aren't a project, person, or system | ai-wearables, crypto |

`topic` is the default. The extraction hook validates `type` against this enum and falls back to `topic` if the LLM outputs an unlisted value.

#### Subject contract

**Slug format:** Lowercase kebab-case. `auth-migration`, not `Auth_Migration` or `authMigration`.

**Creating subjects:** The extraction agent outputs entries with `subject` values. The extraction hook reads the registry before writing. If the LLM output references a slug not in the registry, the hook adds it to `subjects.json` with `display` (Title Case of slug) and `type` inferred from context (default `topic`). Subjects can also be created manually via CLI:

```bash
openclaw zettelclaw subjects add auth-migration
openclaw zettelclaw subjects add max --type person
```

Default subject type is `topic` when type is inferred/invalid. The extraction hook also allows **type correction** for existing subjects: if an entry references an existing slug with a valid `subjectType`, the registry type is updated.

**Renaming subjects:** CLI command renames in both the registry and the log:

```bash
openclaw zettelclaw subjects rename old-slug new-slug
```

This updates `subjects.json` and runs `sed` over `log.jsonl` to rewrite all occurrences. The log is a single file — renaming is a one-liner.

**Merging subjects:** Same as rename — rename the duplicate slug to the canonical one. The old slug is removed from the registry automatically.

**Deleting subjects:** Remove from `subjects.json`. Old log entries keep the slug but it won't be used for new entries.

### 3.2 Entry Types

Five types, each with a distinct query pattern:

| Type | What it captures | When to use |
|---|---|---|
| `task` | Something to do | Action items, follow-ups, blockers |
| `fact` | Something learned or observed | New information about the user, their projects, their environment. Includes preferences, events, observations, lessons, milestones, relationships. |
| `decision` | A choice was made with reasoning | Something changed direction or was committed to |
| `question` | An open loop | Something unresolved that needs an answer. Closes when replaced by a decision or fact. |
| `handoff` | Session boundary state | What's active, what's unresolved |

Corrections use the `replaces` field — a new entry points to the old one it replaces. Old entries are never modified — the log is strictly append-only. The resolver reads forward and builds a replacement map at query time.

### 3.3 Schema

#### Common fields (all entries)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | nanoid, 12 characters. **Generated programmatically by the extraction hook, not by the LLM.** |
| `timestamp` | string | yes | ISO 8601. **Injected by the extraction hook** at extraction time. The LLM does not produce timestamps. |
| `type` | string | yes | One of: `decision`, `fact`, `task`, `question`, `handoff`. |
| `content` | string | yes | The actual information. One sentence to a short paragraph. Plain text. |
| `session` | string | yes | OpenClaw `sessionId` (maps to `<sessionId>.jsonl` transcript file for provenance). **Injected by the extraction hook** from the event context. |
| `detail` | string | no | More information when content isn't enough. On a decision: why. On a fact: background. On a handoff: what happened. On a task: constraints. On a question: what prompted it. |
| `subject` | string | no | Slug from `subjects.json`. The specific thing this entry concerns — a project, person, system, tool. Must match an existing slug or be added to the registry during extraction. |
| `replaces` | string | no | ID of entry this replaces. The old entry is skipped by the resolver. |

`source` is intentionally omitted. The extraction agent writes all entries from session transcripts. Even when the human says "remember this," the agent extracts and writes it. The session ID provides provenance — if you need to know where an entry came from, look up the session. The transcript file lives at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`.

#### Type-specific fields

**task** — something to do:

| Field | Required | Notes |
|---|---|---|
| `status` | yes | `"open"` or `"done"`. If blocked, it's still open — use `detail` for the reason. |

**fact** — something learned or observed:

```jsonl
{"id":"r7Wp3nKx_mZe","timestamp":"2026-02-20T14:35:00Z","type":"fact","content":"Exponential backoff caps at 3 retries with intervals 1s, 5s, 15s — total ~30s","subject":"auth-migration","session":"abc12345"}
```

**decision** — a choice with reasoning:

```jsonl
{"id":"a3k9x_BmQ2yT","timestamp":"2026-02-20T14:20:00Z","type":"decision","content":"Queue-based retries for webhook delivery instead of synchronous","detail":"Synchronous retries were cascading under load during the February auth outage","subject":"auth-migration","session":"abc12345"}
```

```jsonl
{"id":"Ht4vL_9qRx2D","timestamp":"2026-02-20T15:10:00Z","type":"task","content":"Write backfill script for 47 failed webhook jobs from last week","status":"open","subject":"auth-migration","session":"abc12345"}
```

**question** — an open loop:

No additional fields. Closes when replaced by a decision or fact.

```jsonl
{"id":"Jn2fR_7vKw4X","timestamp":"2026-02-20T15:15:00Z","type":"question","content":"Is the current retry strategy sufficient for webhook bursts over 10k/min?","subject":"auth-migration","session":"abc12345"}
```

**handoff** — session boundary state:

No type-specific fields. Uses `content` for the headline and `detail` for the full picture.

```jsonl
{"id":"Ym8kP_3wNx5Q","timestamp":"2026-02-20T15:30:00Z","type":"handoff","content":"Auth migration — retry logic implementation, backfill script not started","detail":"Exponential backoff working in staging. Still need backfill script for 47 failed jobs, then canary deploy. Load testing not done yet.","subject":"auth-migration","session":"abc12345"}
```

The handoff does not repeat decisions or tasks — those are already captured as separate entries from the same session. The briefing generator pulls them by session ID when it needs the full picture. The handoff's job is to summarize where things stand in prose.

#### Replacement examples

Correcting a decision:

```jsonl
{"id":"a3k9x_BmQ2yT","timestamp":"2026-02-20T14:20:00Z","type":"decision","content":"Queue-based retries for webhook delivery","detail":"Cascading failure risk","subject":"auth-migration","session":"abc12345"}
{"id":"Cx6tM_1pWn8Y","timestamp":"2026-02-26T10:00:00Z","type":"decision","content":"Queue-based retries with dead-letter queue for permanent failures","detail":"Discovered some failures are non-retryable, need a DLQ","subject":"auth-migration","replaces":"a3k9x_BmQ2yT","session":"def67890"}
```

Correcting a wrong fact:

```jsonl
{"id":"r7Wp3nKx_mZe","timestamp":"2026-02-20T14:35:00Z","type":"fact","content":"Exponential backoff intervals: 1s, 5s, 15s","subject":"auth-migration","session":"abc12345"}
{"id":"Dw9sN_2qXk7Z","timestamp":"2026-02-26T10:05:00Z","type":"fact","content":"Exponential backoff intervals: 2s, 10s, 30s","detail":"Previous entry had wrong intervals","replaces":"r7Wp3nKx_mZe","session":"def67890"}
```

The original entry is never modified. The replacement points back to it. The resolver reads forward and uses the latest version. Chains work: if A is replaced by B and B is replaced by C, the resolver uses C.

#### Replacement chain resolution

The resolver builds a `Map<id, replacedById>` in a single forward pass over the log. Any entry whose `id` appears as a key is superseded — skip it, use the replacement instead. At a few thousand entries this is <10ms. No index or cache needed for v1. Used by:

1. **Briefing generation** — to show only current versions of facts/decisions.
2. **CLI search** — to filter out superseded entries by default (add `--all` to include them).

### 3.4 Queryability

```bash
# All decisions
rg '"type":"decision"' log.jsonl

# Everything about a subject
rg '"subject":"auth-migration"' log.jsonl

# All open tasks
rg '"status":"open"' log.jsonl

# All open questions (not yet replaced)
rg '"type":"question"' log.jsonl

# Entries from a specific session
rg '"session":"abc12345"' log.jsonl

# Last handoff
rg '"type":"handoff"' log.jsonl | tail -1

# Full-text search
rg 'webhook' log.jsonl
```

### 3.5 Implicit Priority Signals

The log carries priority information without explicit scoring:

| Signal | How it works |
|---|---|
| **Type** | Decisions matter more than facts. Questions are open loops demanding attention. Tasks have status. |
| **Recency** | Recent entries matter more. The briefing windows filter by time. |
| **Frequency** | A subject with 30 entries this month is more active than one with 2. |
| **Replacement depth** | An entry replaced multiple times is actively refined — clearly important. |
| **Handoff presence** | The handoff entry captures what the user cared about at session end. |
| **Open-loop status** | Unanswered questions and open tasks are inherently high-priority until resolved. |

If these prove insufficient, a `pinned: true` boolean can be added later. Pinned entries always appear in the briefing regardless of age. One-field addition, no schema change.

### 3.6 Memory Decay

The log doesn't decay. It's append-only, immutable. Decay is a read concern.

The briefing generator applies natural decay through its time windows:

- Active entries: all entries in the last 14 days (includes recent decisions)
- Open items: open tasks and unanswered questions (no time limit)
- Stale subjects: old entries about subjects referenced in recent sessions

If an entry isn't recent, isn't pending, and isn't being referenced — it doesn't show up in the briefing. It's still in the log, still findable by search. That's decay without deletion.

The time windows are the decay knobs. Tighten them and memory fades faster. Loosen them and more history stays visible.

Log compaction (merging old daily files into monthly summaries) is an eventual operational concern, not a memory concern.

## 4. Extraction

### 4.1 When extraction runs

Zettelclaw uses **OpenClaw plugin hooks** (not internal hooks) for extraction triggers. The plugin hook API provides richer context including `sessionId`, `sessionFile`, and `messages[]`.

| Trigger | Plugin hook | Context available | What happens |
|---|---|---|---|
| Session end (any cause) | `session_end` | `sessionId`, `messageCount`, `durationMs` | Primary trigger — fires on daily reset, idle reset, explicit `/new`/`/reset`, and any other session termination |
| Explicit reset | `before_reset` | `sessionFile`, `messages[]`, `sessionId`, `workspaceDir` | Fires before `/new`/`/reset` clears the session. Provides the full transcript inline via `messages[]`. |
| Gateway startup | `gateway_start` | — | Sweep for un-extracted sessions (catches crashes, restarts) |

**`session_end` is the primary extraction trigger.** It fires whenever a session ends, regardless of how — daily reset (default 4am), idle timeout, explicit `/new` or `/reset`. This eliminates the need for `message:received`-based session transition detection.

**`before_reset` is a secondary trigger** that usually provides immediate extraction with inline `messages[]`; when inline messages are missing, the hook falls back to transcript file loading. If `before_reset` fires first and extracts successfully, the subsequent `session_end` for the same session is skipped via dedup.

**`gateway_start` sweep** catches edge cases: sessions that ended due to crashes, long inactivity, or gateway restarts where `session_end` never fired.

**Scope: main sessions only.** Only sessions with a human participant should produce log entries. The extraction hook checks the session key prefix and skips subagent sessions (`sub:*`), cron sessions (`cron:*`), and other non-interactive sessions. Only `agent:<agentId>:main` (and DM variants) are extracted.

### 4.1.1 Deduplication

The extraction hook maintains a state file at `~/.openclaw/zettelclaw/state.json`:

```json
{
  "extractedSessions": {
    "abc123def456": { "at": "2026-02-20T15:30:00Z", "entries": 7 },
    "def789ghi012": { "at": "2026-02-20T18:00:00Z", "entries": 3 }
  },
  "failedSessions": {
    "xyz999aaa111": { "at": "2026-02-21T10:00:00Z", "error": "LLM timeout", "retries": 1 }
  },
  "importedConversations": {
    "chatgpt:conv-123": {
      "at": "2026-02-22T09:10:00Z",
      "updatedAt": "2026-02-20T14:20:00Z",
      "sessionId": "reclaw:chatgpt:conv-123"
    }
  }
}
```

Before extracting, the hook checks if the `sessionId` is already in `extractedSessions`. If so, extraction is skipped. This prevents duplicate entries when both `before_reset` and `session_end` fire for the same session.

Failed extractions are recorded in `failedSessions` with retry count. The hook retries once on the next trigger. After one retry failure, the session is marked as permanently failed and skipped on subsequent triggers. The `gateway_start` sweep also retries failed sessions once.

The `extractedSessions` map is pruned periodically — entries older than 30 days are removed to keep the file small.

### 4.2 Extraction prompt

The extraction agent reads the conversation transcript and produces JSONL entries. The full prompt:

```markdown
You are the memory extraction agent. Read the conversation transcript below
and extract structured entries into the log.

You will receive:
- Known subjects from `subjects.json`
- Existing log entries relevant to the current transcript (plus open items)
- The current transcript

## Entry types

- **task**: Something to do. Include status: open or done.
- **fact**: Something was learned. A piece of information specific to the user or their work.
- **decision**: A choice was made. Include what was decided and why (use the detail field).
  Includes preferences, observations, events, lessons — anything learned or observed.
- **question**: An open loop. Something unresolved that needs an answer.
- **handoff**: Session boundary. Exactly one per session, at the end. Records what's
  in-flight and what's unresolved. Don't repeat decisions or tasks already captured
  as separate entries — the handoff is for working state, not a session recap.

## Rules

1. Apply the hard filter: only extract information specific to this user.
   "Would I need to know this person to know this?" If a general LLM
   could produce it without user context, skip it.
2. One entry per fact/decision. Don't bundle multiple facts into one entry.
3. Content should be a single sentence to a short paragraph. Plain text.
4. Use the detail field when content alone isn't enough. Why a decision was made,
   background on a fact, what prompted a question, constraints on a task.
5. Use existing slugs from the provided subjects list when a match exists. If the
   entry concerns something genuinely new, use a new kebab-case slug — the hook
   will add it to the registry automatically. For new subjects, include
   `subjectType` with one of: `project`, `person`, `system`, `topic`.
   If unsure, use `topic`. If an existing subject's type should be corrected,
   include `subjectType` on the entry and the hook may update the registry.
   Don't force a subject on entries that aren't clearly about a specific thing.
6. Always produce exactly one handoff entry at the end.
7. Skip trivial exchanges (greetings, acknowledgments, clarifying questions
   that led nowhere).
8. Existing entries are provided so you can evolve memory, not duplicate it.
   If a new fact or decision supersedes an existing entry, include `replaces`
   with the old entry ID.
9. If transcript text cites an event id (for example `[<id>]`), use that
   ID directly for `replaces` when it is the predecessor.
10. If the transcript does not include a direct ID, use the provided existing entries
    to find the most relevant predecessor and set `replaces` accordingly.
11. Do not re-extract information that already exists in the log unless it has
   changed.
12. If a task is now done, emit a new `task` entry with `status: "done"` and
    `replaces` pointing to the previous open task entry.

## Output format

One JSON object per line. No markdown fences, no commentary.
**Do not include `id`, `timestamp`, or `session` fields** — these are injected
programmatically by the extraction hook after your output.

{"type":"decision","content":"...","detail":"...","subject":"..."}
{"type":"fact","content":"...","subject":"..."}
{"type":"task","content":"...","status":"open","subject":"..."}
{"type":"task","content":"...","status":"done","subject":"...","replaces":"<open-task-id>"}
{"type":"handoff","content":"...","detail":"..."}
```

### 4.2.1 Post-processing by extraction hook

The extraction hook receives the LLM's JSONL output and for each line:

1. Parses the JSON object.
2. Validates `type` is one of the five allowed types.
3. Generates a 12-character nanoid for `id`.
4. Sets `timestamp` to the current ISO 8601 time.
5. Sets `session` to the OpenClaw `sessionId` from the hook event context.
6. If `subject` is present:
   - If missing from `subjects.json`, adds it with `display` (Title Case) and `type` defaulting to `topic`.
   - If it already exists and the entry includes a valid `subjectType`, updates the existing registry type.
7. Resolves `replaces` when omitted by the model:
   - First checks transcript references in strict `[<12-char-id>]` form.
   - Otherwise runs targeted log candidate search (type/subject-compatible + keyword-focused) and links only when confidence is high.
8. Appends the complete entry to `log.jsonl`.

If model output is non-empty but produces zero valid JSONL entries after validation, extraction is marked failed and retried per retry policy (instead of being marked extracted).

Before step 1, the hook prepares extraction context and feeds it to the model:
- Detects transcript-mentioned subjects by matching known slugs from `subjects.json`.
- Reads `log.jsonl`, resolves replacements (`filterReplaced`), and selects current entries for those subjects.
- Adds all open tasks and unresolved questions regardless of subject.
- Sends these as `## Existing Entries` so the model can reference IDs in `replaces`.

### 4.3 Transcript access

The extraction hook accesses session transcripts differently depending on the trigger:

**On `before_reset`:**
1. The hook first uses inline `messages[]` when provided.
2. If `messages[]` is missing/empty, it falls back to `sessionFile` transcript read.
3. If `sessionFile` is unavailable, it falls back to transcript lookup by `(agentId, sessionId)`.

**On `session_end`:**
1. The event provides `sessionId` but not `sessionFile` or `messages[]`.
2. The hook locates the transcript at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` (or `.reset.*` variant).
3. Reads and parses the JSONL file, filtering for message entries.

**On `gateway_start` (sweep):**
1. The hook discovers candidate sessions from `sessions.json` and transcript files under each agent’s `sessions/` directory.
2. It resolves session keys when available and applies main-session scope filtering.
3. For each candidate, it locates/reads transcript files and runs the normal extraction pipeline (which handles dedup and retry policy via `state.json`).

**Common to all triggers:**
- Messages are filtered for `type: "message"` entries with `role: "user"` or `role: "assistant"`.
- The extracted conversation text is passed to the LLM extraction prompt (model: Sonnet) along with:
  - the current `subjects.json` contents
  - pre-filtered `## Existing Entries` from the current log (subject-relevant entries + open items), including IDs for `replaces` references

### 4.4 Hard content filter

The filter is the most important rule in the system. It applies at extraction time:

- "Would I need to know this person to know this?"
- If a general-purpose LLM could produce this content without user context, don't extract it.
- No general knowledge, no dependency lists, no version inventories, no boilerplate.
- Decisions, preferences, and user-specific facts pass. Generic information doesn't.

The filter keeps the log lean. A lean log means the briefing is high-signal and search results are relevant.

## 5. Briefing (MEMORY.md)

### 5.1 Two halves

MEMORY.md has two sections with different authors:

**Manual section (human/agent-written):** Goals, priorities, working preferences, identity context. The user's "Polaris" — intent and values that tell the agent why things matter. Persists until the human changes it. Not touched by the nightly job.

**Generated section (nightly-written):** Active subjects, recent decisions, pending items, stale subjects. The current state of the world derived from the log. Rewritten every night.

```markdown
## Goals
- Ship auth migration by end of month
- Keep the monorepo build under 30s
- Zettelclaw V3 spec and implementation

## Preferences
- Bun for all JS/TS, never yarn/pnpm
- Never auto-commit
- Prefer simple solutions over configurable ones

<!-- BEGIN GENERATED BRIEFING -->
## Active
- auth-migration — Queue-based retries implemented, backfill script pending
- zettelclaw — V3 event log spec in progress

## Recent Decisions
- 2026-02-20: Queue-based retries with exponential backoff for webhooks
- 2026-02-18: Bun over yarn — 3-4x faster, one-way door

## Pending
- Backfill script for 47 failed webhook jobs
- Canary deploy + 24h monitoring
- Is retry strategy sufficient for 10k+/min webhook bursts?

## Stale
- whisper-stt — last entry 2026-01-08, referenced in recent session

## Contradictions
- auth-migration: "Synchronous retries with 5 max" (2026-02-10) may conflict with "Queue-based retries with 3 max" (2026-02-20)
<!-- END GENERATED BRIEFING -->
```

### 5.2 Generation

The nightly cron job pre-filters log entries into three buckets, then sends the union to the LLM for presentation:

**Pre-filtering (code-side, before LLM call):**
1. **Active entries**: All entries within `activeWindow` days (default 14). This naturally includes recent decisions.
2. **Open items**: All `type: "task"` with `status: "open"` + all `type: "question"` not yet replaced. No time limit.
3. **Stale candidates**: Entries whose subject appears in the active window but whose most recent entry is older than `staleThreshold` days (default 30).

These three sets are unioned and deduped by ID. Only the resulting entries are sent to the LLM.

**Presentation (LLM-side):**
The briefing model receives pre-bucketed entries and produces sections:
- `## Active` — unique subjects from active entries, one-line summaries
- `## Recent Decisions` — decision-type entries from the active window
- `## Pending` — open tasks and unresolved questions
- `## Stale` — subjects from the stale bucket
- `## Contradictions` — up to 3 likely conflicts where older entries may disagree with newer ones on the same subject

The LLM handles presentation grouping (e.g. pulling decisions into their own section) but does not need to apply time-window filtering — that's already done.

Constraints:
- Max 80 lines between markers (enforced by `limitLines` post-LLM).
- Content outside markers is never touched.
- The generated block is the only part the nightly job writes to.
- Max 3 contradiction flags per nightly run to avoid noise.

### 5.3 Contract

MEMORY.md is auto-loaded into every OpenClaw session (first 200 lines). The manual section provides intent. The generated section provides state. Together they orient the agent without any search or file reads.

The log is authoritative. The briefing is a cache. When they disagree, the log wins.

**MEMORY.md is the only file from OpenClaw's default memory layout that survives.** Daily notes (`memory/YYYY-MM-DD.md`) are eliminated — the log replaces their function. MEMORY.md persists because it's auto-loaded by OpenClaw's session bootstrap (this behavior is independent of the memory plugin slot).

### 5.4 Retrieval Order

When the agent needs information beyond what MEMORY.md and the handoff provide, it uses the zettelclaw-provided memory tools:

1. **MEMORY.md** — auto-loaded by OpenClaw session bootstrap. Already in context.
2. **Last handoff** — written into MEMORY.md between managed markers on each successful extraction when a handoff entry is produced.
3. **`memory_search`** — zettelclaw's wrapped tool. Two search paths:
   - **Log search** (structured filters + ripgrep): precise lookups by type, subject, status. Keyword search over content/detail fields. Replacement-chain-aware.
   - **MEMORY.md search** (builtin semantic): delegated to OpenClaw's builtin for hybrid BM25+vector search over the manual section.
4. **`memory_get`** — zettelclaw's wrapped tool. Reads specific log entries by ID, MEMORY.md content, or transcript files by session ID (provenance lookups).

Each step is more expensive than the last. Most sessions should resolve from steps 1-2 (zero tool calls). Step 3 covers specific lookups and exploration. Step 4 is for deep dives into specific entries or original session transcripts when the log entry alone doesn't have enough context.

When the main agent references a prior event in conversation, it should cite the event as `[<12-char-id>]` (from tool results). Extraction uses this citation format as a high-confidence `replaces` signal.

## 6. Session Handover

### 6.1 Handoff persistence in MEMORY.md

When extraction appends new entries to `log.jsonl`, it checks the newly appended entries for a handoff.
If found, zettelclaw rewrites the `<!-- BEGIN LAST HANDOFF -->` / `<!-- END LAST HANDOFF -->`
managed block in MEMORY.md with the latest handoff content.

The generated handoff block looks like:

```
## Last Session Handoff
Session: abc12345 (2026-02-20T15:30:00Z)
Auth migration — retry logic implementation, backfill script not started
Detail: Exponential backoff working in staging. Still need backfill script for 47 failed jobs, then canary deploy. Load testing not done yet.
```

If the handoff markers are missing, extraction appends them to MEMORY.md and writes the latest
handoff between them.

### 6.2 Implementation note

MEMORY.md now has two generated sections:
- **Nightly briefing block** (`BEGIN/END GENERATED BRIEFING`) written by the cron briefing job.
- **Last handoff block** (`BEGIN/END LAST HANDOFF`) written by extraction when a new handoff is appended.

Each writer only edits its own marker block, so the two generated sections do not overwrite each other.

## 7. Obsidian Layer

Not implemented in current plugin scope.

Contract:
- No Obsidian build pipeline exists in `packages/plugin`.
- No vault sync, note generation, wikilink rendering, or two-way reconciliation is performed.
- If added in a future version, it must consume `log.jsonl` as read-only source data and must not change write-path requirements for extraction.

## 8. OpenClaw Integration

### 8.1 Plugin structure

Distributed as a single OpenClaw **memory slot plugin** via npm. Declares `kind: "memory"` in its manifest, replacing `memory-core` when installed:

```
zettelclaw/
  package.json                    # npm package with openclaw.extensions
  openclaw.plugin.json            # Plugin manifest — kind: "memory", configSchema, etc.
  prompts/
    extraction.md                 # Extraction agent prompt (section 4.2)
    briefing.md                   # Briefing generation prompt for nightly cron
    agents-memory-guidance.md     # Managed guidance block inserted into AGENTS.md
    memory-zettelclaw-notice.md   # Managed notice block inserted into MEMORY.md
    post-init-system-event.md     # System-event template used by init guidance notification
  src/
    plugin.ts                     # Plugin entry — registers hooks, tools, CLI commands
    hooks/
      extraction.ts               # session_end / before_reset / gateway_start — extract from transcripts
    memory/
      handoff.ts                  # Format and write LAST HANDOFF block in MEMORY.md
      managed-block.ts            # Shared utility for marker-delimited block replacement
    tools/
      memory-search.ts            # Wraps builtin memory_search — adds structured filters + replacement resolution
      memory-get.ts               # Wraps builtin memory_get — adds entry-by-ID and transcript lookups
    briefing/
      generate.ts                 # Read log, run briefing prompt, rewrite MEMORY.md block
    log/
      schema.ts                   # Entry types, validation, nanoid generation
      resolve.ts                  # Replacement resolution (forward-pass Map<id, replacedById>)
      query.ts                    # Structured log queries (type/subject/status filters)
    subjects/
      registry.ts                 # Read/write subjects.json, auto-create, rename/merge
    state.ts                      # Dedup state (extractedSessions, failedSessions)
  skills/
    zettelclaw/
      SKILL.md                    # Teaches the agent about the memory system
```

Prompts are stored as standalone markdown files in `prompts/`, not inline in code. This makes them editable, reviewable, and versionable independently of the plugin logic.

### 8.1.1 Memory slot registration

The plugin manifest (`openclaw.plugin.json`) declares the memory slot:

```json
{
  "id": "zettelclaw",
  "name": "Zettelclaw",
  "kind": "memory",
  "configSchema": { ... }
}
```

On `init`, the plugin sets `plugins.slots.memory = "zettelclaw"` in the user's config. This:
- Disables `memory-core` (the default memory plugin)
- Disables the `session-memory` bundled hook (zettelclaw's extraction replaces it)
- Makes zettelclaw's `memory_search` and `memory_get` the active memory tools

The pre-compaction memory flush (`agents.defaults.compaction.memoryFlush`) is disabled by `init` since zettelclaw extracts from full transcripts at session end — no need for the model to self-save during compaction.

### 8.2 What the plugin registers

| Component | OpenClaw mechanism | Purpose |
|---|---|---|
| **Memory slot** | `kind: "memory"` in manifest | Replaces `memory-core` as the active memory plugin |
| **`memory_search` tool** | Wraps `api.runtime.tools.createMemorySearchTool()` | Builtin semantic/keyword search + structured log filters + replacement resolution + ID-forward log result rendering |
| **`memory_get` tool** | Wraps `api.runtime.tools.createMemoryGetTool()` | Builtin file reads + log entry-by-ID + transcript lookups by session ID |
| Extraction hook | Plugin hook: `session_end` | Primary trigger — fires on any session end (daily/idle/explicit reset) |
| Extraction hook | Plugin hook: `before_reset` | Secondary — provides `messages[]` inline on `/new`/`/reset` |
| Extraction hook | Plugin hook: `gateway_start` | Sweep for un-extracted and failed sessions |
| Handoff writer | Extraction post-processing | Rewrites MEMORY.md `LAST HANDOFF` managed block when new handoff is appended |
| Nightly cron | `cron/jobs.json` job upsert during init | Rewrite MEMORY.md briefing block (LLM-powered) |
| Skill | `skills/zettelclaw/SKILL.md` | Agent instructions for the memory system |
| CLI: init | Plugin-registered command | Create log directory, set memory slot, disable flush, register cron, add briefing + handoff markers to MEMORY.md |
| CLI: uninstall | Plugin-registered command | Revert init-time OpenClaw config changes and remove generated briefing block from MEMORY.md (log data preserved) |
| CLI: verify | Plugin-registered command | Validate setup files/config/markers/cron and print per-check pass/fail |
| CLI: log | Plugin-registered command | Pretty-print recent log entries |
| CLI: search | Plugin-registered command | Search log with filters (type, subject, date range, `--all` for replaced) |
| CLI: trace | Plugin-registered command | Trace replacement chains, with irregularity flags (broken links, branching, cycles) |
| CLI: import | Plugin-registered command | Import historical conversations (chatgpt/claude/grok/openclaw), dedupe by state, optional transcript generation, optional source backup/cleanup |
| CLI: subjects | Plugin-registered command | `add`, `rename`, `list` — manage subject registry (`add` defaults type to `topic`) |
| CLI: briefing generate | Plugin-registered command | Run briefing generation immediately and rewrite MEMORY.md generated block |

### 8.3 Installation

```bash
openclaw plugins install zettelclaw
openclaw zettelclaw init
```

`init` does the following:
1. Creates the log directory (`~/.openclaw/zettelclaw/`) with empty `log.jsonl`, `subjects.json`, and `state.json`
2. Sets `plugins.slots.memory = "zettelclaw"` in config (replaces `memory-core`)
3. Disables `agents.defaults.compaction.memoryFlush` (zettelclaw handles persistence)
4. Disables the `session-memory` bundled hook if enabled
5. Registers the nightly cron job for briefing generation
6. Adds briefing markers and handoff markers to MEMORY.md:
   - `<!-- BEGIN GENERATED BRIEFING -->` / `<!-- END GENERATED BRIEFING -->`
   - `<!-- BEGIN LAST HANDOFF -->` / `<!-- END LAST HANDOFF -->`
7. Fires a post-init system event that instructs the main session to update managed Zettelclaw guidance blocks in `AGENTS.md` and `MEMORY.md`

Note: step 7 is guidance-only; CLI `init` does not directly rewrite `AGENTS.md` or inject the Zettelclaw notice block in `MEMORY.md`.

### 8.4 Configuration

In `openclaw.json` under `plugins.entries.zettelclaw`:

```json
{
  "enabled": true,
  "config": {
    "logDir": "~/.openclaw/zettelclaw",
    "extraction": {
      "model": "anthropic/claude-sonnet-4-6",
      "skipSessionTypes": ["cron:", "sub:", "hook:"]
    },
    "briefing": {
      "model": "anthropic/claude-sonnet-4-6",
      "activeWindow": 14,
      "staleThreshold": 30,
      "maxLines": 80
    },

    "cron": {
      "schedule": "0 3 * * *",
      "timezone": "America/Detroit"
    }
  }
}
```

`logDir` contains `log.jsonl`, `subjects.json`, and `state.json`. All in one directory.

Search/embedding configuration is inherited from the user's existing `agents.defaults.memorySearch` settings — no separate search config needed. The builtin indexer handles MEMORY.md semantic search; log search is handled by the wrapper via structured filters + ripgrep.

### 8.5 Nightly cron job

Registered/updated during `init` by writing `~/.openclaw/cron/jobs.json`:
- Job name: `zettelclaw-briefing`
- Schedule: `config.cron.schedule` (default `0 3 * * *`)
- Timezone: `config.cron.timezone` (defaults to local timezone if unset)
- Session target: `isolated`
- Wake mode: `now`
- Payload: `Run: openclaw zettelclaw briefing generate`
- Delivery: none

`init` also removes legacy job names `zettelclaw-reset` and `zettelclaw-nightly` if present.

## 9. Memory Tools (Replaces `memory-core`)

Zettelclaw registers as `kind: "memory"` and replaces `memory-core` in the plugin slot. It provides wrapped versions of the builtin `memory_search` and `memory_get` tools — same tool names, no agent prompt changes needed — with structured log awareness layered on top.

### 9.1 Architecture: wrapping the builtins

`memory-core` is a thin plugin that calls `api.runtime.tools.createMemorySearchTool()` and `createMemoryGetTool()` — these are builtin runtime functions that handle embedding, indexing, hybrid BM25+vector search, MMR, temporal decay, caching, and QMD support. The runtime helpers are always available regardless of which memory plugin is active.

Zettelclaw calls the same runtime helpers internally, then wraps the results with structured log awareness:

```typescript
register(api: OpenClawPluginApi) {
  api.registerTool((ctx) => {
    const builtinSearch = api.runtime.tools.createMemorySearchTool({
      config: ctx.config,
      agentSessionKey: ctx.sessionKey,
    });
    const builtinGet = api.runtime.tools.createMemoryGetTool({
      config: ctx.config,
      agentSessionKey: ctx.sessionKey,
    });

    return [
      wrapMemorySearch(builtinSearch, logDir),
      wrapMemoryGet(builtinGet, logDir),
    ];
  }, { names: ["memory_search", "memory_get"] });
}
```

**What this gives us:**
- All of OpenClaw's search infra for free (hybrid BM25+vector, MMR, temporal decay, embedding caching, QMD, local/remote embeddings)
- Structured filters on top (type, subject, status, replacement chain)
- Same tool names — existing agent prompts and system instructions work unchanged
- The builtin indexer handles markdown memory files (for semantic search); zettelclaw handles `log.jsonl` querying directly

### 9.2 `memory_search` (wrapped)

Extends the builtin schema with optional structured filters:

| Parameter | Type | Source | Description |
|---|---|---|---|
| `query` | string | Builtin | Optional natural language/keyword query. |
| `maxResults` | number | Builtin | Optional. Max results to return. |
| `minScore` | number | Builtin | Optional. Minimum similarity score. |
| `type` | string | Zettelclaw | Optional. Filter by entry type (`fact`, `decision`, `task`, `question`, `handoff`). |
| `subject` | string | Zettelclaw | Optional. Filter by subject slug. |
| `status` | string | Zettelclaw | Optional. Filter tasks by status (`open`, `done`). |
| `includeReplaced` | boolean | Zettelclaw | Optional. Include superseded entries (default: false). |

**Execution flow:**
1. At least one of `query`, `type`, `subject`, or `status` must be present.
2. If structured filters are provided (`type`, `subject`, `status`), run direct structured query over `log.jsonl` (replacement-aware by default).
3. If `query` is provided, run direct keyword search over `log.jsonl` (`content`/`detail`) with the same filters.
4. If `query` is provided and builtin `memory_search` is available, also run builtin semantic search over indexed markdown content (e.g., `MEMORY.md`).
5. Merge and dedupe lines from all sources. Log-backed lines are rendered with IDs inline (e.g., `[id=abc123def456] ...`) so they can be cited in transcript references.

**Indexing:** The builtin indexer only indexes Markdown files — it will not index `log.jsonl`. The search wrapper handles this split:
- **MEMORY.md semantic search** — delegated to the builtin (hybrid BM25+vector, MMR, temporal decay, all inherited).
- **Log search** — handled by the wrapper directly via structured filters (in-process JSONL parsing by type/subject/status) + ripgrep keyword search over `content` and `detail` fields. No vector index over log entries for v1.

This is sufficient because log entries are short, structured, and tagged — structured filters cover precise lookups ("all open tasks for auth-migration"), and ripgrep covers keyword searches ("webhook"). Semantic search adds the most value over MEMORY.md where content is longer and less structured. A vector index over log entries can be added in v2 if keyword + structured filters prove insufficient at scale.

### 9.3 `memory_get` (wrapped)

Extends the builtin with log entry and transcript lookups:

| Parameter | Type | Source | Description |
|---|---|---|---|
| `path` | string | Builtin | File path (e.g., `MEMORY.md`) or zettelclaw entry ID / session reference. |
| `from` | number | Builtin | Optional. Start line (for file reads). |
| `lines` | number | Builtin | Optional. Number of lines (for file reads). |

**Execution flow:**
1. If `path` is `MEMORY.md` or any file path — delegate to the builtin `memory_get` (backward compatible).
2. If `path` matches a 12-character nanoid pattern (e.g., `r7Wp3nKx_mZe`) — look up the log entry by ID in `log.jsonl` and return the full entry JSON with all fields.
3. If `path` starts with `session:` (e.g., `session:abc123def456`) — locate and read the transcript file at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`, filtered to user/assistant messages. This is the provenance lookup — from a log entry's `session` field to the full conversation context.

### 9.4 What's eliminated

By replacing `memory-core`, zettelclaw eliminates:
- `memory/YYYY-MM-DD.md` daily notes — the log captures this information structurally
- The `session-memory` hook — extraction handles session persistence
- The pre-compaction memory flush — full transcripts survive on disk

**What's preserved** (via wrapping the builtin runtime helpers):
- Hybrid BM25 + vector search
- MMR re-ranking (diversity)
- Temporal decay (recency boost)
- Embedding caching (SQLite)
- QMD backend support
- Local and remote embedding providers
- All `agents.defaults.memorySearch` configuration

## 10. Out Of Scope (Current Implementation)

- Obsidian build/sync pipeline.
- Daily markdown memory files (`memory/YYYY-MM-DD.md`).
- Running zettelclaw and `memory-core` together.
- Custom vector index over `log.jsonl` (log search is structured + keyword only).
- Bidirectional sync or reconciliation between external notes and the event log.
- Entry-level confidence/importance scoring fields.

## 11. Verification (v1 scope)

1. **Extraction (explicit)**: Run a substantive session. End with `/new`. Verify `log.jsonl` has new entries including one handoff. Verify entries have programmatically generated `id`, `timestamp`, and `session` fields. Verify the hard content filter excluded generic information.

2. **Extraction (session end)**: Have a session, let it expire (daily/idle reset). Verify `session_end` hook fires and extracts from the expired session's transcript.

3. **Extraction (startup sweep)**: Stop the gateway with an active un-extracted session. Restart. Verify `gateway_start` hook extracts from the stale session. Also verify failed sessions are retried.

4. **Deduplication**: Issue `/new` (triggers `before_reset` extraction), then verify the subsequent `session_end` for the same sessionId is skipped (state.json `extractedSessions` dedup).

4a. **Scope filtering**: Verify subagent, cron, and hook sessions are not extracted. Only main sessions with human participants produce log entries.

5. **Subject auto-creation**: Verify new subjects from extraction are added to `subjects.json`. Verify `openclaw zettelclaw subjects add` and `openclaw zettelclaw subjects rename` work correctly (rename updates both registry and log).

6. **Handoff persistence**: End a session that emits a handoff. Verify MEMORY.md `LAST HANDOFF` block is updated. Start a new session and confirm the handoff appears via MEMORY.md auto-load.

7. **Nightly briefing**: Run `openclaw cron run <zettelclaw-briefing>`. Verify MEMORY.md's generated block is updated. Verify manual content outside the markers is preserved. Verify active subjects, recent decisions, pending items, and stale subjects are populated correctly from the log.

8. **Memory tools**: Verify `memory_search` returns structured log entries with type/subject/status filters and includes event IDs in log-backed result lines. Verify keyword search over log entries works via ripgrep ("webhook" finds the retry decision). Verify semantic search over MEMORY.md works via the builtin. Verify `memory_get` reads entries by ID, MEMORY.md by path, and transcripts by `session:` prefix. Verify `memory-core` is disabled (slot occupied by zettelclaw).

8a. **CLI search**: Run `openclaw zettelclaw search --type decision --subject auth-migration`. Verify correct results. Verify `--all` includes replaced entries.

8b. **CLI trace**: Run `openclaw zettelclaw trace` (and `openclaw zettelclaw trace <id>`). Verify chains render correctly and irregularities are flagged for broken links, branching, and cycles.

9. **End-to-end continuity**: Work across 3 sessions in one day. Verify each session starts with the previous session's handoff. Start a session the next morning after the nightly cron. Verify MEMORY.md briefing reflects all three sessions' activity.

10. **Replacement**: Tell the agent a previous fact was wrong and reference the old entry as `[<id>]` in transcript text. Verify the correction enters the log with `replaces` pointing to the original entry (or best matched predecessor when no citation is present). Verify the next briefing reflects the corrected version. Verify replaced entries are hidden in default search results.

## Appendix A: Implementation Review Resolutions (2026-02-28)

Resolutions from review of the draft spec against OpenClaw's actual API surface:

| # | Question | Resolution |
|---|---|---|
| 1 | nanoid/timestamp generation | LLM outputs entries without `id`, `timestamp`, `session`. Hook injects all three programmatically. |
| 2 | Subject management | CLI commands `subjects add` and `subjects rename` (rename seds the log). Extraction hook upserts subjects (auto-create + valid type updates). |
| 3 | Timestamp source | Injected by hook at extraction time. Not LLM-generated. |
| 4 | Extraction triggers | Plugin hook API provides `session_end`, `before_reset`, `before_compaction`, `after_compaction`, `session_start` — richer than internal hooks. Primary: `session_end` (all session ends). Secondary: `before_reset` (provides `messages[]` inline). Sweep: `gateway_start`. Scope: main sessions only (skip subagents, cron, hooks). |
| 5 | Transcript access | `before_reset` uses `messages[]` first, then `sessionFile`, then `(agentId, sessionId)` transcript lookup fallback. `session_end` resolves by `sessionId`. `.reset.*` variants are supported. |
| 6 | Briefing generation | LLM-powered summarization for the generated MEMORY.md block. |
| 7 | Obsidian layer | Deferred to v2. |
| 8 | Replacement chain | Forward-pass `Map<id, replacedById>` at query time. Used by briefing gen and CLI search. No index for v1. |
| 9 | Session ID format | OpenClaw's `sessionId` from hook event context. Maps to `<sessionId>.jsonl` transcript. |
| 10 | Duplicate handoffs | `state.json` tracks `extractedSessions` map (set of sessionIds). Same session = skip. Failed sessions tracked with retry count (max 1 retry). Map pruned after 30d. |
| 11 | JSONL indexing | Builtin indexer is markdown-only. Log search handled by wrapper (structured filters + ripgrep). Semantic search covers MEMORY.md only for v1. |
| 12 | Handoff persistence | Extraction rewrites MEMORY.md `LAST HANDOFF` block when new handoff entries are appended. `before_prompt_build` hook eliminated — MEMORY.md auto-load handles injection. |
| 13 | Extraction model | Sonnet (configurable via `extraction.model`). |
| 14 | Scope filtering | Only main sessions extracted. Skip `cron:`, `sub:`, `hook:` session key prefixes. |
| 15 | Error handling | Retry extraction once on failure. Mark as permanently failed after second failure. `gateway_start` sweep also retries. |
| 16 | Migration/import | Includes CLI import tooling (`openclaw zettelclaw import`) for chatgpt/claude/grok/openclaw sources, with state-based dedupe and optional source backup/cleanup for openclaw migration. |
| 17 | Subject type enum | Constrained to `project \| person \| system \| topic`. Default `topic`. Validated on creation with fallback. |
| 18 | Briefing pre-filtering | Three buckets (active entries, open items, stale subjects) pre-filtered in code before LLM call. `decisionWindow` config removed — decisions are covered by `activeWindow`. LLM handles presentation only. |
| 19 | Extraction context | Existing log entries (subject-relevant + open items) fed to extraction LLM so it can reference IDs in `replaces` and avoid duplicates. Capped at 50 entries per subject. |
| 20 | `replaces` reliability | Deterministic linker resolves missing `replaces` using strict transcript citations (`[<12-char-id>]`) first, then targeted log candidate search + compatibility/confidence checks. |

## Appendix B: Build Order

Recommended implementation sequence. Each phase is independently testable.

### Phase 1: Core log + schema
- `log/schema.ts` — entry types, validation, nanoid generation
- `log/resolve.ts` — replacement chain resolution
- `log/query.ts` — structured filters (type/subject/status) + ripgrep wrapper
- `subjects/registry.ts` — read/write subjects.json, auto-create
- `state.ts` — extractedSessions/failedSessions tracking
- **Test:** Write entries manually to `log.jsonl`, query them, verify replacement resolution

### Phase 2: Extraction hooks
- `hooks/extraction.ts` — `session_end`, `before_reset`, `gateway_start` handlers
- `prompts/extraction.md` — extraction prompt (from spec section 4.2)
- Post-processing pipeline (parse LLM output → validate → inject id/timestamp/session → upsert subject registry (add/update type) → resolve `replaces` (citation/search) → append to log)
- Dedup via state.json
- Scope filtering (main sessions only)
- Error handling (retry once, mark failed)
- **Test:** Run a real session, hit `/new`, verify log entries appear with correct fields

### Phase 3: Memory tools (wrapped)
- `tools/memory-search.ts` — wrap builtin, add structured filters + ripgrep log search + replacement resolution
- `tools/memory-get.ts` — wrap builtin, add entry-by-ID + session transcript reads
- Plugin manifest (`openclaw.plugin.json`) with `kind: "memory"`
- `plugin.ts` — register tools, hooks, CLI
- **Test:** Install plugin, verify `memory_search` with type/subject filters works, verify `memory_get` by entry ID works, verify `memory-core` is disabled

### Phase 4: Handoff persistence
- Extraction post-processing writes `LAST HANDOFF` markers in MEMORY.md
- **Test:** End a session with a handoff, verify MEMORY.md handoff block updates and is loaded in the next session

### Phase 5: Briefing generation
- `prompts/briefing.md` — briefing generation prompt
- `briefing/generate.ts` — read log, run LLM, rewrite MEMORY.md generated block
- Nightly cron registration
- **Test:** Run cron manually, verify MEMORY.md generated block reflects log state

### Phase 6: CLI + init
- CLI commands: `init`, `uninstall`, `verify`, `log`, `search`, `trace`, `import`, `subjects add/rename/list`, `briefing generate`
- `init` flow: create log dir, set memory slot, disable flush, register cron, add markers
- SKILL.md — agent instructions for the memory system
- **Test:** Full `openclaw plugins install zettelclaw && openclaw zettelclaw init` flow

## Appendix C: OpenClaw Reference Materials

This appendix is intentionally minimal. The current source of truth is the plugin code in `packages/plugin`.

Primary files:
- `src/plugin.ts` (registration)
- `src/hooks/extraction.ts` (extraction + `replaces` linker)
- `src/tools/memory-search.ts`
- `src/tools/memory-get.ts`
- `src/cli/commands.ts`
- `src/briefing/generate.ts`
- `src/log/{schema,query,resolve}.ts`

External API assumptions should be validated against the installed OpenClaw plugin SDK types when upgrading OpenClaw.
