import * as net from 'node:net';
import type { ClamAvConfig } from '../../config/env.js';

export type ScanVerdict = 'CLEAN' | 'INFECTED' | 'INDETERMINATE';

export interface ScanResult {
  readonly verdict: ScanVerdict;
  /** Name of detected malware/signature if INFECTED, or error description if INDETERMINATE. */
  readonly details?: string;
}

export interface MalwareScanner {
  readonly kind: string;
  scanStream(stream: NodeJS.ReadableStream): Promise<ScanResult>;
}

export interface ClamAvScannerOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SCAN_BYTES = 25 * 1024 * 1024; // 25 MiB bounded ceiling
const MAX_CHUNK_SIZE = 64 * 1024; // 64 KiB safe clamav chunk size

/**
 * Production ClamAV malware scanner.
 *
 * Communicates with the clamd daemon over a TCP socket using the streaming `zINSTREAM` protocol.
 * The stream is sent as chunked blocks: [4-byte big-endian length][chunk bytes], terminated by [0x00, 0x00, 0x00, 0x00].
 * All timeouts (connection, read, response) and socket failures are caught and return INDETERMINATE, failing closed.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly kind = 'clamav';
  readonly #host: string;
  readonly #port: number;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  constructor(options: ClamAvScannerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_SCAN_BYTES;
  }

  async scanStream(stream: NodeJS.ReadableStream): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve) => {
      let resolved = false;
      const socket = new net.Socket();
      socket.setTimeout(this.#timeoutMs);

      function finish(result: ScanResult): void {
        if (!resolved) {
          resolved = true;
          clearTimeout(connectTimer);
          clearTimeout(responseTimer);
          socket.removeAllListeners();
          socket.destroy();
          resolve(result);
        }
      }

      // Connection timeout
      const connectTimer = setTimeout(() => {
        finish({ verdict: 'INDETERMINATE', details: 'ClamAV socket connection timed out' });
      }, DEFAULT_CONNECT_TIMEOUT_MS);

      // Overall bounded timeout
      const responseTimer = setTimeout(() => {
        finish({ verdict: 'INDETERMINATE', details: 'ClamAV response timed out' });
      }, this.#timeoutMs);

      socket.connect(this.#port, this.#host, () => {
        clearTimeout(connectTimer);
        // Begin zINSTREAM session (null-terminated command)
        socket.write(Buffer.from('zINSTREAM\0', 'utf8'));

        let totalBytesSent = 0;

        const onData = (chunk: Buffer | string): void => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytesSent += buf.length;

          if (totalBytesSent > this.#maxBytes) {
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
            finish({
              verdict: 'INDETERMINATE',
              details: `File size exceeded scan limit of ${this.#maxBytes} bytes`,
            });
            return;
          }

          // Slice chunk into maximum 64KB sub-chunks if needed
          let offset = 0;
          while (offset < buf.length) {
            const slice = buf.subarray(offset, offset + MAX_CHUNK_SIZE);
            offset += slice.length;

            const header = Buffer.alloc(4);
            header.writeUInt32BE(slice.length, 0);
            socket.write(header);
            socket.write(slice);
          }
        };

        const onEnd = (): void => {
          // Zero-length chunk signals end of stream
          const term = Buffer.alloc(4, 0);
          socket.write(term);
        };

        const onError = (err: Error): void => {
          finish({ verdict: 'INDETERMINATE', details: `Stream error: ${err.message}` });
        };

        stream.on('data', onData);
        stream.once('end', onEnd);
        stream.once('error', onError);
      });

      let responseBuffer = '';
      socket.on('data', (data) => {
        responseBuffer += data.toString('utf8');
        // ClamAV terminates its response with \0 or \n
        if (responseBuffer.includes('\0') || responseBuffer.includes('\n')) {
          const cleaned = responseBuffer.replace(/[\0\r\n]/g, '').trim();

          if (cleaned.endsWith('OK')) {
            finish({ verdict: 'CLEAN' });
          } else if (cleaned.includes('FOUND')) {
            const match = /stream:\s*(.+?)\s*FOUND/.exec(cleaned);
            const signature = match && match[1] ? match[1].trim() : 'Malware detected';
            finish({ verdict: 'INFECTED', details: signature });
          } else {
            finish({
              verdict: 'INDETERMINATE',
              details: cleaned || 'Malformed scanner response',
            });
          }
        }
      });

      socket.on('timeout', () => {
        clearTimeout(connectTimer);
        finish({ verdict: 'INDETERMINATE', details: 'ClamAV response timed out' });
      });

      socket.on('error', (err) => {
        clearTimeout(connectTimer);
        finish({ verdict: 'INDETERMINATE', details: `ClamAV socket error: ${err.message}` });
      });

      socket.on('close', () => {
        clearTimeout(connectTimer);
        if (!resolved) {
          finish({
            verdict: 'INDETERMINATE',
            details: 'ClamAV socket closed before scan completed',
          });
        }
      });
    });
  }
}

/**
 * Test/Development malware scanner.
 *
 * MUST NOT be used in production. Returns the configured simulated outcome.
 */
export class MockMalwareScanner implements MalwareScanner {
  readonly kind = 'mock';
  readonly #outcome: ScanResult;

  constructor(outcome: ScanResult = { verdict: 'CLEAN' }) {
    this.#outcome = outcome;
  }

  async scanStream(_stream: NodeJS.ReadableStream): Promise<ScanResult> {
    return Promise.resolve(this.#outcome);
  }
}

/**
 * Builds the appropriate malware scanner based on environment and configuration.
 *
 * Fails closed in production if ClamAV configuration is missing or invalid.
 * Prevents accidental or silent selection of the mock scanner in production.
 */
export function createMalwareScanner(config?: ClamAvConfig, env?: string): MalwareScanner {
  if (env === 'production') {
    if (!config?.host) {
      throw new Error(
        'ClamAV scanner configuration is required in production (cannot fall back to mock scanner)',
      );
    }
    return new ClamAvScanner({
      host: config.host,
      port: config.port,
      timeoutMs: config.timeoutMs,
    });
  }

  if (config?.host) {
    return new ClamAvScanner({
      host: config.host,
      port: config.port,
      timeoutMs: config.timeoutMs,
    });
  }

  throw new Error(
    'Malware scanner configuration is missing. Refusing to default to mock scanner without explicit injection.',
  );
}
