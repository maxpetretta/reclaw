#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Validate Reclaw release readiness for npm + ClawHub.

Usage:
  scripts/release-preflight.sh [options]

Options:
  --allow-dirty   Do not fail on uncommitted changes.
  --skip-install   Skip dependency installation.
  --skip-tests     Skip lint + test checks.
  -h, --help       Show this help.
EOF
}

allow_dirty=0
skip_install=0
skip_tests=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) allow_dirty=1 ;;
    --skip-install) skip_install=1 ;;
    --skip-tests) skip_tests=1 ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; print_usage >&2; exit 1 ;;
  esac
  shift
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

pass() { printf "  ✅ %s\n" "$1"; }
warn() { printf "  ⚠️  %s\n" "$1"; }
fail() { printf "  ❌ %s\n" "$1"; exit 1; }
step() { printf "\n== %s ==\n" "$1"; }

require_cmd git
require_cmd node
require_cmd npm
require_cmd bun
require_cmd jq

step "Git status"
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$allow_dirty" -eq 1 ]]; then
    warn "Working tree is dirty; continuing because --allow-dirty was passed."
  else
    fail "Working tree is not clean. Commit or stash changes before releasing."
  fi
else
  pass "Working tree is clean"
fi

step "Version alignment"
plugin_version="$(node -p "require('./packages/plugin/package.json').version")"
skill_version="$(node -p "require('./packages/skill/package.json').version")"

[[ -n "$plugin_version" ]] || fail "Missing packages/plugin version"
[[ -n "$skill_version" ]] || fail "Missing packages/skill version"
[[ "$plugin_version" == "$skill_version" ]] || fail "Version mismatch: plugin=$plugin_version skill=$skill_version"

release_tag="v$plugin_version"
pass "Plugin and skill versions match: $plugin_version"

if git rev-parse -q --verify "refs/tags/$release_tag" >/dev/null 2>&1; then
  fail "Tag $release_tag already exists."
fi
pass "Tag is available: $release_tag"

step "Registry checks"
if npm view "reclaw@$plugin_version" version >/dev/null 2>&1; then
  fail "npm package reclaw@$plugin_version is already published."
fi
pass "npm package version is available: reclaw@$plugin_version"

if npm view "@reclaw/skill@$skill_version" version >/dev/null 2>&1; then
  warn "Found @reclaw/skill@$skill_version on npm (unexpected for current workflow)."
else
  pass "No @reclaw/skill npm collision detected (expected)."
fi

step "Dependencies"
if [[ "$skip_install" -eq 1 ]]; then
  warn "Skipped bun install"
else
  bun install --frozen-lockfile
  pass "Dependencies installed"
fi

if [[ "$skip_tests" -eq 1 ]]; then
  warn "Skipped lint and tests"
else
  step "Quality checks"
  bun run lint
  pass "Lint passed"

  bun test packages/plugin/src/__tests__
  pass "Plugin tests passed"
fi

step "Package dry-run"
plugin_pack_json="$(cd packages/plugin && npm pack --dry-run --json)"
skill_pack_json="$(cd packages/skill && npm pack --dry-run --json)"

plugin_tarball="$(echo "$plugin_pack_json" | jq -r '.[0].filename')"
plugin_files="$(echo "$plugin_pack_json" | jq -r '.[0].files | length')"
skill_tarball="$(echo "$skill_pack_json" | jq -r '.[0].filename')"
skill_files="$(echo "$skill_pack_json" | jq -r '.[0].files | length')"

pass "Plugin pack ok: $plugin_tarball ($plugin_files files)"
pass "Skill pack ok: $skill_tarball ($skill_files files)"

step "Ready to publish"
cat <<EOF
Next steps:
  1) Push commits to origin/master.
  2) Create and push tag: $release_tag
     git tag $release_tag
     git push origin $release_tag
  3) Create a GitHub Release for $release_tag and click Publish.

The release workflow (.github/workflows/release.yml) will:
  - publish reclaw@$plugin_version to npm
  - publish skill version $skill_version to ClawHub (slug: reclaw)
EOF

warn "Ensure GitHub secret CLAWHUB_TOKEN is configured before publishing the release."
