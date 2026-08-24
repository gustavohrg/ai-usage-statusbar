import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentUsage } from './provider-types';
import {
  formatHttpError,
  formatUsageErrorDetail,
  HttpStatusError,
  httpsGet,
  httpsPost,
} from './provider-shared';

const HOME = os.homedir();
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_OAUTH_SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers';
const CLAUDE_OAUTH_CLIENT_ID =
  process.env.CLAUDE_CODE_OAUTH_CLIENT_ID ||
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
interface ClaudeOauthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number | string;
  scopes?: string[];
  rateLimitTier?: string;
  subscriptionType?: string;
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: ClaudeOauthCredentials;
  [key: string]: any;
}
export async function getClaudeUsage(): Promise<AgentUsage> {
  const credPath = path.join(HOME, '.claude', '.credentials.json');
  try {
    const cred = readClaudeCredentials(credPath);
    const token = cred.claudeAiOauth?.accessToken;
    if (!token) {
      throw new Error('Missing Claude access token in credentials');
    }

    try {
      const data = await fetchClaudeUsage(token);
      return mapClaudeUsage(data);
    } catch (usageError: any) {
      if (!isClaudeTokenExpiredError(usageError)) {
        throw usageError;
      }

      const refreshed = await refreshClaudeAccessToken(credPath, cred);
      if (!refreshed.accessToken) {
        throw new Error('Claude token refresh did not return access token');
      }

      const retried = await fetchClaudeUsage(refreshed.accessToken);
      return mapClaudeUsage(retried);
    }
  } catch (error: unknown) {
    return {
      fiveHour: null,
      sevenDay: null,
      error: formatUsageErrorDetail('claude', formatHttpError(error)),
    };
  }
}

function readClaudeCredentials(credPath: string): ClaudeCredentialsFile {
  const cred = JSON.parse(
    fs.readFileSync(credPath, 'utf8'),
  ) as ClaudeCredentialsFile;
  if (!cred?.claudeAiOauth) {
    throw new Error('Missing claudeAiOauth in credentials');
  }
  return cred;
}

function mapClaudeUsage(data: any): AgentUsage {
  return {
    fiveHour: data.five_hour
      ? {
          utilization: data.five_hour.utilization ?? 0,
          resetsAt: data.five_hour.resets_at ?? '',
        }
      : null,
    sevenDay: data.seven_day
      ? {
          utilization: data.seven_day.utilization ?? 0,
          resetsAt: data.seven_day.resets_at ?? '',
        }
      : null,
  };
}

function fetchClaudeUsage(token: string): Promise<any> {
  return httpsGet('api.anthropic.com', '/api/oauth/usage', {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': CLAUDE_OAUTH_BETA,
  });
}

function isClaudeTokenExpiredError(error: unknown): boolean {
  const text = String((error as any)?.message ?? error ?? '').toLowerCase();
  if (text.includes('token_expired') || text.includes('token has expired')) {
    return true;
  }

  if (error instanceof HttpStatusError) {
    if (error.statusCode !== 401) {
      return false;
    }
    const bodyText = (error.responseBody || '').toLowerCase();
    return (
      bodyText.includes('token_expired') ||
      bodyText.includes('token has expired')
    );
  }

  return false;
}

async function refreshClaudeAccessToken(
  credPath: string,
  cred: ClaudeCredentialsFile,
): Promise<ClaudeOauthCredentials> {
  const oauth = cred.claudeAiOauth ?? {};
  const refreshToken = oauth.refreshToken;
  if (!refreshToken) {
    throw new Error('Claude refresh token missing. Run `claude setup-token`.');
  }

  const refreshed = await httpsPost(
    'api.anthropic.com',
    '/v1/oauth/token',
    {},
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: CLAUDE_OAUTH_SCOPE,
    },
  );

  const accessToken = refreshed?.access_token;
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('Claude refresh response missing access_token');
  }

  const expiresIn = Number(refreshed?.expires_in ?? 0);
  const nextOauth: ClaudeOauthCredentials = {
    ...oauth,
    accessToken,
    refreshToken:
      typeof refreshed?.refresh_token === 'string' && refreshed.refresh_token
        ? refreshed.refresh_token
        : refreshToken,
    expiresAt: Date.now() + Math.max(0, expiresIn) * 1000,
  };

  if (typeof refreshed?.scope === 'string' && refreshed.scope.trim()) {
    nextOauth.scopes = refreshed.scope.trim().split(/\s+/);
  }

  cred.claudeAiOauth = nextOauth;
  writeJsonFileAtomic(credPath, cred);
  return nextOauth;
}

function writeJsonFileAtomic(filePath: string, data: unknown) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}
