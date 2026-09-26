import type * as http from 'http';
import { LOCAL_MACHINE_RPC_PATH, LOCAL_SCHEDULE_CONTROL_PATH } from '@lody/shared';
import { LOCAL_PROJECT_CONTROL_PATH } from '@lody/shared/node/local-project-control';
import {
  LOCAL_CONTROL_HEADER,
  LOCAL_SESSION_CONTROL_PATH,
  LOCAL_SESSION_CONTROL_STREAM_MEDIA_TYPE,
} from '@lody/shared/node/local-ipc';
import type { LocalSessionControlResponse } from '@lody/shared';
import { LocalControlHandler, type LocalSessionControlConfig } from '@/lib/local-control-handler';

export const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
let nextControlRequestId = 1;
export type { LocalSessionControlConfig } from '@/lib/local-control-handler';

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>
): boolean {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return false;
  }
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function wantsSessionControlStream(req: http.IncomingMessage, requestPath: string): boolean {
  if (requestPath !== LOCAL_SESSION_CONTROL_PATH) return false;
  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return value
    .split(',')
    .some((entry) => entry.trim().startsWith(LOCAL_SESSION_CONTROL_STREAM_MEDIA_TYPE));
}

function writeSessionControlStreamFrame(
  res: http.ServerResponse,
  frame: Record<string, unknown>
): boolean {
  if (res.writableEnded || res.destroyed) return false;
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': `${LOCAL_SESSION_CONTROL_STREAM_MEDIA_TYPE}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  }
  try {
    res.write(`${JSON.stringify(frame)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function createLocalSessionControlRequestHandler(
  config: LocalSessionControlConfig
): http.RequestListener {
  const handler = new LocalControlHandler(config);

  return (req, res) => {
    const requestId = nextControlRequestId++;
    const requestPath = typeof req.url === 'string' ? req.url.split('?')[0] : '';
    const controlHeader = req.headers[LOCAL_CONTROL_HEADER];
    const controlHeaderValue = Array.isArray(controlHeader)
      ? controlHeader.join(',')
      : (controlHeader ?? '');
    config.logger.debug(
      `[local-control:${requestId}] incoming request: method=${req.method ?? 'UNKNOWN'} path=${requestPath || '/'} header=${controlHeaderValue || 'missing'}`
    );

    if (req.method === 'OPTIONS') {
      config.logger.debug(
        `[local-control:${requestId}] rejected request: method_not_allowed (OPTIONS)`
      );
      jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    if (req.method !== 'POST') {
      config.logger.debug(
        `[local-control:${requestId}] rejected request: not_found (method=${req.method ?? 'UNKNOWN'})`
      );
      jsonResponse(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    if (
      requestPath !== LOCAL_SCHEDULE_CONTROL_PATH &&
      requestPath !== LOCAL_SESSION_CONTROL_PATH &&
      requestPath !== LOCAL_MACHINE_RPC_PATH &&
      requestPath !== LOCAL_PROJECT_CONTROL_PATH
    ) {
      config.logger.debug(
        `[local-control:${requestId}] rejected request: not_found (path=${requestPath || 'empty'})`
      );
      jsonResponse(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    if (req.headers[LOCAL_CONTROL_HEADER] !== '1') {
      config.logger.debug(
        `[local-control:${requestId}] rejected request: forbidden (invalid header value=${controlHeaderValue || 'missing'})`
      );
      jsonResponse(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        config.logger.debug(
          `[local-control:${requestId}] rejected request: payload_too_large size=${size}`
        );
        jsonResponse(res, 413, { ok: false, error: 'payload_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      void (async () => {
        if (res.headersSent || res.writableEnded || res.destroyed) {
          return;
        }

        const raw = Buffer.concat(chunks).toString('utf8');
        config.logger.debug(
          `[local-control:${requestId}] request body received: bytes=${Buffer.byteLength(raw, 'utf8')} path=${requestPath}`
        );
        const streamResponses = wantsSessionControlStream(req, requestPath);
        const response = await handler.handle({
          path: requestPath,
          rawBody: raw,
          requestId,
          onSessionResponse: streamResponses
            ? (message: LocalSessionControlResponse) => {
                writeSessionControlStreamFrame(res, { kind: 'response', response: message });
              }
            : undefined,
        });
        if (streamResponses && response.status === 200 && response.payload.ok === true) {
          writeSessionControlStreamFrame(res, { kind: 'complete' });
          if (!res.writableEnded && !res.destroyed) {
            res.end();
          }
          return;
        }
        if (streamResponses && res.headersSent) {
          writeSessionControlStreamFrame(res, {
            kind: 'error',
            error:
              typeof response.payload.error === 'string'
                ? response.payload.error
                : 'local_control_failed',
            status: response.status,
            details: response.payload.details,
          });
          if (!res.writableEnded && !res.destroyed) {
            res.end();
          }
          return;
        }
        jsonResponse(res, response.status, response.payload);
      })();
    });

    req.on('error', (error) => {
      config.logger.debug(`[local-control:${requestId}] request stream error: ${error.message}`);
      if (!res.headersSent) {
        jsonResponse(res, 500, { ok: false, error: 'request_stream_error' });
      }
    });
  };
}
