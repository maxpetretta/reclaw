# Reclaw V3: Event Log Architecture

Status: Implementation contract
Last updated: 2026-03-02
Scope: `packages/plugin` + `packages/skill` (OpenClaw memory slot plugin + memory skill package)

## 0. Global Rename Spec (`zettelclaw` -> `reclaw`)

This section is the canonical v3 naming contract. Until the rename lands in code, legacy `zettelclaw` strings may still appear in examples below; treat the mappings in this section as authoritative.

### 0.1 Naming and Brand Direction

- Canonical product name: `Reclaw`
- Canonical plugin/skill namespace: `reclaw`
- Product role line: `Reclaw is the OpenClaw memory system plugin`
- Primary tagline (from legacy Reclaw): `Reclaim your AI conversations.`
- Preferred memory framing (from legacy Reclaw): `durable memory`
- CLI heading style: `🦞 Reclaw - Reclaim your AI conversations`
- Deprecated for new user-facing copy: `Zettelclaw` (allowed only in migration warnings and backward-compat notes)

### 0.2 Rename Matrix (Plugin + Skill Packages)

| Surface | Legacy value | New value | Migration behavior |
|---|---|---|---|
| Plugin manifest ID (`openclaw.plugin.json`) | `zettelclaw` | `reclaw` | Register plugin under `reclaw`. Keep temporary alias routing for `zettelclaw` CLI command path. |
| Plugin manifest display name | `Zettelclaw` | `Reclaw` | Replace all user-facing labels. |
| Plugin npm package name (`packages/plugin/package.json`) | `zettelclaw` | `reclaw` | Publish new package name; keep compatibility notes in release docs. |
| Plugin config key in `openclaw.json` | `plugins.entries.zettelclaw` | `plugins.entries.reclaw` | Auto-migrate key on `init`/`verify` when legacy key exists. |
| Memory slot ownership | `plugins.slots.memory = "zettelclaw"` | `plugins.slots.memory = "reclaw"` | Rewrite slot value during migration. |
| Plugin allowlist entry | `"zettelclaw"` | `"reclaw"` | Replace allowlist value; dedupe list. |
| Default log directory | `~/.openclaw/zettelclaw` | `~/.openclaw/reclaw` | Migrate directory path on first `init` (see 0.3). |
| CLI root command | `openclaw zettelclaw ...` | `openclaw reclaw ...` | `openclaw zettelclaw ...` remains a deprecated alias during transition. |
| Cron names | `zettelclaw-memory-snapshot`, `zettelclaw-briefing`, `zettelclaw-reset`, `zettelclaw-nightly`, `zettelclaw-import-worker-*` | `reclaw-memory-snapshot`, `reclaw-briefing`, `reclaw-reset`, `reclaw-nightly`, `reclaw-import-worker-*` | `init` removes legacy names and upserts new names. |
| Model/session labels | `zettelclaw-extraction-model`, `zettelclaw-memory-snapshot-model`, `zettelclaw-import-extract` | `reclaw-extraction-model`, `reclaw-memory-snapshot-model`, `reclaw-import-extract` | Rename for observability consistency. |
| Prompt filename | `prompts/memory-zettelclaw-notice.md` | `prompts/memory-reclaw-notice.md` | Update references in command wiring. |
| Managed markers in `AGENTS.md`/`MEMORY.md` | `BEGIN/END ZETTELCLAW ...` | `BEGIN/END RECLAW ...` | Readers accept both marker families; writers emit `RECLAW` markers. |
| Managed block headings | `## Memory System (Zettelclaw)`, `## Zettelclaw Memory Mode`, `## Zettelclaw Session Handoff` | `## Memory System (Reclaw)`, `## Reclaw Memory Mode`, `## Reclaw Session Handoff` | Rewrite on next managed-block update. |
| Plugin skill directory | `packages/plugin/skills/zettelclaw/` | `packages/plugin/skills/reclaw/` | Move directory and update manifest references. |
| Published skill package name | `@zettelclaw/skill` | `@reclaw/skill` | Publish new package and update resolver fallback candidates. |
| Skill package entry path | `zettelclaw/SKILL.md` | `reclaw/SKILL.md` | Move entry path and `files` array. |
| Skill frontmatter name | `name: zettelclaw` | `name: reclaw` | Required for runtime skill discovery consistency. |
| Internal type names | `ZettelclawState`, `registerZettelclawCli`, etc. | `ReclawState`, `registerReclawCli`, etc. | Pure refactor; no behavior change. |

### 0.3 Backward Compatibility and Migration Contract

1. Config migration on first `openclaw reclaw init`:
   - If `plugins.entries.zettelclaw` exists and `plugins.entries.reclaw` does not, move the object to `plugins.entries.reclaw`.
   - If `plugins.slots.memory === "zettelclaw"`, rewrite to `"reclaw"`.
   - Replace any `"zettelclaw"` value in `plugins.allow` with `"reclaw"` and dedupe.

2. Log directory migration:
   - If `~/.openclaw/reclaw` does not exist and `~/.openclaw/zettelclaw` exists, move `zettelclaw` -> `reclaw`.
   - If both directories exist and both are non-empty, abort with an actionable conflict message (no automatic merge).
   - After migration, all reads/writes use `~/.openclaw/reclaw` unless an explicit `logDir` override is configured.

3. Marker migration:
   - Managed-block readers must detect both `ZETTELCLAW` and `RECLAW` marker sets.
   - Managed-block writers must emit only `RECLAW` markers and headings.
   - Existing legacy blocks are replaced in place the next time `init`, `snapshot generate`, or `handoff refresh` runs.

4. CLI compatibility window:
   - Register `openclaw reclaw` as canonical.
   - Keep `openclaw zettelclaw` as a deprecated alias for one minor release cycle with warning output on use.
   - Alias removal target: first v4 release after rename stabilization.

5. Cron migration:
   - On `init`, remove legacy cron names and create/update only `reclaw-*` names.
   - Import worker names follow `reclaw-import-worker-<jobId>` immediately after rename.

6. Legacy Reclaw importer continuity:
   - Keep existing import source support (`chatgpt`, `claude`, `grok`, `openclaw`) under `openclaw reclaw import`.
   - Position this as the successor to the old standalone Reclaw importer, now integrated directly in the memory plugin workflow.

### 0.4 Implementation Sequence (Scoped to Plugin + Skill)

