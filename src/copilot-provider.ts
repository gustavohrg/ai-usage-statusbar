import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentUsage, CopilotUsageOptions } from './provider-types';
import {
  findJsonlFiles,
  formatUsageErrorDetail,
  httpsJsonRequest,
} from './provider-shared';

const HOME = os.homedir();
const COPILOT_MAX_FILES_PER_SOURCE = 250;
interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
  cacheWrite?: number;
}

const COPILOT_MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'raptor-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.5': { input: 5.0, cachedInput: 0.5, output: 30.0 },
  'gpt-4.1': { input: 2.0, cachedInput: 0.5, output: 8.0 },
  'grok-code-fast-1': { input: 0.2, cachedInput: 0.02, output: 1.5 },
  'claude-haiku-4.5': {
    input: 1.0,
    cachedInput: 0.1,
    cacheWrite: 1.25,
    output: 5.0,
  },
  'claude-sonnet-4': {
    input: 3.0,
    cachedInput: 0.3,
    cacheWrite: 3.75,
    output: 15.0,
  },
  'claude-sonnet-4.5': {
    input: 3.0,
    cachedInput: 0.3,
    cacheWrite: 3.75,
    output: 15.0,
  },
  'claude-sonnet-4.6': {
    input: 3.0,
    cachedInput: 0.3,
    cacheWrite: 3.75,
    output: 15.0,
  },
  'claude-opus-4.5': {
    input: 5.0,
    cachedInput: 0.5,
    cacheWrite: 6.25,
    output: 25.0,
  },
  'claude-opus-4.6': {
    input: 5.0,
    cachedInput: 0.5,
    cacheWrite: 6.25,
    output: 25.0,
  },
  'claude-opus-4.7': {
    input: 5.0,
    cachedInput: 0.5,
    cacheWrite: 6.25,
    output: 25.0,
  },
  'gemini-2.5-pro': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gemini-3.1-pro': { input: 2.0, cachedInput: 0.2, output: 12.0 },
  'gemini-3-flash': { input: 0.5, cachedInput: 0.05, output: 3.0 },
  goldeneye: { input: 1.25, cachedInput: 0.125, output: 10.0 },
};

