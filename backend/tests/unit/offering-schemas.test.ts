import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  CreateAssignmentBodySchema,
  CreateOfferingBodySchema,
  CreateSlotBodySchema,
  EndAssignmentBodySchema,
  UpdateOfferingBodySchema,
} from '../../src/modules/academics/offering.schemas.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

// Request contracts of Milestone 3 Batch 2 (doc 31), checked without a database: closed bodies, no client-supplied scope,
// forward-only status targets, the teaching-role vocabulary and the HH:MM time format.

const offering = {
  termId: uuidv7(),
  courseId: uuidv7(),
  offeringKind: 'CORE',
  registrationPolicy: 'MANUAL',
};

describe('course offering bodies', () => {
  it('accept the documented shape', () => {
    expect(Value.Check(CreateOfferingBodySchema, offering)).toBe(true);
    expect(
      Value.Check(CreateOfferingBodySchema, {
        ...offering,
        sectionId: uuidv7(),
        groupLabel: 'G1',
        capacity: 30,
      }),
    ).toBe(true);
  });

  it.each(['organizationId', 'tenantId', 'campusId', 'departmentId', 'codeSnapshot', 'status'])(
    'refuse a client-supplied %s',
    (field) => {
      expect(Value.Check(CreateOfferingBodySchema, { ...offering, [field]: uuidv7() })).toBe(false);
    },
  );

  it('refuse unknown kinds and policies', () => {
    expect(Value.Check(CreateOfferingBodySchema, { ...offering, offeringKind: 'HOMEROOM' })).toBe(
      false,
    );
    expect(Value.Check(CreateOfferingBodySchema, { ...offering, registrationPolicy: 'ANY' })).toBe(
      false,
    );
  });

  it('a PATCH can only move forward and never touches identity', () => {
    expect(Value.Check(UpdateOfferingBodySchema, { status: 'PUBLISHED' })).toBe(true);
    expect(Value.Check(UpdateOfferingBodySchema, { status: 'DRAFT' })).toBe(false);
    expect(Value.Check(UpdateOfferingBodySchema, { termId: uuidv7() })).toBe(false);
    expect(Value.Check(UpdateOfferingBodySchema, { capacity: null })).toBe(true);
  });
});

describe('faculty assignment bodies', () => {
  const body = {
    employeeId: uuidv7(),
    teachingRole: 'PRIMARY',
    validFrom: '2026-07-01',
    reason: 'Load approved',
  };
  it('require a reason and a teaching role from the closed list', () => {
    expect(Value.Check(CreateAssignmentBodySchema, body)).toBe(true);
    expect(Value.Check(CreateAssignmentBodySchema, { ...body, reason: 'no' })).toBe(false);
    expect(Value.Check(CreateAssignmentBodySchema, { ...body, teachingRole: 'HOD' })).toBe(false);
    // the authorization vocabulary ("role") is not accepted as a field name
    expect(Value.Check(CreateAssignmentBodySchema, { ...body, role: 'PRIMARY' })).toBe(false);
  });
  it('ending changes only the end date, with a reason', () => {
    expect(
      Value.Check(EndAssignmentBodySchema, { validTo: '2026-09-30', reason: 'Moved on' }),
    ).toBe(true);
    expect(Value.Check(EndAssignmentBodySchema, { validTo: '2026-09-30' })).toBe(false);
    expect(
      Value.Check(EndAssignmentBodySchema, {
        validTo: '2026-09-30',
        reason: 'x'.repeat(5),
        employeeId: uuidv7(),
      }),
    ).toBe(false);
  });
});

describe('timetable slot bodies', () => {
  const slot = { weekday: 1, startTime: '09:00', endTime: '10:00', effectiveFrom: '2026-07-01' };
  it('ISO weekday 1-7 and 24-hour HH:MM times', () => {
    expect(Value.Check(CreateSlotBodySchema, slot)).toBe(true);
    for (const bad of [
      { weekday: 0 },
      { weekday: 8 },
      { startTime: '24:00' },
      { startTime: '9:00' },
      { endTime: '10:60' },
    ]) {
      expect(Value.Check(CreateSlotBodySchema, { ...slot, ...bad }), JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});
