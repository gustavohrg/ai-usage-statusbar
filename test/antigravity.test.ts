const assert = require('node:assert/strict');
const { test } = require('node:test');
const runtime = require('../out/antigravity.js');

type UsageResult = {
  utilization: number;
  resetsAt: string;
};
type UsageWindow = {
  label: string;
  modelGroup?: string;
  utilization: number;
  resetsAt: string;
  kind: 'fiveHour' | 'sevenDay' | 'other';
  usageKnown?: boolean;
};
type AgentUsage = {
  fiveHour: UsageResult | null;
  sevenDay: UsageResult | null;
  windows: UsageWindow[];
  error?: string;
  meta?: { tooltipNotes?: string[] };
};
type AntigravityProcessInfo = {
  pid: number;
  uid: number;
  command: string;
};
type AntigravityRequestArgs = {
  scheme: 'https' | 'http';
  port: number;
  path: string;
  body: unknown;
  timeoutMs: number;
};
type AntigravityProbeOptions = {
  discoverProcess?: () => Promise<AntigravityProcessInfo | null>;
  discoverPorts?: (pid: number, timeoutMs: number) => Promise<number[]>;
  request?: (args: AntigravityRequestArgs) => Promise<unknown>;
  runHeadless?: (timeoutMs: number) => Promise<unknown>;
  useHeadless?: boolean;
  retryDelayMs?: number;
  logger?: (message: string) => void;
};
type AntigravityRuntime = {
  ANTIGRAVITY_QUOTA_SUMMARY_PATH: string;
  getAntigravityOptimisticWindow: (
    usage: AgentUsage,
  ) => { window: UsageResult; kind: UsageWindow['kind'] } | null;
  getAntigravityUsage: (
    options?: AntigravityProbeOptions,
  ) => Promise<AgentUsage>;
  parseAntigravityCommandModelConfigs: (payload: unknown) => AgentUsage;
  parseAntigravityHeadlessUsage: (payload: unknown) => AgentUsage;
  parseAntigravityListeningPorts: (output: string) => number[];
  parseAntigravityProcesses: (
    output: string,
    currentUid?: number,
  ) => AntigravityProcessInfo[];
  parseAntigravityQuotaSummary: (payload: unknown) => AgentUsage;
  parseAntigravityTimestamp: (value: unknown) => string;
  parseAntigravityUserStatus: (payload: unknown) => AgentUsage;
};

const antigravity = runtime as unknown as AntigravityRuntime;
const {
  ANTIGRAVITY_QUOTA_SUMMARY_PATH,
  getAntigravityOptimisticWindow,
  getAntigravityUsage,
  parseAntigravityCommandModelConfigs,
  parseAntigravityHeadlessUsage,
  parseAntigravityListeningPorts,
  parseAntigravityProcesses,
  parseAntigravityQuotaSummary,
  parseAntigravityTimestamp,
  parseAntigravityUserStatus,
} = antigravity;

type FixtureRecord = Record<string, unknown>;
type FixtureGroup = {
  displayName: string;
  buckets: FixtureRecord[];
};

const resetAt = '2030-01-01T00:00:00.000Z';

function summaryPayload(groups: FixtureGroup[]): FixtureRecord {
  return { response: { groups } };
}

function headlessPayload(groups: unknown[]): FixtureRecord {
  return {
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: { groups },
    },
  };
}

test('parses headless agy usage command data', () => {
  const usage = parseAntigravityHeadlessUsage(
    headlessPayload([
      {
        name: 'Gemini Models',
        buckets: [
          {
            id: 'gemini-weekly',
            name: 'Weekly Limit Remaining',
            window: 'weekly',
            remaining_fraction: 0.75,
            reset_time: resetAt,
          },
        ],
      },
    ]),
  );

  assert.equal(usage.sevenDay?.utilization, 25);
  assert.match(usage.meta.tooltipNotes[0], /headless/);
});

function bucket(overrides: FixtureRecord = {}): FixtureRecord {
  const hasExplicitRemaining =
    Object.prototype.hasOwnProperty.call(overrides, 'remainingFraction') ||
    Object.prototype.hasOwnProperty.call(overrides, 'remaining');
  return {
    bucketId: 'weekly',
    displayName: 'Weekly',
    ...(hasExplicitRemaining ? {} : { remainingFraction: 0.5 }),
    resetTime: resetAt,
    ...overrides,
  };
}

