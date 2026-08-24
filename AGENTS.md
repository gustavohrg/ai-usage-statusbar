# Repository Instructions

## Release Documentation

- `CHANGELOG.md` is release-only documentation.
- Do not modify `CHANGELOG.md` during implementation, cleanup, planning,
  documentation, branding, or verification work.
- Modify `CHANGELOG.md` only as part of the explicit GitHub release action.
- Preserve historical entries when performing that release update.

## Product Scope

- This repository ships the VS Code extension only; do not reintroduce the
  retired Electron tray application.
- Supported v1 provider configuration IDs are `claude`, `codex`, `copilot`, and
  opt-in `antigravity`.
- `agy` is the Antigravity runtime process name, not a provider configuration
  alias.

## Provider Identity

- Provider identity uses bundled Font Awesome brand assets, a registered VS Code
  custom icon font for the compact status bar, and outline SVG adaptations for
  local artwork.
- Do not reintroduce user-configurable provider dots, emoji markers, or
  provider-specific status-bar color settings.
- Keep readable provider-name text as the status-bar fallback and tooltip label.