const MODEL_ALIASES: Record<string, string> = {
  'gpt-5.1': 'gpt-5.2',
  'gpt-5.1-codex': 'gpt-5.2-codex',
  'gpt-5.1-codex-mini': 'gpt-5.4-mini',
  'gpt-5.1-codex-max': 'gpt-5.2-codex',
  'gpt-4o': 'gpt-4.1',
  'gpt-4o-mini': 'gpt-5-mini',
  'gemini-3-pro': 'gemini-3.1-pro',
  'gemini-3-flash-preview': 'gemini-3-flash',
  'gemini-3-pro-preview': 'gemini-3.1-pro',
  'gemini-3.1-pro-preview': 'gemini-3.1-pro',
};

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
interface CopilotUsageRecord {
  sessionId?: string;
  timestampMs?: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export async function getCopilotUsage(
  options: CopilotUsageOptions,
): Promise<AgentUsage> {
  try {
    const lookbackDays = clampInteger(options.lookbackDays, 1, 365, 30);
    const includedCredits = Math.max(
      1,
      Number(options.includedCredits || 1000),
    );
    const autoModel = normalizeModel(options.autoModel || 'gpt-5.3-codex');
    const windowMode =
      options.windowMode === 'currentMonth' ? 'currentMonth' : 'lookbackDays';
    const { sinceMs, windowLabel } = getCopilotWindowRange(
      windowMode,
      lookbackDays,
    );

    const roots = getVsCodeWorkspaceStorageRoots().filter((root) =>
      fs.existsSync(root),
    );
    if (roots.length === 0) {
      return {
        fiveHour: null,
        sevenDay: null,
        error: formatUsageErrorDetail(
          'copilot',
          'No VS Code workspaceStorage directories found',
        ),
      };
    }

    const transcriptFiles = collectWorkspaceFiles(roots, 'transcript').slice(
      0,
      COPILOT_MAX_FILES_PER_SOURCE,
    );
    const chatFiles = collectWorkspaceFiles(roots, 'chat').slice(
      0,
      COPILOT_MAX_FILES_PER_SOURCE,
    );

    const records: CopilotUsageRecord[] = [];
    const exactSessionIds = new Set<string>();
    let exactTranscriptSessions = 0;

    for (const file of transcriptFiles) {
      const parsed = parseTranscriptFile(file, sinceMs);
      if (parsed.records.length > 0) {
        records.push(...parsed.records);
      }
      if (parsed.sessionId && parsed.records.length > 0) {
        exactSessionIds.add(parsed.sessionId);
      }
      if (parsed.hasShutdown) {
        exactTranscriptSessions += 1;
      }
    }

    for (const file of chatFiles) {
      const parsed = parseChatSessionFile(file, sinceMs);
      if (parsed.sessionId && exactSessionIds.has(parsed.sessionId)) {
        continue;
      }
      records.push(...parsed.records);
    }

    if (records.length === 0) {
      console.log('[Copilot] No local records found, trying API fallback...');
      console.log(
        `[Copilot] roots=${roots.length}, transcriptFiles=${transcriptFiles.length}, chatFiles=${chatFiles.length}`,
      );
      const rateLimit = await fetchCopilotRateLimit();
      if (rateLimit) {
        const usedPercent =
          rateLimit.limit > 0
            ? Math.round((rateLimit.used / rateLimit.limit) * 100)
            : 0;
        const resetDate =
          rateLimit.reset > 0 ? new Date(rateLimit.reset * 1000) : null;
        const resetLabel = resetDate
          ? `resets ${resetDate.toLocaleDateString()} ${resetDate.toLocaleTimeString()}`
          : 'reset unknown';
        return {
          fiveHour: null,
          sevenDay: null,
          displayHint: `${usedPercent}% used (${rateLimit.used}/${rateLimit.limit}), ${resetLabel}`,
          raw: {
            usedPercent,
            remaining: rateLimit.remaining,
            limit: rateLimit.limit,
            reset: rateLimit.reset,
          },
        };
      }
      return {
        fiveHour: null,
        sevenDay: null,
        error: formatUsageErrorDetail(
          'copilot',
          'No Copilot usage records found',
        ),
      };
    }

    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      credits: 0,
      unknownModels: new Set<string>(),
      zeroOutput: 0,
      modelCredits: new Map<string, number>(),
    };

    for (const record of records) {
      totals.inputTokens += record.inputTokens;
      totals.outputTokens += record.outputTokens;
      totals.cacheReadTokens += record.cacheReadTokens;
      totals.cacheWriteTokens += record.cacheWriteTokens;
      if (record.outputTokens <= 0) {
        totals.zeroOutput += 1;
      }

      const pricing = estimateCopilotCredits(record, autoModel);
      totals.credits += pricing.credits;
      totals.modelCredits.set(
        pricing.pricingModel,
        (totals.modelCredits.get(pricing.pricingModel) ?? 0) + pricing.credits,
      );
      if (!pricing.pricingKnown) {
        totals.unknownModels.add(pricing.pricingModel);
      }
    }

    const totalTokens =
      totals.inputTokens +
      totals.outputTokens +
      totals.cacheReadTokens +
      totals.cacheWriteTokens;
    const spendUsd = totals.credits / 100;
    const usedPercent = Math.max(
      0,
      Math.min(100, Math.round((totals.credits / includedCredits) * 100)),
    );
    const zeroOutputPct = Math.round(
      (totals.zeroOutput * 100) / records.length,
    );

    const tooltipNotes = [
      `${windowLabel} window`,
      `${formatInteger(records.length)} records`,
      `${formatInteger(totalTokens)} tokens`,
      `$${spendUsd.toFixed(2)} spend`,
      `${totals.credits.toFixed(1)} / ${includedCredits.toFixed(0)} credits (${usedPercent}%)`,
    ];

    if (exactTranscriptSessions > 0) {
      tooltipNotes.push(
        `${exactTranscriptSessions} session(s) used exact transcript shutdown metrics`,
      );
    }
    if (totals.unknownModels.size > 0) {
      tooltipNotes.push(
        `Unknown pricing model(s): ${Array.from(totals.unknownModels).slice(0, 3).join(', ')}`,
      );
    }
    if (zeroOutputPct >= 50) {
      tooltipNotes.push(
        'High zero-output ratio detected; historical Copilot logs may be incomplete.',
      );
    }

    const topPricedModels = [...totals.modelCredits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([model]) => model)
      .filter((model) => !totals.unknownModels.has(model));
    for (const model of topPricedModels) {
      const rate = COPILOT_MODEL_PRICES[model];
      if (!rate) {
        continue;
      }
      const modelSpendUsd = (totals.modelCredits.get(model) ?? 0) / 100;
      tooltipNotes.push(
        `${model}: $${modelSpendUsd.toFixed(2)} (in $${formatRate(rate.input)}, cached $${formatRate(rate.cachedInput)}, out $${formatRate(rate.output)} /1M)`,
      );
    }

    return {
      fiveHour: {
        utilization: usedPercent,
        resetsAt: '',
      },
      sevenDay: null,
      meta: {
        segmentSuffix: `$${formatCompactCurrency(spendUsd)} ${formatCompactNumber(totalTokens)} tok`,
        tooltipNotes,
        hideReset: true,
        compactTooltip: true,
      },
    };
  } catch (error: unknown) {
    return {
      fiveHour: null,
      sevenDay: null,
      error: formatUsageErrorDetail(
        'copilot',
        String((error as any)?.message ?? error),
      ),
    };
  }
}

