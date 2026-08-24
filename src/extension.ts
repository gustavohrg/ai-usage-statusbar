import * as vscode from 'vscode';
import {
  AgentUsage,
  CopilotUsageOptions,
  UsageResult,
  UsageWindow,
  getAntigravityUsage,
  getClaudeUsage,
  getCodexUsage,
  getCopilotUsage,
} from './provider-adapter';

let usageBar: vscode.StatusBarItem;
let timer: ReturnType<typeof setInterval>;

type ProviderKey = 'claude' | 'codex' | 'copilot' | 'antigravity';
type UsageScale = 'ratio' | 'percent';

interface ProviderViewModel {
  key: ProviderKey;
  name: string;
  scale: UsageScale;
  data: AgentUsage;
}

interface DisplayConfig {
  enableThresholdColors: boolean;
  weeklyExhaustedDisplay: 'percent' | 'remainingDays';
  warningThreshold: number;
  criticalThreshold: number;
}

type CopilotWindowMode = 'lookbackDays' | 'currentMonth';
type ProviderAlertLevel = 'none' | 'warning' | 'critical';

const DEFAULT_PROVIDERS: ProviderKey[] = ['claude', 'codex', 'copilot'];
const PROVIDER_ICON_MARKUP: Record<ProviderKey, string> = {
  claude: '$(ai-usage-claude)',
  codex: '$(ai-usage-codex)',
  copilot: '$(ai-usage-copilot)',
  antigravity: '$(ai-usage-antigravity)',
};
const STATUS_BAR_COLORS = {
  disabled: new vscode.ThemeColor('statusBarItem.foreground'),
  warning: new vscode.ThemeColor('statusBarItem.warningForeground'),
  critical: new vscode.ThemeColor('statusBarItem.errorForeground'),
};

