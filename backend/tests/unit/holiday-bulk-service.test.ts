import { describe, expect, it } from 'vitest';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import {
  BulkCreateHolidaysBodySchema,
  CreateHolidayBodySchema,
  HolidayService,
} from '../../src/modules/academics/holiday.service.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';

const orgContext = issueTrustedContext({
  tenantId: '01939a00-0000-7000-8000-000000000a01',
  userId: '01939a00-0000-7000-8000-00000000aa01',
  actorKind: 'STAFF',
});

const campusId = '01939a00-0000-7000-8000-000000000c01';

interface ScriptOptions {
  grants?: { scope_mode: string; scope_type: string; scope_id: string | null }[];
  lockedTerms?: { code: string; start_date: string; end_date: string }[];
  existingHolidays?: { holiday_date: string; lower_name: string }[];
}

function createScriptedTx(options: ScriptOptions = {}): {
  tx: TenantTx;
  insertedHolidays: unknown[][];
  auditLogs: unknown[];
} {
  const insertedHolidays: unknown[][] = [];
  const auditLogs: unknown[] = [];
  const grants = options.grants ?? [
    { scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null },
  ];
  const lockedTerms = options.lockedTerms ?? [];
  const existingHolidays = options.existingHolidays ?? [];

  const tx = {
    query: (queryText: string, params?: unknown[]) => {
      const q = queryText.replace(/\s+/g, ' ').trim();

      // Authorization check query
      if (q.includes('FROM app.role_assignments ra') && q.includes('app.role_permissions rp')) {
        return Promise.resolve({ rows: grants, rowCount: grants.length });
      }

      // Locked terms query
      if (q.includes('FROM app.terms') && q.includes("status = 'LOCKED'")) {
        return Promise.resolve({ rows: lockedTerms, rowCount: lockedTerms.length });
      }

      // Existing active holidays query
      if (q.includes('FROM app.holidays') && q.includes("status = 'ACTIVE'")) {
        return Promise.resolve({ rows: existingHolidays, rowCount: existingHolidays.length });
      }

      // Holiday insert query
      if (q.includes('INSERT INTO app.holidays')) {
        if (params) insertedHolidays.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Audit log insert query
      if (q.includes('INSERT INTO app.audit_log') || q.includes('INSERT INTO app.audit_events')) {
        if (params) auditLogs.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as TenantTx;

  return { tx, insertedHolidays, auditLogs };
}

describe('Holiday Bulk Approval: Schema and Service Contracts', () => {
  const bulkCompiler = TypeCompiler.Compile(BulkCreateHolidaysBodySchema);
  const singleCompiler = TypeCompiler.Compile(CreateHolidayBodySchema);

  it('accepts bulk payloads with campusId as null, undefined, or valid UUIDv7', () => {
    const validWithNull = {
      campusId: null,
      reason: 'Annual Indian school holiday calendar approval',
      holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }],
    };
    const validWithUndefined = {
      reason: 'Annual Indian school holiday calendar approval',
      holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }],
    };
    const validWithCampus = {
      campusId,
      reason: 'Annual Indian school holiday calendar approval',
      holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }],
    };

    expect(bulkCompiler.Check(validWithNull)).toBe(true);
    expect(bulkCompiler.Check(validWithUndefined)).toBe(true);
    expect(bulkCompiler.Check(validWithCampus)).toBe(true);
  });

  it('accepts single holiday payload with campusId as null, undefined, or valid UUIDv7', () => {
    expect(
      singleCompiler.Check({
        campusId: null,
        holidayDate: '2026-08-15',
        name: 'Independence Day',
        kind: 'HOLIDAY',
        reason: 'National holiday observance',
      }),
    ).toBe(true);

    expect(
      singleCompiler.Check({
        holidayDate: '2026-08-15',
        name: 'Independence Day',
        kind: 'HOLIDAY',
        reason: 'National holiday observance',
      }),
    ).toBe(true);
  });

  it('rejects invalid dates, unsupported kinds, or invalid campusId in schema', () => {
    // Invalid date format
    expect(
      bulkCompiler.Check({
        reason: 'Annual approval',
        holidays: [{ holidayDate: '15-08-2026', name: 'Independence Day', kind: 'HOLIDAY' }],
      }),
    ).toBe(false);

    // Unsupported kind
    expect(
      bulkCompiler.Check({
        reason: 'Annual approval',
        holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'INVALID_KIND' }],
      }),
    ).toBe(false);

    // Invalid UUID for campusId
    expect(
      bulkCompiler.Check({
        campusId: 'not-a-uuid',
        reason: 'Annual approval',
        holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }],
      }),
    ).toBe(false);

    // Reason too short (< 5 chars)
    expect(
      bulkCompiler.Check({
        reason: 'abc',
        holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }],
      }),
    ).toBe(false);

    // Empty holidays array
    expect(
      bulkCompiler.Check({
        reason: 'Annual approval',
        holidays: [],
      }),
    ).toBe(false);
  });

  it('bulk creates holidays with campusId: null and writes audit log', async () => {
    const { tx, insertedHolidays, auditLogs } = createScriptedTx();

    const result = await HolidayService.bulkCreate(tx, orgContext, {
      campusId: null,
      reason: 'Annual Indian school holiday calendar approval',
      holidays: [
        { holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' },
        { holidayDate: '2026-10-02', name: 'Mahatma Gandhi Jayanti', kind: 'HOLIDAY' },
      ],
    });

    expect(result.createdCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.createdIds).toHaveLength(2);
    expect(insertedHolidays).toHaveLength(2);

    // Both inserted rows have campus_id = null (org-wide)
    expect(insertedHolidays[0]?.[2]).toBeNull();
    expect(insertedHolidays[1]?.[2]).toBeNull();

    // Audit log was recorded
    expect(auditLogs).toHaveLength(1);
  });

  it('detects existing duplicates and skips them idempotently', async () => {
    const { tx, insertedHolidays } = createScriptedTx({
      existingHolidays: [{ holiday_date: '2026-08-15', lower_name: 'independence day' }],
    });

    const result = await HolidayService.bulkCreate(tx, orgContext, {
      campusId: null,
      reason: 'Annual Indian school holiday calendar approval',
      holidays: [
        { holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' },
        { holidayDate: '2026-10-02', name: 'Mahatma Gandhi Jayanti', kind: 'HOLIDAY' },
      ],
    });

    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped[0]).toEqual({
      holidayDate: '2026-08-15',
      name: 'Independence Day',
      reason: 'Already declared',
    });
    expect(insertedHolidays).toHaveLength(1);
    expect(insertedHolidays[0]?.[4]).toBe('Mahatma Gandhi Jayanti');
  });

  it('skips holidays falling inside a LOCKED term', async () => {
    const { tx, insertedHolidays } = createScriptedTx({
      lockedTerms: [{ code: 'TERM-LOCK', start_date: '2026-08-01', end_date: '2026-08-31' }],
    });

    const result = await HolidayService.bulkCreate(tx, orgContext, {
      campusId: null,
      reason: 'Annual Indian school holiday calendar approval',
      holidays: [
        { holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' },
        { holidayDate: '2026-10-02', name: 'Mahatma Gandhi Jayanti', kind: 'HOLIDAY' },
      ],
    });

    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped[0]?.reason).toContain('Date lies in locked term TERM-LOCK');
    expect(insertedHolidays).toHaveLength(1);
    expect(insertedHolidays[0]?.[4]).toBe('Mahatma Gandhi Jayanti');
  });

  it('refuses organization-wide bulk creation if actor only has campus-scoped permission', async () => {
    const { tx } = createScriptedTx({
      grants: [{ scope_mode: 'GRANTED', scope_type: 'CAMPUS', scope_id: campusId }],
    });

    await expect(
      HolidayService.bulkCreate(tx, orgContext, {
        campusId: null, // Attempting org-wide without org permission
        reason: 'Annual Indian school holiday calendar approval',
        holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }],
      }),
    ).rejects.toThrow('Access denied.');
  });
});