function getCopilotWindowRange(
  mode: 'lookbackDays' | 'currentMonth',
  lookbackDays: number,
): { sinceMs: number; windowLabel: string } {
  if (mode === 'currentMonth') {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLabel = monthStart.toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
    return {
      sinceMs: monthStart.getTime(),
      windowLabel: `${monthLabel} (current month)`,
    };
  }
  return {
    sinceMs: Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
    windowLabel: `${lookbackDays}d`,
  };
}
function collectWorkspaceFiles(
  roots: string[],
  mode: 'chat' | 'transcript',
): string[] {
  const files: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspaceDir = path.join(root, entry.name);
      const targetDir =
        mode === 'chat'
          ? path.join(workspaceDir, 'chatSessions')
          : path.join(workspaceDir, 'GitHub.copilot-chat', 'transcripts');
      files.push(...findJsonlFiles(targetDir));
    }
  }

  return files.sort((a, b) => getFileMtimeMs(b) - getFileMtimeMs(a));
}

function getFileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function parseTranscriptFile(
  filePath: string,
  sinceMs: number,
): { records: CopilotUsageRecord[]; sessionId?: string; hasShutdown: boolean } {
  const records: CopilotUsageRecord[] = [];
  let sessionId: string | undefined;
  let hasShutdown = false;

  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue;
    }

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === 'session.start') {
      sessionId = event.data?.sessionId ?? sessionId;
    }
    if (event.type !== 'session.shutdown' || !event.data?.modelMetrics) {
      continue;
    }

    const timestampMs = toTimestampMs(event.timestamp);
    if (timestampMs && timestampMs < sinceMs) {
      continue;
    }

    hasShutdown = true;
    const metrics = event.data.modelMetrics;
    for (const [model, metric] of Object.entries<any>(metrics)) {
      const usage = metric?.usage ?? {};
      records.push({
        sessionId: sessionId ?? event.data?.sessionId,
        timestampMs,
        model: normalizeModel(model),
        inputTokens: Number(usage.inputTokens ?? 0) || 0,
        outputTokens: Number(usage.outputTokens ?? 0) || 0,
        cacheReadTokens: Number(usage.cacheReadTokens ?? 0) || 0,
        cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0) || 0,
      });
    }
  }

  return { records, sessionId, hasShutdown };
}

