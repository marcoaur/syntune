# Contributing to Syntune

Thanks for wanting to make Syntune better! 💜

## Branch flow

```
feature/your-idea ──PR──▶ develop ──PR──▶ stg ──PR──▶ main ──▶ auto build & release
```

| Branch | Role | Who merges |
|:--|:--|:--|
| `develop` | Integration branch — **all contributions land here** | Maintainer, after review |
| `stg` | Staging — release candidates soak here | Maintainer (PR from `develop` only) |
| `main` | Production — every merge triggers the installer build & GitHub release | Maintainer (PR from `stg` only) |

The flow is enforced by CI: pull requests targeting `main` or `stg` from anywhere other than the previous stage fail automatically. All three branches are protected — no direct pushes, PRs require approval.

## How to contribute

1. **Fork** the repository
2. Create your branch **from `develop`**:
   ```bash
   git checkout develop
   git pull
   git checkout -b feature/my-idea
   ```
3. Code. Match the style around you — vanilla JS, no frameworks, comments in Portuguese are welcome (the codebase speaks both languages)
4. Test with `npm start` (Node 18+)
5. Open a **Pull Request to `develop`** with a clear description of what and why

## Releasing (maintainers)

1. Bump the version on `develop` (`npm run build` bumps patch · `npm run build feature` minor · `npm run build major`) and commit `package.json`
2. PR `develop` → `stg`, let it soak/test
3. PR `stg` → `main`
4. On merge, GitHub Actions builds `Syntune-Setup.exe` + `Syntune-Portable.exe` and publishes the `v<version>` release automatically — the README's `latest/download` links pick it up instantly

## Good first contributions

- 🌍 New UI languages — add a JSON file to `locales/`
- 🐧 USB device detection on Linux/macOS (currently Windows-only)
- 🎵 New metadata sources (Discogs? Deezer?)
- ♿ Accessibility

## License

By contributing you agree your work is licensed under [GPL-3.0](LICENSE) — it stays free, forever, with your name in the history.
