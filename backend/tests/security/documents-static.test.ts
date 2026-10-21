import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static gates for the Documents slice (migration 0031), no database needed.
const backend = resolve(import.meta.dirname, '../..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('Documents: exactly one source file writes app.files / app.file_links (the audited service)', () => {
  it('only document.service.ts writes the two tables, and nothing deletes them at runtime', () => {
    const fileWriters: string[] = [];
    const linkWriters: string[] = [];
    for (const f of walk(join(backend, 'src'))) {
      const text = readFileSync(f, 'utf8');
      const rel = f.slice(backend.length + 1);
      expect(text, f).not.toMatch(/DELETE\s+FROM\s+app\.(files|file_links)/i);
      if (/(INSERT\s+INTO|UPDATE)\s+app\.files\b/i.test(text)) fileWriters.push(rel);
      if (/(INSERT\s+INTO|UPDATE)\s+app\.file_links\b/i.test(text)) linkWriters.push(rel);
    }
    expect(fileWriters).toEqual(['src/modules/documents/document.service.ts']);
    expect(linkWriters).toEqual(['src/modules/documents/document.service.ts']);
  });
});

describe('Documents: the scan worker seam is not reachable over HTTP', () => {
  it('no route file references finalizeScan (a client can never promote its own upload to AVAILABLE)', () => {
    for (const f of walk(join(backend, 'src/modules/documents'))) {
      if (!f.endsWith('.routes.ts')) continue;
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/finalizeScan/);
    }
  });

  it('the service never writes a signed URL to the audit log', () => {
    const svc = readFileSync(join(backend, 'src/modules/documents/document.service.ts'), 'utf8');
    // the presign results are named `upload`/`link`; neither their `.url` is ever handed to recordAudit
    const auditBlocks = svc.match(/recordAudit\([\s\S]*?\);/g) ?? [];
    expect(auditBlocks.length).toBeGreaterThan(0);
    for (const block of auditBlocks) {
      expect(block).not.toMatch(/\.url\b/);
      expect(block).not.toMatch(/presign/i);
    }
  });
});
