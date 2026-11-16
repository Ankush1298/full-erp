/**
 * Test isolation and persistent database protection guards.
 *
 * PREVENTS ACCIDENTAL WRITES, MUTATIONS, OR PROVISIONING AGAINST PERSISTENT DATABASES
 * (campusos_demo, campusos_dev, campusos_prod, staging, or production clusters).
 */

export const FORBIDDEN_PERSISTENT_DB_NAMES = Object.freeze([
  'campusos_demo',
  'campusos_dev',
  'campusos_prod',
  'production',
  'prod',
  'staging',
  'postgres',
  'template0',
  'template1',
]);

export const DISPOSABLE_TEST_DB_PATTERN = /^campusos_(?:test_[0-9a-f]{12}|mig_[0-9a-f]{10}|dr_[0-9a-f]{10})$/;

export class PersistentDatabaseMutationBlockedError extends Error {
  constructor(message: string) {
    super(`[PERSISTENT_DB_MUTATION_BLOCKED] ${message}`);
    this.name = 'PersistentDatabaseMutationBlockedError';
  }
}

export function extractDatabaseName(urlOrName: string): string {
  if (!urlOrName) return '';
  const trimmed = urlOrName.trim();
  if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) {
    try {
      const parsed = new URL(trimmed);
      return decodeURIComponent(parsed.pathname.slice(1)).toLowerCase();
    } catch {
      return '';
    }
  }
  return trimmed.toLowerCase();
}

export function isPersistentDatabase(urlOrName: string): boolean {
  const dbName = extractDatabaseName(urlOrName);
  if (!dbName) return false;
  return FORBIDDEN_PERSISTENT_DB_NAMES.includes(dbName);
}

export function isDisposableDatabase(urlOrName: string): boolean {
  const dbName = extractDatabaseName(urlOrName);
  return DISPOSABLE_TEST_DB_PATTERN.test(dbName);
}

export function assertDisposableTestDatabase(
  urlOrName: string,
  context: string = 'Automated Test',
): void {
  const dbName = extractDatabaseName(urlOrName);

  if (!dbName) {
    throw new PersistentDatabaseMutationBlockedError(
      `${context}: Target database connection string is empty or invalid. Tests require an explicitly validated disposable database.`,
    );
  }

  // 1. Strict refusal for protected persistent databases
  if (FORBIDDEN_PERSISTENT_DB_NAMES.includes(dbName)) {
    throw new PersistentDatabaseMutationBlockedError(
      `${context}: Refusing to execute against protected persistent database '${dbName}'. Automated tests and test setups MUST NOT target persistent databases (campusos_demo, campusos_dev, etc.). Use disposable test databases provided by Vitest global setup (inject('dbAdminUrl')).`,
    );
  }

  // 2. Strict pattern matching: must be an ephemeral test DB (e.g. campusos_test_<12hex> or campusos_mig_<10hex>)
  if (!DISPOSABLE_TEST_DB_PATTERN.test(dbName)) {
    if (!dbName.startsWith('campusos_test_') && !dbName.startsWith('campusos_mig_')) {
      throw new PersistentDatabaseMutationBlockedError(
        `${context}: Database '${dbName}' is not a recognized disposable test database pattern (${DISPOSABLE_TEST_DB_PATTERN}). All automated tests requiring database writes must run in isolated, disposable databases.`,
      );
    }
  }
}

export function validatePersistentWriteAuthorized(
  urlOrName: string,
  justification: string,
): void {
  // Fail closed if running under a test runner
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    throw new PersistentDatabaseMutationBlockedError(
      `Automated tests are NEVER authorized to write to persistent databases, regardless of override flags. Attempted on: ${extractDatabaseName(urlOrName)}`,
    );
  }

  if (
    process.env['ALLOW_PERSISTENT_DATABASE_MUTATION'] !== 'true' ||
    process.env['OPERATOR_CONFIRMED_MUTATION'] !== 'true'
  ) {
    throw new PersistentDatabaseMutationBlockedError(
      `Persistent database mutation requires explicit operator authorization via ALLOW_PERSISTENT_DATABASE_MUTATION=true and OPERATOR_CONFIRMED_MUTATION=true. Justification: "${justification}". Target: ${extractDatabaseName(urlOrName)}`,
    );
  }
}