test('parses complete Gemini and Claude/GPT quota summary', () => {
  const usage = parseAntigravityQuotaSummary(
    summaryPayload([
      {
        displayName: 'Gemini Models',
        buckets: [
          bucket({
            bucketId: 'gemini-weekly',
            displayName: 'Weekly limit',
            remainingFraction: 0.82,
          }),
          bucket({
            bucketId: 'gemini-5h',
            displayName: '5-hour limit',
            remainingFraction: 0.65,
          }),
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          bucket({
            bucketId: 'claude-weekly',
            displayName: 'Weekly limit',
            remaining: { remainingFraction: 0.4 },
          }),
          bucket({
            bucketId: 'claude-5h',
            displayName: '5-hour limit',
            remaining: { case: 'remainingFraction', value: 0.9 },
          }),
        ],
      },
    ]),
  );

  assert.equal(usage.windows.length, 4);
  assert.ok(usage.fiveHour);
  assert.ok(usage.sevenDay);
  assert.equal(usage.fiveHour.utilization, 35);
  assert.equal(usage.sevenDay.utilization, 60);
  assert.deepEqual(
    usage.windows.map((window) => window.kind),
    ['sevenDay', 'fiveHour', 'sevenDay', 'fiveHour'],
  );
});

test('uses the least-constrained AGY model group for compact usage', () => {
  const usage = parseAntigravityQuotaSummary(
    summaryPayload([
      {
        displayName: 'Gemini Models',
        buckets: [
          bucket({
            bucketId: 'gemini-weekly',
            displayName: 'Weekly limit',
            remainingFraction: 0.9,
          }),
          bucket({
            bucketId: 'gemini-5h',
            displayName: '5-hour limit',
            remainingFraction: 0.7,
          }),
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          bucket({
            bucketId: 'claude-weekly',
            displayName: 'Weekly limit',
            remainingFraction: 0,
          }),
        ],
      },
    ]),
  );

  const compact = getAntigravityOptimisticWindow(usage);
  assert.ok(compact);
  assert.equal(Math.round(compact.window.utilization), 30);
  assert.equal(compact.kind, 'fiveHour');
});

test('supports direct, nested, and one-of remaining fractions', () => {
  const usage = parseAntigravityQuotaSummary(
    summaryPayload([
      {
        displayName: 'Shapes',
        buckets: [
          bucket({
            bucketId: 'direct',
            displayName: 'Direct',
            remainingFraction: 0.8,
          }),
          bucket({
            bucketId: 'nested',
            displayName: 'Nested',
            remainingFraction: undefined,
            remaining: { remainingFraction: 0.7 },
          }),
          bucket({
            bucketId: 'oneof',
            displayName: 'One Of',
            remainingFraction: undefined,
            remaining: { case: 'remainingFraction', value: 0.6 },
          }),
        ],
      },
    ]),
  );

  assert.deepEqual(
    usage.windows.map((window) => Math.round(window.utilization)),
    [20, 30, 40],
  );
});

test('keeps weekly-only responses without synthesizing five-hour usage', () => {
  const usage = parseAntigravityQuotaSummary(
    summaryPayload([
      {
        displayName: 'Gemini Models',
        buckets: [bucket({ bucketId: 'weekly', displayName: 'Weekly' })],
      },
    ]),
  );

  assert.equal(usage.fiveHour, null);
  assert.ok(usage.sevenDay);
  assert.equal(usage.sevenDay.utilization, 50);
  assert.equal(usage.windows[0].kind, 'sevenDay');
});

test('projects a five-hour bucket into the compatibility field', () => {
  const usage = parseAntigravityQuotaSummary(
    summaryPayload([
      {
        displayName: 'Gemini Models',
        buckets: [bucket({ bucketId: '5h', displayName: '5h limit' })],
      },
    ]),
  );
  assert.ok(usage.fiveHour);
  assert.equal(usage.fiveHour.utilization, 50);
  assert.equal(usage.sevenDay, null);
  assert.equal(usage.windows[0].kind, 'fiveHour');
});

test('marks disabled and missing-usage buckets as unknown', () => {
  const usage = parseAntigravityQuotaSummary(
    summaryPayload([
      {
        displayName: 'Gemini Models',
        buckets: [
          bucket({ bucketId: 'disabled', disabled: true }),
          bucket({ bucketId: 'missing', remainingFraction: undefined }),
          bucket({ bucketId: 'valid', remainingFraction: 0.9 }),
        ],
      },
    ]),
  );

  assert.equal(usage.windows.length, 3);
  assert.deepEqual(
    usage.windows.map((window) => window.usageKnown),
    [false, false, true],
  );
  assert.ok(usage.sevenDay);
  assert.equal(Math.round(usage.sevenDay.utilization), 10);
});

