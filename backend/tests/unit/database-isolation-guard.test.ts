import { describe, expect, it } from 'vitest';
import {
  assertDisposableTestDatabase,
  extractDatabaseName,
  FORBIDDEN_PERSISTENT_DB_NAMES,
  isDisposableDatabase,
  isPersistentDatabase,
  PersistentDatabaseMutationBlockedError,
  validatePersistentWriteAuthorized,
} from '../../src/shared/database/test-guard.js';

describe('Database Isolation & Persistent Database Protection Guard (P0)', () => {
  describe('extractDatabaseName', () => {
    it('extracts database name from postgresql connection URL', () => {
      const url =
        'postgresql://campusos_admin:secret@127.0.0.1:54329/campusos_demo?sslmode=disable';
      expect(extractDatabaseName(url)).toBe('campusos_demo');
    });

    it('extracts database name from postgres connection URL', () => {
      const url = 'postgres://app_runtime:pass@localhost:5432/campusos_dev';
      expect(extractDatabaseName(url)).toBe('campusos_dev');
    });

    it('extracts database name from plain string', () => {
      expect(extractDatabaseName('campusos_demo')).toBe('campusos_demo');
      expect(extractDatabaseName(' CAMPUSOS_DEV ')).toBe('campusos_dev');
    });

    it('returns empty string for invalid or empty input', () => {
      expect(extractDatabaseName('')).toBe('');
      expect(extractDatabaseName('not-a-url')).toBe('not-a-url');
    });
  });

  describe('isPersistentDatabase & FORBIDDEN_PERSISTENT_DB_NAMES', () => {
    it('identifies campusos_demo and campusos_dev as persistent databases', () => {
      expect(isPersistentDatabase('campusos_demo')).toBe(true);
      expect(isPersistentDatabase('campusos_dev')).toBe(true);
      expect(
        isPersistentDatabase('postgresql://campusos_admin:pass@127.0.0.1:54329/campusos_demo'),
      ).toBe(true);
    });

    it('identifies production, staging, and system databases as persistent', () => {
      expect(isPersistentDatabase('campusos_prod')).toBe(true);
      expect(isPersistentDatabase('production')).toBe(true);
      expect(isPersistentDatabase('prod')).toBe(true);
      expect(isPersistentDatabase('staging')).toBe(true);
      expect(isPersistentDatabase('postgres')).toBe(true);
    });

    it('recognizes disposable database patterns as non-persistent', () => {
      expect(isPersistentDatabase('campusos_test_0123456789ab')).toBe(false);
      expect(isPersistentDatabase('campusos_mig_0123456789')).toBe(false);
      expect(isDisposableDatabase('campusos_test_0123456789ab')).toBe(true);
      expect(isDisposableDatabase('campusos_demo')).toBe(false);
    });
  });

  describe('assertDisposableTestDatabase', () => {
    it('refuses campusos_demo with PersistentDatabaseMutationBlockedError', () => {
      expect(() =>
        assertDisposableTestDatabase(
          'postgresql://campusos_admin:pass@127.0.0.1:54329/campusos_demo',
          'IntegrationTest',
        ),
      ).toThrow(PersistentDatabaseMutationBlockedError);

      expect(() => assertDisposableTestDatabase('campusos_demo', 'IntegrationTest')).toThrow(
        /Refusing to execute against protected persistent database 'campusos_demo'/,
      );
    });

    it('refuses campusos_dev with PersistentDatabaseMutationBlockedError', () => {
      expect(() =>
        assertDisposableTestDatabase('postgresql://app_runtime:pass@127.0.0.1:54329/campusos_dev'),
      ).toThrow(/Refusing to execute against protected persistent database 'campusos_dev'/);
    });

    it('refuses production or staging target databases', () => {
      for (const name of FORBIDDEN_PERSISTENT_DB_NAMES) {
        expect(() => assertDisposableTestDatabase(name)).toThrow(
          PersistentDatabaseMutationBlockedError,
        );
      }
    });

    it('refuses databases that do not match the disposable test pattern', () => {
      expect(() => assertDisposableTestDatabase('my_local_school')).toThrow(
        /is not a recognized disposable test database pattern/,
      );
      expect(() => assertDisposableTestDatabase('school_test')).toThrow(
        /is not a recognized disposable test database pattern/,
      );
    });

    it('accepts valid disposable test databases created by Vitest global setup', () => {
      expect(() => assertDisposableTestDatabase('campusos_test_0123456789ab')).not.toThrow();
      expect(() =>
        assertDisposableTestDatabase(
          'postgresql://app_migrator:pass@127.0.0.1:5432/campusos_test_fedcba987654',
        ),
      ).not.toThrow();
      expect(() => assertDisposableTestDatabase('campusos_mig_0123456789')).not.toThrow();
    });
  });

  describe('validatePersistentWriteAuthorized', () => {
    it('strictly forbids persistent database mutations in automated test runners (VITEST)', () => {
      // In this test runner, process.env.VITEST is true
      expect(() =>
        validatePersistentWriteAuthorized('campusos_demo', 'Intentional test mutation'),
      ).toThrow(/Automated tests are NEVER authorized to write to persistent databases/);
    });
  });
});
