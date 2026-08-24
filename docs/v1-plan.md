# v1 Launch Plan

## Goal

Ship a focused, maintainable VS Code extension for local AI usage monitoring.
Codex is the primary daily-use path and must remain reliable throughout the
cleanup. v1 is an extension-only release; the retired tray application is not a
v1 product surface.

## Current baseline

- Package version: `0.2.14`.
- Runtime entrypoint: `src/extension.ts`.
- Provider/runtime adapter: `src/provider-adapter.ts`.
- Supported providers: Claude, Codex, and Copilot.
- Codex source order: `codex app-server` rate limits, then local session data.
- Copilot source order: local VS Code workspace records, then authenticated API
  rate-limit fallback.
- Refresh interval: 60 seconds.
- Build command: `npm run compile`.
- Package command: `npm run package:vsix`.

The first static audit found no unused TypeScript declarations with
`--noUnusedLocals --noUnusedParameters`. The cleanup therefore removes only
confirmed dead compatibility, stale repository artifacts, and documentation that
describes deleted products. Active provider fallbacks are runtime behavior, not
dead code, and remain in v1.

## Repository target

Keep the root reserved for product metadata and build configuration:

```text
README.md
CHANGELOG.md
ATTRIBUTION.md
LICENSE
package.json
package-lock.json
tsconfig.json
src/
  extension.ts
  provider-adapter.ts
docs/
  v1-plan.md
  development.md
  roadmap/
.github/
.vscode/
```

Generated output, analysis caches, historical handoff snapshots, and removed
product notes must not be part of the active tree or VSIX package.

## Phase 1 — Repository cleanup

1. Consolidate maintainer documentation under `docs/`.
2. Remove stale documents that describe the deleted Electron tray product:
   `PROJECT_ANALYSIS.md`, `SESSION_HANDOFF.md`, `SPEC_PLAN.md`, and `memory/`.
3. Remove tracked Graphify output and ignore `graphify-out/` as generated data.
4. Keep `CHANGELOG.md` historical entries for provenance; do not treat history
   as an active product dependency.
5. Keep `ATTRIBUTION.md`; upstream credit and license obligations are not dead
   code.
6. Exclude `docs/`, generated output, and development-only files from VSIX
   packaging.
7. Replace hard-coded historical VSIX filenames in user and maintainer docs with
   the current generated filename pattern.

## Phase 2 — Legacy and dead-code removal

For every function, branch, alias, and exported symbol:

1. Identify runtime callsites, VS Code contribution points, and provider input
   contracts.
2. Delete code with no callsite, no manifest entry, and no supported external
   contract.
3. Remove undocumented provider aliases and the color-dot
   `aiUsageMonitor.providerMarkers` setting when official-logo rendering
   replaces it.
4. Do not remove a provider fallback only because its name contains `fallback`:
   Codex session parsing and Copilot API rate-limit lookup are active recovery
   paths.
5. Do not remove parser compatibility for observed provider response shapes
   without a replacement fixture and a documented migration decision.
6. Do not leave aliases, deprecated wrappers, commented-out implementations, or
   TODO placeholders after a replacement is merged.

The supported provider configuration IDs for v1 are exactly:

```text
claude
codex
copilot
```

## Phase 3 — Runtime hardening

- Preserve the current status-bar contract: one compact segment per enabled
  provider, threshold badges, and tooltip details.
- Make provider errors explicit and non-fatal; one unavailable provider must not
  prevent other enabled providers from rendering.
- Keep credentials local; never log access tokens or raw credential files.
- Keep the Codex app-server request bounded by its timeout and terminate child
  processes on every settled path.
- Keep Copilot local-history estimation labeled as estimated data.
- Keep configuration defaults and README examples synchronized with
  `package.json`.

### Provider branding and icons

- Replace the current user-configurable color-coded dots and emoji markers with
  the official or brand-approved logos for Claude, Codex, and Copilot.
- Render each provider logo in a consistent outline treatment: monochrome
  stroke/line artwork on a transparent background, with no filled color dots and
  no dependency on emoji fonts. The outline must remain recognizable at compact
  status-bar size.
