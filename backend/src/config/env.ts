import { z } from 'zod';
import {
  CURSOR_KEY_ID_PATTERN,
  CURSOR_MAX_KEYS,
  isCanonicalCursorKey,
} from '../shared/pagination/index.js';

/**
 * Wraps a secret value so it cannot be printed or serialised by accident
 * (logs, JSON responses, util.inspect). The only way to read it is `.reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED]';
  }
}

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL'),
  DATABASE_SSL: z.enum(['disable', 'require']).default('disable'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  TRUST_PROXY: booleanString,
  // Comma-separated browser origins allowed to call state-changing endpoints (CSRF origin check).
  APP_ORIGINS: z.string().default(''),
  // Optional cursor-codec keys: both or neither (see parseCursorKeys). Left undefined, not defaulted, so an explicitly
  // supplied empty string can be told apart from an absent variable and refused.
  CURSOR_KEYS: z.string().optional(),
  CURSOR_ACTIVE_KEY_ID: z.string().optional(),
  // Explicit, disabled-by-default activation of GET /api/v1/students/directory. Separate from the cursor keys: keys alone
  // never switch the route on. It does NOT detect or guarantee a single-instance deployment (the route's rate limiter is
  // per process); setting it is the operator's statement that this limitation is acceptable.
  STUDENT_DIRECTORY_LIST_ENABLED: booleanString,
  // Dedicated keyring for TOTP secrets at rest (docs/architecture/v3/23-mfa.md §3), same format as the cursor keys but a
  // separate ring: material may never be shared with CURSOR_KEYS. Both or neither; REQUIRED in production, because MFA is
  // mandatory for the HOD-and-above and REGISTRAR roles and no MFA can be enrolled or verified without it.
  MFA_ENCRYPTION_KEYS: z.string().optional(),
  MFA_ENCRYPTION_ACTIVE_KEY_ID: z.string().optional(),
});

/** Parses APP_ORIGINS: exact origins only (scheme://host[:port]), no paths, no wildcards. */
function parseOrigins(raw: string, problems: string[]): string[] {
  const out: string[] = [];
  for (const item of raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    try {
      const u = new URL(item);
      if (
        (u.protocol !== 'https:' && u.protocol !== 'http:') ||
        u.origin !== item ||
        item.includes('*')
      ) {
        throw new Error();
      }
      out.push(u.origin);
    } catch {
      problems.push('APP_ORIGINS: each entry must be an exact origin like https://app.example.edu');
      break;
    }
  }
  return out;
}

/** A keyring: one active key (used for new data) plus retiring keys (read only). */
export interface KeyRingConfig {
  readonly activeKeyId: string;
  /** Every configured key, active and retiring, by ID. Values are canonical unpadded base64url of 32 bytes. */
  readonly keys: ReadonlyMap<string, Secret>;
}
export type CursorConfig = KeyRingConfig;
export type MfaConfig = KeyRingConfig;

/**
 * `<KEYS>` is `<keyId>:<key>` entries separated by commas (no whitespace is trimmed); `<ACTIVE>` names the key used for
 * new data, every other key only reads. Both variables or neither: absent means the ring is absent and nothing else
 * changes. Errors name the variable and the rule, never a value. Used for CURSOR_KEYS and MFA_ENCRYPTION_KEYS.
 */