1. Plugin package:
   - Rename manifest/package identifiers, command root, config keys, log directory default, cron names, marker constants, prompt filenames, and user-facing copy.
   - Keep CLI alias and marker dual-read support.
   - Update plugin tests to assert `reclaw` defaults and migration behavior.
   - Primary files: `packages/plugin/openclaw.plugin.json`, `packages/plugin/package.json`, `packages/plugin/src/plugin.ts`, `packages/plugin/src/config.ts`, `packages/plugin/src/cli/*.ts`, `packages/plugin/src/memory/markers.ts`, `packages/plugin/prompts/*.md`, `packages/plugin/src/__tests__/*.test.ts`.

2. Skill package:
   - Rename package name and entry path to `@reclaw/skill` + `reclaw/SKILL.md`.
   - Rewrite SKILL.md commands/examples to `openclaw reclaw ...`.
   - Sync plugin bundled skill copy (`packages/plugin/skills/reclaw/SKILL.md`).
   - Primary files: `packages/skill/package.json`, `packages/skill/reclaw/SKILL.md`, `packages/plugin/skills/reclaw/SKILL.md`, and any resolver logic in `packages/cli/src/lib/skill.ts` that points at `@zettelclaw/skill`.

3. Verification gates:
   - `rg -n "zettelclaw|Zettelclaw|ZETTELCLAW" packages/plugin packages/skill` returns only intentional compatibility shims/messages.
   - Fresh install path produces only `reclaw` identifiers in config, cron jobs, markers, and log directory.
   - Migration path from a live `zettelclaw` install preserves data and command functionality.

### 0.5 Non-Goals of Rename

- No event schema change (`log.jsonl` entry fields stay the same).
- No behavior change to extraction/snapshot logic.
- No rollback to legacy daily-memory file workflows.

## 1. System Contract

Zettelclaw is the single active memory system when installed and initialized:
- Source of truth: append-only event log (`log.jsonl`) + subject registry (`subjects.json`) + plugin state (`state.json`).
- Memory slot ownership: `plugins.slots.memory = "zettelclaw"` (replaces `memory-core`).
- Persistence path: extraction hooks write structured events from transcripts.
- Recall path: wrapped `memory_search` and `memory_get`.
- Curation path: nightly memory snapshot job rewrites only the managed generated block in `MEMORY.md`.

Legacy memory behaviors are disabled by init:
- `memory/YYYY-MM-DD.md` usage is not part of this system.
- `session-memory` bundled hook is disabled.
- pre-compaction `memoryFlush` is disabled.

## 2. Design Constraints

1. Log writes are append-only; corrections are represented as new entries and never mutate prior entries.
2. Event identity fields (`id`, `session`) are always system-injected; live extraction `timestamp` is hook-injected, while import timestamps are normalized by the import pipeline.
3. Extraction and snapshot generation are separate: extraction captures, snapshot generation summarizes.
4. The hard extraction filter is mandatory: only user-specific information is stored.
5. Query surfaces expose full append-only history and support narrowing by type/subject/status/date.
6. Subject slugs are registry-backed (`kebab-case`) with constrained type enum and `topic` fallback; non-handoff entries require `subject` and missing values normalize to `unknown`.
7. Main-session scope only for extraction (`agent:*:main`, `agent:*`, `dm:*`), with skip prefixes for non-interactive traffic.
8. Managed-block writes are isolated: snapshot and handoff writers only edit their own marker regions.

## 3. Event Log

### 3.1 File Layout

```
~/.openclaw/zettelclaw/log.jsonl
~/.openclaw/zettelclaw/subjects.json
~/.openclaw/zettelclaw/state.json
```

`log.jsonl` is a single append-only file. The extraction hook appends entries at session end. Ripgrep searches it directly. Git tracks it for history. One file is simpler than one-per-day — no date-based file routing, no glob patterns for queries, no directory to manage. A year of daily use produces a few thousand lines. Ripgrep handles millions.

`subjects.json` is a registry of known subject slugs. The extraction agent reads it before writing to ensure consistent slugs across sessions.

`state.json` is a record of extraction/import bookkeeping, including session extraction status, failed retries, imported-conversation dedupe metadata, async import job state, and per-event usage counters used by snapshot generation.

```json
{
  "extractedSessions": {
    "abc123def456": { "at": "2026-02-20T15:30:00Z", "entries": 7 }
  },
  "failedSessions": {},
  "importedConversations": {
    "chatgpt:conv-123": {
      "at": "2026-02-22T09:10:00Z",
      "updatedAt": "2026-02-20T14:20:00Z",
      "sessionId": "reclaw:chatgpt:conv-123",
      "entries": 12
    }
  },
  "eventUsage": {
    "abc123def456": {
      "memoryGetCount": 4,
      "memorySearchCount": 9,
      "citationCount": 2,
      "lastAccessAt": "2026-03-01T18:22:11.000Z"
    }
  },
  "importJobs": {}
}
```

#### Subject type enum

| Type | For | Examples |
|---|---|---|
| `person` | People | alice-chen, contacts |
| `project` | Things being built | zettelclaw, my-saas-app, home-automation |
| `system` | Infrastructure, services, tools | openclaw, telegram, tts |
| `topic` | Recurring themes that aren't a project, person, or system | ai-wearables, crypto |

`topic` is the default. The extraction hook validates `type` against this enum and falls back to `topic` if the LLM outputs an unlisted value.

#### Subject contract

**Slug format:** Lowercase kebab-case. `auth-migration`, not `Auth_Migration` or `authMigration`.

**Creating subjects:** The extraction agent outputs entries with `subject` values. For non-handoff entries, `subject` is required; if omitted, the hook fills `unknown`. The extraction hook reads the registry before writing. If the LLM output references a slug not in the registry, the hook adds it to `subjects.json` with `display` (Title Case of slug) and `type` from the entry's `subjectType` hint (default `topic`). Subjects can also be created manually via CLI:

```bash
openclaw zettelclaw subjects add auth-migration
openclaw zettelclaw subjects add alice-chen --type person
```

Default subject type is `topic` when no `subjectType` hint is provided or when the hint is invalid. The extraction hook also allows **type correction** for existing subjects: if an entry references an existing slug with a valid `subjectType`, the registry type is updated.

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
| `question` | An open loop | Something unresolved that needs an answer. Resolve by adding follow-up `decision`/`fact`/`task` entries on the same subject. |
| `handoff` | Session boundary state | What's active, what's unresolved |