function parseChatSessionFile(
  filePath: string,
  sinceMs: number,
): { records: CopilotUsageRecord[]; sessionId?: string } {
  const records: CopilotUsageRecord[] = [];
  const { session, requests } = collectSessionRequests(filePath);
  const sessionModel = getSessionSelectedModel(session);
  const sessionId =
    session.sessionId || path.basename(filePath).replace(/\.jsonl$/i, '');

  for (const request of requests) {
    const timestampMs = toTimestampMs(request?.timestamp);
    if (timestampMs && timestampMs < sinceMs) {
      continue;
    }

    const metadata = request?.result?.metadata ?? {};
    const inputTokens =
      roughTokens(metadata.renderedUserMessage) +
      roughTokens(metadata.renderedGlobalContext);
    const outputTokens = Number(request?.completionTokens ?? 0);

    records.push({
      sessionId,
      timestampMs,
      model: modelFromRequest(request, sessionModel),
      inputTokens,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }

  return { records, sessionId };
}

function collectSessionRequests(filePath: string): {
  session: any;
  requests: any[];
} {
  const state: any = Object.create(null);
  const requestsById = new Map<string, any>();

  const captureRequest = (request: any) => {
    if (!request || typeof request !== 'object') {
      return;
    }
    const requestId = request.requestId;
    if (typeof requestId !== 'string' || !requestId) {
      return;
    }
    const existing = requestsById.get(requestId);
    if (existing) {
      const prevTokens = Number(existing.completionTokens ?? 0) || 0;
      const newTokens = Number(request.completionTokens ?? 0) || 0;
      requestsById.set(requestId, {
        ...existing,
        ...request,
        completionTokens: Math.max(prevTokens, newTokens),
      });
      return;
    }
    requestsById.set(requestId, request);
  };

  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.kind === 0) {
      Object.assign(state, event.v ?? {});
      for (const request of state.requests ?? []) {
        captureRequest(request);
      }
      continue;
    }

    if ((event.kind === 1 || event.kind === 2) && Array.isArray(event.k)) {
      setPath(state, event.k, event.v);
      if (event.k[0] !== 'requests') {
        continue;
      }
      if (event.k.length === 1) {
        for (const request of state.requests ?? []) {
          captureRequest(request);
        }
        continue;
      }
      const requestIndex = event.k[1];
      if (typeof requestIndex === 'number') {
        captureRequest(state.requests?.[requestIndex]);
      }
    }
  }

  return {
    session: state,
    requests: [...requestsById.values()],
  };
}

function setPath(
  target: any,
  jsonPath: Array<string | number>,
  value: unknown,
) {
  let cursor = target;
  for (let index = 0; index < jsonPath.length - 1; index++) {
    const key = jsonPath[index];
    if (typeof key === 'string' && UNSAFE_KEYS.has(key)) {
      return;
    }
    const nextKey = jsonPath[index + 1];
    if (cursor[key] == null) {
      cursor[key] = typeof nextKey === 'number' ? [] : {};
    }
    cursor = cursor[key];
  }
  const lastKey = jsonPath[jsonPath.length - 1];
  if (typeof lastKey === 'string' && UNSAFE_KEYS.has(lastKey)) {
    return;
  }
  cursor[lastKey] = value;
}

function resolveRequestModel(request: any): string {
  const directCandidates = [
    request?.resolvedModel,
    request?.model,
    request?.modelName,
    request?.modelId,
    request?.result?.resolvedModel,
    request?.result?.model,
    request?.result?.modelId,
    request?.result?.metadata?.model,
    request?.result?.metadata?.modelId,
    request?.response?.resolvedModel,
    request?.response?.model,
    request?.response?.modelId,
    request?.selectedModel?.identifier,
    request?.selectedModel?.metadata?.version,
    request?.selectedModel?.metadata?.family,
    request?.inputState?.selectedModel?.identifier,
    request?.inputState?.selectedModel?.metadata?.version,
    request?.inputState?.selectedModel?.metadata?.family,
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeModelCandidate(candidate);
    if (normalized && normalized !== 'auto') {
      return normalized;
    }
  }

  const details = String(request?.details ?? '').toLowerCase();
  const detailsMatch = details.match(
    /(gpt-[a-z0-9.-]+|claude-[a-z0-9.-]+|gemini-[a-z0-9.-]+|grok-[a-z0-9.-]+)/,
  );
  if (detailsMatch?.[1]) {
    return normalizeModel(detailsMatch[1]);
  }

  if (details.includes('auto')) {
    return 'auto';
  }
  return 'auto';
}

function modelFromRequest(request: any, sessionModel: string): string {
  const requestModel = resolveRequestModel(request);
  if (requestModel !== 'auto') {
    return requestModel;
  }
  return sessionModel || 'auto';
}

function normalizeModelCandidate(value: unknown): string | null {
  const normalized = normalizeModel(String(value ?? ''));
  return normalized ? normalized : null;
}

function getSessionSelectedModel(session: any): string {
  const selected = session?.inputState?.selectedModel;
  const candidates = [
    selected?.metadata?.version,
    selected?.metadata?.family,
    selected?.identifier,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeModelCandidate(candidate);
    if (normalized && normalized !== 'auto') {
      return normalized;
    }
  }
  return 'auto';
}

