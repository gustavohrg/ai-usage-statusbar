# Antigravity Provider Plan

## Goal

Add an opt-in Antigravity usage monitor to the VS Code extension. Antigravity is
Google's CLI, invoked locally as `agy`.

The first implementation will read quota data from an already-running `agy`
process. It will remain read-only and must not launch the CLI, scrape its
terminal UI, or add a third-party usage package.

## Repository Findings

- Provider selection and status-bar rendering live in `src/extension.ts`.
- Provider adapters live in `src/provider-adapter.ts`.
- Provider configuration is declared in `package.json`.
- The shared `AgentUsage` contract currently models one `fiveHour` window and
  one `sevenDay` window.
- No provider-specific test runner currently exists.
- Antigravity is not part of the default provider list yet.

## Live `agy` Contract

A running local `agy` process was inspected directly.

Observed behavior:

- The process is visible as `agy`.
- It exposes two ephemeral loopback TCP listeners.
- One listener speaks HTTPS and the other speaks HTTP.
- The HTTPS listener uses a self-signed local certificate.
- The CLI endpoint does not require a CSRF header.
- Requests work with `Content-Type: application/json` and
  `Connect-Protocol-Version: 1`.
- An empty JSON request body is accepted.

Primary endpoint:

```text
/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
```

Fallback endpoints:

```text
/exa.language_server_pb.LanguageServerService/GetUserStatus
/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs
```

The live quota-summary response currently exposes weekly buckets for both major
pools:

- Gemini Models
- Claude and GPT models

The response did not contain a 5-hour bucket in the inspected session.
`GetUserStatus` returned account/plan metadata and model-level quota rows.
`GetCommandModelConfigs` returned no model rows in that session.

## Data Parsing Rules

The parser must support all observed remaining-value shapes:

```json
"remainingFraction": 0.82
```

```json
"remaining": {
  "remainingFraction": 0.82
}
```

```json
"remaining": {
  "case": "remainingFraction",
  "value": 0.82
}
```

Usage conversion:

```text
usedPercent = clamp((1 - remainingFraction) * 100, 0, 100)
```

Window classification:

- Explicit `window: "weekly"` means weekly usage.
- Bucket IDs or labels containing `5h`, `5-hour`, or equivalent mean a session
  window.
- Unknown windows remain detailed `other` windows.
- A model row without explicit window metadata must not be mislabeled as a
  5-hour window.
- Disabled buckets or buckets without a valid remaining fraction are not usage
  measurements.

Model-level fallback rows should be grouped by display label, not model ID. The
live CLI returned placeholder model IDs, so classification should use labels
such as Gemini, Claude, and GPT.

## Proposed Usage Contract

Keep the existing compatibility fields:

```ts
fiveHour: UsageResult | null;
sevenDay: UsageResult | null;
```

Add structured detail windows:

```ts
interface UsageWindow {
  label: string;
  utilization: number;
  resetsAt: string;
  kind: 'fiveHour' | 'sevenDay' | 'other';
  usageKnown?: boolean;
}
```

`AgentUsage` should gain an optional collection of these windows. Existing
providers can continue using only `fiveHour` and `sevenDay`.

For Antigravity:

- Preserve every valid quota-summary bucket in the detail collection.
- Project the most-constrained known session bucket into `fiveHour` when one
  exists.
- Project the most-constrained known weekly bucket into `sevenDay` when one
  exists.
- Do not synthesize a missing window.
- Preserve model-level fallback data as detailed windows when its time window is
  unknown.

## Runtime Flow

1. Detect a same-user running `agy` process.
2. Do not rely only on `command -v agy`; aliases, custom installation paths, and
   extension environment differences are possible.
3. Discover the process's listening ports with `lsof`.
4. Probe each candidate port over HTTPS first.
5. Fall back to HTTP when HTTPS fails.
6. Allow disabled certificate verification only for loopback HTTPS connections.
7. Request `RetrieveUserQuotaSummary`.
8. If the response is unsupported or has no usable buckets, request
   `GetUserStatus`.