Corrections are appended as new entries with the same subject. Old entries are never modified — the log is strictly append-only. Lineage is reconstructed by querying a subject's entries in chronological order.

### 3.3 Schema

#### Common fields (all entries)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | nanoid, 12 characters. **Generated programmatically by the extraction hook, not by the LLM.** |
| `timestamp` | string | yes | ISO 8601. Live extraction injects current time. Import extraction may set per-entry historical timestamps; if omitted/invalid, import falls back to the conversation `updatedAt`. |
| `type` | string | yes | One of: `decision`, `fact`, `task`, `question`, `handoff`. |
| `content` | string | yes | The actual information. One sentence to a short paragraph. Plain text. |
| `session` | string | yes | OpenClaw `sessionId` (maps to `<sessionId>.jsonl` transcript file for provenance). **Injected by the extraction hook** from the event context. |
| `detail` | string | no | More information when content isn't enough. On a decision: why. On a fact: background. On a handoff: what happened. On a task: constraints. On a question: what prompted it. |
| `subject` | string | yes* | Slug from `subjects.json`. Required for `task`/`fact`/`decision`/`question`. `handoff` may omit. Missing non-handoff subjects are normalized to `unknown`. |

`source` is intentionally omitted. The extraction agent writes all entries from session transcripts. Even when the human says "remember this," the agent extracts and writes it. The session ID provides provenance — if you need to know where an entry came from, look up the session. The transcript file lives at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`.

`subjects` arrays are intentionally omitted. Each entry has a single canonical `subject` slug.

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

No additional fields. Resolution is represented by later entries on the same subject.

```jsonl
{"id":"Jn2fR_7vKw4X","timestamp":"2026-02-20T15:15:00Z","type":"question","content":"Is the current retry strategy sufficient for webhook bursts over 10k/min?","subject":"auth-migration","session":"abc12345"}
```

**handoff** — session boundary state:

No type-specific fields. Uses `content` for the headline and `detail` for the full picture.

```jsonl
{"id":"Ym8kP_3wNx5Q","timestamp":"2026-02-20T15:30:00Z","type":"handoff","content":"Auth migration — retry logic implementation, backfill script not started","detail":"Exponential backoff working in staging. Still need backfill script for 47 failed jobs, then canary deploy. Load testing not done yet.","subject":"auth-migration","session":"abc12345"}
```

The handoff does not repeat decisions or tasks — those are already captured as separate entries from the same session. The snapshot generator pulls them by session ID when it needs the full picture. The handoff's job is to summarize where things stand in prose.

#### Chronological correction examples

Correcting a decision is represented by adding a newer decision on the same subject:

```jsonl
{"id":"a3k9x_BmQ2yT","timestamp":"2026-02-20T14:20:00Z","type":"decision","content":"Queue-based retries for webhook delivery","detail":"Cascading failure risk","subject":"auth-migration","session":"abc12345"}
{"id":"Cx6tM_1pWn8Y","timestamp":"2026-02-26T10:00:00Z","type":"decision","content":"Queue-based retries with dead-letter queue for permanent failures","detail":"Discovered some failures are non-retryable, need a DLQ","subject":"auth-migration","session":"def67890"}
```

Correcting a wrong fact is represented the same way:

```jsonl
{"id":"r7Wp3nKx_mZe","timestamp":"2026-02-20T14:35:00Z","type":"fact","content":"Exponential backoff intervals: 1s, 5s, 15s","subject":"auth-migration","session":"abc12345"}
{"id":"Dw9sN_2qXk7Z","timestamp":"2026-02-26T10:05:00Z","type":"fact","content":"Exponential backoff intervals: 2s, 10s, 30s","detail":"Previous entry had wrong intervals","subject":"auth-migration","session":"def67890"}
```

The original entry is never modified. To reconstruct current state, query the subject and read entries oldest-to-newest.

### 3.4 Queryability

```bash
# All decisions
rg '"type":"decision"' log.jsonl

# Everything about a subject
rg '"subject":"auth-migration"' log.jsonl

# Subject history in chronological order (for lineage reasoning)
rg '"subject":"auth-migration"' log.jsonl | jq -s 'sort_by(.timestamp)[]'

# All open tasks
rg '"status":"open"' log.jsonl

# All open questions
rg '"type":"question"' log.jsonl

# Entries from a specific session
rg '"session":"abc12345"' log.jsonl

# Zettelclaw session handoff
rg '"type":"handoff"' log.jsonl | tail -1

# Full-text search
rg 'webhook' log.jsonl
```

### 3.5 Implicit Priority Signals

The log carries priority information without explicit scoring:

| Signal | How it works |
|---|---|
| **Type** | Decisions matter more than facts. Questions are open loops demanding attention. Tasks have status. |
| **Recency** | Recent entries matter more. Snapshot windows filter by time. |
| **Frequency** | A subject with 30 entries this month is more active than one with 2. |
| **Usage signals** | Frequently cited/read entries (`eventUsage`) are likely durable and important. |
| **Handoff presence** | The handoff entry captures what the user cared about at session end. |
| **Open-loop status** | Unanswered questions and open tasks are inherently high-priority until resolved. |

If these prove insufficient, a `pinned: true` boolean can be added later. Pinned entries always appear in the snapshot regardless of age. One-field addition, no schema change.

### 3.6 Memory Decay

The log doesn't decay. It's append-only, immutable. Decay is a read concern.

The snapshot generator applies natural decay through its time windows:

- Active entries: all entries in the last 14 days (includes recent decisions)
- Open items: open tasks and unanswered questions (no time limit)
- Stale subjects: old entries about subjects referenced in recent sessions
- Durable entries: older `decision`/`fact` entries with positive usage score from `state.json.eventUsage`
  (`score = 2*citationCount + memoryGetCount + 0.25*memorySearchCount`, top 10)

If an entry isn't recent, isn't pending, isn't durable, and isn't being referenced — it doesn't show up in the snapshot. It's still in the log, still findable by search. That's decay without deletion.

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
      "sessionId": "reclaw:chatgpt:conv-123",
      "entries": 12
    }
  },
  "eventUsage": {
    "abc123def456": {
      "memoryGetCount": 4,
      "memorySearchCount": 9,
      "citationCount": 2,
      "lastAccessAt": "2026-03-01T18:22:11.000Z"
    }
  },
  "importJobs": {}
}
```

