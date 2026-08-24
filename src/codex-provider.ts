import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { AgentUsage, UsageResult } from './provider-types';
import { findJsonlFiles, formatUsageErrorDetail } from './provider-shared';

const HOME = os.homedir();
const CODEX_APP_SERVER_TIMEOUT_MS = 7_000;
const SESSION_SCAN_FILE_LIMIT = 5;
const CODEX_INIT_REQUEST_ID = 1;
const CODEX_RATE_LIMITS_REQUEST_ID = 2;
interface CodexRateLimitWindow {
  usedPercent?: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
  windowDurationMinutes?: number | null;
  windowMinutes?: number | null;
  window_minutes?: number | null;
  window_duration_mins?: number | null;
}

interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

interface CodexRateLimitsResult {
  rateLimits?: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
}
export async function getCodexUsage(): Promise<AgentUsage> {
  const appServerUsage = await getCodexUsageFromAppServer();
  if (!appServerUsage.error) {
    return appServerUsage;
  }

  const sessionUsage = await getCodexUsageFromSessions();
  if (!sessionUsage.error) {
    return sessionUsage;
  }

  return {
    fiveHour: null,
    sevenDay: null,
    error: formatUsageErrorDetail(
      'codex',
      `app_server=${appServerUsage.error ?? ''}; sessions=${sessionUsage.error ?? ''}`,
    ),
  };
}
async function getCodexUsageFromAppServer(): Promise<AgentUsage> {
  try {
    const result = await readCodexRateLimitsFromAppServer();
    const snapshot = pickCodexSnapshot(result);
    if (!snapshot?.primary && !snapshot?.secondary) {
      return {
        fiveHour: null,
        sevenDay: null,
        error: 'No rate limit windows from app server',
      };
    }

    return mapCodexWindows(snapshot);
  } catch (error: any) {
    return {
      fiveHour: null,
      sevenDay: null,
      error: String(error.message ?? error),
    };
  }
}