function parseKeyRing(
  rawKeys: string | undefined,
  rawActive: string | undefined,
  names: { keys: string; active: string },
  problems: string[],
): KeyRingConfig | undefined {
  const K = names.keys;
  const A = names.active;
  if (rawKeys === undefined && rawActive === undefined) return undefined;
  if (rawKeys === undefined || rawActive === undefined || rawKeys === '' || rawActive === '') {
    if (rawKeys === undefined) problems.push(`${K}: required when ${A} is set`);
    if (rawActive === undefined) problems.push(`${A}: required when ${K} is set`);
    if (rawKeys === '') problems.push(`${K}: must not be empty`);
    if (rawActive === '') problems.push(`${A}: must not be empty`);
    return undefined;
  }

  const before = problems.length;
  const entries = rawKeys.split(',');
  if (entries.length > CURSOR_MAX_KEYS) {
    problems.push(`${K}: at most ${CURSOR_MAX_KEYS} keys are allowed`);
    return undefined;
  }
  const keys = new Map<string, Secret>();
  const seenMaterial = new Set<string>();
  entries.forEach((entry, index) => {
    const n = index + 1;
    const parts = entry.split(':');
    const id = parts[0];
    const key = parts[1];
    if (parts.length !== 2 || id === undefined || key === undefined) {
      problems.push(`${K}: entry ${n} must be <keyId>:<key> (empty entries are not allowed)`);
    } else if (!CURSOR_KEY_ID_PATTERN.test(id)) {
      problems.push(
        `${K}: entry ${n} key ID must be 1 to 16 letters, digits, "-" or "_", starting with a letter or digit`,
      );
    } else if (!isCanonicalCursorKey(key)) {
      problems.push(
        `${K}: entry ${n} key must be the canonical unpadded base64url encoding of exactly 32 bytes`,
      );
    } else if (keys.has(id)) {
      problems.push(`${K}: entry ${n} repeats a key ID`);
    } else if (seenMaterial.has(key)) {
      problems.push(`${K}: entry ${n} repeats key material`);
    } else {
      seenMaterial.add(key);
      keys.set(id, new Secret(key));
    }
  });

  if (!CURSOR_KEY_ID_PATTERN.test(rawActive)) {
    problems.push(
      `${A}: must be 1 to 16 letters, digits, "-" or "_", starting with a letter or digit`,
    );
  } else if (problems.length === before && !keys.has(rawActive)) {
    problems.push(`${A}: must name one of the keys in ${K}`);
  }
  return problems.length === before ? { activeKeyId: rawActive, keys } : undefined;
}

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly trustProxy: boolean;
  /** Exact browser origins allowed to send state-changing requests. Empty = same-host only (dev). */
  readonly allowedOrigins: readonly string[];
  readonly database: {
    readonly url: Secret;
    readonly ssl: boolean;
    readonly poolMax: number;
  };
  /** Present only when CURSOR_KEYS and CURSOR_ACTIVE_KEY_ID are both configured. Read by the student directory route. */
  readonly cursor?: CursorConfig;
  /** STUDENT_DIRECTORY_LIST_ENABLED (default false). The directory route needs this AND `cursor`. */
  readonly studentDirectoryListEnabled: boolean;
  /** MFA_ENCRYPTION_KEYS + MFA_ENCRYPTION_ACTIVE_KEY_ID. Always present in production; absent elsewhere = MFA unavailable. */
  readonly mfa?: MfaConfig;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates configuration and fails fast. Error messages name the variable and the rule that
 * failed — never the supplied value (values may be secrets).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;

  const problems: string[] = [];
  const allowedOrigins = parseOrigins(e.APP_ORIGINS, problems);
  const cursor = parseKeyRing(
    e.CURSOR_KEYS,
    e.CURSOR_ACTIVE_KEY_ID,
    { keys: 'CURSOR_KEYS', active: 'CURSOR_ACTIVE_KEY_ID' },
    problems,
  );
  const mfa = parseKeyRing(
    e.MFA_ENCRYPTION_KEYS,
    e.MFA_ENCRYPTION_ACTIVE_KEY_ID,
    { keys: 'MFA_ENCRYPTION_KEYS', active: 'MFA_ENCRYPTION_ACTIVE_KEY_ID' },
    problems,
  );
  if (mfa && cursor) {
    const cursorMaterial = new Set([...cursor.keys.values()].map((k) => k.reveal()));
    if ([...mfa.keys.values()].some((k) => cursorMaterial.has(k.reveal()))) {
      problems.push('MFA_ENCRYPTION_KEYS: must not reuse key material from CURSOR_KEYS');
    }
  }
  if (e.STUDENT_DIRECTORY_LIST_ENABLED && !cursor) {
    problems.push(
      'STUDENT_DIRECTORY_LIST_ENABLED: requires valid CURSOR_KEYS and CURSOR_ACTIVE_KEY_ID',
    );
  }
  if (e.NODE_ENV === 'production') {
    if (allowedOrigins.length === 0) {
      problems.push('APP_ORIGINS: required in production (CSRF origin allow-list)');
    } else if (allowedOrigins.some((o) => !o.startsWith('https://'))) {
      problems.push('APP_ORIGINS: must be https:// origins in production');
    }
    if (e.DATABASE_SSL !== 'require') {
      problems.push('DATABASE_SSL: must be "require" in production');
    }
    if (
      !mfa &&
      e.MFA_ENCRYPTION_KEYS === undefined &&
      e.MFA_ENCRYPTION_ACTIVE_KEY_ID === undefined
    ) {
      problems.push(
        'MFA_ENCRYPTION_KEYS: required in production (MFA is mandatory for administrative roles)',
      );
    }
    if (e.HOST === '0.0.0.0' && !e.TRUST_PROXY) {
      problems.push('HOST: binding 0.0.0.0 in production requires TRUST_PROXY=true (behind proxy)');
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    allowedOrigins,
    database: {
      url: new Secret(e.DATABASE_URL),
      ssl: e.DATABASE_SSL === 'require',
      poolMax: e.DATABASE_POOL_MAX,
    },
    ...(cursor ? { cursor } : {}),
    studentDirectoryListEnabled: e.STUDENT_DIRECTORY_LIST_ENABLED,
    ...(mfa ? { mfa } : {}),
  };
}
