#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Clone your current OpenClaw workspace into a temporary test workspace.

Usage:
  scripts/clone-openclaw-workspace.sh [options]

Options:
  --source-workspace <path>   Source workspace (default: ~/.openclaw/workspace)
  --dest-root <path>          Destination root (default: ~/tmp/reclaw-workspaces)
  --name <value>              Folder name under dest root (default: workspace-<timestamp>)
  -h, --help                  Show this help

Environment overrides:
  SOURCE_OPENCLAW_WORKSPACE   Source workspace path
  DEST_ROOT                   Destination root
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

timestamp="$(date +%Y%m%d-%H%M%S)"
source_workspace="${SOURCE_OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
dest_root="${DEST_ROOT:-$HOME/tmp/reclaw-workspaces}"
name="workspace-$timestamp"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-workspace)
      shift
      source_workspace="${1:-}"
      ;;
    --dest-root)
      shift
      dest_root="${1:-}"
      ;;
    --name)
      shift
      name="${1:-}"
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

if [[ -z "$source_workspace" || -z "$dest_root" || -z "$name" ]]; then
  echo "source workspace, destination root, and name must be non-empty" >&2
  exit 1
fi

require_cmd rsync

if [[ ! -d "$source_workspace" ]]; then
  echo "Source workspace not found: $source_workspace" >&2
  exit 1
fi

dest_workspace="$dest_root/$name"
if [[ -e "$dest_workspace" ]]; then
  echo "Destination already exists: $dest_workspace" >&2
  exit 1
fi

mkdir -p "$dest_root"
rsync -a "$source_workspace/" "$dest_workspace/"

echo "Workspace clone created:"
echo "  $dest_workspace"
echo
echo "Run reclaw against the clone:"
echo "  npx reclaw --mode openclaw --workspace \"$dest_workspace\" --state-path \"$dest_workspace/.reclaw-state.json\""
