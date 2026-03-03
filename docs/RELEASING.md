# Releasing Reclaw

This repo publishes two release artifacts from one GitHub Release:

- `reclaw` plugin package to npm
- `@reclaw/skill` bundle to ClawHub (slug: `reclaw`)

The publish automation runs from `.github/workflows/release.yml` on `release.published`.

## Prerequisites

1. You can publish GitHub Releases in this repo.
2. GitHub Actions trusted publishing is enabled for npm (OIDC) for package `reclaw`.
3. Repository secret `CLAWHUB_TOKEN` is set.
4. `packages/plugin/package.json` and `packages/skill/package.json` have the same `version`.

## Preflight

Run preflight from repo root:

```bash
bun run release:preflight
```

The preflight validates:

- clean git tree
- plugin/skill version alignment
- release tag availability (`v<version>`)
- npm version availability for `reclaw`
- lint and tests
- `npm pack --dry-run` for plugin and skill

## Publish

1. Push your release commit(s) to `origin/master`.
2. Create and push the version tag:

```bash
version="$(node -p "require('./packages/plugin/package.json').version")"
git tag "v$version"
git push origin "v$version"
```

3. Create a GitHub Release for tag `v<version>` and click **Publish release**.
4. Watch the `Release` workflow; it publishes both npm + ClawHub artifacts.

## Post-publish checks

```bash
version="$(node -p "require('./packages/plugin/package.json').version")"
npm view "reclaw@$version" version
```

Then verify the new skill version in ClawHub.
