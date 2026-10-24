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
  // Dedicated HMAC keyring for import matching-data bindings (docs/architecture/v3/26 §3.5.4): the key that makes the stored
  // binding of a committed import's date-of-birth/guardian-phone data unguessable from the database alone. Same format as
  // the other rings, separate material (never shared with CURSOR_KEYS or MFA_ENCRYPTION_KEYS). Both or neither; REQUIRED
  // in production. Absent elsewhere = a commit that carries matching data is refused (503), never committed unbound.
  IMPORT_MATCHING_KEYS: z.string().optional(),
  IMPORT_MATCHING_ACTIVE_KEY_ID: z.string().optional(),
  // Object storage for the documents kernel (ADR-010). All-or-nothing, like the keyrings; REQUIRED in production, where
  // its absence fails closed (no documents feature rather than an insecure fallback). Credentials are wrapped in Secret.
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: booleanString,
  STORAGE_BUCKET_GENERAL: z.string().optional(),
  STORAGE_BUCKET_SENSITIVE: z.string().optional(),
  STORAGE_BUCKET_GENERATED: z.string().optional(),
  // ClamAV daemon configuration for malware scanning (Milestone 1 / Phase 1E).
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
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
export type ImportMatchingConfig = KeyRingConfig;

/** Object-storage configuration (one private bucket per storage class). Present only when fully configured. */
export interface StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: Secret;
  readonly secretAccessKey: Secret;
  readonly forcePathStyle: boolean;
  readonly buckets: Readonly<Record<'GENERAL' | 'SENSITIVE' | 'GENERATED', string>>;
}

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * STORAGE_* is all-or-nothing: absent means the documents feature is unavailable (fail closed). Any one set requires
 * every one set, with a valid https endpoint, a region, credentials and three DISTINCT private bucket names. Errors
 * name the variable and the rule, never a value (credentials are secret).
 */
function parseStorage(
  e: {
    STORAGE_ENDPOINT?: string | undefined;
    STORAGE_REGION?: string | undefined;
    STORAGE_ACCESS_KEY_ID?: string | undefined;
    STORAGE_SECRET_ACCESS_KEY?: string | undefined;
    STORAGE_FORCE_PATH_STYLE: boolean;
    STORAGE_BUCKET_GENERAL?: string | undefined;
    STORAGE_BUCKET_SENSITIVE?: string | undefined;
    STORAGE_BUCKET_GENERATED?: string | undefined;
  },
  problems: string[],
): StorageConfig | undefined {
  const fields = {
    STORAGE_ENDPOINT: e.STORAGE_ENDPOINT,
    STORAGE_REGION: e.STORAGE_REGION,
    STORAGE_ACCESS_KEY_ID: e.STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY: e.STORAGE_SECRET_ACCESS_KEY,
    STORAGE_BUCKET_GENERAL: e.STORAGE_BUCKET_GENERAL,
    STORAGE_BUCKET_SENSITIVE: e.STORAGE_BUCKET_SENSITIVE,
    STORAGE_BUCKET_GENERATED: e.STORAGE_BUCKET_GENERATED,
  };
  if (Object.values(fields).every((v) => v === undefined)) return undefined;

  const before = problems.length;
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === '')
      problems.push(`${name}: required when any STORAGE_* is set`);
  }
  if (fields.STORAGE_ENDPOINT !== undefined && fields.STORAGE_ENDPOINT !== '') {
    try {
      const u = new URL(fields.STORAGE_ENDPOINT);
      if (u.protocol !== 'https:') problems.push('STORAGE_ENDPOINT: must be an https:// URL');
    } catch {
      problems.push('STORAGE_ENDPOINT: must be a valid https:// URL');
    }
  }
  const buckets = {
    GENERAL: fields.STORAGE_BUCKET_GENERAL,
    SENSITIVE: fields.STORAGE_BUCKET_SENSITIVE,
    GENERATED: fields.STORAGE_BUCKET_GENERATED,
  };
  for (const [cls, name] of Object.entries(buckets)) {
    if (name !== undefined && name !== '' && !BUCKET_NAME_RE.test(name)) {
      problems.push(`STORAGE_BUCKET_${cls}: must be a valid bucket name (3-63 chars, lowercase)`);
    }
  }
  const names = Object.values(buckets).filter((v): v is string => !!v);
  if (names.length === 3 && new Set(names).size !== 3) {
    problems.push(
      'STORAGE_BUCKET_*: the three bucket names must be distinct (separate buckets per class)',
    );
  }
  if (problems.length !== before) return undefined;
  return {
    endpoint: fields.STORAGE_ENDPOINT as string,
    region: fields.STORAGE_REGION as string,
    accessKeyId: new Secret(fields.STORAGE_ACCESS_KEY_ID as string),
    secretAccessKey: new Secret(fields.STORAGE_SECRET_ACCESS_KEY as string),
    forcePathStyle: e.STORAGE_FORCE_PATH_STYLE,
    buckets: {
      GENERAL: buckets.GENERAL as string,
      SENSITIVE: buckets.SENSITIVE as string,
      GENERATED: buckets.GENERATED as string,
    },
  };
}

