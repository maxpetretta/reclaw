#!/usr/bin/env bash
set -euo pipefail
future=$(node -e 'console.log(new Date(Date.now()+15000).toISOString())')
add=$(openclaw cron add --at "$future" --disabled --session isolated --name zc-nested-worker-test --message "Reply with exactly nested-worker-ok" --no-deliver --delete-after-run --model anthropic/claude-haiku-4-5 --json)
id=$(printf '%s' "$add" | jq -r '.id')
printf 'id=%s\n' "$id"
openclaw cron run "$id" --expect-final
openclaw cron runs --id "$id" --limit 1
