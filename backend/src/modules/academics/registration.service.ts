import { resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { parseDate, parseReason } from '../people/validation.js';
import { cohortPeriodScope } from './calendar.service.js';
import { offeringScope } from './offering.service.js';
import {
  assertScoped,
  checkVersion,
  conflict,
  ensureTrusted,
  invalid,
  iso,
  mapDbError,
  text,
} from './common.js';
import {
  REGISTRATION_KINDS,
  WRITABLE_SOURCES,
  type CreateElectiveGroupBody,
  type CreateRegistrationBody,
  type ElectiveGroupDto,
  type FromSectionBody,
  type RegistrationDto,
  type UpdateElectiveGroupBody,
  type UpdateRegistrationBody,
} from './registration.schemas.js';

/**
 * Elective groups and course registrations (migration 0039, doc 33). Scope is always read from the database: an elective
 * group's from its cohort period's programme, a registration's from BOTH its offering (campus/department of the offering)
 * and its term enrolment (the frozen campus/department of the student's programme enrolment). Held but out of scope,
 * missing or another tenant's ⇒ the same 404; not held ⇒ 403. Writes are staff-only (RLS and `assertStaffActor`).
 *
 * Every product rule is in the database guards (window, min/max, capacity, audience, same term, one live registration
 * per student and offering, transitions), so it binds every writer; their plain-English refusals are returned as 409.
 * Lock order (the guard's): term enrolment -> offering -> elective group. The from-section action inserts in ascending
 * term-enrolment order, so two runs, or a run and a single registration, cannot deadlock.
 */

const READ = 'academic.program.read';
const OFFERING_MANAGE = 'academic.offering.manage';
const ENROLL_READ = 'enrollment.term.read';
const ENROLL_MANAGE = 'enrollment.term.manage';
const lower = (s: string): string => s.toLowerCase();
const uuidOrThrow = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !isUuidV7(v)) throw invalid(`Invalid ${what} ID.`);
  return lower(v);
};
const instant = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid(`${field} is invalid.`);
  return new Date(v).toISOString();
};
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// =============================================================================================
// Elective groups
// =============================================================================================
interface GroupRow {
  id: string;
  cohort_period_id: string;
  code: string;
  name: string;
  min_select: number;
  max_select: number;
  opens_at: Date | null;
  closes_at: Date | null;
  status: ElectiveGroupDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
const GROUP_COLS = `id, cohort_period_id, code, name, min_select, max_select, opens_at, closes_at, status, version,
  created_at, updated_at`;
const toGroup = (r: GroupRow): ElectiveGroupDto => ({
  id: r.id,
  cohortPeriodId: r.cohort_period_id,
  code: r.code,
  name: r.name,
  minSelect: r.min_select,
  maxSelect: r.max_select,
  opensAt: r.opens_at ? iso(r.opens_at) : null,
  closesAt: r.closes_at ? iso(r.closes_at) : null,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

async function periodScope(tx: TenantTx, ctx: TrustedContext, cohortPeriodId: string) {
  const s = await cohortPeriodScope(tx, ctx, cohortPeriodId);
  return { campus_id: s.campusId, department_id: s.departmentId };
}

export class ElectiveGroupService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    cohortPeriodId: string,
    input: CreateElectiveGroupBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    const cp = uuidOrThrow(cohortPeriodId, 'cohort period');
    if (!input || typeof input !== 'object') throw invalid('Elective group payload is required.');
    const code = text(input.code, 'code', 1, 30, CODE_RE);
    const name = text(input.name, 'name', 1, 255);
    const { minSelect, maxSelect } = input;
    if (!Number.isInteger(minSelect) || !Number.isInteger(maxSelect) || minSelect > maxSelect) {
      throw invalid('minSelect must not exceed maxSelect.');
    }
    const opensAt = input.opensAt === undefined ? null : instant(input.opensAt, 'opensAt');
    const closesAt = input.closesAt === undefined ? null : instant(input.closesAt, 'closesAt');
    if (opensAt && closesAt && closesAt <= opensAt)
      throw invalid('closesAt must be after opensAt.');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, OFFERING_MANAGE);
    const scope = await periodScope(tx, ctx, cp);
    await assertScoped(tx, ctx, OFFERING_MANAGE, scope);

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.elective_groups
           (id, organization_id, cohort_period_id, code, name, min_select, max_select, opens_at, closes_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.tenantId, cp, code, name, minSelect, maxSelect, opensAt, closesAt],
      );
    } catch (err) {
      mapDbError(err, 'An elective group with this code already exists in the cohort period.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.elective_group.create',
        resourceType: 'elective_group',
        resourceId: id,
        campusId: scope.campus_id,
        departmentId: scope.department_id,
        riskTier: 1,
        reasonText: reason,
        changes: {
          cohortPeriodId: { old: null, new: cp },
          code: { old: null, new: code },
          minSelect: { old: null, new: minSelect },
          maxSelect: { old: null, new: maxSelect },
          opensAt: { old: null, new: opensAt },
          closesAt: { old: null, new: closesAt },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    cohortPeriodId: string,
  ): Promise<ElectiveGroupDto[]> {
    ensureTrusted(ctx);
    const cp = uuidOrThrow(cohortPeriodId, 'cohort period');
    await AuthorizationEngine.assert(tx, ctx, READ);
    await assertScoped(tx, ctx, READ, await periodScope(tx, ctx, cp));
    const r = await tx.query<GroupRow>(
      `SELECT ${GROUP_COLS} FROM app.elective_groups WHERE organization_id = $1 AND cohort_period_id = $2
        ORDER BY code, id`,
      [ctx.tenantId, cp],
    );
    return r.rows.map(toGroup);
  }

  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateElectiveGroupBody,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<ElectiveGroupDto> {
    ensureTrusted(ctx);
    const gid = uuidOrThrow(id, 'elective group');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, OFFERING_MANAGE);
    const probe = await tx.query<{ cohort_period_id: string }>(
      `SELECT cohort_period_id FROM app.elective_groups WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, gid],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    const scope = await periodScope(tx, ctx, probe.rows[0].cohort_period_id);
    await assertScoped(tx, ctx, OFFERING_MANAGE, scope);

    const r = await tx.query<GroupRow>(
      `SELECT ${GROUP_COLS} FROM app.elective_groups WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, gid],
    );
    const cur = r.rows[0];
    if (!cur) throw resourceNotFound();
    checkVersion(options.expected, cur.version, 'Elective group');

    const next = {
      name: input.name === undefined ? cur.name : text(input.name, 'name', 1, 255),
      min_select: input.minSelect ?? cur.min_select,
      max_select: input.maxSelect ?? cur.max_select,
      opens_at:
        input.opensAt === undefined
          ? cur.opens_at && iso(cur.opens_at)
          : input.opensAt && instant(input.opensAt, 'opensAt'),
      closes_at:
        input.closesAt === undefined
          ? cur.closes_at && iso(cur.closes_at)
          : input.closesAt && instant(input.closesAt, 'closesAt'),
      status: input.status ?? cur.status,
    };
    if (next.min_select > next.max_select) throw invalid('minSelect must not exceed maxSelect.');
    let updated: GroupRow | undefined;
    try {
      const u = await tx.query<GroupRow>(
        `UPDATE app.elective_groups
            SET name = $3, min_select = $4, max_select = $5, opens_at = $6, closes_at = $7, status = $8
          WHERE organization_id = $1 AND id = $2 RETURNING ${GROUP_COLS}`,
        [
          ctx.tenantId,
          gid,
          next.name,
          next.min_select,
          next.max_select,
          next.opens_at,
          next.closes_at,
          next.status,
        ],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'Elective group conflict.');
    }
    if (!updated) throw resourceNotFound();
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    const before = toGroup(cur);
    const after = toGroup(updated);
    for (const k of ['name', 'minSelect', 'maxSelect', 'opensAt', 'closesAt', 'status'] as const) {
      if (before[k] !== after[k]) changes[k] = { old: before[k], new: after[k] };
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.elective_group.update',
        resourceType: 'elective_group',
        resourceId: gid,
        campusId: scope.campus_id,
        departmentId: scope.department_id,
        riskTier: 1,
        reasonText: reason,
        changes,
      },
      options.meta,
    );
    return after;
  }
}

