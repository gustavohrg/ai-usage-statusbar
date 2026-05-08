# AI Usage Monitor GH

Real-time Claude, Codex, and Copilot usage monitoring directly in the VS Code
status bar.

This repository is an independent maintained version focused only on the VS Code
extension.

## Installation

### From VS Code Marketplace

1. Open Extensions in VS Code.
2. Search for `AI Usage Monitor GH`.
3. Click Install.

Direct link (after publish):
https://marketplace.visualstudio.com/items?itemName=gustavohrg.ai-usage-statusbar-gustavohrg-2026

### From VSIX (manual install)

```bash
npm install
npm run package:vsix
code --install-extension ai-usage-statusbar-gustavohrg-2026-0.2.10.vsix --force
```

Then reload VS Code when prompted.

### From GitHub Releases

1. Open the Releases page:
   https://github.com/gustavohrg/ai-usage-statusbar/releases
2. Select the latest release.
3. In the right-side Assets section, download the `.vsix` file.
4. Install it with VS Code:

```bash
code --install-extension ai-usage-statusbar-gustavohrg-2026-<version>.vsix --force
```

Then reload VS Code when prompted.

## Features

- Single status bar indicator with Claude, Codex, and Copilot usage summary
- Provider-level threshold warnings (warning and critical badges per provider)
- Tooltip breakdown for 5-hour and 7-day windows
- 60-second auto-refresh
- Configurable provider markers and display options
- Copilot estimated spend and token volume from local VS Code chat history

## Provider Support

| Provider | Data source                                                  | Status                              |
| -------- | ------------------------------------------------------------ | ----------------------------------- |
| Claude   | OAuth usage API (`~/.claude/.credentials.json`)              | Supported                           |
| Codex    | `codex app-server` (`account/rateLimits/read`) with fallback | Supported                           |
| Copilot  | Local VS Code workspace storage and transcripts              | Supported (estimated credits/spend) |

## Configuration

Configure the extension in `settings.json` using `aiUsageMonitor.*` keys.

Example:

```json
{
  "aiUsageMonitor.enabledProviders": ["claude", "codex", "copilot"],
  "aiUsageMonitor.enableThresholdColors": true,
  "aiUsageMonitor.showProviderLetter": true,
  "aiUsageMonitor.providerMarkers": {
    "claude": "🟠",
    "codex": "🔵",
    "copilot": "🟢"
  },
  "aiUsageMonitor.copilotWindowMode": "currentMonth",
  "aiUsageMonitor.copilotLookbackDays": 30,
  "aiUsageMonitor.warningThreshold": 70,
  "aiUsageMonitor.criticalThreshold": 90,
  "aiUsageMonitor.statusBarColors": {
    "disabled": "#8b949e",
    "warning": "#e3b341",
    "critical": "#ff7b72"
  }
}
```

## Status Bar Example

```text
🟠 C 72% 1h 30m 🔵 O 85% 45m 🟢 G 18% $20.2 1.4M tok
```

## Requirements

- VS Code 1.79+
- At least one configured provider tool used locally at least once
- Optional tools per provider:
  - Claude Code credentials file
  - Codex CLI in PATH
  - GitHub Copilot chat history in VS Code local storage

## Attribution

This project is based on MIT-licensed work originally created by Payola Joker.

Original repository: https://github.com/payolajoker/vsix-ai-usage-monitor

This repository is an independent maintained version with ongoing updates and
scope focused on the VS Code status bar extension.

This project is not affiliated with or endorsed by the original author unless
stated otherwise.

## License

MIT. See LICENSE.

## Publisher Metadata

- Extension ID: `gustavohrg.ai-usage-statusbar-gustavohrg-2026`
- Repository: https://github.com/gustavohrg/ai-usage-statusbar
- Issues: https://github.com/gustavohrg/ai-usage-statusbar/issues
