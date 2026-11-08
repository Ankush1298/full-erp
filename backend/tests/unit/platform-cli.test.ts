import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_GRANTS_NOT_IMPLEMENTED_MESSAGE,
  SupportGrantsNotImplementedError,
  createSupportGrant,
  createTenant,
  EMAIL_REGEX,
  parseArgs,
  seedTenant,
  SLUG_REGEX,
  suspendTenant,
} from '../../tools/platform/platform-cli.js';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = resolve(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('Platform CLI (Unit)', () => {
  describe('Argument Parsing & Validation', () => {
    it('parses tenant:create flags correctly', () => {
      const parsed = parseArgs([
        'tenant:create',
        '--name',
        'Apex Institute of Technology',
        '--slug',
        'apex-tech',
        '--admin-email',
        'admin@apex.test',
      ]);

      expect(parsed.command).toBe('tenant:create');
      expect(parsed.flags['name']).toBe('Apex Institute of Technology');
      expect(parsed.flags['slug']).toBe('apex-tech');
      expect(parsed.flags['admin-email']).toBe('admin@apex.test');
    });

    it('parses tenant:seed and tenant:suspend flags', () => {
      const parsedSeed = parseArgs(['tenant:seed', '--tenant', 'apex-tech']);
      expect(parsedSeed.command).toBe('tenant:seed');
      expect(parsedSeed.flags['tenant']).toBe('apex-tech');

      const parsedSuspend = parseArgs([
        'tenant:suspend',
        '--tenant',
        'apex-tech',
        '--reason',
        'Administrative audit',
      ]);
      expect(parsedSuspend.command).toBe('tenant:suspend');
      expect(parsedSuspend.flags['tenant']).toBe('apex-tech');
      expect(parsedSuspend.flags['reason']).toBe('Administrative audit');
    });

    it('parses support:grant flags with duration', () => {
      const parsed = parseArgs([
        'support:grant',
        '--tenant',
        'apex-tech',
        '--admin-email',
        'secops@campusos.test',
        '--duration-hours',
        '2',
      ]);
      expect(parsed.command).toBe('support:grant');
      expect(parsed.flags['tenant']).toBe('apex-tech');
      expect(parsed.flags['admin-email']).toBe('secops@campusos.test');
      expect(parsed.flags['duration-hours']).toBe('2');
    });

    it('throws helpful usage error when no command or --help is given', () => {
      expect(() => parseArgs([])).toThrow(/Usage:/);
      expect(() => parseArgs(['--help'])).toThrow(/Usage:/);
    });

    it('slug regex matches valid slugs and rejects invalid ones', () => {
      expect(SLUG_REGEX.test('apex-tech')).toBe(true);
      expect(SLUG_REGEX.test('oxford-univ-2026')).toBe(true);
      expect(SLUG_REGEX.test('a')).toBe(false); // too short
      expect(SLUG_REGEX.test('Apex-Tech')).toBe(false); // uppercase
      expect(SLUG_REGEX.test('-apex')).toBe(false); // leading hyphen
      expect(SLUG_REGEX.test('apex-')).toBe(false); // trailing hyphen
      expect(SLUG_REGEX.test('apex_tech')).toBe(false); // underscore
    });

    it('email regex validates correctly', () => {
      expect(EMAIL_REGEX.test('admin@college.edu')).toBe(true);
      expect(EMAIL_REGEX.test('invalid-email')).toBe(false);
      expect(EMAIL_REGEX.test('@domain.com')).toBe(false);
    });
  });

  describe('createTenant', () => {
    it('rejects invalid inputs before executing database queries', async () => {
      const mockDb = { query: vi.fn() };

      await expect(createTenant(mockDb, { name: '', slug: 'valid-slug' })).rejects.toThrow(
        'Tenant name must be between 1 and 255 characters.',
      );

      await expect(
        createTenant(mockDb, { name: 'Valid Name', slug: 'INVALID_SLUG!' }),
      ).rejects.toThrow(
        'Tenant slug must consist of 3-63 lowercase alphanumeric characters or hyphens.',
      );

      await expect(
        createTenant(mockDb, {
          name: 'Valid Name',
          slug: 'valid-slug',
          adminEmail: 'not-an-email',
        }),
      ).rejects.toThrow('Invalid administrator email format.');

      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('rejects duplicate slug when organization already exists', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ id: 'existing-id' }],
        }),
      };

      await expect(
        createTenant(mockDb, { name: 'New Campus', slug: 'existing-campus' }),
      ).rejects.toThrow('An organization with slug "existing-campus" already exists.');
    });

    it('provisions organization and seeds roles successfully', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT id FROM app.organizations WHERE slug = $1')) {
            return Promise.resolve({ rows: [] }); // Slug not taken
          }
          if (sql.includes('SELECT code FROM platform.permissions')) {
            return Promise.resolve({ rows: [{ code: 'user.account.read' }] });
          }
          if (sql.includes('SELECT id FROM app.roles WHERE')) {
            return Promise.resolve({ rows: [{ id: 'role-college-admin-id' }] });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const result = await createTenant(mockDb, {
        name: 'Metro University',
        slug: 'metro-univ',
        adminEmail: 'admin@metro.test',
      });

      expect(result.name).toBe('Metro University');
      expect(result.slug).toBe('metro-univ');
      expect(result.status).toBe('ACTIVE');
      expect(result.adminUserId).toBeDefined();

      // Verify organization was inserted
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO app.organizations'),
        [result.id, 'Metro University', 'metro-univ'],
      );

      // Verify admin user was inserted
      expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO app.users'), [
        result.adminUserId,
        result.id,
        'admin@metro.test',
        'Metro University Administrator',
      ]);

      // Verify COLLEGE_ADMIN role assignment was inserted
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO app.role_assignments'),
        [expect.any(String), result.id, result.adminUserId, 'role-college-admin-id'],
      );
    });
  });

  describe('seedTenant', () => {
    it('throws error when organization is not found', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      };

      await expect(seedTenant(mockDb, 'unknown-org')).rejects.toThrow(
        'Organization "unknown-org" not found.',
      );
    });

    it('re-seeds permissions when organization is found', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT id, name, slug FROM app.organizations')) {
            return Promise.resolve({
              rows: [{ id: 'org-123', name: 'Valley College', slug: 'valley-col' }],
            });
          }
          if (sql.includes('SELECT code FROM platform.permissions')) {
            return Promise.resolve({ rows: [{ code: 'user.account.read' }] });
          }
          if (sql.includes('SELECT id FROM app.roles WHERE')) {
            return Promise.resolve({ rows: [{ id: 'role-1' }] });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const result = await seedTenant(mockDb, 'valley-col');
      expect(result.id).toBe('org-123');
      expect(result.name).toBe('Valley College');
    });
  });

  describe('suspendTenant', () => {
    it('suspends active tenant', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ id: 'org-123', name: 'Valley College', status: 'SUSPENDED' }],
        }),
      };

      const result = await suspendTenant(mockDb, 'valley-col', 'Security audit');
      expect(result.status).toBe('SUSPENDED');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'SUSPENDED'"),
        ['valley-col'],
      );
    });

    it('throws when tenant is not found', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      };

      await expect(suspendTenant(mockDb, 'missing-org')).rejects.toThrow(
        'Organization "missing-org" not found.',
      );
    });
  });

  describe('support grants (removed, fail closed)', () => {
    it('the CLI refuses before connecting to anything, prints no token, and exits non-zero (no database env set)', () => {
      const r = spawnSync(
        'npx',
        [
          'tsx',
          'tools/platform/cli.ts',
          'support:grant',
          '--tenant',
          'x',
          '--admin-email',
          'a@b.test',
        ],
        {
          cwd: resolve(__dirname, '../..'),
          env: { PATH: process.env['PATH'] ?? '' },
          encoding: 'utf8',
        },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('not implemented');
      expect(r.stdout).toBe('');
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/[A-Za-z0-9_-]{20,}\.[0-9a-f]{64}/); // no payload.signature token
    });

    it('no insecure fallback signing key and no grant-token minting remains in the platform tooling or the application', () => {
      const files = [
        ...walk(resolve(__dirname, '../../tools')),
        ...walk(resolve(__dirname, '../../src')),
      ];
      expect(files.length).toBeGreaterThan(50);
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        expect(text, f).not.toContain('support-grant-local-key');
        expect(text, f).not.toMatch(/grantToken/);
      }
    });

    it('the CLI refuses before connecting to anything, prints no token, and exits non-zero (no database env set)', () => {
      const r = spawnSync(
        'npx',
        [
          'tsx',
          'tools/platform/cli.ts',
          'support:grant',
          '--tenant',
          'x',
          '--admin-email',
          'a@b.test',
        ],
        {
          cwd: resolve(__dirname, '../..'),
          env: { PATH: process.env['PATH'] ?? '' },
          encoding: 'utf8',
        },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('not implemented');
      expect(r.stdout).toBe('');
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/[A-Za-z0-9_-]{20,}\.[0-9a-f]{64}/); // no payload.signature token
    });

    it('no insecure fallback signing key and no HMAC grant minting remains in the platform tooling or the application', () => {
      const files = [
        ...walk(resolve(__dirname, '../../tools')),
        ...walk(resolve(__dirname, '../../src')),
      ];
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        expect(text, f).not.toContain('support-grant-local-key');
        expect(text, f).not.toMatch(/grantToken/);
      }
    });

    it('createSupportGrant issues nothing: it always throws, whatever it is given', () => {
      expect(() =>
        (createSupportGrant as (...a: unknown[]) => unknown)('org-1', 'x@campusos.test', 4),
      ).toThrow(SupportGrantsNotImplementedError);
      expect(() => createSupportGrant()).toThrow(/not implemented/);
      expect(SUPPORT_GRANTS_NOT_IMPLEMENTED_MESSAGE).not.toMatch(/signature/i);
    });
  });
});
