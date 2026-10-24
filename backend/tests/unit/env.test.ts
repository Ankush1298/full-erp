import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, Secret } from '../../src/config/env.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { createCursorCodec } from '../../src/shared/pagination/index.js';

const base = {
  DATABASE_URL: 'postgresql://app:Sup3rS3cretValue@127.0.0.1:5432/db', // secret-scan:allow (deliberate test fixture)
};

// Production always needs the dedicated MFA keyring (23-mfa.md §3); generated at run time, not a real credential.
const MFA_KEYS = {
  MFA_ENCRYPTION_KEYS: `m1:${randomBytes(32).toString('base64url')}`,
  MFA_ENCRYPTION_ACTIVE_KEY_ID: 'm1',
};

// Production also needs the dedicated import matching-data HMAC ring (doc 26 §3.5.4); generated at run time.
const IMPORT_KEYS = {
  IMPORT_MATCHING_KEYS: `i1:${randomBytes(32).toString('base64url')}`,
  IMPORT_MATCHING_ACTIVE_KEY_ID: 'i1',
};

// Production also needs object storage for the documents kernel (ADR-010). Not real credentials.
const STORAGE_KEYS = {
  STORAGE_ENDPOINT: 'https://s3.example.com',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY_ID: 'AKIATEST',
  STORAGE_SECRET_ACCESS_KEY: 'storage-secret-value', // secret-scan:allow (deliberate test fixture)
  STORAGE_BUCKET_GENERAL: 'campus-general',
  STORAGE_BUCKET_SENSITIVE: 'campus-sensitive',
  STORAGE_BUCKET_GENERATED: 'campus-generated',
};

// Production also needs ClamAV configuration for malware scanning (ADR-010).
const CLAMAV_KEYS = {
  CLAMAV_HOST: '127.0.0.1',
  CLAMAV_PORT: '3310',
};

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig(base);
    expect(c.env).toBe('development');
    expect(c.host).toBe('127.0.0.1');
    expect(c.trustProxy).toBe(false);
    expect(c.database.ssl).toBe(false);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('never echoes a supplied value in error messages', () => {
    const bad = { DATABASE_URL: 'mysql://user:Sup3rS3cretValue@host/db' }; // secret-scan:allow (deliberate test fixture)
    let message = '';
    try {
      loadConfig(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('Sup3rS3cretValue');
  });

  it('requires TLS to the database in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/DATABASE_SSL/);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        DATABASE_SSL: 'require',
        APP_ORIGINS: 'https://app.example.edu',
        ...MFA_KEYS,
        ...IMPORT_KEYS,
        ...STORAGE_KEYS,
        ...CLAMAV_KEYS,
      }),
    ).not.toThrow();
  });

  it('refuses wildcard bind in production unless behind a trusted proxy', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_SSL: 'require',
      HOST: '0.0.0.0',
      APP_ORIGINS: 'https://app.example.edu',
      ...MFA_KEYS,
      ...IMPORT_KEYS,
      ...STORAGE_KEYS,
      ...CLAMAV_KEYS,
    };
    expect(() => loadConfig(prod)).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...prod, TRUST_PROXY: 'true' })).not.toThrow();
  });
});

describe('APP_ORIGINS (CSRF origin allow-list)', () => {
  const prod = { ...base, NODE_ENV: 'production', DATABASE_SSL: 'require' };
  it('is required in production and must be https', () => {
    expect(() => loadConfig(prod)).toThrow(/APP_ORIGINS: required/);
    expect(() => loadConfig({ ...prod, APP_ORIGINS: 'http://app.example.edu' })).toThrow(/https/);
  });
  it('parses exact origins and rejects paths, wildcards and junk (fail closed)', () => {
    expect(
      loadConfig({ ...base, APP_ORIGINS: 'https://a.edu, http://localhost:5173' }).allowedOrigins,
    ).toEqual(['https://a.edu', 'http://localhost:5173']);
    expect(loadConfig(base).allowedOrigins).toEqual([]);
    for (const bad of [
      '*',
      'https://a.edu/',
      'https://a.edu/path',
      'a.edu',
      'ftp://a.edu',
      'https://*.a.edu',
    ]) {
      expect(() => loadConfig({ ...base, APP_ORIGINS: bad }), bad).toThrow(/APP_ORIGINS/);
    }
  });
});