Before extracting, the hook checks if the `sessionId` is already in `extractedSessions`. If so, extraction is skipped. This prevents duplicate entries when both `before_reset` and `session_end` fire for the same session.

Failed extractions are recorded in `failedSessions` with retry count. The hook retries once on the next trigger. After one retry failure, the session is marked as permanently failed and skipped on subsequent triggers. The `gateway_start` sweep also retries failed sessions once.

During extraction, transcript citations (`[<12-char-id>]`) increment `eventUsage.citationCount` for the cited event ID.

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
   Subject is required for all non-handoff entries. If you truly cannot choose,
   use `unknown`.
6. Always produce exactly one handoff entry at the end.
7. Skip trivial exchanges (greetings, acknowledgments, clarifying questions
   that led nowhere).
8. Existing entries are provided so you can evolve memory, not duplicate it.
   To reason about history, list entries for the same subject in chronological order.
9. Do not re-extract information that already exists in the log unless it has
   changed.
10. If a task is now done, emit a new `task` entry with `status: "done"` and
    describe closure details in `detail` when useful.

## Output format

One JSON object per line. No markdown fences, no commentary.
Do not include `id` or `session` fields — these are injected programmatically.
For standard live extraction, do not include `timestamp`.
For historical import mode, you may include an optional `timestamp` field.
If only a day is known, use noon for that date.

{"type":"decision","content":"...","detail":"...","subject":"..."}
{"type":"fact","content":"...","subject":"..."}
{"type":"task","content":"...","status":"open","subject":"..."}
{"type":"task","content":"...","status":"done","subject":"...","detail":"..."}
{"type":"fact","content":"...","subject":"unknown"}
{"type":"fact","content":"...","subject":"...","timestamp":"2026-02-12T12:00:00.000Z"}
{"type":"handoff","content":"...","detail":"..."}

When introducing a new subject slug, add `"subjectType":"project|person|system|topic"` on that entry.
```

### 4.2.1 Post-processing by extraction hook

The extraction hook receives the LLM's JSONL output and for each line:

1. Parses the JSON object.
2. Reads optional `subjectType` hint (`subjectType`/`subject_type`) and strips it from the candidate payload.
3. For non-handoff entries, if `subject` is missing/blank, sets `subject: "unknown"`.
4. Validates schema (`type`, required fields, task status, allowed keys).
5. Finalizes the entry (injects `id`, current `timestamp`, and `session` from hook context).
6. Upserts `subject` in `subjects.json` (auto-create with `topic` fallback; valid `subjectType` can update existing type).
7. Appends the complete entry to `log.jsonl`.

If model output is non-empty but produces zero valid JSONL entries after validation, extraction is marked failed and retried per retry policy (instead of being marked extracted).

Before step 1, the hook prepares extraction context and feeds it to the model:
- Detects transcript-mentioned subjects by matching known slugs from `subjects.json`.
- Reads `log.jsonl` and selects entries for those subjects.
- Adds all open tasks and unresolved questions regardless of subject.
- Sends these as `## Existing Entries` (sorted oldest-to-newest by timestamp) so the model can reason about subject lineage chronologically.

### 4.2.2 Historical import extraction mode

The import pipeline reuses the extraction prompt with an additional historical-mode system prefix:
- transcript is archived historical data
- optional per-entry `timestamp` is allowed
- date-only timestamps are normalized to noon (`YYYY-MM-DDT12:00:00.000Z`)
- omitted timestamps default to the conversation `updatedAt`

Import extraction uses the same subject fallback (`unknown` for missing non-handoff subjects), `subjectType` hint handling, and chronological subject-history strategy as live extraction.

At import write time, the runner enforces historical import invariants:
- `session` is normalized to `reclaw:<platform>:<conversationId>`
- persisted entry `timestamp` preserves extraction/model timestamp when valid; otherwise it falls back to the conversation `updatedAt`
- subject slugs are trimmed before registry upsert/appending

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
  - pre-filtered `## Existing Entries` from the current log (subject-relevant entries + open items), including event IDs for direct transcript citations

### 4.4 Hard content filter

The filter is the most important rule in the system. It applies at extraction time:

- "Would I need to know this person to know this?"
- If a general-purpose LLM could produce this content without user context, don't extract it.
- No general knowledge, no dependency lists, no version inventories, no boilerplate.
- Decisions, preferences, and user-specific facts pass. Generic information doesn't.

The filter keeps the log lean. A lean log means the generated snapshot is high-signal and search results are relevant.

## 5. Memory Snapshot (MEMORY.md)

### 5.1 Two halves

MEMORY.md has two sections with different authors:

**Manual section (human/agent-written):** Goals, priorities, working preferences, identity context. The user's "Polaris" — intent and values that tell the agent why things matter. Persists until the human changes it. Not touched by the nightly job.

**Generated section (nightly-written):** A memory snapshot derived from the log that prioritizes current interests, active work, conversation focus, and open loops. Rewritten every night.

```markdown
## Goals
- Ship auth migration by end of month
- Keep the monorepo build under 30s

## Preferences
- TypeScript strict mode everywhere
- Prefer simple solutions over configurable ones

<!-- BEGIN ZETTELCLAW MEMORY SNAPSHOT -->
## Snapshot
- Auth migration is active with retry logic in place; delivery hardening and backfill remain.
- Zettelclaw memory system work is focused on chain quality and snapshot relevance.

## Human Interests
- Reliable automation that preserves continuity across sessions
- Clear event history and correction chains over one-off summaries

## Active Projects and Systems
- auth-migration — queue retries enabled, backfill/canary still pending
- zettelclaw — memory snapshot and event-chain improvements in progress

## Conversation Focus
- Improving event quality and keeping references explicit in transcripts
- Tightening plugin behavior so MEMORY.md reflects current priorities clearly

## Active Tasks
- Backfill script for 47 failed webhook jobs
- Canary deploy + 24h monitoring

## Open Questions
- Is retry strategy sufficient for 10k+/min webhook bursts?

## Recent Decisions
- 2026-02-20: Queue-based retries with exponential backoff for webhooks
- 2026-02-18: Switched to queue-based job processing for import pipeline

## Stale Threads
- legacy-api — last entry 2026-01-08, referenced in recent session
<!-- END ZETTELCLAW MEMORY SNAPSHOT -->
```

### 5.2 Generation

The nightly cron job pre-filters log entries into four buckets, then sends the union to the LLM for presentation:

