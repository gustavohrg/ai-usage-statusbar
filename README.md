# AI Usage Pulse GH 2026

Real-time Claude, Codex, Copilot, and optional Antigravity usage monitoring
directly in the VS Code status bar.

This repository is an independent maintained version focused only on the VS Code
extension.

## Installation

### From VS Code Marketplace

1. Open Extensions in VS Code.
2. Search for `AI Usage Pulse GH 2026`.
3. Click Install.

Direct link (after publish):
https://marketplace.visualstudio.com/items?itemName=gustavohrg.ai-usage-statusbar-gustavohrg-2026

### From VSIX (manual install)

```bash
npm ci
npm run package:vsix
code --install-extension ai-usage-statusbar-gustavohrg-2026-<version>.vsix --force
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

- Single status bar indicator with Claude, Codex, Copilot, and optional
  Antigravity usage summary
- Provider-level threshold warnings with text badges and theme-aware colors
- Tooltip breakdown for 5-hour and 7-day windows
- Antigravity tooltip details for Gemini, Claude/GPT, account, plan, and
  fallback data
- Bundled Font Awesome outline identity assets and VS Code custom icon
  contributions with readable provider-name fallback text
- 60-second auto-refresh
- Copilot estimated spend and token volume from local VS Code chat history

## Provider Support

| Provider    | Data source                                                  | Status                              |
| ----------- | ------------------------------------------------------------ | ----------------------------------- |
| Claude      | OAuth usage API (`~/.claude/.credentials.json`)              | Supported                           |
| Codex       | `codex app-server` (`account/rateLimits/read`) with fallback | Supported                           |
| Copilot     | Local VS Code workspace storage and transcripts              | Supported (estimated credits/spend) |
| Antigravity | Running local `agy` process over loopback HTTP/HTTPS         | Supported (opt-in)                  |

Antigravity is read-only and local-process-only. The extension does not launch
`agy`, scrape its terminal UI, implement Google OAuth, or use the third-party
`antigravity-usage` package. Enable it only when `agy` is already running:

```json
{
  "aiUsageMonitor.enabledProviders": [
    "claude",
    "codex",
    "copilot",
    "antigravity"
  ]
}
```

The monitor first requests `RetrieveUserQuotaSummary`, then falls back to
`GetUserStatus` and `GetCommandModelConfigs` when needed. Missing 5-hour data is
shown as missing; it is never synthesized from weekly or model-level data.

## Configuration

Configure the extension in `settings.json` using `aiUsageMonitor.*` keys.

Example:

```json
{
  "aiUsageMonitor.enabledProviders": [
    "claude",
    "codex",
    "copilot",
    "antigravity"
  ],
  "aiUsageMonitor.enableThresholdColors": true,
  "aiUsageMonitor.copilotWindowMode": "currentMonth",
  "aiUsageMonitor.copilotLookbackDays": 30,
  "aiUsageMonitor.warningThreshold": 70,
  "aiUsageMonitor.criticalThreshold": 85
}
```

## Status Bar Example

```text
$(ai-usage-claude) 72% 1h 30m   $(ai-usage-codex) 85% 45m   $(ai-usage-copilot) 18% $20.2 1.4M tok
```

The `$(ai-usage-*)` references resolve to the bundled Font Awesome provider
icons in VS Code. Tooltip headings enable VS Code theme icons and retain the
provider name for accessibility.

## Requirements

- VS Code 1.79+
- At least one configured provider tool used locally at least once
- Optional tools per provider:
  - Claude Code credentials file
  - Codex CLI in PATH
  - GitHub Copilot chat history in VS Code local storage
  - Antigravity CLI `agy` already running for local quota probing

Antigravity currently depends on `lsof` to discover `agy`'s loopback listeners.
Its local HTTPS endpoint uses a self-signed certificate; certificate
verification is disabled only for requests sent to `127.0.0.1`.

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
