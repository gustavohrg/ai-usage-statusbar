# Development and Debugging

Quick reference for running this extension locally in VS Code.

## 1) One-time setup

```bash
npm install
npm run compile
```

## 2) Debug profile

This repo includes one debug profile in `.vscode/launch.json`:

- `Run Extension`
  - Launches an Extension Development Host
  - Runs the `npm: compile` pre-launch task
  - Uses `--disable-extensions` to reduce noise from unrelated extensions

The profile sets:

- `NODE_OPTIONS=--no-deprecation --no-warnings`
- `NODE_NO_WARNINGS=1`

This keeps debug console output focused on extension behavior. No standalone
`.vscode/tasks.json` file is required; VS Code discovers the `compile` npm
script from `package.json`.

## 3) Recommended inner loop

For a normal debug launch:

1. Select `Run Extension` in the Run and Debug view.
2. Start the Extension Development Host.

For continuous recompilation while editing, run this in a separate terminal:

```bash
npm run watch
```

## 4) Notes about runtime warnings

Warnings like Node deprecation or experimental runtime messages can come from VS
Code/Electron host internals, not from this extension logic. The debug profile
env settings above are used to reduce that noise during development.

## 5) Useful checks before commit

```bash
npm run compile
npm run package:vsix
```

## 6) Extension Settings

See `README.md` for the full `aiUsageMonitor.*` configuration reference and
`settings.json` example.

## 7) Running as an installed extension (non-debug)

To install and run the extension as a normal user-installed extension instead of
the Extension Development Host:

```bash
# Build and package in one step
npm run package:vsix

# Install into your running VS Code
code --install-extension ai-usage-statusbar-gustavohrg-2026-<version>.vsix --force
```

Then reload the VS Code window when prompted.

**Iteration workflow** (after changing source):

```bash
npm run package:vsix
code --install-extension ai-usage-statusbar-gustavohrg-2026-<version>.vsix --force
# Reload VS Code window
```

> Tip: bump `version` in `package.json` before re-packaging to avoid VS Code
> caching the old build.
