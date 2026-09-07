import { spawn } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import type { AgentUsage, UsageResult, UsageWindow } from './provider-types';

export const ANTIGRAVITY_QUOTA_SUMMARY_PATH =
  '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
export const ANTIGRAVITY_USER_STATUS_PATH =
  '/exa.language_server_pb.LanguageServerService/GetUserStatus';
export const ANTIGRAVITY_COMMAND_MODEL_CONFIGS_PATH =
  '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs';

const ANTIGRAVITY_TIMEOUT_MS = 10_000;
const ANTIGRAVITY_REQUEST_TIMEOUT_MS = 1_500;
const ANTIGRAVITY_QUOTA_RETRY_COUNT = 3;
const ANTIGRAVITY_QUOTA_RETRY_DELAY_MS = 250;
const ANTIGRAVITY_HEADLESS_COMMAND = '/usage';
const LOOPBACK_HOST = '127.0.0.1';

type JsonRecord = Record<string, unknown>;
type AntigravityScheme = 'https' | 'http';

export interface AntigravityProcessInfo {
  pid: number;
  uid: number;
  command: string;
}

export interface AntigravityRequestArgs {
  scheme: AntigravityScheme;
  port: number;
  path: string;
  body: unknown;
  timeoutMs: number;
}

export type AntigravityRequest = (
  args: AntigravityRequestArgs,
) => Promise<unknown>;

export interface AntigravityProbeOptions {
  timeoutMs?: number;
  discoverProcess?: () => Promise<AntigravityProcessInfo | null>;
  discoverPorts?: (pid: number, timeoutMs: number) => Promise<number[]>;
  request?: AntigravityRequest;
  runHeadless?: (timeoutMs: number) => Promise<unknown>;
  useHeadless?: boolean;
  retryDelayMs?: number;
  logger?: (message: string) => void;
}