function normalizeModel(model: string): string {
  const normalized = String(model || '')
    .toLowerCase()
    .replace(/^copilot\//, '')
    .replace(/_/g, '-')
    .trim();
  if (!normalized) {
    return 'auto';
  }
  return MODEL_ALIASES[normalized] ?? normalized;
}

function estimateCopilotCredits(
  record: CopilotUsageRecord,
  autoModel: string,
): { credits: number; pricingKnown: boolean; pricingModel: string } {
  const rawModel = normalizeModel(record.model);
  const pricingModel =
    rawModel === 'auto' ? normalizeModel(autoModel) : rawModel;
  const price = COPILOT_MODEL_PRICES[pricingModel];
  if (!price) {
    return { credits: 0, pricingKnown: false, pricingModel };
  }

  const nonCachedInput = Math.max(
    0,
    record.inputTokens - record.cacheReadTokens,
  );
  const usd =
    (nonCachedInput * price.input +
      record.cacheReadTokens * price.cachedInput +
      record.cacheWriteTokens * (price.cacheWrite ?? price.cachedInput) +
      record.outputTokens * price.output) /
    1_000_000;
  return {
    credits: usd * 100,
    pricingKnown: true,
    pricingModel,
  };
}

function roughTokens(value: unknown): number {
  const text = String(value ?? '');
  if (!text.trim()) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function toTimestampMs(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  const text = String(value).trim();
  if (!text) {
    return undefined;
  }
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(value)}`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatRate(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value
    .toFixed(3)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

function formatCompactCurrency(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  if (value >= 100) {
    return `${value.toFixed(0)}`;
  }
  if (value >= 10) {
    return `${value.toFixed(1).replace(/\.0$/, '')}`;
  }
  return `${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
}

async function fetchCopilotRateLimit(): Promise<{
  remaining: number;
  reset: number;
  used: number;
  limit: number;
} | null> {
  try {
    // Copilot uses github.copilot auth provider, not plain github
    const providers = ['github.copilot', 'github'];
    let session: vscode.AuthenticationSession | undefined;
    for (const providerId of providers) {
      session = await vscode.authentication.getSession(providerId, [], {
        createIfNone: false,
      });
      if (session) {
        console.log(`[Copilot] Got auth session from provider: ${providerId}`);
        break;
      }
    }
    if (!session) {
      console.error('[Copilot] No Copilot/GitHub auth session found');
      return null;
    }

    console.log('[Copilot] Got GitHub auth session, fetching rate limit...');
    const token = session.accessToken;
    const data = await httpsJsonRequest(
      'GET',
      'api.github.com',
      '/copilot_internal/v2/token',
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'ai-usage-statusbar',
      },
    );

    console.log(
      '[Copilot] API response:',
      JSON.stringify(data).substring(0, 500),
    );

    if (data && typeof data === 'object') {
      const remaining = Number(data.remaining ?? data.rate?.remaining ?? 0);
      const reset = Number(data.reset ?? data.rate?.reset ?? 0);
      const used = Number(data.used ?? data.rate?.used ?? 0);
      const limit = Number(data.limit ?? data.rate?.limit ?? 0);
      console.log(
        `[Copilot] Parsed: used=${used}, limit=${limit}, remaining=${remaining}`,
      );
      return { remaining, reset, used, limit };
    }
    console.error('[Copilot] Invalid API response structure');
    return null;
  } catch (err) {
    console.error('[Copilot] API fetch failed:', err);
    return null;
  }
}

function getVsCodeWorkspaceStorageRoots(): string[] {
  const roots: string[] = [];
  if (process.platform === 'darwin') {
    roots.push(
      path.join(
        HOME,
        'Library',
        'Application Support',
        'Code',
        'User',
        'workspaceStorage',
      ),
      path.join(
        HOME,
        'Library',
        'Application Support',
        'Code - Insiders',
        'User',
        'workspaceStorage',
      ),
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      roots.push(
        path.join(appData, 'Code', 'User', 'workspaceStorage'),
        path.join(appData, 'Code - Insiders', 'User', 'workspaceStorage'),
      );
    }
  }

  roots.push(
    path.join(HOME, '.config', 'Code', 'User', 'workspaceStorage'),
    path.join(HOME, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
  );

  return [...new Set(roots)];
}