- Prefer bundled local SVG/PNG assets or a stable VS Code-supported icon
  mechanism; do not load provider artwork from remote URLs at runtime.
- Remove user-configurable marker symbols once the logo contract is in place.
  Provider identity must not depend on arbitrary color choices or emoji fonts.
- Preserve an accessible textual provider name in the segment or tooltip when
  the status-bar surface cannot render a custom image asset.
- Verify logo licensing/attribution and light/dark theme legibility before v1.

The icon change must update `package.json`, README examples, tooltip rendering,
and the VSIX asset allowlist together. Outline assets and their fallback must
remain visually distinct without relying on color alone.

Potential structural follow-up after the cleanup: split provider adapters and
rendering helpers into smaller modules only when the split reduces coupling and
can be verified without changing the displayed contract. No speculative
abstraction is required for v1.

## Phase 4 — Verification gate

Run the smallest relevant checks after each cleanup boundary:

```bash
npm ci
npm run compile
npm run package:vsix
```

The release check must also confirm:

- no stale tray-app, memory, or Graphify paths remain outside historical
  changelog text;
- no undocumented provider alias remains in runtime configuration handling;
- no unreferenced TypeScript declaration remains;
- the VSIX contains the extension runtime and required metadata, but not source,
  maintainer docs, caches, or generated analysis output;
- Codex app-server-first behavior still compiles and the session fallback
  remains reachable;
- Claude and Copilot paths still compile and remain independently renderable.
- status-bar segments and tooltips use the approved provider outline assets,
  with a readable text fallback when the VS Code surface cannot render custom
  artwork;
- the removed color-dot marker setting is absent from the v1 settings schema and
  documentation;

A v1 smoke session should enable Codex, confirm a live status-bar percentage and
reset time, then exercise the unavailable-provider state without crashing the
extension. Claude and Copilot are checked when their local credentials/data are
available.

## Phase 5 — Direct VS Code Marketplace deployment

The final v1 gate is direct publication to the VS Code Marketplace. A GitHub
release or attached VSIX is not a substitute for a Marketplace deployment.

1. Set the release version in `package.json` and `package-lock.json` to the v1
   version (`1.0.0` unless the release decision records another version).
2. Run `npm ci`, `npm run compile`, and `npm run package:vsix` from the exact
   release commit.
3. Publish the generated VSIX directly with the VS Code Marketplace publisher
   credentials, for example `npx @vscode/vsce publish`.
4. Supply the publisher token only through a secret or environment variable; do
   not commit tokens, packaged credentials, or local release artifacts.
5. Confirm the Marketplace listing reports the new version and install the
   published extension in a clean VS Code profile.
6. Verify the installed extension's Codex status-bar flow, provider logos,
   settings, and tooltip behavior after Marketplace propagation.

The deployment is complete only after the Marketplace listing and a clean
installation report the same version and behavior as the release commit.


## Definition of done

v1 is ready when:

- the repository contains only active extension code, required metadata, and
  intentionally retained history;
- every remaining function has a runtime callsite or an explicit VS Code/runtime
  contract;
- supported settings use canonical provider IDs only;
- stale product documentation and generated analysis artifacts are removed;
- `npm run compile` and VSIX packaging pass;
- the packaged extension excludes development and repository-internal files;
- README, changelog, package metadata, and `docs/` agree on scope and commands;
- Codex daily monitoring behavior is unchanged in the supported app-server and
  session-data scenarios.
- provider logos use the approved outline treatment, are bundled,
  license-reviewed, and render legibly in both light and dark VS Code themes;
- the v1 package is published directly to the VS Code Marketplace;
- a clean VS Code profile can install the published version and exercise the
  Codex monitoring path;

## Explicit non-goals

- Reintroducing or maintaining the Electron tray application.
- Adding a remote backend or telemetry pipeline.
- Adding a new provider as part of the cleanup.
- Replacing the current Codex data sources without evidence and fixtures.
- Large refactors that do not remove a confirmed maintenance risk.