/** ClamAV daemon configuration for the background malware scan worker. */
export interface ClamAvConfig {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

function parseClamAv(
  e: {
    CLAMAV_HOST?: string | undefined;
    CLAMAV_PORT: number;
    CLAMAV_TIMEOUT_MS: number;
  },
  problems: string[],
): ClamAvConfig | undefined {
  if (e.CLAMAV_HOST === undefined) return undefined;
  const host = e.CLAMAV_HOST.trim();
  if (host.length === 0) {
    problems.push('CLAMAV_HOST: must not be empty');
    return undefined;
  }
  return {
    host,
    port: e.CLAMAV_PORT,
    timeoutMs: e.CLAMAV_TIMEOUT_MS,
  };
}

/**
 * `<KEYS>` is `<keyId>:<key>` entries separated by commas (no whitespace is trimmed); `<ACTIVE>` names the key used for
 * new data, every other key only reads. Both variables or neither: absent means the ring is absent and nothing else
 * changes. Errors name the variable and the rule, never a value. Used for CURSOR_KEYS, MFA_ENCRYPTION_KEYS and
 * IMPORT_MATCHING_KEYS.
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
  /** IMPORT_MATCHING_KEYS + IMPORT_MATCHING_ACTIVE_KEY_ID. Always present in production; absent elsewhere = an import commit
   * carrying matching data is refused (fail closed). */
  readonly importMatching?: ImportMatchingConfig;
  /** Object storage (STORAGE_*). Always present in production; absent elsewhere = the documents feature is unavailable. */
  readonly storage?: StorageConfig;
  /** ClamAV daemon configuration. Always present in production; absent elsewhere = scanner fails closed. */
  readonly clamav?: ClamAvConfig;
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
  const importMatching = parseKeyRing(
    e.IMPORT_MATCHING_KEYS,
    e.IMPORT_MATCHING_ACTIVE_KEY_ID,
    { keys: 'IMPORT_MATCHING_KEYS', active: 'IMPORT_MATCHING_ACTIVE_KEY_ID' },
    problems,
  );
  if (importMatching) {
    for (const [name, ring] of [
      ['CURSOR_KEYS', cursor],
      ['MFA_ENCRYPTION_KEYS', mfa],
    ] as const) {
      const other = new Set([...(ring?.keys.values() ?? [])].map((k) => k.reveal()));
      if ([...importMatching.keys.values()].some((k) => other.has(k.reveal()))) {
        problems.push(`IMPORT_MATCHING_KEYS: must not reuse key material from ${name}`);
      }
    }
  }
  const storage = parseStorage(e, problems);
  const clamav = parseClamAv(e, problems);
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
    if (
      !importMatching &&
      e.IMPORT_MATCHING_KEYS === undefined &&
      e.IMPORT_MATCHING_ACTIVE_KEY_ID === undefined
    ) {
      problems.push(
        'IMPORT_MATCHING_KEYS: required in production (import commits with matching data are bound by it)',
      );
    }
    if (e.HOST === '0.0.0.0' && !e.TRUST_PROXY) {
      problems.push('HOST: binding 0.0.0.0 in production requires TRUST_PROXY=true (behind proxy)');
    }
    if (!storage && e.STORAGE_ENDPOINT === undefined && e.STORAGE_BUCKET_SENSITIVE === undefined) {
      problems.push(
        'STORAGE_ENDPOINT: required in production (the documents kernel has no insecure fallback)',
      );
    }
    if (!clamav && e.CLAMAV_HOST === undefined) {
      problems.push(
        'CLAMAV_HOST: required in production (malware scanning is mandatory for document uploads)',
      );
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
    ...(importMatching ? { importMatching } : {}),
    ...(storage ? { storage } : {}),
    ...(clamav ? { clamav } : {}),
  };
}