9. If necessary, request `GetCommandModelConfigs`.
10. Parse the first valid response within a bounded deadline.
11. Return a friendly provider error when `agy` is not running or no endpoint is
    usable.

The provider must not spawn an agent process or send terminal commands to `agy`.

## Extension Integration

### Provider identity

- Configuration key: `antigravity`
- Accepted aliases: `antigravity`, `agy`
- Display name: `Antigravity`
- Status-bar letter: `A`
- Usage scale: `percent`
- Add a distinct configurable provider marker.

### Configuration

Update `package.json`:

- Add `antigravity` to the `enabledProviders` enum.
- Add the Antigravity marker to the provider marker documentation/defaults.
- Keep Antigravity out of the default enabled provider list initially.

Opt-in is intentional. Users without a running `agy` process should not receive
a permanent error segment by default.

### Status bar

The compact segment should use the most constrained known Antigravity window. If
only weekly data is available, display weekly data rather than pretending a
session window exists.

The tooltip should show all known windows, including:

- Gemini weekly/session usage;
- Claude/GPT weekly/session usage;
- model-level fallback rows when their window is unknown;
- account and plan metadata when available;
- the actual source and fallback path used.

## Planned File Changes

### `src/provider-adapter.ts`

Add:

- `getAntigravityUsage()`;
- `agy` process discovery;
- listening-port discovery;
- loopback HTTP/HTTPS request handling;
- quota-summary parsing;
- `GetUserStatus` parsing;
- `GetCommandModelConfigs` parsing;
- Antigravity-specific error formatting;
- the optional detailed-window usage contract.

### `src/extension.ts`

Update:

- `ProviderKey`;
- provider normalization;
- provider refresh dispatch;
- default marker mapping;
- detailed-window tooltip rendering.

### `package.json`

Update provider configuration metadata and documentation.

### `README.md`

Document:

- Antigravity support;
- the `agy` requirement;
- opt-in configuration;
- local-process-only behavior;
- current limitations.

### `CHANGELOG.md`

Record the provider addition when implemented.

## Verification Plan

Add focused parser fixtures using Node's built-in test runner or the smallest
compatible local test setup. Required cases:

1. Complete quota summary with Gemini and Claude/GPT groups.
2. Direct `remainingFraction` values.
3. Nested `remaining.remainingFraction` values.
4. Nested one-of `{ case, value }` values.
5. Weekly-only live response.
6. 5-hour bucket response.
7. Disabled or missing-usage buckets.
8. Legacy `GetUserStatus` fallback.
9. Empty `GetCommandModelConfigs` response.
10. Malformed and numeric reset timestamps.
11. Utilization clamping.
12. No running `agy` process.
13. HTTPS failure followed by HTTP success.

Build verification:

```bash
npm run compile
npm test
```

Live smoke verification with `agy` running:

1. Enable `antigravity` in `aiUsageMonitor.enabledProviders`.
2. Confirm the provider segment appears.
3. Confirm the tooltip reflects the live weekly buckets.
4. Confirm missing 5-hour data is not fabricated.
5. Stop `agy` and confirm a friendly unavailable state.
6. Restart `agy` and confirm recovery on the next refresh.
7. Confirm Claude, Codex, and Copilot behavior remains unchanged.

## Explicit Non-Goals

Initial implementation excludes:

- automatic `agy` process launch;
- PTY lifecycle management;
- terminal/TUI scraping;
- direct Google OAuth implementation;
- remote Cloud Code quota fallback;
- multi-account selection;
- dependency on the third-party `antigravity-usage` CLI;
- platform-specific process discovery beyond the supported local probe path.

These can be considered separately after the local read-only provider is stable.

## References

- [Official Antigravity CLI installer](https://antigravity.google/cli)
- [CodexBar Antigravity provider notes](https://github.com/qinscode/CodexBar/blob/main/docs/antigravity.md)
- [CodexBar Antigravity local probe](https://github.com/qinscode/CodexBar/blob/main/Sources/CodexBarCore/Providers/Antigravity/AntigravityStatusProbe.swift)
- [Third-party `antigravity-usage` CLI](https://github.com/skainguyen1412/antigravity-usage)
  — reference only; not an intended dependency
