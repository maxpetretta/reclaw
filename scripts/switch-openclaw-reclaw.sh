#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Switch OpenClaw's reclaw plugin source between local repo and remote release.

Usage:
  scripts/switch-openclaw-reclaw.sh <mode> [options]

Modes:
  local      Install reclaw from this repo's packages/plugin path.
  latest     Install the latest remote npm release (default: reclaw@latest).
  status     Show current reclaw plugin install details.

Options:
  --repo <path>   Repo root path for local mode (default: script_dir/..).
  --copy          For local mode, copy plugin files instead of linking.
  --link          For local mode, link plugin path (default).
  --spec <spec>   npm spec for latest mode (default: reclaw@latest).
  --no-pin        For latest mode, do not pin resolved version in OpenClaw.
  --pin           For latest mode, pin resolved version (default).
  --init          Run "openclaw reclaw init" after install.
  -h, --help      Show this help.

Examples:
  scripts/switch-openclaw-reclaw.sh local
  scripts/switch-openclaw-reclaw.sh local --copy
  scripts/switch-openclaw-reclaw.sh latest
  scripts/switch-openclaw-reclaw.sh latest --spec reclaw@2026.3.2
  scripts/switch-openclaw-reclaw.sh status
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

note() {
  echo "- $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

show_reclaw_status() {
  echo
  note "Current reclaw plugin status:"
  if ! openclaw plugins info reclaw; then
    fail "Could not read reclaw plugin info."
  fi
}

install_with_retry() {
  local -a install_cmd=("$@")

  if "${install_cmd[@]}"; then
    return 0
  fi

  note "Initial install failed; attempting clean reinstall."
  openclaw plugins uninstall --force reclaw >/dev/null 2>&1 || true
  "${install_cmd[@]}"
}

if [[ $# -lt 1 ]]; then
  print_usage >&2
  exit 1
fi

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  print_usage
  exit 0
fi

mode="$1"
shift

repo_override=""
use_link=1
npm_spec="reclaw@latest"
pin_latest=1
run_init=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || fail "--repo requires a value"
      repo_override="$2"
      shift 2
      ;;
    --copy)
      use_link=0
      shift
      ;;
    --link)
      use_link=1
      shift
      ;;
    --spec)
      [[ $# -ge 2 ]] || fail "--spec requires a value"
      npm_spec="$2"
      shift 2
      ;;
    --no-pin)
      pin_latest=0
      shift
      ;;
    --pin)
      pin_latest=1
      shift
      ;;
    --init)
      run_init=1
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

require_cmd openclaw

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "$script_dir/.." && pwd)"
repo_root="$default_repo_root"
if [[ -n "$repo_override" ]]; then
  repo_root="$(cd "$repo_override" && pwd)"
fi

case "$mode" in
  local)
    plugin_path="$repo_root/packages/plugin"
    [[ -d "$plugin_path" ]] || fail "Local plugin path not found: $plugin_path"
    [[ -f "$plugin_path/openclaw.plugin.json" ]] || fail "Missing manifest: $plugin_path/openclaw.plugin.json"

    note "Switching reclaw to local plugin path:"
    note "  $plugin_path"

    install_cmd=("openclaw" "plugins" "install")
    if [[ "$use_link" -eq 1 ]]; then
      install_cmd+=("--link")
    fi
    install_cmd+=("$plugin_path")

    install_with_retry "${install_cmd[@]}"
    ;;
  latest)
    note "Switching reclaw to remote release spec: $npm_spec"

    install_cmd=("openclaw" "plugins" "install")
    if [[ "$pin_latest" -eq 1 ]]; then
      install_cmd+=("--pin")
    fi
    install_cmd+=("$npm_spec")

    install_with_retry "${install_cmd[@]}"
    ;;
  status)
    show_reclaw_status
    exit 0
    ;;
  *)
    fail "Unknown mode: $mode (expected: local, latest, status)"
    ;;
esac

openclaw plugins enable reclaw >/dev/null 2>&1 || true

if [[ "$run_init" -eq 1 ]]; then
  note "Running: openclaw reclaw init"
  openclaw reclaw init
fi

show_reclaw_status
