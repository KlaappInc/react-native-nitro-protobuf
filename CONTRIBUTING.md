# Contributing

This repo follows **Git Flow** with automated releases.

## Branches

| Branch | Purpose | Protected |
|--------|---------|-----------|
| `main` | Production. Only release merges land here; every commit is a released version. | yes |
| `develop` | Integration branch (the **default**). All features merge here. | yes |
| `feature/*` | New work. Branch off `develop`, PR back into `develop`. | — |
| `hotfix/*` | Urgent production fix. Branch off `main`, PR into `main`, then back-merge to `develop`. | — |
| `release/*` | Optional. A stabilization branch off `develop` before a release (not required — see Releases). | — |

```
feature/x ─┐
feature/y ─┼─▶ develop ─────▶ main ─▶ (Release + npm publish)
hotfix/z ──────────────────▶ main ─┘ └─▶ back-merge to develop
```

## Workflow

1. Branch off `develop`:
   ```sh
   git switch develop && git pull
   git switch -c feature/my-thing
   ```
2. Commit using **Conventional Commits** (`feat:`, `fix:`, `perf:`, `docs:`,
   `chore:`, `test:`, `ci:`, `refactor:`) — this drives the changelog and version.
3. Open a PR into `develop`. CI (`lint` + `test`, incl. the native ASan/UBSan
   fuzz) must pass before merge.
4. Hotfixes branch off `main`, PR into `main`, and are back-merged into `develop`.

## Releases

Releases are cut from `main` by [release-please](https://github.com/googleapis/release-please):

1. When `develop` is ready, open a PR `develop → main` and merge it.
2. release-please opens a "release" PR on `main` that bumps the version and
   updates `CHANGELOG.md` from the Conventional Commits. Review and merge it.
3. Merging tags a GitHub Release, which triggers `release.yml` to run the test
   suite and publish `@klaappinc/react-native-nitro-protobuf` to npm.

(A manual `release/*` branch is an alternative if you need to stabilize before
merging to `main`, but it is not required — release-please handles versioning.)

## Local development

```sh
bun install
bun run test          # unit + native fuzz (when protoc/nanopb/clang present)
bun run lint-ci       # eslint
bun run format:check  # prettier
bun run ios           # run the example app
```