interface AntigravityModelRow {
  label: string;
  modelGroup: string;
  fraction: number | null;
  resetsAt: string;
  kind: UsageWindow['kind'];
  usageKnown: boolean;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function firstValue(record: JsonRecord | null, keys: string[]): unknown {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function firstString(record: JsonRecord | null, keys: string[]): string {
  const value = firstValue(record, keys);
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function firstArray(record: JsonRecord | null, keys: string[]): unknown[] {
  const value = firstValue(record, keys);
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function resolvedRemainingFraction(value: unknown): number | null {
  const direct = finiteNumber(value);
  if (direct !== null) {
    return direct;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const directFraction = finiteNumber(
    firstValue(record, ['remainingFraction', 'remaining_fraction']),
  );
  if (directFraction !== null) {
    return directFraction;
  }

  const nested = asRecord(firstValue(record, ['remaining']));
  if (nested) {
    const nestedFraction = finiteNumber(
      firstValue(nested, ['remainingFraction', 'remaining_fraction']),
    );
    if (nestedFraction !== null) {
      return nestedFraction;
    }
    const oneOfCase = firstString(nested, ['case']);
    if (oneOfCase.toLowerCase() === 'remainingfraction') {
      return finiteNumber(firstValue(nested, ['value']));
    }
  }

  const oneOfCase = firstString(record, ['case']);
  if (oneOfCase.toLowerCase() === 'remainingfraction') {
    return finiteNumber(firstValue(record, ['value']));
  }

  return null;
}

function responsePayload(value: unknown): JsonRecord | null {
  const root = asRecord(value);
  if (!root) {
    return null;
  }
  const nestedResponse = asRecord(firstValue(root, ['response']));
  if (nestedResponse) {
    return nestedResponse;
  }
  const nestedSummary = asRecord(firstValue(root, ['summary']));
  if (nestedSummary) {
    return nestedSummary;
  }
  return root;
}

function describePayload(value: unknown): string {
  const root = asRecord(value);
  if (!root) {
    return `payloadType=${typeof value}`;
  }
  const nestedResponse = asRecord(firstValue(root, ['response']));
  const nestedSummary = asRecord(firstValue(root, ['summary']));
  const candidate = nestedResponse ?? nestedSummary ?? root;
  const groups = firstValue(candidate, ['groups']);
  return [
    `payloadKeys=${Object.keys(root).slice(0, 8).join(',') || 'none'}`,
    `responseKeys=${
      Object.keys(nestedResponse ?? {})
        .slice(0, 8)
        .join(',') || 'none'
    }`,
    `summaryKeys=${
      Object.keys(nestedSummary ?? {})
        .slice(0, 8)
        .join(',') || 'none'
    }`,
    `groups=${Array.isArray(groups) ? groups.length : 'none'}`,
  ].join(' ');
}

function validateResponseCode(value: unknown) {
  const root = asRecord(value);
  const code = firstValue(root, ['code']);
  if (code === undefined || code === null) {
    return;
  }

  const nestedCode = asRecord(code);
  const resolved = nestedCode
    ? firstValue(nestedCode, ['value', 'code', 'name'])
    : code;
  if (resolved === undefined || resolved === null) {
    return;
  }

  if (typeof resolved === 'number' && resolved === 0) {
    return;
  }
  if (
    typeof resolved === 'string' &&
    ['0', 'ok', 'success'].includes(resolved.trim().toLowerCase())
  ) {
    return;
  }
  throw new Error(`Antigravity API returned code ${String(resolved)}`);
}

function classifyWindow(
  value: JsonRecord | null,
  fallbackText = '',
  explicitWindow?: unknown,
): UsageWindow['kind'] {
  const explicit = String(explicitWindow ?? '')
    .trim()
    .toLowerCase();
  const bucketText = [
    fallbackText,
    firstString(value, ['bucketId']),
    firstString(value, ['bucket_id']),
    firstString(value, ['displayName']),
    firstString(value, ['display_name']),
    firstString(value, ['label']),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const text = `${explicit} ${bucketText}`;

  if (explicit === 'weekly' || /(?:weekly|week|7\s*[-_ ]?day|7d)/i.test(text)) {
    return 'sevenDay';
  }
  if (
    /(?:5\s*[-_ ]?h(?:our)?|five\s*[-_ ]?hour|session|short\s*term)/i.test(text)
  ) {
    return 'fiveHour';
  }
  return 'other';
}

function parseTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  const record = asRecord(value);
  if (record) {
    const seconds = finiteNumber(
      firstValue(record, ['seconds', 'epochSeconds']),
    );
    const nanos =
      finiteNumber(firstValue(record, ['nanos', 'nanoseconds'])) ?? 0;
    if (seconds !== null) {
      return timestampFromEpoch(seconds + nanos / 1_000_000_000);
    }
  }

  const numeric = finiteNumber(value);
  if (numeric !== null) {
    return timestampFromEpoch(numeric);
  }

  if (typeof value !== 'string') {
    return '';
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function timestampFromEpoch(value: number): string {
  const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  return date.toISOString();
}

export function parseAntigravityTimestamp(value: unknown): string {
  return parseTimestamp(value);
}

function usageResult(window: UsageWindow | undefined): {
  utilization: number;
  resetsAt: string;
} | null {
  if (!window || window.usageKnown === false) {
    return null;
  }
  return {
    utilization: window.utilization,
    resetsAt: window.resetsAt,
  };
}

function chooseMostConstrained(
  windows: UsageWindow[],
  kind: UsageWindow['kind'],
): UsageWindow | undefined {
  const candidates = windows.filter(
    (window) => window.kind === kind && window.usageKnown !== false,
  );
  candidates.sort((left, right) => {
    if (left.utilization !== right.utilization) {
      return right.utilization - left.utilization;
    }
    const leftReset = left.resetsAt ? Date.parse(left.resetsAt) : Infinity;
    const rightReset = right.resetsAt ? Date.parse(right.resetsAt) : Infinity;
    if (leftReset !== rightReset) {
      return leftReset - rightReset;
    }
    return left.label.localeCompare(right.label);
  });
  return candidates[0];
}

function createUsage(windows: UsageWindow[], notes: string[] = []): AgentUsage {
  const session = chooseMostConstrained(windows, 'fiveHour');
  const weekly = chooseMostConstrained(windows, 'sevenDay');
  const usage: AgentUsage = {
    fiveHour: usageResult(session),
    sevenDay: usageResult(weekly),
    windows,
  };
  if (notes.length > 0) {
    usage.meta = { tooltipNotes: notes };
  }
  return usage;
}

export function getAntigravityOptimisticWindow(
  data: AgentUsage,
): { window: UsageResult; kind: UsageWindow['kind'] } | null {
  const groups = new Map<string, UsageWindow>();
  for (const candidate of data.windows ?? []) {
    if (candidate.usageKnown === false) {
      continue;
    }
    const group = candidate.modelGroup ?? candidate.label;
    const current = groups.get(group);
    if (!current || candidate.utilization > current.utilization) {
      groups.set(group, candidate);
    }
  }

  let selected: UsageWindow | undefined;
  for (const candidate of groups.values()) {
    if (!selected || candidate.utilization < selected.utilization) {
      selected = candidate;
    }
  }
  if (!selected) {
    return null;
  }
  return {
    window: {
      utilization: selected.utilization,
      resetsAt: selected.resetsAt,
    },
    kind: selected.kind,
  };
}

function addNotes(data: AgentUsage, notes: string[]): AgentUsage {
  const existing = data.meta?.tooltipNotes ?? [];
  const merged = [...existing, ...notes].filter(
    (note, index, all) => note && all.indexOf(note) === index,
  );
  return {
    ...data,
    meta: {
      ...(data.meta ?? {}),
      tooltipNotes: merged,
    },
  };
}

function hasKnownUsage(data: AgentUsage): boolean {
  return Boolean(data.windows?.some((window) => window.usageKnown !== false));
}

function quotaSummaryGroups(payload: unknown): unknown[] {
  const root = responsePayload(payload);
  const groups = firstValue(root, ['groups']);
  if (!Array.isArray(groups)) {
    throw new Error('Missing quota groups');
  }
  return groups;
}

function parseQuotaBucket(
  group: JsonRecord,
  bucket: unknown,
): UsageWindow | null {
  const record = asRecord(bucket);
  if (!record) {
    return null;
  }

  const bucketId = firstString(record, ['bucketId', 'bucket_id', 'id', 'name']);
  const displayName = firstString(record, [
    'displayName',
    'display_name',
    'label',
    'name',
  ]);
  const resolvedId = bucketId || displayName;
  if (!resolvedId) {
    return null;
  }

  const disabledValue = firstValue(record, ['disabled', 'isDisabled']);
  const disabled =
    disabledValue === true ||
    (typeof disabledValue === 'string' &&
      ['true', '1', 'yes'].includes(disabledValue.toLowerCase()));
  const fraction = resolvedRemainingFraction(record);

  const groupLabel =
    firstString(group, ['displayName', 'display_name', 'label', 'name']) ||
    'Quota';
  const bucketLabel = displayName || resolvedId;
  const explicitWindow = firstValue(record, [
    'window',
    'windowType',
    'window_type',
  ]);
  const resetsAt = parseTimestamp(
    firstValue(record, ['resetTime', 'reset_time', 'resetAt', 'reset_at']),
  );
  return {
    label: `${groupLabel} ${bucketLabel}`.trim(),
    modelGroup: groupLabel,
    utilization: fraction === null ? 0 : clampPercent((1 - fraction) * 100),
    resetsAt,
    kind: classifyWindow(record, '', explicitWindow),
    usageKnown: !disabled && fraction !== null,
  };
}

export function parseAntigravityQuotaSummary(payload: unknown): AgentUsage {
  validateResponseCode(payload);
  const groups = quotaSummaryGroups(payload);
  const windows: UsageWindow[] = [];
  for (const groupValue of groups) {
    const group = asRecord(groupValue);
    if (!group) {
      continue;
    }
    for (const bucket of firstArray(group, ['buckets'])) {
      const parsed = parseQuotaBucket(group, bucket);
      if (parsed) {
        windows.push(parsed);
      }
    }
  }

  return createUsage(windows);
}
function headlessCommandData(payload: unknown): JsonRecord {
  const root = asRecord(payload);
  const command = asRecord(firstValue(root, ['command']));
  const data = asRecord(firstValue(command, ['data']));
  if (!data) {
    throw new Error('Headless /usage returned no quota data');
  }
  return data;
}

export function parseAntigravityHeadlessUsage(payload: unknown): AgentUsage {
  const usage = parseAntigravityQuotaSummary(headlessCommandData(payload));
  return addNotes(usage, ['Source: agy headless /usage']);
}

function modelConfigRows(
  payload: unknown,
  source: 'userStatus' | 'command',
): { rows: unknown[]; userStatus: JsonRecord | null } {
  const root = asRecord(payload);
  if (!root) {
    throw new Error('Malformed Antigravity response');
  }
  const body = responsePayload(payload) ?? root;

  if (source === 'command') {
    return {
      rows: firstArray(body, ['clientModelConfigs', 'client_model_configs']),
      userStatus: null,
    };
  }

  const userStatus = asRecord(firstValue(body, ['userStatus', 'user_status']));
  if (!userStatus) {
    throw new Error('Missing userStatus');
  }
  const cascade = asRecord(
    firstValue(userStatus, [
      'cascadeModelConfigData',
      'cascade_model_config_data',
    ]),
  );
  return {
    rows: firstArray(cascade, ['clientModelConfigs', 'client_model_configs']),
    userStatus,
  };
}

function identityNotes(userStatus: JsonRecord | null): string[] {
  if (!userStatus) {
    return [];
  }
  const notes: string[] = [];
  const email = firstString(userStatus, [
    'email',
    'accountEmail',
    'account_email',
  ]);
  if (email) {
    notes.push(`Account: ${email}`);
  }

  const tier = asRecord(firstValue(userStatus, ['userTier', 'user_tier']));
  const planStatus = asRecord(
    firstValue(userStatus, ['planStatus', 'plan_status']),
  );
  const planInfo = asRecord(firstValue(planStatus, ['planInfo', 'plan_info']));
  const plan =
    firstString(tier, ['name', 'displayName', 'display_name']) ||
    firstString(planInfo, [
      'planDisplayName',
      'plan_display_name',
      'displayName',
      'display_name',
      'productName',
      'product_name',
      'planName',
      'plan_name',
      'planShortName',
      'plan_short_name',
    ]);
  if (plan) {
    notes.push(`Plan: ${plan}`);
  }
  return notes;
}

function modelRowToCandidate(rowValue: unknown): AntigravityModelRow | null {
  const row = asRecord(rowValue);
  if (!row) {
    return null;
  }
  const quota = asRecord(
    firstValue(row, ['quotaInfo', 'quota_info', 'quota', 'quotaData']),
  );
  const quotaOrRow = quota ?? row;
  const modelOrAlias = asRecord(
    firstValue(row, ['modelOrAlias', 'model_or_alias']),
  );
  const modelId =
    firstString(modelOrAlias, ['model', 'modelId', 'model_id']) ||
    firstString(row, ['modelId', 'model_id', 'model']);
  const label =
    firstString(row, ['label', 'displayName', 'display_name', 'name']) ||
    modelId ||
    'Model';
  const fraction = resolvedRemainingFraction(quotaOrRow);
  const resetValue = firstValue(quotaOrRow, [
    'resetTime',
    'reset_time',
    'resetAt',
    'reset_at',
  ]);
  const resetsAt = parseTimestamp(resetValue);
  const description = firstString(quotaOrRow, [
    'description',
    'resetDescription',
    'reset_description',
  ]);
  const disabledValue = firstValue(quotaOrRow, ['disabled', 'isDisabled']);
  if (
    disabledValue === true ||
    (typeof disabledValue === 'string' &&
      disabledValue.toLowerCase() === 'true')
  ) {
    return null;
  }

  const explicitWindow =
    firstValue(row, ['window', 'windowType', 'window_type']) ??
    firstValue(quotaOrRow, ['window', 'windowType', 'window_type']);
  const kind =
    explicitWindow === undefined || explicitWindow === null
      ? 'other'
      : classifyWindow(row, '', explicitWindow);
  if (fraction === null && !resetsAt && !description) {
    return null;
  }
  return {
    label,
    modelGroup: label,
    fraction,
    resetsAt,
    kind,
    usageKnown: fraction !== null,
  };
}

function chooseModelCandidate(
  current: AntigravityModelRow,
  next: AntigravityModelRow,
): AntigravityModelRow {
  if (current.usageKnown !== next.usageKnown) {
    return next.usageKnown ? next : current;
  }
  if (current.fraction !== null && next.fraction !== null) {
    const currentUtilization = clampPercent((1 - current.fraction) * 100);
    const nextUtilization = clampPercent((1 - next.fraction) * 100);
    if (currentUtilization !== nextUtilization) {
      return nextUtilization > currentUtilization ? next : current;
    }
  }
  if (current.resetsAt && next.resetsAt) {
    return Date.parse(next.resetsAt) < Date.parse(current.resetsAt)
      ? next
      : current;
  }
  return current;
}

function parseModelUsage(rows: unknown[], notes: string[]): AgentUsage {
  const grouped = new Map<string, AntigravityModelRow>();
  for (const row of rows) {
    const candidate = modelRowToCandidate(row);
    if (!candidate) {
      continue;
    }
    const key = candidate.label.toLocaleLowerCase();
    const existing = grouped.get(key);
    grouped.set(
      key,
      existing ? chooseModelCandidate(existing, candidate) : candidate,
    );
  }

  const windows: UsageWindow[] = [...grouped.values()].map((candidate) => ({
    label: candidate.label,
    modelGroup: candidate.modelGroup,
    utilization:
      candidate.fraction === null
        ? 0
        : clampPercent((1 - candidate.fraction) * 100),
    resetsAt: candidate.resetsAt,
    kind: candidate.kind,
    usageKnown: candidate.usageKnown,
  }));
  return createUsage(windows, notes);
}

export function parseAntigravityUserStatus(payload: unknown): AgentUsage {
  validateResponseCode(payload);
  const { rows, userStatus } = modelConfigRows(payload, 'userStatus');
  return parseModelUsage(rows, identityNotes(userStatus));
}

export function parseAntigravityCommandModelConfigs(
  payload: unknown,
): AgentUsage {
  validateResponseCode(payload);
  const { rows } = modelConfigRows(payload, 'command');
  return parseModelUsage(rows, []);
}

function parseEndpointResponse(pathname: string, payload: unknown): AgentUsage {
  if (pathname === ANTIGRAVITY_QUOTA_SUMMARY_PATH) {
    return parseAntigravityQuotaSummary(payload);
  }
  if (pathname === ANTIGRAVITY_USER_STATUS_PATH) {
    return parseAntigravityUserStatus(payload);
  }
  return parseAntigravityCommandModelConfigs(payload);
}

async function enrichQuotaSummaryIdentity(
  data: AgentUsage,
  request: AntigravityRequest,
  scheme: AntigravityScheme,
  port: number,
  deadline: number,
): Promise<AgentUsage> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return data;
  }
  try {
    const payload = await request({
      scheme,
      port,
      path: ANTIGRAVITY_USER_STATUS_PATH,
      body: {},
      timeoutMs: Math.min(ANTIGRAVITY_REQUEST_TIMEOUT_MS, remaining),
    });
    const identity = parseAntigravityUserStatus(payload);
    const notes = identity.meta?.tooltipNotes ?? [];
    if (notes.length === 0) {
      return data;
    }
    return addNotes(data, ['Identity: GetUserStatus', ...notes]);
  } catch {
    return data;
  }
}

async function waitForAntigravityRetry(delayMs: number): Promise<void> {
  const { promise, resolve } = createDeferred<void>();
  setTimeout(resolve, delayMs);
  await promise;
}

function resolveAntigravityTimeout(options: AntigravityProbeOptions): number {
  return Math.max(
    250,
    Math.min(
      ANTIGRAVITY_TIMEOUT_MS,
      Number(options.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS),
    ),
  );
}

async function probeAntigravityHeadless(
  options: AntigravityProbeOptions,
): Promise<AgentUsage> {
  const timeoutMs = resolveAntigravityTimeout(options);
  const runHeadless = options.runHeadless ?? runAntigravityHeadless;
  const payload = await runHeadless(timeoutMs);
  return parseAntigravityHeadlessUsage(payload);
}

async function runAntigravityHeadless(timeoutMs: number): Promise<unknown> {
  const printTimeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1_000) - 1);
  const output = await runCommand(
    'agy',
    [
      '-p',
      ANTIGRAVITY_HEADLESS_COMMAND,
      '--output-format',
      'json',
      '--print-timeout',
      `${printTimeoutSeconds}s`,
    ],
    timeoutMs,
  );
  try {
    return JSON.parse(output);
  } catch (error: unknown) {
    throw new Error(
      `agy headless /usage returned invalid JSON: ${errorMessage(error)}`,
    );
  }
}

async function probeAntigravity(
  options: AntigravityProbeOptions,
): Promise<AgentUsage> {
  const timeoutMs = resolveAntigravityTimeout(options);
  const deadline = Date.now() + timeoutMs;
  const discoverProcess =
    options.discoverProcess ?? discoverRunningAntigravityProcess;
  const processInfo = await discoverProcess();
  if (!processInfo) {
    throw new Error('No running agy process found for the current user');
  }

  const discoverPorts = options.discoverPorts ?? discoverAntigravityPorts;
  const ports = await discoverPorts(
    processInfo.pid,
    Math.max(1, deadline - Date.now()),
  );
  if (ports.length === 0) {
    throw new Error('agy has no loopback listening ports');
  }

  const request = options.request ?? requestAntigravityJson;
  const paths = [
    ANTIGRAVITY_QUOTA_SUMMARY_PATH,
    ANTIGRAVITY_USER_STATUS_PATH,
    ANTIGRAVITY_COMMAND_MODEL_CONFIGS_PATH,
  ];
  let lastError: unknown = new Error('No usable Antigravity response');
  const retryDelayMs = Math.max(
    0,
    Number(options.retryDelayMs ?? ANTIGRAVITY_QUOTA_RETRY_DELAY_MS),
  );
  const diagnostics: string[] = [];
  for (const port of ports) {
    for (const pathname of paths) {
      const retryCount =
        pathname === ANTIGRAVITY_QUOTA_SUMMARY_PATH ||
        pathname === ANTIGRAVITY_USER_STATUS_PATH
          ? ANTIGRAVITY_QUOTA_RETRY_COUNT
          : 1;
      for (const scheme of ['https', 'http'] as const) {
        for (let attempt = 0; attempt < retryCount; attempt += 1) {
          if (attempt > 0) {
            await waitForAntigravityRetry(retryDelayMs);
          }
          let payload: unknown;
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new Error('Antigravity request timed out');
          }
          try {
            payload = await request({
              scheme,
              port,
              path: pathname,
              body: {},
              timeoutMs: Math.min(ANTIGRAVITY_REQUEST_TIMEOUT_MS, remaining),
            });
            const parsed = parseEndpointResponse(pathname, payload);
            if (!hasKnownUsage(parsed)) {
              const name = pathname.slice(pathname.lastIndexOf('/') + 1);
              const detail = `${scheme.toUpperCase()} ${port} ${name}: no usable quota rows; ${describePayload(payload)}`;
              diagnostics.push(detail.slice(0, 500));
              lastError = new Error(`${name} returned no usable quota rows`);
              continue;
            }
            let result = parsed;
            if (pathname === ANTIGRAVITY_QUOTA_SUMMARY_PATH) {
              result = await enrichQuotaSummaryIdentity(
                parsed,
                request,
                scheme,
                port,
                deadline,
              );
            }
            return addNotes(result, [
              `Source: agy ${scheme.toUpperCase()} ${pathname.slice(
                pathname.lastIndexOf('/') + 1,
              )}`,
            ]);
          } catch (error: unknown) {
            const name = pathname.slice(pathname.lastIndexOf('/') + 1);
            const shape =
              payload === undefined ? '' : `; ${describePayload(payload)}`;
            const detail = `${scheme.toUpperCase()} ${port} ${name}: ${errorMessage(error)}${shape}`;
            diagnostics.push(detail.slice(0, 500));
            lastError = error;
            if (!shouldRetryAntigravityRequest(error)) {
              break;
            }
          }
        }
      }
    }
  }
  const detail = diagnostics.join(' | ').slice(0, 3_000);
  throw new Error(
    detail
      ? `${errorMessage(lastError)}; attempts: ${detail}`
      : errorMessage(lastError),
  );
}

export async function getAntigravityUsage(
  options: AntigravityProbeOptions = {},
): Promise<AgentUsage> {
  const hasInjectedLocalProbe = Boolean(
    options.discoverProcess || options.discoverPorts || options.request,
  );
  const useHeadless = options.useHeadless !== false && !hasInjectedLocalProbe;
  const fallbackToLocal = useHeadless && !options.runHeadless;

  try {
    if (useHeadless) {
      try {
        return await probeAntigravityHeadless(options);
      } catch (headlessError: unknown) {
        if (!fallbackToLocal) {
          throw headlessError;
        }
        try {
          return await probeAntigravity(options);
        } catch (localError: unknown) {
          throw new Error(
            `agy headless probe failed: ${errorMessage(headlessError)}; ` +
              `local probe failed: ${errorMessage(localError)}`,
          );
        }
      }
    }
    return await probeAntigravity(options);
  } catch (error: unknown) {
    const detail = errorMessage(error).replace(/\s+/g, ' ').slice(0, 3_000);
    if (options.logger) {
      options.logger(
        `[ai-usage-statusbar] Antigravity probe failed: ${detail}`,
      );
    }
    return {
      fiveHour: null,
      sevenDay: null,
      error: formatAntigravityError(error),
      meta: {
        tooltipNotes: [`Probe diagnostics: ${detail}`],
      },
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error ?? '');
}
function shouldRetryAntigravityRequest(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase();
  return ![
    'timed out',
    'timeout',
    'econn',
    'socket',
    'self-signed',
    'certificate',
    'wrong version',
    'eproto',
    'fetch failed',
  ].some((marker) => text.includes(marker));
}

export function formatAntigravityError(error: unknown): string {
  const text = errorMessage(error).toLowerCase();
  if (text.includes('no running agy') || text.includes('agy not running')) {
    return 'ANTIGRAVITY NOT RUNNING (start `agy` first)';
  }
  if (text.includes('lsof') || text.includes('listening ports')) {
    return 'ANTIGRAVITY PORTS UNAVAILABLE (restart `agy` and retry)';
  }
  if (
    text.includes('401') ||
    text.includes('403') ||
    text.includes('signed out') ||
    text.includes('authentication required') ||
    text.includes('not authenticated')
  ) {
    return 'ANTIGRAVITY LOGIN REQUIRED (run `agy` once to sign in)';
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return 'ANTIGRAVITY API TIMEOUT';
  }
  return 'ANTIGRAVITY USAGE UNAVAILABLE';
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  const promiseConstructor = Promise as PromiseConstructor & {
    withResolvers?: <Value>() => Deferred<Value>;
  };
  if (typeof promiseConstructor.withResolvers === 'function') {
    return promiseConstructor.withResolvers<T>();
  }

  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const { promise, resolve, reject } = createDeferred<string>();
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const timer = setTimeout(
    () => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out`));
    },
    Math.max(1, timeoutMs),
  );

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.once('error', (error) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.once('close', (code, signal) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    if (code === 0) {
      resolve(stdout);
      return;
    }
    const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
    reject(new Error(`${command} exited with ${code ?? signal}${detail}`));
  });
  return promise;
}

function isAgyCommand(command: string): boolean {
  const executable = command
    .trim()
    .split(/\s+/)[0]
    ?.replace(/^['"]|['"]$/g, '');
  if (!executable) {
    return false;
  }
  const basename = executable.split(/[\\/]/).pop()?.toLowerCase();
  return basename === 'agy' || basename === 'agy.exe';
}

export function parseAntigravityProcesses(
  output: string,
  currentUid = typeof process.getuid === 'function'
    ? process.getuid()
    : undefined,
): AntigravityProcessInfo[] {
  const matches: AntigravityProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const uid = Number(match[2]);
    const command = match[3] ?? '';
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(uid) ||
      !isAgyCommand(command)
    ) {
      continue;
    }
    if (currentUid !== undefined && uid !== currentUid) {
      continue;
    }
    if (pid === process.pid) {
      continue;
    }
    matches.push({ pid, uid, command });
  }
  matches.sort((left, right) => left.pid - right.pid);
  return matches;
}

async function discoverRunningAntigravityProcess(): Promise<AntigravityProcessInfo | null> {
  const output = await runCommand(
    'ps',
    ['-axo', 'pid=,uid=,command='],
    ANTIGRAVITY_TIMEOUT_MS,
  );
  const processes = parseAntigravityProcesses(output);
  return processes[0] ?? null;
}

export function parseAntigravityListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  const pattern =
    /(?:127(?:\.\d+){3}|localhost|\*|\[?::1\]?):(\d+)\s+\(LISTEN\)/gi;
  for (const match of output.matchAll(pattern)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      ports.add(port);
    }
  }
  const sorted = [...ports];
  sorted.sort((left, right) => left - right);
  return sorted;
}

async function discoverAntigravityPorts(
  pid: number,
  timeoutMs: number,
): Promise<number[]> {
  const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)];
  let lastError: unknown;
  for (const command of ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof']) {
    try {
      const output = await runCommand(command, args, timeoutMs);
      const ports = parseAntigravityListeningPorts(output);
      if (ports.length === 0) {
        throw new Error('no listening ports found');
      }
      return ports;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('lsof unavailable');
}

export function requestAntigravityJson(
  args: AntigravityRequestArgs,
): Promise<unknown> {
  const { promise, resolve, reject } = createDeferred<unknown>();
  const payload = JSON.stringify(args.body ?? {});
  const commonOptions: http.RequestOptions = {
    hostname: LOOPBACK_HOST,
    port: args.port,
    path: args.path,
    method: 'POST',
    agent: false,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Connection: 'close',
      'Content-Length': Buffer.byteLength(payload).toString(),
    },
    timeout: Math.max(1, args.timeoutMs),
  };
  const handleResponse = (response: http.IncomingMessage) => {
    let raw = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      raw += chunk;
    });
    response.on('end', () => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        reject(
          new Error(
            `Antigravity HTTP ${status}${raw ? `: ${raw.slice(0, 500)}` : ''}`,
          ),
        );
        return;
      }
      if (!raw.trim()) {
        const contentType = response.headers['content-type'] ?? 'unknown';
        const contentLength = response.headers['content-length'] ?? 'unknown';
        reject(
          new Error(
            `Antigravity HTTP ${status}: empty response ` +
              `(content-type=${contentType}, content-length=${contentLength})`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error: unknown) {
        reject(error);
      }
    });
  };

  let request: http.ClientRequest;
  if (args.scheme === 'https') {
    request = https.request(
      {
        ...commonOptions,
        // The host is hard-coded to loopback; only this local TLS connection
        // may accept agy's self-signed certificate.
        rejectUnauthorized: false,
      },
      handleResponse,
    );
  } else {
    request = http.request(commonOptions, handleResponse);
  }
  request.once('error', (error) => reject(error));
  request.once('timeout', () => {
    request.destroy(new Error('Antigravity request timed out'));
  });
  request.end(payload);
  return promise;
}
