/**
 * @packageDocumentation
 * Request body reading and JSON parsing with hard safety limits. The reader
 * enforces a maximum payload size (defends against unbounded-body DoS) and only
 * accepts `application/json` for mutating requests.
 */

import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors';

/** Default maximum accepted request body, in bytes (256 KiB). */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** Read the raw request body, aborting if it exceeds `maxBytes`. */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      fn();
    };

    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop accumulating and drain the rest so the connection stays healthy
        // enough for the router to send a 413 response (we never buffer beyond
        // the limit, so memory stays bounded).
        finish(() => {
          reject(new HttpError(413, 'payload_too_large', `request body exceeds ${maxBytes} bytes`));
        });
        // Switch the stream into discard mode after our listeners are removed;
        // this drains the unread bytes and keeps the HTTP keep-alive framing in
        // sync without buffering attacker-controlled data.
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(() => resolve(Buffer.concat(chunks)));
    const onError = (err: Error): void => finish(() => reject(err));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Parse the request body as JSON. Returns `undefined` for an empty body. Throws
 * an {@link HttpError} for the wrong content type or malformed JSON.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return undefined;

  const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType && contentType !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'expected application/json');
  }
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw HttpError.badRequest('request body is not valid JSON');
  }
}