**Pre-filtering (code-side, before LLM call):**
1. **Active entries**: All entries within `activeWindow` days (default 14). This naturally includes recent decisions.
2. **Open items**: All `type: "task"` with `status: "open"` + all `type: "question"`. No time limit.
3. **Stale candidates**: Entries whose subject appears in the active window but whose most recent entry is older than `staleThreshold` days (default 30).
4. **Durable entries**: Older `decision`/`fact` entries with positive usage score from `state.json.eventUsage`, scored as `2*citationCount + memoryGetCount + 0.25*memorySearchCount`, capped to top 10.

These sets are unioned and deduped by ID. Only the resulting entries are sent to the LLM.

**Presentation (LLM-side):**
The snapshot model receives pre-bucketed entries plus subject-activity summaries and produces a MEMORY snapshot, typically using:
- `## Snapshot`
- `## Human Interests`
- `## Active Projects and Systems`
- `## Conversation Focus`
- `## Active Tasks`
- `## Open Questions`
- `## Recent Decisions`
- `## Stale Threads`
- `## Durable Memory`
- `## Risks or Watchouts` (optional)

The LLM handles presentation grouping, prioritization, and consolidation but does not need to apply time-window filtering — that's already done.

Constraints:
- Max 80 lines between markers (enforced by `limitLines` post-LLM).
- Content outside markers is never touched.
- The generated block is the only part the nightly job writes to.

### 5.3 Contract

MEMORY.md is auto-loaded into every OpenClaw session (first 200 lines). The manual section provides intent. The generated section provides state. Together they orient the agent without any search or file reads.

The log is authoritative. The generated snapshot is a cache. When they disagree, the log wins.

**MEMORY.md is the only file from OpenClaw's default memory layout that survives.** Daily notes (`memory/YYYY-MM-DD.md`) are eliminated — the log replaces their function. MEMORY.md persists because it's auto-loaded by OpenClaw's session bootstrap (this behavior is independent of the memory plugin slot).

### 5.4 Retrieval Order

When the agent needs information beyond what MEMORY.md and the handoff provide, it uses the zettelclaw-provided memory tools:

1. **MEMORY.md** — auto-loaded by OpenClaw session bootstrap. Already in context.
2. **Zettelclaw session handoff** — written into MEMORY.md between managed markers on each successful extraction when a handoff entry is produced.
3. **`memory_search`** — zettelclaw's wrapped tool. Two search paths:
   - **Log search** (structured filters + ripgrep): precise lookups by type, subject, status. Keyword search over content/detail fields.
   - **MEMORY.md search** (builtin semantic): delegated to OpenClaw's builtin for hybrid BM25+vector search over the manual section.
4. **`memory_get`** — zettelclaw's wrapped tool. Reads specific log entries by ID, MEMORY.md content, or transcript files by session ID (provenance lookups). ID reads increment usage counters used by durable snapshot selection.

Each step is more expensive than the last. Most sessions should resolve from steps 1-2 (zero tool calls). Step 3 covers specific lookups and exploration. Step 4 is for deep dives into specific entries or original session transcripts when the log entry alone doesn't have enough context.

When the main agent references a prior event in conversation, it should cite the event as `[<12-char-id>]` (from tool results). Extraction uses this citation format for usage tracking and clearer transcript provenance.

## 6. Session Handover

### 6.1 Handoff persistence in MEMORY.md

When extraction appends new entries to `log.jsonl`, it checks the newly appended entries for a handoff.
If found, zettelclaw rewrites the `<!-- BEGIN ZETTELCLAW SESSION HANDOFF -->` / `<!-- END ZETTELCLAW SESSION HANDOFF -->`
managed block in MEMORY.md with the latest handoff content.

The generated handoff block looks like:

```
## Zettelclaw Session Handoff
Session: abc12345 (2026-02-20T15:30:00Z)
Auth migration — retry logic implementation, backfill script not started
Detail: Exponential backoff working in staging. Still need backfill script for 47 failed jobs, then canary deploy. Load testing not done yet.
```

If the handoff markers are missing, extraction appends them to MEMORY.md and writes the latest
handoff between them.

### 6.2 Implementation note