test('parses legacy GetUserStatus rows by display label', () => {
  const usage = parseAntigravityUserStatus({
    userStatus: {
      email: 'user@example.com',
      userTier: { name: 'Ultra' },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini',
            modelOrAlias: { model: 'placeholder-a' },
            quotaInfo: { remainingFraction: 0.8, resetTime: resetAt },
          },
          {
            label: 'Gemini',
            modelOrAlias: { model: 'placeholder-b' },
            quotaInfo: { remainingFraction: 0.5, resetTime: resetAt },
          },
          {
            label: 'Claude',
            modelOrAlias: { model: 'placeholder-c' },
            quotaInfo: { remainingFraction: 0.9, resetTime: resetAt },
          },
        ],
      },
    },
  });

  assert.equal(usage.windows.length, 2);
  assert.equal(usage.fiveHour, null);
  const gemini = usage.windows.find((window) => window.label === 'Gemini');
  assert.ok(gemini);
  assert.equal(gemini.utilization, 50);
  assert.ok(usage.meta);
  assert.deepEqual(usage.meta.tooltipNotes, [
    'Account: user@example.com',
    'Plan: Ultra',
  ]);
});

test('accepts an empty GetCommandModelConfigs response', () => {
  const usage = parseAntigravityCommandModelConfigs({
    clientModelConfigs: [],
  });

  assert.deepEqual(usage.windows, []);
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.sevenDay, null);
});

test('handles malformed and numeric reset timestamps', () => {
  const numeric = parseAntigravityTimestamp(1_893_456_000);
  assert.equal(numeric, new Date(1_893_456_000 * 1000).toISOString());
  assert.equal(parseAntigravityTimestamp('not-a-timestamp'), '');

  const usage = parseAntigravityQuotaSummary(
    summaryPayload([
      {
        displayName: 'Gemini',
        buckets: [
          bucket({ bucketId: 'numeric', resetTime: 1_893_456_000 }),
          bucket({ bucketId: 'malformed', resetTime: 'invalid' }),
        ],
      },
    ]),
  );
  assert.equal(usage.windows[0].resetsAt, numeric);
  assert.equal(usage.windows[1].resetsAt, '');
});

test('clamps utilization at zero and one hundred percent', () => {
  const usage = parseAntigravityQuotaSummary(
    summaryPayload([
      {
        displayName: 'Gemini',
        buckets: [
          bucket({ bucketId: 'overused', remainingFraction: -0.5 }),
          bucket({ bucketId: 'unused', remainingFraction: 1.5 }),
        ],
      },
    ]),
  );

  assert.deepEqual(
    usage.windows.map((window) => window.utilization),
    [100, 0],
  );
});

test('detects same-user agy processes and loopback ports', () => {
  const processes = parseAntigravityProcesses(
    [
      '41001 501 /custom/install/agy --serve',
      '41002 502 /custom/install/agy --serve',
      '41003 501 /custom/install/not-agy',
    ].join('\n'),
    501,
  );
  assert.deepEqual(
    processes.map((process) => process.pid),
    [41001],
  );

  assert.deepEqual(
    parseAntigravityListeningPorts(
      'agy 41001 user 10u IPv4 TCP 127.0.0.1:45123 (LISTEN)\n' +
        'agy 41001 user 11u IPv6 TCP [::1]:45124 (LISTEN)',
    ),
    [45123, 45124],
  );
});

test('uses headless agy usage without a persistent local process', async () => {
  const usage = await getAntigravityUsage({
    runHeadless: async () =>
      headlessPayload([
        {
          name: 'Claude and GPT models',
          buckets: [
            {
              id: 'third-party-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.6,
              reset_time: resetAt,
            },
          ],
        },
      ]),
    logger: () => {},
  });

  assert.equal(usage.sevenDay?.utilization, 40);
  assert.match(usage.meta.tooltipNotes[0], /headless/);
});

test('returns a friendly unavailable state without a running agy process', async () => {
  const usage = await getAntigravityUsage({
    discoverProcess: async () => null,
    logger: () => {},
  });

  assert.match(usage.error, /ANTIGRAVITY NOT RUNNING/);
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.sevenDay, null);
});