// =============================================================================================
// Course registrations
// =============================================================================================
interface RegRow {
  id: string;
  term_enrollment_id: string;
  student_id: string;
  course_offering_id: string;
  elective_group_id: string | null;
  status: RegistrationDto['status'];
  valid_from: string;
  valid_to: string | null;
  source: RegistrationDto['source'];
  registration_kind: RegistrationDto['registrationKind'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
const REG_COLS = `id, term_enrollment_id, student_id, course_offering_id, elective_group_id, status,
  valid_from::text AS valid_from, valid_to::text AS valid_to, source, registration_kind, version, created_at, updated_at`;
const toReg = (r: RegRow): RegistrationDto => ({
  id: r.id,
  termEnrollmentId: r.term_enrollment_id,
  studentId: r.student_id,
  courseOfferingId: r.course_offering_id,
  electiveGroupId: r.elective_group_id,
  status: r.status,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  source: r.source,
  registrationKind: r.registration_kind,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** The term enrolment's student and FROZEN programme scope (never a caller value). Missing ⇒ 404. */
async function enrollmentScope(tx: TenantTx, ctx: TrustedContext, enrollmentId: string) {
  const r = await tx.query<{
    student_id: string;
    user_id: string | null;
    campus_id: string;
    department_id: string;
  }>(
    `SELECT e.student_id, st.user_id, sp.campus_id, sp.department_id
       FROM app.term_enrollments e
       JOIN app.student_programs sp
         ON sp.organization_id = e.organization_id AND sp.student_id = e.student_id AND sp.id = e.student_program_id
       JOIN app.students st ON st.organization_id = e.organization_id AND st.id = e.student_id
      WHERE e.organization_id = $1 AND e.id = $2`,
    [ctx.tenantId, enrollmentId],
  );
  const row = r.rows[0];
  if (!row) throw resourceNotFound();
  return row;
}

async function insertRegistration(
  tx: TenantTx,
  ctx: TrustedContext,
  row: {
    termEnrollmentId: string;
    studentId: string;
    offeringId: string;
    validFrom: string;
    source: string;
    kind: string;
    pending: boolean;
  },
): Promise<string> {
  const id = uuidv7();
  try {
    await tx.query(
      `INSERT INTO app.course_registrations
         (id, organization_id, term_enrollment_id, student_id, course_offering_id, status, valid_from, source,
          registration_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        ctx.tenantId,
        row.termEnrollmentId,
        row.studentId,
        row.offeringId,
        row.pending ? 'PENDING_APPROVAL' : 'REGISTERED',
        row.validFrom,
        row.source,
        row.kind,
      ],
    );
  } catch (err) {
    mapDbError(err, 'The student already holds a live registration for this offering.');
  }
  return id;
}

export class CourseRegistrationService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    offeringId: string,
    input: CreateRegistrationBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const oid = uuidOrThrow(offeringId, 'offering');
    if (!input || typeof input !== 'object') throw invalid('Registration payload is required.');
    const eid = uuidOrThrow(input.termEnrollmentId, 'term enrolment');
    const validFrom = parseDate(input.validFrom, 'validFrom');
    if (!WRITABLE_SOURCES.includes(input.source)) throw invalid('Invalid source.');
    const kind = input.registrationKind ?? 'REGULAR';
    if (!(REGISTRATION_KINDS as readonly string[]).includes(kind))
      throw invalid('Invalid registrationKind.');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, ENROLL_MANAGE);
    const o = await offeringScope(tx, ctx, oid);
    await assertScoped(tx, ctx, ENROLL_MANAGE, {
      campus_id: o.campusId,
      department_id: o.departmentId,
    });
    const e = await enrollmentScope(tx, ctx, eid);
    await assertScoped(tx, ctx, ENROLL_MANAGE, {
      campus_id: e.campus_id,
      department_id: e.department_id,
    });

    const id = await insertRegistration(tx, ctx, {
      termEnrollmentId: eid,
      studentId: e.student_id,
      offeringId: oid,
      validFrom,
      source: input.source,
      kind,
      pending: input.pendingApproval === true,
    });
    await recordAudit(
      tx,
      ctx,
      {
        action: 'enrollment.course_registration.create',
        resourceType: 'course_registration',
        resourceId: id,
        subjectStudentId: e.student_id,
        campusId: e.campus_id,
        departmentId: e.department_id,
        riskTier: 1,
        reasonText: reason,
        changes: {
          courseOfferingId: { old: null, new: oid },
          termEnrollmentId: { old: null, new: eid },
          source: { old: null, new: input.source },
          registrationKind: { old: null, new: kind },
          validFrom: { old: null, new: validFrom },
        },
      },
      meta,
    );
    return id;
  }

  /**
   * doc 07 §3.2 AUTO_FROM_SECTION: registers every member of the offering's section whose membership is open on
   * `validFrom` and whose enrolment is REGISTERED/ACTIVE, unless already live on the offering. Explicit and re-runnable
   * (a student placed later is picked up by the next run) instead of a side effect of publishing, so the lock order
   * stays enrolment -> offering (doc 33 §3). All or nothing: one refusal (e.g. capacity) rolls the run back.
   */
  static async fromSection(
    tx: TenantTx,
    ctx: TrustedContext,
    offeringId: string,
    input: FromSectionBody,
    meta: AuditRequestMeta = {},
  ): Promise<{ created: number; alreadyRegistered: number }> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const oid = uuidOrThrow(offeringId, 'offering');
    if (!input || typeof input !== 'object') throw invalid('Payload is required.');
    const validFrom = parseDate(input.validFrom, 'validFrom');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, ENROLL_MANAGE);
    const o = await offeringScope(tx, ctx, oid);
    await assertScoped(tx, ctx, ENROLL_MANAGE, {
      campus_id: o.campusId,
      department_id: o.departmentId,
    });
    const off = await tx.query<{ section_id: string | null; registration_policy: string }>(
      `SELECT section_id, registration_policy FROM app.course_offerings WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, oid],
    );
    const sectionId = off.rows[0]?.section_id;
    if (off.rows[0]?.registration_policy !== 'AUTO_FROM_SECTION' || !sectionId) {
      throw conflict(
        'Only a section offering with registration policy AUTO_FROM_SECTION registers from its section.',
      );
    }
    const members = await tx.query<{
      term_enrollment_id: string;
      student_id: string;
      live: boolean;
    }>(
      `SELECT m.term_enrollment_id, m.student_id,
              EXISTS (SELECT 1 FROM app.course_registrations r
                       WHERE r.organization_id = m.organization_id AND r.student_id = m.student_id
                         AND r.course_offering_id = $3 AND r.valid_to IS NULL) AS live
         FROM app.section_memberships m
         JOIN app.term_enrollments e ON e.organization_id = m.organization_id AND e.id = m.term_enrollment_id
        WHERE m.organization_id = $1 AND m.section_id = $2 AND e.status IN ('REGISTERED', 'ACTIVE')
          AND m.valid_from <= $4::date AND (m.valid_to IS NULL OR m.valid_to >= $4::date)
        ORDER BY m.term_enrollment_id`,
      [ctx.tenantId, sectionId, oid, validFrom],
    );
    let created = 0;
    for (const m of members.rows) {
      if (m.live) continue;
      const id = await insertRegistration(tx, ctx, {
        termEnrollmentId: m.term_enrollment_id,
        studentId: m.student_id,
        offeringId: oid,
        validFrom,
        source: 'AUTO_SECTION',
        kind: 'REGULAR',
        pending: false,
      });
      created++;
      await recordAudit(
        tx,
        ctx,
        {
          action: 'enrollment.course_registration.create',
          resourceType: 'course_registration',
          resourceId: id,
          subjectStudentId: m.student_id,
          campusId: o.campusId,
          departmentId: o.departmentId,
          riskTier: 1,
          reasonText: reason,
          changes: {
            courseOfferingId: { old: null, new: oid },
            source: { old: null, new: 'AUTO_SECTION' },
            validFrom: { old: null, new: validFrom },
          },
        },
        meta,
      );
    }
    return { created, alreadyRegistered: members.rows.length - created };
  }

  /** The offering's registrations (history included): the roster source of Milestone 4. Staff only (RLS). */
  static async listForOffering(
    tx: TenantTx,
    ctx: TrustedContext,
    offeringId: string,
  ): Promise<RegistrationDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const oid = uuidOrThrow(offeringId, 'offering');
    await AuthorizationEngine.assert(tx, ctx, ENROLL_READ);
    const o = await offeringScope(tx, ctx, oid);
    await assertScoped(tx, ctx, ENROLL_READ, {
      campus_id: o.campusId,
      department_id: o.departmentId,
    });
    const r = await tx.query<RegRow>(
      `SELECT ${REG_COLS} FROM app.course_registrations WHERE organization_id = $1 AND course_offering_id = $2
        ORDER BY student_id, valid_from, id`,
      [ctx.tenantId, oid],
    );
    return r.rows.map(toReg);
  }

  /** One enrolment's registrations: staff in scope, or the student themself (SELF; RLS shows only their rows). */
  static async listForEnrollment(
    tx: TenantTx,
    ctx: TrustedContext,
    enrollmentId: string,
  ): Promise<RegistrationDto[]> {
    ensureTrusted(ctx);
    const eid = uuidOrThrow(enrollmentId, 'term enrolment');
    await AuthorizationEngine.assert(tx, ctx, ENROLL_READ);
    const e = await enrollmentScope(tx, ctx, eid);
    await assertScoped(tx, ctx, ENROLL_READ, {
      campus_id: e.campus_id,
      department_id: e.department_id,
      student_id: e.student_id,
      ...(e.user_id ? { user_id: e.user_id } : {}),
    });
    const r = await tx.query<RegRow>(
      `SELECT ${REG_COLS} FROM app.course_registrations WHERE organization_id = $1 AND term_enrollment_id = $2
        ORDER BY valid_from, id`,
      [ctx.tenantId, eid],
    );
    return r.rows.map(toReg);
  }

  /** Approve / reject a pending row, or close a live one on `validTo` (default: today is NOT assumed; required). */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateRegistrationBody,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<RegistrationDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const rid = uuidOrThrow(id, 'course registration');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const reason = parseReason(input.reason);
    const approve = input.status === 'REGISTERED';
    if (approve && input.validTo !== undefined)
      throw invalid('An approval does not close the registration.');
    if (!approve && input.validTo === undefined)
      throw invalid('validTo is required to close a registration.');
    const validTo = approve ? null : parseDate(input.validTo, 'validTo');
    await AuthorizationEngine.assert(tx, ctx, ENROLL_MANAGE);
    const probe = await tx.query<{ term_enrollment_id: string; course_offering_id: string }>(
      `SELECT term_enrollment_id, course_offering_id FROM app.course_registrations WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, rid],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    const e = await enrollmentScope(tx, ctx, probe.rows[0].term_enrollment_id);
    await assertScoped(tx, ctx, ENROLL_MANAGE, {
      campus_id: e.campus_id,
      department_id: e.department_id,
    });
    const o = await offeringScope(tx, ctx, probe.rows[0].course_offering_id);
    await assertScoped(tx, ctx, ENROLL_MANAGE, {
      campus_id: o.campusId,
      department_id: o.departmentId,
    });

    // Lock order enrolment -> registration (the guard re-locks the enrolment, already held).
    await tx.query(
      `SELECT 1 FROM app.term_enrollments WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, probe.rows[0].term_enrollment_id],
    );
    const r = await tx.query<RegRow>(
      `SELECT ${REG_COLS} FROM app.course_registrations WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, rid],
    );
    const cur = r.rows[0];
    if (!cur) throw resourceNotFound();
    checkVersion(options.expected, cur.version, 'Course registration');
    if (cur.valid_to !== null) throw conflict('The registration is already closed.');
    if (validTo !== null && validTo < cur.valid_from)
      throw invalid('validTo must not be before validFrom.');

    let updated: RegRow | undefined;
    try {
      const u = await tx.query<RegRow>(
        `UPDATE app.course_registrations SET status = $3, valid_to = $4 WHERE organization_id = $1 AND id = $2
         RETURNING ${REG_COLS}`,
        [ctx.tenantId, rid, input.status, validTo],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'Course registration conflict.');
    }
    if (!updated) throw resourceNotFound();
    await recordAudit(
      tx,
      ctx,
      {
        action: 'enrollment.course_registration.update',
        resourceType: 'course_registration',
        resourceId: rid,
        subjectStudentId: cur.student_id,
        campusId: e.campus_id,
        departmentId: e.department_id,
        riskTier: 1,
        reasonText: reason,
        changes: {
          status: { old: cur.status, new: updated.status },
          validTo: { old: null, new: updated.valid_to },
        },
      },
      options.meta,
    );
    return toReg(updated);
  }
}