export function activate(context: vscode.ExtensionContext) {
  usageBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1000,
  );

  usageBar.show();

  context.subscriptions.push(usageBar);

  doRefresh();
  timer = setInterval(doRefresh, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function doRefresh() {
  const displayConfig = getDisplayConfig();
  const copilotConfig = getCopilotConfig();
  const enabledProviders = getEnabledProviders();
  if (enabledProviders.length === 0) {
    renderNoProvidersBar(usageBar, displayConfig);
    return;
  }

  const providers = await Promise.all(
    enabledProviders.map(async (key): Promise<ProviderViewModel> => {
      const name = getProviderName(key);
      const scale = getProviderScale(key);
      try {
        return {
          key,
          name,
          scale,
          data: await getProviderData(key, copilotConfig),
        };
      } catch {
        return {
          key,
          name,
          scale,
          data: createUnavailableUsage(name),
        };
      }
    }),
  );

  renderCombinedBar(usageBar, providers, displayConfig);
}
function getProviderName(key: ProviderKey): string {
  if (key === 'claude') {
    return 'Claude';
  }
  if (key === 'codex') {
    return 'Codex';
  }
  if (key === 'copilot') {
    return 'Copilot';
  }
  return 'Antigravity';
}

function getProviderScale(key: ProviderKey): UsageScale {
  return key === 'claude' ? 'ratio' : 'percent';
}

async function getProviderData(
  key: ProviderKey,
  copilotConfig: CopilotUsageOptions,
): Promise<AgentUsage> {
  if (key === 'claude') {
    return getClaudeUsage();
  }
  if (key === 'copilot') {
    return getCopilotUsage(copilotConfig);
  }
  if (key === 'antigravity') {
    return getAntigravityUsage();
  }
  return getCodexUsage();
}

function createUnavailableUsage(name: string): AgentUsage {
  return {
    fiveHour: null,
    sevenDay: null,
    error: `${name} unavailable`,
  };
}

function getCopilotConfig(): CopilotUsageOptions {
  const config = vscode.workspace.getConfiguration('aiUsageMonitor');
  const lookbackDays = Math.max(
    1,
    Math.min(
      365,
      Math.round(Number(config.get<number>('copilotLookbackDays', 30))),
    ),
  );
  const includedCredits = Math.max(
    1,
    Number(config.get<number>('copilotIncludedCredits', 1000)),
  );
  const autoModel = String(
    config.get<string>('copilotAutoModel', 'gpt-5.3-codex') ?? 'gpt-5.3-codex',
  )
    .trim()
    .toLowerCase();
  const windowMode = normalizeCopilotWindowMode(
    config.get<string>('copilotWindowMode', 'lookbackDays'),
  );
  return {
    lookbackDays,
    includedCredits,
    autoModel,
    windowMode,
  };
}

function normalizeCopilotWindowMode(value: unknown): CopilotWindowMode {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === 'currentmonth' ? 'currentMonth' : 'lookbackDays';
}

function getDisplayConfig(): DisplayConfig {
  const config = vscode.workspace.getConfiguration('aiUsageMonitor');
  const enableThresholdColors = config.get<boolean>(
    'enableThresholdColors',
    true,
  );
  const weeklyExhaustedDisplay = normalizeWeeklyExhaustedDisplay(
    config.get<string>('weeklyExhaustedDisplay', 'percent'),
  );
  const warningThreshold = clampPercent(
    config.get<number>('warningThreshold', 70),
  );
  const criticalThreshold = Math.max(
    warningThreshold,
    clampPercent(config.get<number>('criticalThreshold', 85)),
  );

  return {
    enableThresholdColors,
    weeklyExhaustedDisplay,
    warningThreshold,
    criticalThreshold,
  };
}

function normalizeWeeklyExhaustedDisplay(
  value: unknown,
): 'percent' | 'remainingDays' {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === 'remainingdays' ? 'remainingDays' : 'percent';
}

function clampPercent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function getEnabledProviders(): ProviderKey[] {
  const config = vscode.workspace.getConfiguration('aiUsageMonitor');
  const configuredProviders = config.get<string[]>('enabledProviders');
  if (!configuredProviders) {
    return [...DEFAULT_PROVIDERS];
  }
  return normalizeProviderList(configuredProviders);
}

function normalizeProviderList(input: string[]): ProviderKey[] {
  const enabled: ProviderKey[] = [];
  for (const token of input) {
    const normalized = normalizeProviderToken(
      String(token).trim().toLowerCase(),
    );
    if (normalized && !enabled.includes(normalized)) {
      enabled.push(normalized);
    }
  }
  return enabled;
}

function normalizeProviderToken(token: string): ProviderKey | null {
  if (token === 'claude') {
    return 'claude';
  }
  if (token === 'codex') {
    return 'codex';
  }
  if (token === 'copilot') {
    return 'copilot';
  }
  if (token === 'antigravity') {
    return 'antigravity';
  }
  return null;
}

function toPercent(utilization: number, scale: 'ratio' | 'percent'): number {
  const raw =
    scale === 'ratio' && utilization <= 1 ? utilization * 100 : utilization;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function renderNoProvidersBar(
  bar: vscode.StatusBarItem,
  display: DisplayConfig,
) {
  bar.text = 'AI usage disabled';
  bar.color = STATUS_BAR_COLORS.disabled;
  bar.tooltip =
    'No providers are enabled. Configure aiUsageMonitor.enabledProviders.';
}

function renderCombinedBar(
  bar: vscode.StatusBarItem,
  providers: ProviderViewModel[],
  display: DisplayConfig,
) {
  bar.text = providers
    .map((provider) => formatSegment(provider, display))
    .join('   ');
  const usable = providers
    .map((provider) => getAlertPercent(provider.data, provider.scale))
    .filter((v): v is number => typeof v === 'number');
  if (usable.length === 0) {
    bar.color = STATUS_BAR_COLORS.disabled;
  } else if (!display.enableThresholdColors) {
    bar.color = undefined;
  } else if (usable.length === 1) {
    const used = usable[0] ?? 0;
    bar.color =
      used >= display.criticalThreshold
        ? STATUS_BAR_COLORS.critical
        : used >= display.warningThreshold
          ? STATUS_BAR_COLORS.warning
          : undefined;
  } else {
    // Keep multi-provider bar neutral; text badges indicate per-provider alert state.
    bar.color = undefined;
  }

  const tip = new vscode.MarkdownString();
  tip.isTrusted = false;
  tip.supportThemeIcons = true;
  providers.forEach((provider, index) => {
    if (index > 0) {
      tip.appendMarkdown('\n');
    }
    appendUsageTooltip(
      tip,
      provider.key,
      provider.name,
      provider.data,
      provider.scale,
    );
  });
  bar.tooltip = tip;
}

function getFiveHourPercent(
  data: AgentUsage,
  scale: UsageScale,
): number | null {
  if (data.error || !data.fiveHour) {
    return null;
  }
  return toPercent(data.fiveHour.utilization, scale);
}

function getSevenDayPercent(
  data: AgentUsage,
  scale: UsageScale,
): number | null {
  if (data.error || !data.sevenDay) {
    return null;
  }
  return toPercent(data.sevenDay.utilization, scale);
}

function getMostConstrainedWindow(
  data: AgentUsage,
): { window: UsageResult; kind: UsageWindow['kind'] } | null {
  if (data.windows?.length) {
    const known = data.windows.filter((window) => window.usageKnown !== false);
    let selected: UsageWindow | undefined;
    for (const candidate of known) {
      if (!selected || candidate.utilization > selected.utilization) {
        selected = candidate;
      }
    }
    if (selected) {
      return {
        window: {
          utilization: selected.utilization,
          resetsAt: selected.resetsAt,
        },
        kind: selected.kind,
      };
    }
    return null;
  }

  if (data.fiveHour) {
    return { window: data.fiveHour, kind: 'fiveHour' };
  }
  if (data.sevenDay) {
    return { window: data.sevenDay, kind: 'sevenDay' };
  }
  return null;
}

function getDetailedUsageTooltip(
  tip: vscode.MarkdownString,
  data: AgentUsage,
  scale: UsageScale,
) {
  tip.appendMarkdown(`| Window | Used | Resets In |\n|---|---|---|\n`);
  for (const window of data.windows ?? []) {
    const used =
      window.usageKnown === false
        ? 'unknown'
        : `${toPercent(window.utilization, scale)}%`;
    const reset = formatReset(window.resetsAt);
    tip.appendMarkdown(
      `| ${window.label} | **${used}** | ${reset || '--'} |\n`,
    );
  }
  if (data.meta?.tooltipNotes?.length) {
    tip.appendMarkdown('\n');
    for (const note of data.meta.tooltipNotes) {
      tip.appendMarkdown(`- ${note}\n`);
    }
  }
}

function getAlertPercent(data: AgentUsage, scale: UsageScale): number | null {
  // API fallback: use rate limit percent
  if (data.displayHint && data.raw) {
    return data.raw.usedPercent;
  }
  if (data.error) {
    return null;
  }
  if (data.windows?.length) {
    const compact = getMostConstrainedWindow(data);
    return compact ? toPercent(compact.window.utilization, scale) : null;
  }
  if (isWeeklyExhausted(data, scale)) {
    return 100;
  }
  return getFiveHourPercent(data, scale) ?? getSevenDayPercent(data, scale);
}

function formatSegment(
  provider: ProviderViewModel,
  display: DisplayConfig,
): string {
  const prefix = formatProviderPrefix(provider, display);
  const { data, scale } = provider;

  // API fallback: show rate limit percent when no local data
  if (data.displayHint && data.raw) {
    return `${prefix} ${data.raw.usedPercent}%`;
  }

  if (data.error) {
    return `${prefix} unavailable`;
  }

  const compact = data.windows?.length ? getMostConstrainedWindow(data) : null;
  if (data.windows?.length) {
    if (!compact) {
      return `${prefix} --`;
    }
    const used = toPercent(compact.window.utilization, scale);
    const reset = formatReset(compact.window.resetsAt);
    const showReset = !data.meta?.hideReset && Boolean(reset);
    const segmentSuffix = data.meta?.segmentSuffix
      ? ` ${data.meta.segmentSuffix}`
      : '';
    const windowLabel = compact.kind === 'sevenDay' ? ' 7d' : '';
    return `${prefix}${windowLabel} ${used}%${showReset ? ` ${reset}` : ''}${segmentSuffix}`;
  }

  if (isWeeklyExhausted(data, scale)) {
    if (display.weeklyExhaustedDisplay === 'remainingDays') {
      const daysLeft = formatDaysRemaining(data.sevenDay?.resetsAt ?? '');
      return `${prefix} ${daysLeft}`;
    }
    return `${prefix} 100%`;
  }

  const activeWindow = data.fiveHour ?? data.sevenDay;
  if (!activeWindow) {
    return `${prefix} --`;
  }

  const used = toPercent(activeWindow.utilization, scale);
  const reset = formatReset(activeWindow.resetsAt);
  const showReset = !data.meta?.hideReset && Boolean(reset);
  const segmentSuffix = data.meta?.segmentSuffix
    ? ` ${data.meta.segmentSuffix}`
    : '';
  const windowLabel = data.fiveHour ? '' : ' 7d';
  return `${prefix}${windowLabel} ${used}%${showReset ? ` ${reset}` : ''}${segmentSuffix}`;
}

function formatDaysRemaining(iso: string): string {
  if (!iso) {
    return 'soon';
  }
  try {
    const diffMs = Math.max(0, new Date(iso).getTime() - Date.now());
    const dayMs = 24 * 60 * 60 * 1000;
    const days = Math.max(1, Math.ceil(diffMs / dayMs));
    return `${days}d`;
  } catch {
    return 'soon';
  }
}

function formatProviderPrefix(
  provider: ProviderViewModel,
  display: DisplayConfig,
): string {
  const base = PROVIDER_ICON_MARKUP[provider.key] ?? provider.name;
  const alertBadge = getProviderAlertBadge(provider, display);
  return alertBadge ? `${base}${alertBadge}` : base;
}

function getProviderAlertBadge(
  provider: ProviderViewModel,
  display: DisplayConfig,
): string {
  if (!display.enableThresholdColors) {
    return '';
  }
  const alertLevel = getProviderAlertLevel(provider, display);
  if (alertLevel === 'critical') {
    return ' [critical]';
  }
  if (alertLevel === 'warning') {
    return ' [warning]';
  }
  return '';
}

function getProviderAlertLevel(
  provider: ProviderViewModel,
  display: DisplayConfig,
): ProviderAlertLevel {
  const used = getAlertPercent(provider.data, provider.scale);
  if (used === null) {
    return 'none';
  }
  if (used >= display.criticalThreshold) {
    return 'critical';
  }
  if (used >= display.warningThreshold) {
    return 'warning';
  }
  return 'none';
}

function isWeeklyExhausted(data: AgentUsage, scale: UsageScale): boolean {
  if (!data.sevenDay) {
    return false;
  }
  return toPercent(data.sevenDay.utilization, scale) >= 100;
}

function appendUsageTooltip(
  tip: vscode.MarkdownString,
  providerKey: ProviderKey,
  name: string,
  data: AgentUsage,
  scale: UsageScale,
) {
  const icon = PROVIDER_ICON_MARKUP[providerKey];
  tip.appendMarkdown(`${icon} **${name}**\n\n`);
  // API fallback: show rate limit info from GitHub API
  if (data.displayHint && data.raw) {
    tip.appendMarkdown(`- ${data.displayHint}\n`);
    if (data.meta?.tooltipNotes?.length) {
      tip.appendMarkdown('\n');
      for (const note of data.meta.tooltipNotes) {
        tip.appendMarkdown(`- ${note}\n`);
      }
    }
    return;
  }

  if (data.windows?.length) {
    getDetailedUsageTooltip(tip, data, scale);
    return;
  }

  if (data.error || (!data.fiveHour && !data.sevenDay)) {
    tip.appendMarkdown(`- ${data.error ?? 'No data available'}\n`);
    for (const note of data.meta?.tooltipNotes ?? []) {
      tip.appendMarkdown(`- ${note}\n`);
    }
    return;
  }

  if (data.meta?.compactTooltip) {
    for (const note of data.meta.tooltipNotes ?? []) {
      tip.appendMarkdown(`- ${note}\n`);
    }
    return;
  }

  tip.appendMarkdown(`| Window | Used | Resets In |\n|---|---|---|\n`);
  if (isWeeklyExhausted(data, scale) && data.sevenDay) {
    const used7d = toPercent(data.sevenDay.utilization, scale);
    const reset7d = formatReset(data.sevenDay.resetsAt);
    tip.appendMarkdown(
      `| 7-Day Weekly | **${used7d}%** | ${reset7d || '--'} |\n`,
    );
    tip.appendMarkdown(
      `\n- Weekly cap reached; short-session reset is unavailable.\n`,
    );
    return;
  }

  if (data.fiveHour) {
    const used5h = toPercent(data.fiveHour.utilization, scale);
    const reset5h = formatReset(data.fiveHour.resetsAt);
    const primaryLabel = data.meta?.primaryLabel || '5-Hour Session';
    tip.appendMarkdown(
      `| ${primaryLabel} | **${used5h}%** | ${reset5h || '--'} |\n`,
    );
  }
  if (data.sevenDay) {
    const used7d = toPercent(data.sevenDay.utilization, scale);
    const reset7d = formatReset(data.sevenDay.resetsAt);
    tip.appendMarkdown(
      `| 7-Day Weekly | **${used7d}%** | ${reset7d || '--'} |\n`,
    );
  }
  if (!data.fiveHour) {
    tip.appendMarkdown(
      '\n- 5-Hour Session is not present in the current Codex rate-limit response.\n',
    );
  }

  if (data.meta?.tooltipNotes?.length) {
    tip.appendMarkdown('\n');
    for (const note of data.meta.tooltipNotes) {
      tip.appendMarkdown(`- ${note}\n`);
    }
  }
}

function formatReset(iso: string): string {
  if (!iso) {
    return '';
  }
  try {
    const diff = Math.max(0, new Date(iso).getTime() - Date.now());
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    if (h > 0) {
      return `${h}h ${m}m`;
    }
    if (m > 0) {
      return `${m}m`;
    }
    return 'soon';
  } catch {
    return '';
  }
}

export function deactivate() {
  clearInterval(timer);
}
