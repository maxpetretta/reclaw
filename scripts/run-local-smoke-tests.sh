#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Run local Reclaw smoke tests end-to-end.

Usage:
  scripts/run-local-smoke-tests.sh [options]

Options:
  --with-inference  Run full extraction (schedules OpenClaw jobs and writes outputs).
                    Default behavior uses --dry-run to avoid inference cost.
  --with-legacy-sessions  Enable legacy session import during smoke runs.
                          Default is off for cloned-workspace smoke reliability.
  --skip-tarball    Skip the installed-tarball smoke pass.
  --keep-tmp        Keep temporary smoke directory after completion.
  -h, --help        Show this help.
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

run_step() {
  local title="$1"
  shift
  printf "\n== %s ==\n" "$title"
  "$@"
}

write_chatgpt_export() {
  local export_root="$1"
  mkdir -p "$export_root/chatgpt"
  cat >"$export_root/chatgpt/conversations.json" <<'EOF'
[
  {
    "id": "smoke-chat-1",
    "title": "Smoke test conversation",
    "create_time": 1700000000,
    "update_time": 1700000060,
    "current_node": "node-2",
    "default_model_slug": "gpt-4o-mini",
    "mapping": {
      "node-1": {
        "id": "node-1",
        "message": {
          "author": { "role": "user" },
          "create_time": 1700000000,
          "content": { "parts": ["Summarize this smoke test export."] }
        }
      },
      "node-2": {
        "id": "node-2",
        "parent": "node-1",
        "message": {
          "author": { "role": "assistant" },
          "create_time": 1700000030,
          "content": { "parts": ["Smoke test assistant response."] }
        }
      }
    }
  }
]
EOF
}

with_inference=0
with_legacy_sessions=0
skip_tarball=0
keep_tmp=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-inference)
      with_inference=1
      ;;
    --with-legacy-sessions)
      with_legacy_sessions=1
      ;;
    --skip-tarball)
      skip_tarball=1
      ;;
    --keep-tmp)
      keep_tmp=1
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
  shift
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

require_cmd bun
require_cmd node
require_cmd npm
require_cmd rsync
require_cmd openclaw

# Fail early if PATH contains a broken openclaw shim.
openclaw --help >/dev/null

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/reclaw-smoke-XXXXXX")"
if [[ "$keep_tmp" -eq 0 ]]; then
  trap 'rm -rf "$smoke_root"' EXIT
fi

echo "Smoke root: $smoke_root"

clone_profile() {
  local name="$1"
  "$repo_root/scripts/clone-openclaw-workspace.sh" --dest-root "$smoke_root" --name "$name" >/dev/null
  printf "%s\n" "$smoke_root/$name"
}

run_reclaw_smoke() {
  local runner="$1"
  local workspace_dir="$2"
  local vault_dir="$3"
  local export_dir="$4"
  local state_path="$5"
  local -a cmd=("${@:6}")

  local args=(
    --yes
    --input "$export_dir"
    --provider chatgpt
    --parallel-jobs 1
    --state-path "$state_path"
    --workspace "$workspace_dir"
    --legacy-sessions "$([[ "$with_legacy_sessions" -eq 1 ]] && echo on || echo off)"
  )

  if [[ "$with_inference" -eq 0 ]]; then
    args+=(--dry-run)
  fi

  run_step "$runner: openclaw mode" "${cmd[@]}" --mode openclaw --target-path "$workspace_dir" "${args[@]}"
  run_step "$runner: zettelclaw mode" "${cmd[@]}" --mode zettelclaw --target-path "$vault_dir" "${args[@]}"
}

run_status_smoke() {
  local runner="$1"
  local state_path="$2"
  local -a cmd=("${@:3}")

  run_step "$runner: status (human)" "${cmd[@]}" status --state-path "$state_path"

  printf "\n== %s ==\n" "$runner: status (json)"
  local json_output
  json_output="$("${cmd[@]}" status --state-path "$state_path" --json)"
  printf "%s\n" "$json_output"
  printf "%s\n" "$json_output" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  const parsed = JSON.parse(raw);
  if (!parsed || !parsed.stateFile || typeof parsed.stateFile.path !== "string") {
    throw new Error("Status JSON missing required stateFile.path");
  }
});
'
}

run_step "Install dependencies" bun install --frozen-lockfile
run_step "Lint" bun run lint
run_step "CLI tests" bun run cli:test
run_step "CLI build" bun run cli:build
run_step "Website build" bun run web:build

run_step "CLI prepack" bun run --cwd packages/cli prepack
run_step "npm pack dry-run" bash -lc "cd \"$repo_root/packages/cli\" && npm pack --dry-run >/dev/null"

tarball_name="$(cd "$repo_root/packages/cli" && npm pack --silent --ignore-scripts | tail -n 1)"
tarball_path="$repo_root/packages/cli/$tarball_name"
echo "Tarball: $tarball_path"

source_profile_dir="$(clone_profile source-smoke-profile)"
source_workspace_dir="$source_profile_dir/workspace"
source_vault_dir="$source_profile_dir/vault-smoke"
source_export_dir="$source_profile_dir/export-smoke"
source_state_path="$source_profile_dir/.reclaw-state.json"
write_chatgpt_export "$source_export_dir"

run_reclaw_smoke "Source smoke" "$source_workspace_dir" "$source_vault_dir" "$source_export_dir" "$source_state_path" bun run cli --
run_status_smoke "Source smoke" "$source_state_path" bun run cli --

if [[ "$skip_tarball" -eq 0 ]]; then
  tarball_app_dir="$smoke_root/tarball-app"
  mkdir -p "$tarball_app_dir"
  run_step "Tarball smoke: npm init" bash -lc "cd \"$tarball_app_dir\" && npm init -y >/dev/null"
  run_step "Tarball smoke: npm install reclaw tarball" bash -lc "cd \"$tarball_app_dir\" && npm install \"$tarball_path\" >/dev/null"

  installed_cli="$tarball_app_dir/node_modules/reclaw/bin/reclaw.js"
  run_step "Tarball smoke: help" node "$installed_cli" --help >/dev/null

  tarball_profile_dir="$(clone_profile tarball-smoke-profile)"
  tarball_workspace_dir="$tarball_profile_dir/workspace"
  tarball_vault_dir="$tarball_profile_dir/vault-smoke"
  tarball_export_dir="$tarball_profile_dir/export-smoke"
  tarball_state_path="$tarball_profile_dir/.reclaw-state.json"
  write_chatgpt_export "$tarball_export_dir"

  run_reclaw_smoke "Tarball smoke" "$tarball_workspace_dir" "$tarball_vault_dir" "$tarball_export_dir" "$tarball_state_path" node "$installed_cli"
  run_status_smoke "Tarball smoke" "$tarball_state_path" node "$installed_cli"
fi

echo
echo "Smoke tests passed."
if [[ "$keep_tmp" -eq 1 ]]; then
  echo "Temporary artifacts kept at: $smoke_root"
fi