MEMORY.md now has two generated sections:
- **Nightly snapshot block** (`BEGIN/END ZETTELCLAW MEMORY SNAPSHOT`) written by the cron snapshot job.
- **Zettelclaw session handoff block** (`BEGIN/END ZETTELCLAW SESSION HANDOFF`) written by extraction when a new handoff is appended.

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
    briefing.md                   # Memory snapshot generation prompt for nightly cron
    agents-memory-guidance.md     # Managed guidance block inserted into AGENTS.md
    memory-zettelclaw-notice.md   # Managed notice block inserted into MEMORY.md
    post-init-system-event.md     # System-event template used by init guidance notification
  src/
    plugin.ts                     # Plugin entry — registers hooks, tools, CLI commands
    config.ts                     # Plugin config schema and validation
    extraction/
      prompt.ts                   # Build extraction prompt (system + user) with existing entries
      shared.ts                   # JSONL parsing, subject detection, aux field stripping
    hooks/
      extraction.ts               # session_end / before_reset / gateway_start — route events to pipeline
      pipeline.ts                 # Core extraction pipeline — LLM call, parse, write entries
      session-discovery.ts        # gateway_start sweep — find un-extracted/failed sessions
      transcript-utils.ts         # Locate and read transcript files by session/agent ID
    memory/
      handoff.ts                  # Format and write ZETTELCLAW SESSION HANDOFF block in MEMORY.md
      managed-block.ts            # Shared utility for marker-delimited block replacement
      markers.ts                  # All managed-block marker constants (briefing, handoff, guidance, notice)
    tools/
      memory-search.ts            # Wraps builtin memory_search — adds structured filters + log search rendering
      memory-get.ts               # Wraps builtin memory_get — adds entry-by-ID and transcript lookups
      shared.ts                   # Shared tool result formatting (textResult)
    briefing/
      generate.ts                 # Read log, run snapshot prompt, rewrite MEMORY.md block
    log/
      schema.ts                   # Entry types, validation, nanoid generation, type/status parsers
      query.ts                    # Structured log queries (type/subject/status filters) + ripgrep search
    subjects/
      registry.ts                 # Read/write subjects.json, auto-create, rename/merge
    state.ts                      # Dedup state (extractedSessions, failedSessions, eventUsage, importJobs)
    state-normalize.ts            # State file normalization and validation helpers
    store/
      files.ts                    # File I/O helpers for state/registry persistence
    import/
      adapters/
        chatgpt.ts                # ChatGPT JSON export → ImportedConversation[]
        claude.ts                 # Claude JSON export → ImportedConversation[]
        grok.ts                   # Grok JSON export → ImportedConversation[]
        openclaw.ts               # OpenClaw transcript migration → ImportedConversation[]
        shared.ts                 # Shared adapter utils (readString, parseTimestampMs, normalizeRole)
      extract.ts                  # Import extraction — LLM call with historical-mode prefix
      extract-policy.ts           # Retry and quality policy for import extraction
      extract-quality.ts          # Extraction output quality checks
      extract-timestamp.ts        # Historical timestamp resolution and normalization
      run.ts                      # Import runner — orchestrate conversation→entries pipeline
      sessions.ts                 # Session ID generation for imported conversations
      types.ts                    # Shared import type definitions
    lib/
      chat-completions.ts         # OpenAI-compatible chat completions HTTP client
      cron-jobs-store.ts          # Read/write ~/.openclaw/cron/jobs.json
      gateway.ts                  # API base URL resolution
      guards.ts                   # Shared type guards (isObject, isEnoent, isNonEmptyString, escapeRegex, normalizeError)
      llm.ts                      # High-level LLM call wrappers (extractFromTranscript)
      openclaw-cron.ts            # Cron job registration helpers
      path.ts                     # Path resolution utilities
      runtime-env.ts              # Runtime environment detection
      text.ts                     # Shared text processing (normalizeWhitespace, extractTextContent)
      transcript.ts               # Transcript parsing and formatting
    cli/
      commands.ts                 # CLI command registration entry point
      command-like.ts             # Commander-compatible interface for CLI commands
      parse.ts                    # CLI option parsing helpers
      paths.ts                    # CLI path resolution from config
      openclaw-config.ts          # OpenClaw config read/write for init/uninstall
      register-setup-commands.ts  # init, uninstall, verify commands
      register-log-commands.ts    # log, search, trace commands
      register-subject-commands.ts # subjects add/rename/list commands
      register-briefing-commands.ts # snapshot + handoff refresh commands
      register-import-commands.ts # import, import status/resume commands
      import-detect.ts            # Auto-detect import source platform
      import-file-ops.ts          # Import file read/backup/cleanup
      import-job-cron.ts          # Async import job cron worker registration
      import-job-format.ts        # Import job status formatting
      import-job-options.ts       # Import job option parsing
      import-job-store.ts         # Import job state persistence
      import-ops.ts               # Import execution logic
      import-ui.ts                # Import CLI user feedback
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
| **`memory_search` tool** | Wraps `api.runtime.tools.createMemorySearchTool()` | Builtin semantic/keyword search + structured log filters + ID-forward log result rendering |
| **`memory_get` tool** | Wraps `api.runtime.tools.createMemoryGetTool()` | Builtin file reads + log entry-by-ID + transcript lookups by session ID |
| Extraction hooks | Plugin hooks: `session_end`, `before_reset` | Primary (`session_end`) and secondary (`before_reset`) triggers route through `hooks/pipeline.ts` |
| Startup sweep | Plugin hook: `gateway_start` | Sweep for un-extracted and failed sessions via `hooks/session-discovery.ts` |
| Handoff writer | Extraction post-processing | Rewrites MEMORY.md `ZETTELCLAW SESSION HANDOFF` managed block when new handoff is appended |
| Nightly cron | `cron/jobs.json` job upsert during init | Rewrite MEMORY.md generated snapshot block (LLM-powered) |
| Skill | `skills/zettelclaw/SKILL.md` | Agent instructions for the memory system |
| CLI: init | Plugin-registered command | Create log directory, set memory slot, disable flush, register cron, add generated snapshot + handoff markers to MEMORY.md |
| CLI: uninstall | Plugin-registered command | Revert init-time OpenClaw config changes and remove generated snapshot block from MEMORY.md (log data preserved) |
| CLI: verify | Plugin-registered command | Validate setup files/config/markers/cron and print per-check pass/fail |
| CLI: log | Plugin-registered command | Pretty-print recent log entries |
| CLI: search | Plugin-registered command | Search log with filters (type, subject, status, date range) |
| CLI: trace | Plugin-registered command | Trace chronological subject event sequences |
| CLI: import | Plugin-registered command | Queue async historical import workers by default (chatgpt/claude/grok/openclaw), with state-based dedupe, chronological processing, extraction context, subject type upsert, optional transcript generation, and optional source backup/cleanup |
| CLI: import status/resume | Plugin-registered command | Inspect async import jobs and re-queue eligible jobs from `state.json.importJobs` |
| CLI: subjects | Plugin-registered command | `add`, `rename`, `list` — manage subject registry (`add` defaults type to `topic`) |
| CLI: snapshot generate | Plugin-registered command | Run snapshot generation immediately and rewrite MEMORY.md generated block |
| CLI: handoff refresh | Plugin-registered command | Force-refresh the MEMORY.md `ZETTELCLAW SESSION HANDOFF` managed block from the latest handoff event in `log.jsonl` |

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
5. Registers the nightly cron job for snapshot generation
6. Adds generated snapshot markers and handoff markers to MEMORY.md:
   - `<!-- BEGIN ZETTELCLAW MEMORY SNAPSHOT -->` / `<!-- END ZETTELCLAW MEMORY SNAPSHOT -->`
   - `<!-- BEGIN ZETTELCLAW SESSION HANDOFF -->` / `<!-- END ZETTELCLAW SESSION HANDOFF -->`
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
      "timezone": "America/New_York"
    }
  }
}
```

`logDir` contains `log.jsonl`, `subjects.json`, and `state.json`. All in one directory.

Search/embedding configuration is inherited from the user's existing `agents.defaults.memorySearch` settings — no separate search config needed. The builtin indexer handles MEMORY.md semantic search; log search is handled by the wrapper via structured filters + ripgrep.

### 8.5 Nightly cron job

Registered/updated during `init` by writing `~/.openclaw/cron/jobs.json`:
- Job name: `zettelclaw-memory-snapshot`
- Schedule: `config.cron.schedule` (default `0 3 * * *`)
- Timezone: `config.cron.timezone` (defaults to local timezone if unset)
- Session target: `isolated`
- Wake mode: `now`
- Payload: `Run: openclaw zettelclaw snapshot generate`
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
- Structured filters on top (type, subject, status)
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

**Execution flow:**
1. At least one of `query`, `type`, `subject`, or `status` must be present.
2. If structured filters are provided (`type`, `subject`, `status`), run direct structured query over `log.jsonl`.
3. If `query` is provided, run direct keyword search over `log.jsonl` (`content`/`detail`) with the same filters.
4. If `query` is provided and builtin `memory_search` is available, also run builtin semantic search over indexed markdown content (e.g., `MEMORY.md`).
5. Merge and dedupe lines from all sources. Log-backed lines are rendered with IDs inline (e.g., `[id=abc123def456] ...`) so they can be cited in transcript references.

`memory_search` increments `eventUsage.memorySearchCount` for log-backed result IDs (structured + keyword matches), a weaker signal than explicit ID fetches.

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
2. If `path` matches a 12-character nanoid pattern (e.g., `r7Wp3nKx_mZe`) — look up the log entry by ID in `log.jsonl`, increment `eventUsage.memoryGetCount` for that ID, and return the full entry JSON with all fields.
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

6. **Handoff persistence**: End a session that emits a handoff. Verify MEMORY.md `ZETTELCLAW SESSION HANDOFF` block is updated. Start a new session and confirm the handoff appears via MEMORY.md auto-load.

7. **Nightly snapshot**: Run `openclaw cron run <zettelclaw-memory-snapshot>`. Verify MEMORY.md's generated block is updated. Verify manual content outside the markers is preserved. Verify the snapshot reflects current interests, active projects/systems, conversation focus, active tasks, open questions, and durable memory from the log.

8. **Memory tools**: Verify `memory_search` returns structured log entries with type/subject/status filters and includes event IDs in log-backed result lines. Verify keyword search over log entries works via ripgrep ("webhook" finds the retry decision). Verify semantic search over MEMORY.md works via the builtin. Verify `memory_get` reads entries by ID, MEMORY.md by path, and transcripts by `session:` prefix. Verify `memory-core` is disabled (slot occupied by zettelclaw).

8a. **CLI search**: Run `openclaw zettelclaw search --type decision --subject auth-migration`. Verify correct filtered results.

8b. **CLI trace**: Run `openclaw zettelclaw trace` (and `openclaw zettelclaw trace <id>`). Verify chronological subject sequences render correctly.

8c. **Usage counters**: Read an entry via `memory_get` by ID, run a `memory_search` that returns log-backed IDs, and cite `[<id>]` in a later transcript. Verify `state.json.eventUsage` increments (`memoryGetCount`, `memorySearchCount`, `citationCount`) for referenced IDs.

8d. **Async import jobs**: Start `openclaw zettelclaw import ...` (non-dry-run). Verify a queued job appears in `state.json.importJobs`, trackable via `openclaw zettelclaw import status <jobId>`, and recoverable with `openclaw zettelclaw import resume <jobId>` when needed.

9. **End-to-end continuity**: Work across 3 sessions in one day. Verify each session starts with the previous session's handoff. Start a session the next morning after the nightly cron. Verify MEMORY.md snapshot reflects all three sessions' activity.

10. **Corrections**: Tell the agent a previous fact was wrong and reference the old entry as `[<id>]` in transcript text. Verify the correction enters the log as a new entry on the same subject. Verify the next snapshot reflects the corrected version.

## Appendix A: Implementation Review Resolutions (2026-02-28)

Resolutions from review of the draft spec against OpenClaw's actual API surface:

| # | Question | Resolution |
|---|---|---|
| 1 | nanoid/timestamp generation | Live extraction LLM outputs entries without `id`, `timestamp`, `session`; hook injects all three. Import extraction may emit optional `timestamp`; persisted import entries preserve valid extracted timestamps and fall back to conversation `updatedAt` when missing/invalid. |
| 2 | Subject management | CLI commands `subjects add` and `subjects rename` (rename seds the log). Extraction hook upserts subjects (auto-create + valid type updates). |
| 3 | Timestamp source | Live extraction timestamps are hook-injected at extraction time. Import pipeline persists model/extraction historical timestamps when valid, with fallback to each conversation `updatedAt`. |
| 4 | Extraction triggers | Plugin hook API provides `session_end`, `before_reset`, `before_compaction`, `after_compaction`, `session_start` — richer than internal hooks. Primary: `session_end` (all session ends). Secondary: `before_reset` (provides `messages[]` inline). Sweep: `gateway_start`. Scope: main sessions only (skip subagents, cron, hooks). |
| 5 | Transcript access | `before_reset` uses `messages[]` first, then `sessionFile`, then `(agentId, sessionId)` transcript lookup fallback. `session_end` resolves by `sessionId`. `.reset.*` variants are supported. |
| 6 | Snapshot generation | LLM-powered summarization for the generated MEMORY.md block. |
| 7 | Obsidian layer | Deferred to v2. |
| 8 | Historical continuity | Full append-only history retained; continuity is reconstructed by subject + timestamp ordering. |
| 9 | Session ID format | OpenClaw's `sessionId` from hook event context. Maps to `<sessionId>.jsonl` transcript. |
| 10 | Duplicate handoffs | `state.json` tracks `extractedSessions` map (set of sessionIds). Same session = skip. Failed sessions tracked with retry count (max 1 retry). Map pruned after 30d. |
| 11 | JSONL indexing | Builtin indexer is markdown-only. Log search handled by wrapper (structured filters + ripgrep). Semantic search covers MEMORY.md only for v1. |
| 12 | Handoff persistence | Extraction rewrites MEMORY.md `ZETTELCLAW SESSION HANDOFF` block when new handoff entries are appended. `before_prompt_build` hook eliminated — MEMORY.md auto-load handles injection. |
| 13 | Extraction model | Sonnet (configurable via `extraction.model`). |
| 14 | Scope filtering | Only main sessions extracted. Skip `cron:`, `sub:`, `hook:` session key prefixes. |
| 15 | Error handling | Retry extraction once on failure. Mark as permanently failed after second failure. `gateway_start` sweep also retries. |
| 16 | Migration/import | Includes CLI import tooling (`openclaw zettelclaw import`) for chatgpt/claude/grok/openclaw sources, queued async by default via isolated cron workers, with state-based dedupe, chronological processing (oldest to newest), import extraction context (`## Existing Entries` with IDs), subject type upsert from `subjectType` hints, malformed-output repair retry, `import status/resume` job management, and optional source backup/cleanup for openclaw migration. |
| 17 | Subject type enum | Constrained to `project \| person \| system \| topic`. Default `topic`. Subject type comes exclusively from explicit `subjectType` hints in extraction output; no programmatic slug-based inference. Validated on creation with fallback. |
| 18 | Snapshot pre-filtering | Four buckets (active entries, open items, stale subjects, durable entries) pre-filtered in code before LLM call. `decisionWindow` config removed — decisions are covered by `activeWindow`. LLM handles presentation only. |
| 19 | Extraction context | Existing log entries (subject-relevant + open items) fed to extraction LLM to avoid duplicates and reason about chronology. Capped at 50 entries per subject and rendered chronologically (oldest to newest). |
| 20 | Chronological lineage | Subject history is reconstructed by sorting entries by timestamp; no explicit replacement-link field. |
| 21 | Long-term recall signals | `state.json.eventUsage` tracks `memoryGetCount`, `memorySearchCount`, and `citationCount` per event, and nightly snapshot includes top durable entries outside recency window using score `2*citationCount + memoryGetCount + 0.25*memorySearchCount`. |
| 22 | Subject requirement | `subject` is required for non-handoff entries. Missing non-handoff subjects are normalized to `unknown` before validation/write. |
| 23 | Transcript ID style | Event references in transcripts use bracketed IDs (`[<12-char-id>]`) for provenance and usage tracking. |

