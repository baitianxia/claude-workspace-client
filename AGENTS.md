# Project development rules

## Branch and commit workflow

- `main` is the default and only development branch for this repository.
- Work directly on `main`; do not create, switch to, or use feature branches or
  worktrees unless the user explicitly changes this rule.
- Keep the working tree clean before starting a separate change, and commit
  completed changes to `main` with a message that describes the user-visible
  behavior.

## Required checks

- Read the current documentation under `docs/` before changing behavior.
- Preserve the current enterprise WeCom synchronization and Claude session
  binding behavior when importing older work.
- Run the relevant type checks and tests before declaring a change complete.
- Do not mark Windows release remediation as accepted without real Windows x64
  PowerShell 5.1 lifecycle evidence; Linux checks do not replace that evidence.

## Documentation ownership

- Update `README.md` and the applicable document under `docs/` in the same
  change when a user-visible path, workflow, or release contract changes.
- Keep `docs/windows-remediation-2026-09.md` as the owner of Windows release
  acceptance criteria. Do not silently replace its 7z requirement with ZIP.