function readCodexRateLimitsFromAppServer(): Promise<CodexRateLimitsResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCodexAppServerProcess();
    const rl = readline.createInterface({ input: child.stdout });

    let settled = false;
    let rateLimitsRequestSent = false;
    let stderr = '';
    let requestTimer: NodeJS.Timeout | undefined;

    const doneResolve = (value: CodexRateLimitsResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (requestTimer) {
        clearTimeout(requestTimer);
      }
      rl.close();
      child.kill();
      resolve(value);
    };

    const doneReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (requestTimer) {
        clearTimeout(requestTimer);
      }
      rl.close();
      child.kill();
      reject(error);
    };

    child.on('error', (err) => {
      doneReject(new Error(`Failed to start codex app-server: ${err.message}`));
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4_000) {
        stderr = stderr.slice(-4_000);
      }
    });

    child.stdin.on('error', () => {
      // ignore EPIPE when the process exits while writing
    });

    const send = (payload: Record<string, any>) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (msg.id === CODEX_INIT_REQUEST_ID) {
        if (msg.error) {
          doneReject(
            new Error(
              `codex app-server initialize failed: ${msg.error?.message ?? 'Unknown error'}`,
            ),
          );
          return;
        }
        if (!rateLimitsRequestSent) {
          rateLimitsRequestSent = true;
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({
            jsonrpc: '2.0',
            id: CODEX_RATE_LIMITS_REQUEST_ID,
            method: 'account/rateLimits/read',
            params: null,
          });
        }
        return;
      }

      if (msg.id !== CODEX_RATE_LIMITS_REQUEST_ID) {
        return;
      }

      if (msg.error) {
        doneReject(
          new Error(
            `account/rateLimits/read failed: ${msg.error?.message ?? 'Unknown error'}`,
          ),
        );
        return;
      }

      doneResolve((msg.result ?? {}) as CodexRateLimitsResult);
    });

    child.on('exit', (code, signal) => {
      if (settled) {
        return;
      }
      const detail = stderr.trim() ? ` stderr: ${stderr.trim()}` : '';
      doneReject(
        new Error(
          `codex app-server exited before response (code=${code}, signal=${signal}).${detail}`,
        ),
      );
    });

    requestTimer = setTimeout(() => {
      doneReject(new Error('codex app-server request timed out'));
    }, CODEX_APP_SERVER_TIMEOUT_MS);

    send({
      jsonrpc: '2.0',
      id: CODEX_INIT_REQUEST_ID,
      method: 'initialize',
      params: {
        clientInfo: { name: 'ai-usage-monitor', version: '0.2.7' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function spawnCodexAppServerProcess() {
  if (process.platform === 'win32') {
    return spawn(
      'cmd.exe',
      ['/d', '/s', '/c', 'codex app-server --listen stdio://'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  }
  return spawn('codex', ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function pickCodexSnapshot(
  result: CodexRateLimitsResult,
): CodexRateLimitSnapshot | null {
  return pickRateLimitSnapshot(result, ['codex']);
}

function pickRateLimitSnapshot(
  result: CodexRateLimitsResult,
  preferredKeywords: string[],
): CodexRateLimitSnapshot | null {
  const byLimitId = result.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === 'object') {
    for (const keyword of preferredKeywords) {
      const direct = byLimitId[keyword];
      if (direct) {
        return direct;
      }
    }

    for (const [key, value] of Object.entries(byLimitId)) {
      const loweredKey = key.toLowerCase();
      if (preferredKeywords.some((keyword) => loweredKey.includes(keyword))) {
        return value;
      }
      const label =
        `${value.limitId ?? ''} ${value.limitName ?? ''}`.toLowerCase();
      if (preferredKeywords.some((keyword) => label.includes(keyword))) {
        return value;
      }
    }

    const first = Object.values(byLimitId)[0];
    if (first) {
      return first;
    }
  }

  return result.rateLimits ?? null;
}

function mapCodexWindow(window: CodexRateLimitWindow): UsageResult {
  return {
    utilization: window.usedPercent ?? 0,
    resetsAt: unixToIso(window.resetsAt),
  };
}

function mapCodexWindows(snapshot: CodexRateLimitSnapshot): AgentUsage {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is CodexRateLimitWindow => Boolean(window),
  );

  const hasDurationMetadata = windows.some(
    (window) => getCodexWindowDurationMins(window) !== null,
  );
  if (!hasDurationMetadata) {
    // Older Codex responses used fixed primary=5h, secondary=7d slots.
    return {
      fiveHour: snapshot.primary ? mapCodexWindow(snapshot.primary) : null,
      sevenDay: snapshot.secondary ? mapCodexWindow(snapshot.secondary) : null,
    };
  }

  const fiveHour = windows.find(
    (window) => getCodexWindowDurationMins(window) === 300,
  );
  const sevenDay = windows.find(
    (window) => getCodexWindowDurationMins(window) === 10_080,
  );

  return {
    fiveHour: fiveHour ? mapCodexWindow(fiveHour) : null,
    sevenDay: sevenDay ? mapCodexWindow(sevenDay) : null,
  };
}

function getCodexWindowDurationMins(
  window: CodexRateLimitWindow,
): number | null {
  const values = [
    window.windowDurationMins,
    window.windowDurationMinutes,
    window.windowMinutes,
    window.window_minutes,
    window.window_duration_mins,
  ];
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return null;
}

function unixToIso(ts: number | string | null | undefined): string {
  if (!ts) {
    return '';
  }
  const numericTs = Number(ts);
  if (!Number.isFinite(numericTs)) {
    const parsed = new Date(String(ts));
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }
  const ms = numericTs > 9_999_999_999 ? numericTs : numericTs * 1000;
  return new Date(ms).toISOString();
}

async function getCodexUsageFromSessions(): Promise<AgentUsage> {
  try {
    const sessionsDir = path.join(HOME, '.codex', 'sessions');
    const files = findJsonlFiles(sessionsDir);
    if (files.length === 0) {
      return {
        fiveHour: null,
        sevenDay: null,
        error: 'No session files found',
      };
    }

    const filesWithMtime = files.map((filePath) => {
      try {
        return { path: filePath, mtime: fs.statSync(filePath).mtimeMs };
      } catch {
        return { path: filePath, mtime: 0 };
      }
    });
    filesWithMtime.sort((a, b) => b.mtime - a.mtime);

    let rateLimits: any = null;
    for (const file of filesWithMtime
      .slice(0, SESSION_SCAN_FILE_LIMIT)
      .map((entry) => entry.path)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          const data = JSON.parse(line);
          if (
            data.type === 'event_msg' &&
            data.payload?.type === 'token_count' &&
            data.payload?.rate_limits
          ) {
            rateLimits = data.payload.rate_limits;
          }
        } catch {
          // skip malformed lines
        }
      }
      if (rateLimits) {
        break;
      }
    }

    if (!rateLimits) {
      return { fiveHour: null, sevenDay: null, error: 'No rate limits data' };
    }

    const snapshot: CodexRateLimitSnapshot = {
      primary: rateLimits.primary
        ? normalizeCodexSessionWindow(rateLimits.primary)
        : null,
      secondary: rateLimits.secondary
        ? normalizeCodexSessionWindow(rateLimits.secondary)
        : null,
    };
    return mapCodexWindows(snapshot);
  } catch (error: any) {
    return { fiveHour: null, sevenDay: null, error: String(error.message) };
  }
}

function normalizeCodexSessionWindow(window: any): CodexRateLimitWindow | null {
  if (!window || typeof window !== 'object') {
    return null;
  }
  return {
    usedPercent: Number(window?.used_percent ?? window?.usedPercent ?? 0),
    resetsAt: window?.resets_at ?? window?.resetsAt,
    windowDurationMins:
      window?.window_duration_mins ??
      window?.windowDurationMins ??
      window?.window_minutes ??
      window?.windowMinutes,
  };
}

