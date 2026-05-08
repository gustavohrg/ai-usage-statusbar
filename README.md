# AI Usage Monitor

Real-time Claude, Codex, and Copilot usage monitoring directly in the VS Code
status bar.

This repository is an independent maintained version focused only on the VS Code
extension.

## Installation

### From VS Code Marketplace

1. Open Extensions in VS Code.
2. Search for `AI Usage Monitor`.
3. Click Install.

Direct link (after publish):
https://marketplace.visualstudio.com/items?itemName=gustavohrg.ai-usage-statusbar

### From VSIX (manual install)

```bash
npm install
npm run package:vsix
code --install-extension ai-usage-statusbar-0.2.7.vsix --force
```

Then reload VS Code when prompted.

## Features

- Single status bar indicator with Claude, Codex, and Copilot usage summary
- Color-coded threshold warnings
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

- Extension ID: `gustavohrg.ai-usage-statusbar`
- Repository: https://github.com/gustavohrg/ai-usage-statusbar
- Issues: https://github.com/gustavohrg/ai-usage-statusbar/issues