## Appendix B: Build Order

Recommended implementation sequence. Each phase is independently testable.

### Phase 1: Core log + schema
- `log/schema.ts` — entry types, validation, nanoid generation, type/status parsers
- `log/query.ts` — structured filters (type/subject/status) + ripgrep wrapper
- `subjects/registry.ts` — read/write subjects.json, auto-create
- `state.ts` + `state-normalize.ts` — extractedSessions/failedSessions tracking and normalization
- `lib/guards.ts` — shared type guards (isObject, isEnoent, isNonEmptyString, escapeRegex, normalizeError)
- `lib/text.ts` — shared text processing (normalizeWhitespace, extractTextContent)
- **Test:** Write entries manually to `log.jsonl`, query by filters/subject/date, verify chronological ordering

### Phase 2: Extraction hooks
- `hooks/extraction.ts` — `session_end`, `before_reset`, `gateway_start` event routing
- `hooks/pipeline.ts` — core extraction pipeline (LLM call → parse → write)
- `hooks/session-discovery.ts` — `gateway_start` sweep for un-extracted sessions
- `hooks/transcript-utils.ts` — transcript file location and reading
- `extraction/prompt.ts` — build extraction prompt with existing entries context
- `extraction/shared.ts` — JSONL parsing, subject detection, aux field stripping
- `prompts/extraction.md` — extraction prompt (from spec section 4.2)
- Post-processing pipeline (parse LLM output → normalize missing non-handoff subject to `unknown` → validate → inject id/timestamp/session → upsert subject registry (add/update type) → append to log)
- Dedup via state.json
- Scope filtering (main sessions only)
- Error handling (retry once, mark failed)
- **Test:** Run a real session, hit `/new`, verify log entries appear with correct fields

