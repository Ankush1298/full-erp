import * as net from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ClamAvScanner,
  MockMalwareScanner,
  createMalwareScanner,
} from '../../src/modules/documents/scanner.js';

describe('ClamAvScanner (streaming TCP zINSTREAM protocol)', () => {
  it('detects clean file when clamd answers OK', async () => {
    const server = net.createServer((socket) => {
      let receivedCmd = false;
      const chunks: Buffer[] = [];

      socket.on('data', (data) => {
        if (!receivedCmd) {
          receivedCmd = true;
          expect(data.subarray(0, 10).toString('utf8')).toBe('zINSTREAM\0');
          data = data.subarray(10);
        }
        if (data.length > 0) {
          chunks.push(data);
        }
        // When client sends 4-byte 0 (terminator), answer OK
        if (data.includes(Buffer.from([0, 0, 0, 0]))) {
          socket.write('stream: OK\0');
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const scanner = new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 2000 });
      const stream = Readable.from([Buffer.from('Clean file content')]);
      const result = await scanner.scanStream(stream);

      expect(result).toEqual({ verdict: 'CLEAN' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('detects malware when clamd answers FOUND with threat name', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        if (data.includes(Buffer.from([0, 0, 0, 0]))) {
          socket.write('stream: Win.Test.EICAR_HDB-1 FOUND\0');
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const scanner = new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 2000 });
      const stream = Readable.from([Buffer.from('EICAR test string')]);
      const result = await scanner.scanStream(stream);

      expect(result).toEqual({
        verdict: 'INFECTED',
        details: 'Win.Test.EICAR_HDB-1',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports INDETERMINATE on scanner ERROR response', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('stream: Internal clamav daemon error ERROR\0');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const scanner = new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 2000 });
      const stream = Readable.from([Buffer.from('File content')]);
      const result = await scanner.scanStream(stream);

      expect(result.verdict).toBe('INDETERMINATE');
      expect(result.details).toContain('Internal clamav daemon error ERROR');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports INDETERMINATE when socket connection is refused (fail closed)', async () => {
    // Pick an unused port where no server is listening
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 59999, timeoutMs: 1000 });
    const stream = Readable.from([Buffer.from('File content')]);
    const result = await scanner.scanStream(stream);

    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.details).toMatch(/ECONNREFUSED/);
  });

  it('reports INDETERMINATE on scanner timeout (fail closed)', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // Connects but intentionally never responds
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const scanner = new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 200 });
      const stream = Readable.from([Buffer.from('File content')]);
      const result = await scanner.scanStream(stream);

      expect(result.verdict).toBe('INDETERMINATE');
      expect(result.details).toMatch(/timed out/i);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports INDETERMINATE when file exceeds maxBytes limit', async () => {
    const server = net.createServer((_socket) => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const scanner = new ClamAvScanner({
        host: '127.0.0.1',
        port,
        timeoutMs: 2000,
        maxBytes: 10, // tiny max limit
      });
      const stream = Readable.from([Buffer.from('This chunk is longer than 10 bytes')]);
      const result = await scanner.scanStream(stream);

      expect(result.verdict).toBe('INDETERMINATE');
      expect(result.details).toMatch(/exceeded scan limit/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('splits chunks larger than 64KB into valid ClamAV chunk frames', async () => {
    const receivedChunkSizes: number[] = [];
    let buf = Buffer.alloc(0);
    const sockets = new Set<net.Socket>();

    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));

      socket.on('data', (data) => {
        buf = Buffer.concat([buf, data]);
        if (buf.length >= 10 && buf.subarray(0, 10).toString('utf8') === 'zINSTREAM\0') {
          buf = buf.subarray(10);
        }

        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            buf = buf.subarray(4);
            socket.write('stream: OK\0');
            break;
          }
          if (buf.length < 4 + len) {
            break;
          }
          receivedChunkSizes.push(len);
          buf = buf.subarray(4 + len);
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const scanner = new ClamAvScanner({
        host: '127.0.0.1',
        port,
        timeoutMs: 2000,
        maxBytes: 200 * 1024,
      });
      // 100KB buffer (exceeds 64KB single frame)
      const largeBuffer = Buffer.alloc(100 * 1024, 0x41);
      const stream = Readable.from([largeBuffer]);
      const result = await scanner.scanStream(stream);

      expect(result).toEqual({ verdict: 'CLEAN' });
      expect(receivedChunkSizes[0]).toBe(64 * 1024);
      expect(receivedChunkSizes[1]).toBe(36 * 1024);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('MockMalwareScanner', () => {
  it('returns configured outcome', async () => {
    const cleanScanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    expect(await cleanScanner.scanStream(Readable.from([]))).toEqual({ verdict: 'CLEAN' });

    const infectedScanner = new MockMalwareScanner({
      verdict: 'INFECTED',
      details: 'Test.Virus',
    });
    expect(await infectedScanner.scanStream(Readable.from([]))).toEqual({
      verdict: 'INFECTED',
      details: 'Test.Virus',
    });
  });
});

describe('createMalwareScanner', () => {
  it('requires ClamAV configuration in production and fails closed', () => {
    expect(() => createMalwareScanner(undefined, 'production')).toThrow(
      /ClamAV scanner configuration is required in production/,
    );
    expect(() =>
      createMalwareScanner({ host: '', port: 3310, timeoutMs: 5000 }, 'production'),
    ).toThrow(/ClamAV scanner configuration is required in production/);
  });

  it('builds ClamAvScanner in production when configuration is valid', () => {
    const scanner = createMalwareScanner(
      { host: 'clamav.internal', port: 3310, timeoutMs: 15000 },
      'production',
    );
    expect(scanner.kind).toBe('clamav');
    expect(scanner).toBeInstanceOf(ClamAvScanner);
  });

  it('builds ClamAvScanner in development/test when config is present', () => {
    const scanner = createMalwareScanner(
      { host: 'localhost', port: 3310, timeoutMs: 5000 },
      'development',
    );
    expect(scanner.kind).toBe('clamav');
  });

  it('refuses to default to mock scanner silently when configuration is absent', () => {
    expect(() => createMalwareScanner(undefined, 'development')).toThrow(
      /Refusing to default to mock scanner/,
    );
  });
});