describe('Secret', () => {
  it('cannot be printed, serialised or inspected', () => {
    const c = loadConfig(base);
    expect(String(c.database.url)).toBe('[REDACTED]');
    expect(`${c.database.url.toString()}`).toBe('[REDACTED]');
    expect(JSON.stringify(c)).not.toContain('Sup3rS3cretValue');
    expect(inspect(c, { depth: 5 })).not.toContain('Sup3rS3cretValue');
  });

  it('reveals only through reveal()', () => {
    expect(new Secret('abc').reveal()).toBe('abc');
  });
});

describe('cursor key configuration (optional)', () => {
  // Generated at run time: nothing below is a real credential.
  const keyA = randomBytes(32).toString('base64url');
  const keyB = randomBytes(32).toString('base64url');
  const keyC = randomBytes(32).toString('base64url');
  const keyD = randomBytes(32).toString('base64url');
  const keyE = randomBytes(32).toString('base64url');
  const prod = {
    ...base,
    NODE_ENV: 'production',
    DATABASE_SSL: 'require',
    APP_ORIGINS: 'https://a.edu',
    ...MFA_KEYS,
    ...IMPORT_KEYS,
    ...STORAGE_KEYS,
    ...CLAMAV_KEYS,
  };

  function messageOf(env: Record<string, string>): string {
    try {
      loadConfig({ ...base, ...env });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as Error).message;
    }
    throw new Error('expected loadConfig to throw');
  }

  it('absent: cursor configuration is absent and existing behaviour is unchanged', () => {
    const c = loadConfig(base);
    expect('cursor' in c).toBe(false);
    expect(c.cursor).toBeUndefined();
    expect(() => loadConfig(prod)).not.toThrow();
    expect('cursor' in loadConfig(prod)).toBe(false);
  });

  it('parses a single key', () => {
    const c = loadConfig({ ...base, CURSOR_KEYS: `k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' });
    expect(c.cursor?.activeKeyId).toBe('k1');
    expect(c.cursor?.keys.size).toBe(1);
    expect(c.cursor?.keys.get('k1')?.reveal()).toBe(keyA);
  });

  it('parses several keys, selects the active one, and still starts in production', () => {
    const c = loadConfig({
      ...prod,
      CURSOR_KEYS: `k1:${keyA},k-2:${keyB},K_3:${keyC},4:${keyD}`,
      CURSOR_ACTIVE_KEY_ID: 'k-2',
    });
    expect(c.cursor?.activeKeyId).toBe('k-2');
    expect([...(c.cursor?.keys.keys() ?? [])]).toEqual(['k1', 'k-2', 'K_3', '4']);
    expect(c.cursor?.keys.get('4')?.reveal()).toBe(keyD);
  });

  it('produces a config the cursor codec accepts directly', () => {
    const c = loadConfig({
      ...base,
      CURSOR_KEYS: `k1:${keyA},k2:${keyB}`,
      CURSOR_ACTIVE_KEY_ID: 'k2',
    });
    if (!c.cursor) throw new Error('cursor configuration missing');
    const codec = createCursorCodec(c.cursor);
    const binding = {
      tenantId: uuidv7(),
      userId: uuidv7(),
      routeId: 'students.directory',
      filterHash: 'ab'.repeat(32),
    };
    expect(codec.decode(codec.encode({ ...binding, lastAdmissionNumber: 'A-1' }), binding)).toEqual(
      {
        lastAdmissionNumber: 'A-1',
      },
    );
  });

  const rejected: [string, Record<string, string>, RegExp][] = [
    ['keys without an active ID', { CURSOR_KEYS: `k1:${keyA}` }, /CURSOR_ACTIVE_KEY_ID: required/],
    ['an active ID without keys', { CURSOR_ACTIVE_KEY_ID: 'k1' }, /CURSOR_KEYS: required/],
    [
      'an explicitly empty CURSOR_KEYS',
      { CURSOR_KEYS: '', CURSOR_ACTIVE_KEY_ID: 'k1' },
      /CURSOR_KEYS: must not be empty/,
    ],
    [
      'an explicitly empty CURSOR_ACTIVE_KEY_ID',
      { CURSOR_KEYS: `k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: '' },
      /CURSOR_ACTIVE_KEY_ID: must not be empty/,
    ],
    [
      'both empty',
      { CURSOR_KEYS: '', CURSOR_ACTIVE_KEY_ID: '' },
      /CURSOR_KEYS: must not be empty[\s\S]*CURSOR_ACTIVE_KEY_ID: must not be empty/,
    ],
    [
      'an entry without a separator',
      { CURSOR_KEYS: `k1${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 must be <keyId>:<key>/,
    ],
    [
      'an extra separator',
      { CURSOR_KEYS: `k1:${keyA}:x`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 must be <keyId>:<key>/,
    ],
    [
      'a trailing comma',
      { CURSOR_KEYS: `k1:${keyA},`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 2 must be <keyId>:<key>/,
    ],
    [
      'a leading comma',
      { CURSOR_KEYS: `,k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 must be <keyId>:<key>/,
    ],
    [
      'a lone comma',
      { CURSOR_KEYS: ',', CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 must be <keyId>:<key>/,
    ],
    [
      'a space after a comma',
      { CURSOR_KEYS: `k1:${keyA}, k2:${keyB}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 2 key ID/,
    ],
    ['an empty key ID', { CURSOR_KEYS: `:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' }, /entry 1 key ID/],
    [
      'a key ID with a space',
      { CURSOR_KEYS: `k 1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k 1' },
      /entry 1 key ID/,
    ],
    [
      'a 17-character key ID',
      { CURSOR_KEYS: `${'k'.repeat(17)}:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key ID/,
    ],
    [
      'a key ID starting with a dash',
      { CURSOR_KEYS: `-k:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key ID/,
    ],
    ['an empty key', { CURSOR_KEYS: 'k1:', CURSOR_ACTIVE_KEY_ID: 'k1' }, /entry 1 key must be/],
    [
      'a padded key',
      { CURSOR_KEYS: `k1:${keyA}=`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'standard base64 characters',
      { CURSOR_KEYS: `k1:${'+'.repeat(43)}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'a non-canonical encoding',
      { CURSOR_KEYS: `k1:${keyA.slice(0, 42)}B`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'a 31-byte key',
      { CURSOR_KEYS: `k1:${randomBytes(31).toString('base64url')}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'a 33-byte key',
      { CURSOR_KEYS: `k1:${randomBytes(33).toString('base64url')}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'a duplicate key ID',
      { CURSOR_KEYS: `k1:${keyA},k1:${keyB}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 2 repeats a key ID/,
    ],
    [
      'duplicate key material',
      { CURSOR_KEYS: `k1:${keyA},k2:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 2 repeats key material/,
    ],
    [
      'more than four keys',
      {
        CURSOR_KEYS: `k1:${keyA},k2:${keyB},k3:${keyC},k4:${keyD},k5:${keyE}`,
        CURSOR_ACTIVE_KEY_ID: 'k1',
      },
      /CURSOR_KEYS: at most 4 keys/,
    ],
    [
      'an active ID that is not configured',
      { CURSOR_KEYS: `k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k2' },
      /CURSOR_ACTIVE_KEY_ID: must name one of the keys/,
    ],
    [
      'an invalid active ID',
      { CURSOR_KEYS: `k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k 1' },
      /CURSOR_ACTIVE_KEY_ID: must be 1 to 16/,
    ],
  ];

  it.each(rejected)(
    'rejects %s, naming the variable and rule and never the value',
    (_name, env, pattern) => {
      const message = messageOf(env);
      expect(message).toMatch(pattern);
      for (const secretText of [keyA, keyB, keyC, keyD, keyE])
        expect(message).not.toContain(secretText);
      for (const value of Object.values(env)) {
        if (value.length > 20) expect(message).not.toContain(value);
      }
    },
  );

  it('is checked together with the production rules in one ConfigError', () => {
    const message = messageOf({ NODE_ENV: 'production', CURSOR_KEYS: `k1:${keyA}` });
    expect(message).toMatch(/CURSOR_ACTIVE_KEY_ID: required/);
    expect(message).toMatch(/APP_ORIGINS: required in production/);
  });

  it('keeps key material out of inspection and serialisation of the config', () => {
    const c = loadConfig({
      ...base,
      CURSOR_KEYS: `k1:${keyA},k2:${keyB}`,
      CURSOR_ACTIVE_KEY_ID: 'k1',
    });
    for (const text of [keyA, keyB]) {
      expect(JSON.stringify(c)).not.toContain(text);
      expect(inspect(c, { depth: 8 })).not.toContain(text);
      expect(String(c.cursor?.keys.get('k1'))).toBe('[REDACTED]');
    }
  });
});

describe('MFA encryption keyring (MFA_ENCRYPTION_KEYS / MFA_ENCRYPTION_ACTIVE_KEY_ID)', () => {
  const k1 = randomBytes(32).toString('base64url');
  const k2 = randomBytes(32).toString('base64url');
  const prod = {
    ...base,
    NODE_ENV: 'production',
    DATABASE_SSL: 'require',
    APP_ORIGINS: 'https://a.edu',
    ...STORAGE_KEYS,
    ...CLAMAV_KEYS,
    ...IMPORT_KEYS,
  };
  const fail = (env: Record<string, string>): string => {
    try {
      loadConfig(env);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as Error).message;
    }
    throw new Error('expected loadConfig to throw');
  };

  it('is required in production: a missing ring refuses to start, and the message names the variable', () => {
    expect(fail(prod)).toMatch(/MFA_ENCRYPTION_KEYS: required in production/);
    const c = loadConfig({
      ...prod,
      MFA_ENCRYPTION_KEYS: `a:${k1}`,
      MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a',
    });
    expect(c.mfa?.activeKeyId).toBe('a');
  });

  it('is optional outside production (MFA is then unavailable, never silently keyless)', () => {
    expect('mfa' in loadConfig(base)).toBe(false);
  });

  it('rejects half-configured, malformed, wrongly sized or duplicated keys and an unknown active id', () => {
    const cases: Record<string, string>[] = [
      { MFA_ENCRYPTION_KEYS: `a:${k1}` },
      { MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a' },
      { MFA_ENCRYPTION_KEYS: '', MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a' },
      { MFA_ENCRYPTION_KEYS: 'a:short', MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a' },
      {
        MFA_ENCRYPTION_KEYS: `a:${randomBytes(16).toString('base64url')}`,
        MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a',
      },
      { MFA_ENCRYPTION_KEYS: `a:${k1}=`, MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a' },
      { MFA_ENCRYPTION_KEYS: `a:${k1},a:${k2}`, MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a' },
      { MFA_ENCRYPTION_KEYS: `a:${k1},b:${k1}`, MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a' },
      { MFA_ENCRYPTION_KEYS: `a:${k1}`, MFA_ENCRYPTION_ACTIVE_KEY_ID: 'b' },
      { MFA_ENCRYPTION_KEYS: `bad id:${k1}`, MFA_ENCRYPTION_ACTIVE_KEY_ID: 'bad id' },
    ];
    for (const env of cases) {
      for (const target of [base, prod]) {
        const message = fail({ ...target, ...env });
        expect(message).toMatch(/MFA_ENCRYPTION_(KEYS|ACTIVE_KEY_ID)/);
        expect(message).not.toContain(k1);
        expect(message).not.toContain(k2);
      }
    }
  });

  it('must not reuse cursor key material (one key, one purpose)', () => {
    const message = fail({
      ...base,
      MFA_ENCRYPTION_KEYS: `a:${k1}`,
      MFA_ENCRYPTION_ACTIVE_KEY_ID: 'a',
      CURSOR_KEYS: `c:${k1}`,
      CURSOR_ACTIVE_KEY_ID: 'c',
    });
    expect(message).toMatch(/MFA_ENCRYPTION_KEYS: must not reuse key material from CURSOR_KEYS/);
    expect(message).not.toContain(k1);
  });

  it('keeps retiring keys for decryption and never prints a key', () => {
    const c = loadConfig({
      ...base,
      MFA_ENCRYPTION_KEYS: `old:${k1},new:${k2}`,
      MFA_ENCRYPTION_ACTIVE_KEY_ID: 'new',
    });
    expect([...(c.mfa?.keys.keys() ?? [])]).toEqual(['old', 'new']);
    expect(c.mfa?.activeKeyId).toBe('new');
    const printed = `${inspect(c, { depth: 10 })}${JSON.stringify(c)}`;
    expect(printed).not.toContain(k1);
    expect(printed).not.toContain(k2);
  });
});

describe('object storage (STORAGE_*) for the documents kernel', () => {
  const prodNoStorage = {
    ...base,
    NODE_ENV: 'production',
    DATABASE_SSL: 'require',
    APP_ORIGINS: 'https://a.edu',
    ...MFA_KEYS,
    ...IMPORT_KEYS,
    ...CLAMAV_KEYS,
  };

  it('is absent (and the documents feature unavailable) outside production when unset', () => {
    expect('storage' in loadConfig(base)).toBe(false);
    expect(loadConfig(base).storage).toBeUndefined();
  });

  it('is REQUIRED in production: a missing config fails closed and names the variable', () => {
    let message = '';
    try {
      loadConfig(prodNoStorage);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/STORAGE_ENDPOINT: required in production/);
  });

  it('is all-or-nothing: a partial config is refused and the secret is never echoed', () => {
    let message = '';
    try {
      loadConfig({
        ...base,
        STORAGE_ENDPOINT: 'https://s3.example.com',
        STORAGE_SECRET_ACCESS_KEY: 'partial-secret',
      }); // secret-scan:allow
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/STORAGE_REGION: required when any STORAGE_\* is set/);
    expect(message).not.toContain('partial-secret');
  });

  it('refuses a non-https endpoint and refuses three buckets that are not distinct', () => {
    expect(() =>
      loadConfig({ ...base, ...STORAGE_KEYS, STORAGE_ENDPOINT: 'http://s3.example.com' }),
    ).toThrow(/STORAGE_ENDPOINT: must be an https/);
    expect(() =>
      loadConfig({ ...base, ...STORAGE_KEYS, STORAGE_BUCKET_SENSITIVE: 'campus-general' }),
    ).toThrow(/distinct/);
  });

  it('parses a full config and keeps the credentials inside Secret (never printed)', () => {
    const c = loadConfig({ ...base, ...STORAGE_KEYS });
    expect(c.storage?.endpoint).toBe('https://s3.example.com');
    expect(c.storage?.buckets.SENSITIVE).toBe('campus-sensitive');
    const printed = `${inspect(c, { depth: 10 })}${JSON.stringify(c)}`;
    expect(printed).not.toContain('storage-secret-value');
  });
});

describe('ClamAV daemon config (CLAMAV_*) for the scan worker', () => {
  const prodNoClamAv = {
    ...base,
    NODE_ENV: 'production',
    DATABASE_SSL: 'require',
    APP_ORIGINS: 'https://a.edu',
    ...MFA_KEYS,
    ...IMPORT_KEYS,
    ...STORAGE_KEYS,
  };

  it('is absent outside production when unset', () => {
    expect('clamav' in loadConfig(base)).toBe(false);
    expect(loadConfig(base).clamav).toBeUndefined();
  });

  it('is REQUIRED in production: missing CLAMAV_HOST fails closed and names the variable', () => {
    let message = '';
    try {
      loadConfig(prodNoClamAv);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/CLAMAV_HOST: required in production/);
  });

  it('parses valid ClamAV configuration with custom port and timeout', () => {
    const c = loadConfig({
      ...base,
      CLAMAV_HOST: 'clamav.internal',
      CLAMAV_PORT: '3310',
      CLAMAV_TIMEOUT_MS: '15000',
    });
    expect(c.clamav).toEqual({
      host: 'clamav.internal',
      port: 3310,
      timeoutMs: 15000,
    });
  });

  it('rejects an empty CLAMAV_HOST', () => {
    expect(() => loadConfig({ ...base, CLAMAV_HOST: '   ' })).toThrow(
      /CLAMAV_HOST: must not be empty/,
    );
  });
});

describe('import matching-data HMAC keyring (IMPORT_MATCHING_KEYS / IMPORT_MATCHING_ACTIVE_KEY_ID)', () => {
  const k1 = randomBytes(32).toString('base64url');
  const k2 = randomBytes(32).toString('base64url');
  const prod = {
    ...base,
    NODE_ENV: 'production',
    DATABASE_SSL: 'require',
    APP_ORIGINS: 'https://a.edu',
    ...MFA_KEYS,
    ...STORAGE_KEYS,
    ...CLAMAV_KEYS,
  };
  const fail = (env: Record<string, string>): string => {
    try {
      loadConfig(env);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as Error).message;
    }
    throw new Error('expected loadConfig to throw');
  };

  it('is required in production: a missing ring refuses to start, and the message names the variable', () => {
    expect(fail(prod)).toMatch(/IMPORT_MATCHING_KEYS: required in production/);
    const c = loadConfig({
      ...prod,
      IMPORT_MATCHING_KEYS: `a:${k1}`,
      IMPORT_MATCHING_ACTIVE_KEY_ID: 'a',
    });
    expect(c.importMatching?.activeKeyId).toBe('a');
  });

  it('is optional outside production (commits with matching data are then refused, never unbound)', () => {
    expect('importMatching' in loadConfig(base)).toBe(false);
  });

  it('rejects half-configured, malformed, wrongly sized or duplicated keys and an unknown active id', () => {
    const cases: Record<string, string>[] = [
      { IMPORT_MATCHING_KEYS: `a:${k1}` },
      { IMPORT_MATCHING_ACTIVE_KEY_ID: 'a' },
      { IMPORT_MATCHING_KEYS: '', IMPORT_MATCHING_ACTIVE_KEY_ID: 'a' },
      { IMPORT_MATCHING_KEYS: 'a:short', IMPORT_MATCHING_ACTIVE_KEY_ID: 'a' },
      {
        IMPORT_MATCHING_KEYS: `a:${randomBytes(16).toString('base64url')}`,
        IMPORT_MATCHING_ACTIVE_KEY_ID: 'a',
      },
      { IMPORT_MATCHING_KEYS: `a:${k1}=`, IMPORT_MATCHING_ACTIVE_KEY_ID: 'a' },
      { IMPORT_MATCHING_KEYS: `a:${k1},a:${k2}`, IMPORT_MATCHING_ACTIVE_KEY_ID: 'a' },
      { IMPORT_MATCHING_KEYS: `a:${k1},b:${k1}`, IMPORT_MATCHING_ACTIVE_KEY_ID: 'a' },
      { IMPORT_MATCHING_KEYS: `a:${k1}`, IMPORT_MATCHING_ACTIVE_KEY_ID: 'b' },
      { IMPORT_MATCHING_KEYS: `bad id:${k1}`, IMPORT_MATCHING_ACTIVE_KEY_ID: 'bad id' },
    ];
    for (const env of cases) {
      for (const target of [base, prod]) {
        const message = fail({ ...target, ...env });
        expect(message).toMatch(/IMPORT_MATCHING_(KEYS|ACTIVE_KEY_ID)/);
        expect(message).not.toContain(k1);
        expect(message).not.toContain(k2);
      }
    }
  });

  it('must not reuse cursor or MFA key material (one key, one purpose)', () => {
    for (const [name, other] of [
      ['CURSOR_KEYS', { CURSOR_KEYS: `c:${k1}`, CURSOR_ACTIVE_KEY_ID: 'c' }],
      [
        'MFA_ENCRYPTION_KEYS',
        { MFA_ENCRYPTION_KEYS: `m:${k1}`, MFA_ENCRYPTION_ACTIVE_KEY_ID: 'm' },
      ],
    ] as const) {
      const message = fail({
        ...base,
        ...other,
        IMPORT_MATCHING_KEYS: `a:${k2},b:${k1}`,
        IMPORT_MATCHING_ACTIVE_KEY_ID: 'a',
      });
      expect(message).toContain(`IMPORT_MATCHING_KEYS: must not reuse key material from ${name}`);
      expect(message).not.toContain(k1);
    }
  });

  it('keeps retiring keys for verification and never prints a key', () => {
    const c = loadConfig({
      ...base,
      IMPORT_MATCHING_KEYS: `old:${k1},new:${k2}`,
      IMPORT_MATCHING_ACTIVE_KEY_ID: 'new',
    });
    expect([...(c.importMatching?.keys.keys() ?? [])]).toEqual(['old', 'new']);
    expect(c.importMatching?.activeKeyId).toBe('new');
    const printed = `${inspect(c, { depth: 10 })}${JSON.stringify(c)}`;
    expect(printed).not.toContain(k1);
    expect(printed).not.toContain(k2);
  });
});
