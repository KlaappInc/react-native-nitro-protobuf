## Summary

<!-- What does this change and why? -->

## Target branch

- [ ] Feature/fix → targets **`develop`** (not `main`)
- [ ] Hotfix → targets **`main`** (and will be back-merged to `develop`)

## Checklist

- [ ] Conventional Commit title (`feat:`, `fix:`, `perf:`, `docs:`, `chore:`, …)
- [ ] `bun run lint-ci` and `bun run format:check` pass
- [ ] `bun run test` passes (unit + native fuzz)
- [ ] If `.proto`/codec changed: regenerated and verified on iOS/Android
- [ ] Docs updated if behavior or API changed