test('returns endpoint diagnostics when every live request fails', async () => {
  const usage = await getAntigravityUsage({
    discoverProcess: async () => ({
      pid: 41001,
      uid: 501,
      command: '/custom/install/agy',
    }),
    discoverPorts: async () => [45123],
    request: async () => {
      throw new Error('HTTP 404: embeddings cache missing');
    },
    retryDelayMs: 0,
    logger: () => {},
  });

  assert.match(usage.error, /ANTIGRAVITY USAGE UNAVAILABLE/);
  assert.ok(usage.meta);
  assert.match(
    usage.meta.tooltipNotes[0],
    /HTTPS 45123 RetrieveUserQuotaSummary/,
  );
  assert.match(usage.meta.tooltipNotes[0], /HTTP 45123 GetCommandModelConfigs/);
});

test('retries a transient quota summary parse failure', async () => {
  let quotaAttempts = 0;
  const usage = await getAntigravityUsage({
    discoverProcess: async () => ({
      pid: 41001,
      uid: 501,
      command: '/custom/install/agy',
    }),
    discoverPorts: async () => [45123],
    request: async ({ path }) => {
      if (path === ANTIGRAVITY_QUOTA_SUMMARY_PATH) {
        quotaAttempts += 1;
        if (quotaAttempts === 1) {
          return { response: {} };
        }
        return summaryPayload([
          {
            displayName: 'Gemini Models',
            buckets: [bucket({ bucketId: 'weekly', displayName: 'Weekly' })],
          },
        ]);
      }
      throw new Error('identity not needed for this fixture');
    },
    retryDelayMs: 0,
  });

  assert.equal(quotaAttempts, 2);
  assert.ok(usage.sevenDay);
  assert.equal(Math.round(usage.sevenDay.utilization), 50);
});

test('moves past timed-out endpoints without retrying the same request', async () => {
  const attempts: Array<{ scheme: string; path: string }> = [];
  const usage = await getAntigravityUsage({
    discoverProcess: async () => ({
      pid: 41001,
      uid: 501,
      command: '/custom/install/agy',
    }),
    discoverPorts: async () => [45123],
    request: async ({ scheme, path }) => {
      attempts.push({ scheme, path });
      if (scheme === 'https' && path === ANTIGRAVITY_QUOTA_SUMMARY_PATH) {
        throw new Error('Antigravity request timed out');
      }
      if (scheme === 'http' && path === ANTIGRAVITY_QUOTA_SUMMARY_PATH) {
        return summaryPayload([
          {
            displayName: 'Gemini Models',
            buckets: [bucket({ bucketId: 'weekly', displayName: 'Weekly' })],
          },
        ]);
      }
      throw new Error('HTTP 404: endpoint unavailable');
    },
    retryDelayMs: 0,
  });

  assert.ok(usage.sevenDay);
  assert.equal(
    attempts.filter(
      (attempt) =>
        attempt.scheme === 'https' &&
        attempt.path === ANTIGRAVITY_QUOTA_SUMMARY_PATH,
    ).length,
    1,
  );
  assert.ok(
    attempts.some(
      (attempt) =>
        attempt.scheme === 'http' &&
        attempt.path === ANTIGRAVITY_QUOTA_SUMMARY_PATH,
    ),
  );
});

test('tries HTTPS before falling back to HTTP', async () => {
  const attempts: Array<{ scheme: string; path: string }> = [];
  const usage = await getAntigravityUsage({
    discoverProcess: async () => ({
      pid: 41001,
      uid: 501,
      command: '/custom/install/agy',
    }),
    discoverPorts: async () => [45123],
    request: async ({ scheme, path }) => {
      attempts.push({ scheme, path });
      if (scheme === 'https') {
        throw new Error('self-signed connection unavailable');
      }
      return summaryPayload([
        {
          displayName: 'Gemini Models',
          buckets: [bucket({ bucketId: 'weekly', displayName: 'Weekly' })],
        },
      ]);
    },
    retryDelayMs: 0,
  });

  const lastAttempt = attempts[attempts.length - 1];
  assert.ok(usage.sevenDay);
  assert.equal(usage.sevenDay.utilization, 50);
  assert.equal(attempts[0].scheme, 'https');
  assert.equal(lastAttempt.scheme, 'http');
  assert.ok(
    attempts.some(
      (attempt) =>
        attempt.scheme === 'http' &&
        attempt.path === ANTIGRAVITY_QUOTA_SUMMARY_PATH,
    ),
  );
  assert.ok(attempts.some((attempt) => attempt.scheme === 'https'));
});
