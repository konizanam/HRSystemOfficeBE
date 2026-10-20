import { Logger } from '@nestjs/common';
import { connect } from 'node:net';
import { env } from '../../config/env';

/** The verdict of a virus scan. */
export type ScanResult = { clean: true } | { clean: false; signature: string };

/**
 * Virus-scan hook for uploads (section 10.4). The default does nothing; set
 * `VIRUS_SCANNER=clamav` to scan with clamd over TCP. A scanner that cannot give a verdict throws,
 * and the upload is refused (fail closed).
 */
export interface VirusScanner {
  readonly name: string;
  scan(bytes: Buffer): Promise<ScanResult>;
}

export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

export class NoopVirusScanner implements VirusScanner {
  readonly name = 'none';

  async scan(): Promise<ScanResult> {
    return { clean: true };
  }
}

/** Raised when the scanner could not give a verdict. */
export class ScannerUnavailableError extends Error {}

/** clamd INSTREAM chunk size (clamd's StreamMaxLength still applies to the whole file). */
const CHUNK_BYTES = 64 * 1024;

/**
 * ClamAV over the clamd TCP protocol: `zINSTREAM`, then length-prefixed chunks and a zero-length
 * terminator; clamd answers `stream: OK` or `stream: <signature> FOUND`.
 */
export class ClamAvScanner implements VirusScanner {
  readonly name = 'clamav';
  private readonly logger = new Logger(ClamAvScanner.name);

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const replies: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn();
      };
      socket.setTimeout(this.timeoutMs, () =>
        finish(() => reject(new ScannerUnavailableError('The virus scanner timed out'))),
      );
      socket.on('error', (err) => {
        this.logger.warn({ err: err.message }, 'clamd connection failed');
        finish(() => reject(new ScannerUnavailableError('The virus scanner is not available')));
      });
      socket.on('data', (chunk: Buffer) => replies.push(chunk));
      socket.on('end', () =>
        finish(() => {
          const reply = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
          const parsed = parseClamdReply(reply);
          if (parsed) resolve(parsed);
          else reject(new ScannerUnavailableError(`Unexpected virus scanner reply: ${reply.slice(0, 100)}`));
        }),
      );
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}

/** Reads `stream: OK` / `stream: Eicar-Test-Signature FOUND`; null for anything else. */
export function parseClamdReply(reply: string): ScanResult | null {
  const body = reply.replace(/^stream:\s*/i, '').trim();
  if (body === 'OK') return { clean: true };
  const found = /^(.*)\s+FOUND$/.exec(body);
  if (found?.[1]) return { clean: false, signature: found[1].trim() };
  return null;
}

/** The scanner chosen by `VIRUS_SCANNER`. */
export function virusScannerFromEnv(): VirusScanner {
  const e = env();
  return e.VIRUS_SCANNER === 'clamav'
    ? new ClamAvScanner(e.CLAMAV_HOST, e.CLAMAV_PORT, e.CLAMAV_TIMEOUT_MS)
    : new NoopVirusScanner();
}
