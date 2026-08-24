import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
export class HttpStatusError extends Error {
  statusCode: number;
  responseBody: string;

  constructor(statusCode: number, message: string, responseBody: string) {
    super(message);
    this.name = 'HttpStatusError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export function formatHttpError(error: unknown): string {
  if (error instanceof HttpStatusError) {
    return error.message;
  }
  return String((error as any)?.message ?? error);
}

export function formatUsageErrorDetail(
  provider: 'claude' | 'codex' | 'copilot',
  errorText: string,
): string {
  const text = String(errorText || '').toLowerCase();
  if (provider === 'claude') {
    if (
      text.includes('token_expired') ||
      text.includes('token has expired') ||
      text.includes('invalid_grant')
    ) {
      return 'CLAUDE CLI RELOGIN REQUIRED (run: claude setup-token)';
    }
    if (
      text.includes('refresh token missing') ||
      text.includes('missing claudeaioauth') ||
      text.includes('missing claude access token') ||
      text.includes('.credentials.json') ||
      (text.includes('enoent') && text.includes('no such file'))
    ) {
      return 'CLAUDE CLI LOGIN REQUIRED (run: claude setup-token)';
    }
    if (text.includes('timed out') || text.includes('timeout')) {
      return 'CLAUDE API TIMEOUT';
    }
    return 'CLAUDE USAGE UNAVAILABLE';
  }

  if (provider === 'codex') {
    if (
      text.includes('authentication') ||
      text.includes('unauthorized') ||
      text.includes('401') ||
      text.includes('login required') ||
      text.includes('not logged in')
    ) {
      return 'CODEX CLI LOGIN REQUIRED (run: codex login)';
    }
    if (
      text.includes('failed to start codex app-server') &&
      (text.includes('enoent') ||
        text.includes('not recognized') ||
        text.includes('cannot find'))
    ) {
      return 'CODEX CLI NOT FOUND (check codex install)';
    }
    if (
      text.includes('no session files found') ||
      text.includes('no rate limits data')
    ) {
      return 'CODEX CLI DATA MISSING (run: codex once)';
    }
    if (text.includes('timed out') || text.includes('timeout')) {
      return 'CODEX CLI TIMEOUT';
    }
    if (text.includes('app-server')) {
      return 'CODEX APP-SERVER UNAVAILABLE';
    }
    return 'CODEX USAGE UNAVAILABLE';
  }

  if (
    text.includes('workspace') ||
    text.includes('no copilot usage records') ||
    text.includes('chat session') ||
    text.includes('transcript')
  ) {
    return 'COPILOT DATA MISSING (open Copilot Chat first)';
  }
  if (text.includes('permission') || text.includes('eacces')) {
    return 'COPILOT DATA PERMISSION ERROR';
  }
  return 'COPILOT USAGE UNAVAILABLE';
}

export function httpsGet(
  hostname: string,
  urlPath: string,
  headers: Record<string, string>,
): Promise<any> {
  return httpsJsonRequest('GET', hostname, urlPath, headers);
}

export function httpsPost(
  hostname: string,
  urlPath: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<any> {
  return httpsJsonRequest('POST', hostname, urlPath, headers, body);
}

export function httpsJsonRequest(
  method: 'GET' | 'POST',
  hostname: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let payload = '';
    const reqHeaders: Record<string, string> = { ...headers };
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload).toString();
    }

    const req = https.request(
      { hostname, path: urlPath, method, headers: reqHeaders },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const status = res.statusCode ?? 0;
            let message = `HTTP ${status}`;
            try {
              const errBody = JSON.parse(raw);
              if (errBody?.error?.message) {
                message = `HTTP ${status}: ${errBody.error.message}`;
              } else if (raw) {
                message = `HTTP ${status}: ${raw}`;
              }
            } catch {
              if (raw) {
                message = `HTTP ${status}: ${raw}`;
              }
            }
            reject(new HttpStatusError(status, message, raw));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(8_000, () => {
      req.destroy(new Error('Request timed out'));
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

export function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) {
    return results;
  }

  const walk = (currentDir: string) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  };

  walk(dir);
  return results;
}