### Phase 3: Memory tools (wrapped)
- `tools/memory-search.ts` — wrap builtin, add structured filters + ripgrep log search
- `tools/memory-get.ts` — wrap builtin, add entry-by-ID + session transcript reads
- Plugin manifest (`openclaw.plugin.json`) with `kind: "memory"`
- `plugin.ts` — register tools, hooks, CLI
- **Test:** Install plugin, verify `memory_search` with type/subject filters works, verify `memory_get` by entry ID works, verify `memory-core` is disabled

### Phase 4: Handoff persistence
- `memory/handoff.ts` — format and write ZETTELCLAW SESSION HANDOFF managed block in MEMORY.md
- `memory/markers.ts` — canonical marker constants (briefing, handoff, guidance, notice)
- Extraction post-processing writes `ZETTELCLAW SESSION HANDOFF` markers in MEMORY.md
- **Test:** End a session with a handoff, verify MEMORY.md handoff block updates and is loaded in the next session

### Phase 5: Memory snapshot generation
- `prompts/briefing.md` — memory snapshot generation prompt
- `briefing/generate.ts` — read log, run LLM, rewrite MEMORY.md generated block
- Nightly cron registration
- **Test:** Run cron manually, verify MEMORY.md generated block reflects snapshot state

### Phase 6: CLI + init
- `cli/commands.ts` — CLI entry point and command tree registration
- `cli/register-setup-commands.ts` — init, uninstall, verify
- `cli/register-log-commands.ts` — log, search, trace
- `cli/register-subject-commands.ts` — subjects add/rename/list
- `cli/register-briefing-commands.ts` — snapshot generate + handoff refresh commands
- `cli/register-import-commands.ts` — import, import status/resume (delegates to `cli/import-*.ts` modules)
- `memory/markers.ts` — canonical marker constants shared by CLI init, briefing, handoff, and tests
- `init` flow: create log dir, set memory slot, disable flush, register cron, add markers
- SKILL.md — agent instructions for the memory system
- **Test:** Full `openclaw plugins install zettelclaw && openclaw zettelclaw init` flow

## Appendix C: OpenClaw Reference Materials

This appendix is intentionally minimal. The current source of truth is the plugin code in `packages/plugin`.

Primary files:
- `src/plugin.ts` (registration)
- `src/hooks/extraction.ts` (event routing)
- `src/hooks/pipeline.ts` (core extraction pipeline)
- `src/hooks/session-discovery.ts` (startup sweep)
- `src/extraction/shared.ts` (JSONL parsing, subject detection)
- `src/extraction/prompt.ts` (extraction prompt construction)
- `src/tools/memory-search.ts`
- `src/tools/memory-get.ts`
- `src/cli/commands.ts` (CLI entry point)
- `src/cli/register-*.ts` (command registration by domain)
- `src/briefing/generate.ts`
- `src/log/{schema,query}.ts`
- `src/lib/guards.ts` (shared type guards)
- `src/lib/text.ts` (shared text processing)
- `src/memory/markers.ts` (managed-block marker constants)
- `src/import/adapters/shared.ts` (shared adapter utilities)

External API assumptions should be validated against the installed OpenClaw plugin SDK types when upgrading OpenClaw.
