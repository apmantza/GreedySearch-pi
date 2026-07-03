# Release Workflow

Releases are automated from `package.json` versions and `CHANGELOG.md` sections.
The curated changelog entry is the source of truth for GitHub release notes.

## Cut a Release

1. Bump `package.json`.
2. Add entries under `## [Unreleased]`.
3. Promote the changelog section:

   ```bash
   npm run changelog:release
   ```

   Or with explicit values:

   ```bash
   node scripts/changelog-release.mjs 2.2.0 --date 2026-07-03
   ```

4. Run checks:

   ```bash
   npm run check:lockfile
   npm run lint
   node test.mjs unit
   ```

5. Commit and push to `master`.

## Changelog Scripts

- `npm run changelog:check` — verifies `## [Unreleased]` has releaseable
  entries.
- `npm run changelog:release` — moves `Unreleased` into the current
  `package.json` version and opens a fresh empty `Unreleased` section.
- `npm run changelog:extract -- <version>` — prints release notes for a
  version.
- `npm run release:backfill-notes` — dry-run GitHub release-body backfill.

The parser supports both current headings like:

```markdown
## [2.1.3] — 2026-06-21
```

and older headings like:

```markdown
## v1.8.5 (2026-04-29)
```

so historical releases can be backfilled from the same changelog.

## GitHub Release Notes

`.github/workflows/release.yml` extracts release notes with:

```bash
node scripts/changelog-extract.mjs "$VERSION" --summary -o RELEASE_NOTES.md
```

and passes `RELEASE_NOTES.md` to `softprops/action-gh-release`. GitHub release
bodies therefore match the curated changelog summary instead of generated PR
or commit-title notes.

## Backfill Existing Releases

Preview the update plan:

```bash
npm run release:backfill-notes
```

Apply it with the GitHub CLI authenticated:

```bash
node scripts/backfill-github-releases.mjs --apply
```

Limit to specific tags:

```bash
node scripts/backfill-github-releases.mjs --apply --only v2.1.3,v2.1.2
```

Use `--full` to write the full changelog prose instead of the summarized body.
