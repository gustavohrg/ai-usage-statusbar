"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANTIGRAVITY_COMMAND_MODEL_CONFIGS_PATH = exports.ANTIGRAVITY_USER_STATUS_PATH = exports.ANTIGRAVITY_QUOTA_SUMMARY_PATH = void 0;
exports.parseAntigravityTimestamp = parseAntigravityTimestamp;
exports.parseAntigravityQuotaSummary = parseAntigravityQuotaSummary;
exports.parseAntigravityUserStatus = parseAntigravityUserStatus;
exports.parseAntigravityCommandModelConfigs = parseAntigravityCommandModelConfigs;
exports.getAntigravityUsage = getAntigravityUsage;
exports.formatAntigravityError = formatAntigravityError;
exports.parseAntigravityProcesses = parseAntigravityProcesses;
exports.parseAntigravityListeningPorts = parseAntigravityListeningPorts;
exports.requestAntigravityJson = requestAntigravityJson;
const child_process_1 = require("child_process");
const http = __importStar(require("http"));
const https = __importStar(require("https"));
exports.ANTIGRAVITY_QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
exports.ANTIGRAVITY_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
exports.ANTIGRAVITY_COMMAND_MODEL_CONFIGS_PATH = '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs';
const ANTIGRAVITY_TIMEOUT_MS = 8000;
const ANTIGRAVITY_REQUEST_TIMEOUT_MS = 3000;
const ANTIGRAVITY_QUOTA_RETRY_COUNT = 3;
const ANTIGRAVITY_QUOTA_RETRY_DELAY_MS = 500;
const LOOPBACK_HOST = '127.0.0.1';
function asRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value;
}
function firstValue(record, keys) {
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
function firstString(record, keys) {
    const value = firstValue(record, keys);
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim();
}
function firstArray(record, keys) {
    const value = firstValue(record, keys);
    return Array.isArray(value) ? value : [];
}
function finiteNumber(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
}
function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
}
function resolvedRemainingFraction(value) {
    const direct = finiteNumber(value);
    if (direct !== null) {
        return direct;
    }
    const record = asRecord(value);
    if (!record) {
        return null;
    }
    const directFraction = finiteNumber(firstValue(record, ['remainingFraction', 'remaining_fraction']));
    if (directFraction !== null) {
        return directFraction;
    }
    const nested = asRecord(firstValue(record, ['remaining']));
    if (nested) {
        const nestedFraction = finiteNumber(firstValue(nested, ['remainingFraction', 'remaining_fraction']));
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
function responsePayload(value) {
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
function describePayload(value) {
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
        `responseKeys=${Object.keys(nestedResponse ?? {})
            .slice(0, 8)
            .join(',') || 'none'}`,
        `summaryKeys=${Object.keys(nestedSummary ?? {})
            .slice(0, 8)
            .join(',') || 'none'}`,
        `groups=${Array.isArray(groups) ? groups.length : 'none'}`,
    ].join(' ');
}
function validateResponseCode(value) {
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
    if (typeof resolved === 'string' &&
        ['0', 'ok', 'success'].includes(resolved.trim().toLowerCase())) {
        return;
    }
    throw new Error(`Antigravity API returned code ${String(resolved)}`);
}
function classifyWindow(value, fallbackText = '', explicitWindow) {
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
    if (/(?:5\s*[-_ ]?h(?:our)?|five\s*[-_ ]?hour|session|short\s*term)/i.test(text)) {
        return 'fiveHour';
    }
    return 'other';
}
function parseTimestamp(value) {
    if (value === undefined || value === null || value === '') {
        return '';
    }
    const record = asRecord(value);
    if (record) {
        const seconds = finiteNumber(firstValue(record, ['seconds', 'epochSeconds']));
        const nanos = finiteNumber(firstValue(record, ['nanos', 'nanoseconds'])) ?? 0;
        if (seconds !== null) {
            return timestampFromEpoch(seconds + nanos / 1000000000);
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
function timestampFromEpoch(value) {
    const milliseconds = Math.abs(value) < 100000000000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) {
        return '';
    }
    return date.toISOString();
}
function parseAntigravityTimestamp(value) {
    return parseTimestamp(value);
}
function usageResult(window) {
    if (!window || window.usageKnown === false) {
        return null;
    }
    return {
        utilization: window.utilization,
        resetsAt: window.resetsAt,
    };
}
function chooseMostConstrained(windows, kind) {
    const candidates = windows.filter((window) => window.kind === kind && window.usageKnown !== false);
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
function createUsage(windows, notes = []) {
    const session = chooseMostConstrained(windows, 'fiveHour');
    const weekly = chooseMostConstrained(windows, 'sevenDay');
    const usage = {
        fiveHour: usageResult(session),
        sevenDay: usageResult(weekly),
        windows,
    };
    if (notes.length > 0) {
        usage.meta = { tooltipNotes: notes };
    }
    return usage;
}
function addNotes(data, notes) {
    const existing = data.meta?.tooltipNotes ?? [];
    const merged = [...existing, ...notes].filter((note, index, all) => note && all.indexOf(note) === index);
    return {
        ...data,
        meta: {
            ...(data.meta ?? {}),
            tooltipNotes: merged,
        },
    };
}
function hasKnownUsage(data) {
    return Boolean(data.windows?.some((window) => window.usageKnown !== false));
}
function quotaSummaryGroups(payload) {
    const root = responsePayload(payload);
    const groups = firstValue(root, ['groups']);
    if (!Array.isArray(groups)) {
        throw new Error('Missing quota groups');
    }
    return groups;
}
function parseQuotaBucket(group, bucket) {
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
    const disabled = disabledValue === true ||
        (typeof disabledValue === 'string' &&
            ['true', '1', 'yes'].includes(disabledValue.toLowerCase()));
    const fraction = resolvedRemainingFraction(record);
    const groupLabel = firstString(group, ['displayName', 'display_name', 'label', 'name']) ||
        'Quota';
    const bucketLabel = displayName || resolvedId;
    const explicitWindow = firstValue(record, [
        'window',
        'windowType',
        'window_type',
    ]);
    const resetsAt = parseTimestamp(firstValue(record, ['resetTime', 'reset_time', 'resetAt', 'reset_at']));
    return {
        label: `${groupLabel} ${bucketLabel}`.trim(),
        utilization: fraction === null ? 0 : clampPercent((1 - fraction) * 100),
        resetsAt,
        kind: classifyWindow(record, '', explicitWindow),
        usageKnown: !disabled && fraction !== null,
    };
}
function parseAntigravityQuotaSummary(payload) {
    validateResponseCode(payload);
    const groups = quotaSummaryGroups(payload);
    const windows = [];
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
function modelConfigRows(payload, source) {
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
    const cascade = asRecord(firstValue(userStatus, [
        'cascadeModelConfigData',
        'cascade_model_config_data',
    ]));
    return {
        rows: firstArray(cascade, ['clientModelConfigs', 'client_model_configs']),
        userStatus,
    };
}
function identityNotes(userStatus) {
    if (!userStatus) {
        return [];
    }
    const notes = [];
    const email = firstString(userStatus, [
        'email',
        'accountEmail',
        'account_email',
    ]);
    if (email) {
        notes.push(`Account: ${email}`);
    }
    const tier = asRecord(firstValue(userStatus, ['userTier', 'user_tier']));
    const planStatus = asRecord(firstValue(userStatus, ['planStatus', 'plan_status']));
    const planInfo = asRecord(firstValue(planStatus, ['planInfo', 'plan_info']));
    const plan = firstString(tier, ['name', 'displayName', 'display_name']) ||
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
function modelRowToCandidate(rowValue) {
    const row = asRecord(rowValue);
    if (!row) {
        return null;
    }
    const quota = asRecord(firstValue(row, ['quotaInfo', 'quota_info', 'quota', 'quotaData']));
    const quotaOrRow = quota ?? row;
    const modelOrAlias = asRecord(firstValue(row, ['modelOrAlias', 'model_or_alias']));
    const modelId = firstString(modelOrAlias, ['model', 'modelId', 'model_id']) ||
        firstString(row, ['modelId', 'model_id', 'model']);
    const label = firstString(row, ['label', 'displayName', 'display_name', 'name']) ||
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
    if (disabledValue === true ||
        (typeof disabledValue === 'string' &&
            disabledValue.toLowerCase() === 'true')) {
        return null;
    }
    const explicitWindow = firstValue(row, ['window', 'windowType', 'window_type']) ??
        firstValue(quotaOrRow, ['window', 'windowType', 'window_type']);
    const kind = explicitWindow === undefined || explicitWindow === null
        ? 'other'
        : classifyWindow(row, '', explicitWindow);
    if (fraction === null && !resetsAt && !description) {
        return null;
    }
    return {
        label,
        fraction,
        resetsAt,
        kind,
        usageKnown: fraction !== null,
    };
}
function chooseModelCandidate(current, next) {
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
function parseModelUsage(rows, notes) {
    const grouped = new Map();
    for (const row of rows) {
        const candidate = modelRowToCandidate(row);
        if (!candidate) {
            continue;
        }
        const key = candidate.label.toLocaleLowerCase();
        const existing = grouped.get(key);
        grouped.set(key, existing ? chooseModelCandidate(existing, candidate) : candidate);
    }
    const windows = [...grouped.values()].map((candidate) => ({
        label: candidate.label,
        utilization: candidate.fraction === null
            ? 0
            : clampPercent((1 - candidate.fraction) * 100),
        resetsAt: candidate.resetsAt,
        kind: candidate.kind,
        usageKnown: candidate.usageKnown,
    }));
    return createUsage(windows, notes);
}
function parseAntigravityUserStatus(payload) {
    validateResponseCode(payload);
    const { rows, userStatus } = modelConfigRows(payload, 'userStatus');
    return parseModelUsage(rows, identityNotes(userStatus));
}
function parseAntigravityCommandModelConfigs(payload) {
    validateResponseCode(payload);
    const { rows } = modelConfigRows(payload, 'command');
    return parseModelUsage(rows, []);
}
function parseEndpointResponse(pathname, payload) {
    if (pathname === exports.ANTIGRAVITY_QUOTA_SUMMARY_PATH) {
        return parseAntigravityQuotaSummary(payload);
    }
    if (pathname === exports.ANTIGRAVITY_USER_STATUS_PATH) {
        return parseAntigravityUserStatus(payload);
    }
    return parseAntigravityCommandModelConfigs(payload);
}
async function enrichQuotaSummaryIdentity(data, request, scheme, port, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        return data;
    }
    try {
        const payload = await request({
            scheme,
            port,
            path: exports.ANTIGRAVITY_USER_STATUS_PATH,
            body: {},
            timeoutMs: Math.min(ANTIGRAVITY_REQUEST_TIMEOUT_MS, remaining),
        });
        const identity = parseAntigravityUserStatus(payload);
        const notes = identity.meta?.tooltipNotes ?? [];
        if (notes.length === 0) {
            return data;
        }
        return addNotes(data, ['Identity: GetUserStatus', ...notes]);
    }
    catch {
        return data;
    }
}
async function waitForAntigravityRetry(delayMs) {
    const { promise, resolve } = createDeferred();
    setTimeout(resolve, delayMs);
    await promise;
}
async function probeAntigravity(options) {
    const timeoutMs = Math.max(250, Math.min(ANTIGRAVITY_TIMEOUT_MS, Number(options.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS)));
    const deadline = Date.now() + timeoutMs;
    const discoverProcess = options.discoverProcess ?? discoverRunningAntigravityProcess;
    const processInfo = await discoverProcess();
    if (!processInfo) {
        throw new Error('No running agy process found for the current user');
    }
    const discoverPorts = options.discoverPorts ?? discoverAntigravityPorts;
    const ports = await discoverPorts(processInfo.pid, Math.max(1, deadline - Date.now()));
    if (ports.length === 0) {
        throw new Error('agy has no loopback listening ports');
    }
    const request = options.request ?? requestAntigravityJson;
    const paths = [
        exports.ANTIGRAVITY_QUOTA_SUMMARY_PATH,
        exports.ANTIGRAVITY_USER_STATUS_PATH,
        exports.ANTIGRAVITY_COMMAND_MODEL_CONFIGS_PATH,
    ];
    let lastError = new Error('No usable Antigravity response');
    const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? ANTIGRAVITY_QUOTA_RETRY_DELAY_MS));
    const diagnostics = [];
    for (const port of ports) {
        for (const scheme of ['https', 'http']) {
            for (const pathname of paths) {
                const retryCount = pathname === exports.ANTIGRAVITY_QUOTA_SUMMARY_PATH ||
                    pathname === exports.ANTIGRAVITY_USER_STATUS_PATH
                    ? ANTIGRAVITY_QUOTA_RETRY_COUNT
                    : 1;
                for (let attempt = 0; attempt < retryCount; attempt += 1) {
                    if (attempt > 0) {
                        await waitForAntigravityRetry(retryDelayMs);
                    }
                    let payload;
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
                        if (pathname === exports.ANTIGRAVITY_QUOTA_SUMMARY_PATH) {
                            result = await enrichQuotaSummaryIdentity(parsed, request, scheme, port, deadline);
                        }
                        return addNotes(result, [
                            `Source: agy ${scheme.toUpperCase()} ${pathname.slice(pathname.lastIndexOf('/') + 1)}`,
                        ]);
                    }
                    catch (error) {
                        const name = pathname.slice(pathname.lastIndexOf('/') + 1);
                        const shape = payload === undefined ? '' : `; ${describePayload(payload)}`;
                        const detail = `${scheme.toUpperCase()} ${port} ${name}: ${errorMessage(error)}${shape}`;
                        diagnostics.push(detail.slice(0, 500));
                        lastError = error;
                    }
                }
            }
        }
    }
    const detail = diagnostics.join(' | ').slice(0, 3000);
    throw new Error(detail
        ? `${errorMessage(lastError)}; attempts: ${detail}`
        : errorMessage(lastError));
}
async function getAntigravityUsage(options = {}) {
    try {
        return await probeAntigravity(options);
    }
    catch (error) {
        const detail = errorMessage(error).replace(/\s+/g, ' ').slice(0, 3000);
        if (options.logger) {
            options.logger(`[ai-usage-statusbar] Antigravity probe failed: ${detail}`);
        }
        else {
            console.error(`[ai-usage-statusbar] Antigravity probe failed: ${detail}`);
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
function errorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return String(error ?? '');
}
function formatAntigravityError(error) {
    const text = errorMessage(error).toLowerCase();
    if (text.includes('no running agy') || text.includes('agy not running')) {
        return 'ANTIGRAVITY NOT RUNNING (start `agy` first)';
    }
    if (text.includes('lsof') || text.includes('listening ports')) {
        return 'ANTIGRAVITY PORTS UNAVAILABLE (restart `agy` and retry)';
    }
    if (text.includes('401') ||
        text.includes('403') ||
        text.includes('signed out')) {
        return 'ANTIGRAVITY LOGIN REQUIRED (run `agy` to sign in)';
    }
    if (text.includes('timed out') || text.includes('timeout')) {
        return 'ANTIGRAVITY API TIMEOUT';
    }
    return 'ANTIGRAVITY USAGE UNAVAILABLE';
}
function createDeferred() {
    const promiseConstructor = Promise;
    if (typeof promiseConstructor.withResolvers === 'function') {
        return promiseConstructor.withResolvers();
    }
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return {
        promise,
        resolve: resolvePromise,
        reject: rejectPromise,
    };
}
function runCommand(command, args, timeoutMs) {
    const { promise, resolve, reject } = createDeferred();
    const child = (0, child_process_1.spawn)(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) {
            return;
        }
        settled = true;
        child.kill();
        reject(new Error(`${command} timed out`));
    }, Math.max(1, timeoutMs));
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
function isAgyCommand(command) {
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
function parseAntigravityProcesses(output, currentUid = typeof process.getuid === 'function'
    ? process.getuid()
    : undefined) {
    const matches = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
        if (!match) {
            continue;
        }
        const pid = Number(match[1]);
        const uid = Number(match[2]);
        const command = match[3] ?? '';
        if (!Number.isInteger(pid) ||
            !Number.isInteger(uid) ||
            !isAgyCommand(command)) {
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
async function discoverRunningAntigravityProcess() {
    const output = await runCommand('ps', ['-axo', 'pid=,uid=,command='], ANTIGRAVITY_TIMEOUT_MS);
    const processes = parseAntigravityProcesses(output);
    return processes[0] ?? null;
}
function parseAntigravityListeningPorts(output) {
    const ports = new Set();
    const pattern = /(?:127(?:\.\d+){3}|localhost|\*|\[?::1\]?):(\d+)\s+\(LISTEN\)/gi;
    for (const match of output.matchAll(pattern)) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
            ports.add(port);
        }
    }
    const sorted = [...ports];
    sorted.sort((left, right) => left - right);
    return sorted;
}
async function discoverAntigravityPorts(pid, timeoutMs) {
    const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)];
    let lastError;
    for (const command of ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof']) {
        try {
            const output = await runCommand(command, args, timeoutMs);
            const ports = parseAntigravityListeningPorts(output);
            if (ports.length === 0) {
                throw new Error('no listening ports found');
            }
            return ports;
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError ?? new Error('lsof unavailable');
}
function requestAntigravityJson(args) {
    const { promise, resolve, reject } = createDeferred();
    const payload = JSON.stringify(args.body ?? {});
    const commonOptions = {
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
    const handleResponse = (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
            raw += chunk;
        });
        response.on('end', () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
                reject(new Error(`Antigravity HTTP ${status}${raw ? `: ${raw.slice(0, 500)}` : ''}`));
                return;
            }
            if (!raw.trim()) {
                const contentType = response.headers['content-type'] ?? 'unknown';
                const contentLength = response.headers['content-length'] ?? 'unknown';
                reject(new Error(`Antigravity HTTP ${status}: empty response ` +
                    `(content-type=${contentType}, content-length=${contentLength})`));
                return;
            }
            try {
                resolve(JSON.parse(raw));
            }
            catch (error) {
                reject(error);
            }
        });
    };
    let request;
    if (args.scheme === 'https') {
        request = https.request({
            ...commonOptions,
            // The host is hard-coded to loopback; only this local TLS connection
            // may accept agy's self-signed certificate.
            rejectUnauthorized: false,
        }, handleResponse);
    }
    else {
        request = http.request(commonOptions, handleResponse);
    }
    request.once('error', (error) => reject(error));
    request.once('timeout', () => {
        request.destroy(new Error('Antigravity request timed out'));
    });
    request.end(payload);
    return promise;
}
