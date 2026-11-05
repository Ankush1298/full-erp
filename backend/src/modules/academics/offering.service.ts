import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { ACTIVE_PRIMARY_POSTING, AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { parseDate, parseReason } from '../people/validation.js';
import { EmployeeService } from '../people/employee.service.js';
import { departmentScopeFilter } from './academic.service.js';
import { cohortPeriodScope } from './calendar.service.js';
import {
  assertScoped,
  checkVersion,
  conflict,
  ensureTrusted,
  invalid,
  iso,
  mapDbError,
} from './common.js';
import type {
  AssignmentDto,
  CreateAssignmentBody,
  CreateOfferingBody,
  CreateSlotBody,
  EndAssignmentBody,
  EndSlotBody,
  EmployeeAssignmentDto,
  EmployeeAssignmentsQuery,
  ListOfferingsQuery,
  OfferingDto,
  SlotDto,
  UpdateOfferingBody,
} from './offering.schemas.js';

/**
 * Milestone 3 Batch 2 (doc 31): course offerings, faculty assignments, timetable slots. Every scope decision uses the
 * offering's campus and department, which the database derives from trusted rows (term, cohort period's programme or the
 * course's owning department) and the request can never supply. Held at all but out of scope, missing, or another
 * tenant's ⇒ the same 404; not held ⇒ 403. The migration guards re-check every rule for every writer.
 */

type Meta = AuditRequestMeta | undefined;
interface UpdateOptions {
  expected: ExpectedVersion;
  meta?: Meta;
}

const READ = 'academic.program.read';
const MANAGE = 'academic.offering.manage';
const ASSIGN = 'academic.faculty.assign';
const lower = (s: string): string => s.toLowerCase();
const uuidOrThrow = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !isUuidV7(v)) throw invalid(`Invalid ${what} ID.`);
  return lower(v);
};

interface Scope {
  campusId: string;
  departmentId: string;
}
const engineScope = (s: Scope) => ({ campus_id: s.campusId, department_id: s.departmentId });

// =============================================================================================
// Course offerings
// =============================================================================================
interface OfferingRow {
  id: string;
  campus_id: string;
  department_id: string;
  term_id: string;
  course_id: string;
  cohort_period_id: string | null;
  section_id: string | null;
  elective_group_id: string | null;
  offering_kind: OfferingDto['offeringKind'];
  group_label: string | null;
  code_snapshot: string;
  title_snapshot: string;
  credits_snapshot: string;
  tracks_attendance: boolean;
  registration_policy: OfferingDto['registrationPolicy'];
  capacity: number | null;
  status: OfferingDto['status'];
  published_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const OFFERING_COLS = `id, campus_id, department_id, term_id, course_id, cohort_period_id, section_id, elective_group_id,
  offering_kind, group_label, code_snapshot, title_snapshot, credits_snapshot::text AS credits_snapshot, tracks_attendance,
  registration_policy, capacity, status, published_at, version, created_at, updated_at`;
const toOffering = (r: OfferingRow): OfferingDto => ({
  id: r.id,
  campusId: r.campus_id,
  departmentId: r.department_id,
  termId: r.term_id,
  courseId: r.course_id,
  cohortPeriodId: r.cohort_period_id,
  sectionId: r.section_id,
  electiveGroupId: r.elective_group_id,
  offeringKind: r.offering_kind,
  groupLabel: r.group_label,
  codeSnapshot: r.code_snapshot,
  titleSnapshot: r.title_snapshot,
  creditsSnapshot: r.credits_snapshot,
  tracksAttendance: r.tracks_attendance,
  registrationPolicy: r.registration_policy,
  capacity: r.capacity,
  status: r.status,
  publishedAt: r.published_at ? iso(r.published_at) : null,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** The scope of an existing offering, read from its row. Missing (or another tenant's, invisible under RLS) ⇒ 404. */
export async function offeringScope(
  tx: TenantTx,
  ctx: TrustedContext,
  offeringId: string,
): Promise<Scope & { status: OfferingDto['status'] }> {
  const r = await tx.query<{
    campus_id: string;
    department_id: string;
    status: OfferingDto['status'];
  }>(
    `SELECT campus_id, department_id, status FROM app.course_offerings WHERE organization_id = $1 AND id = $2`,
    [ctx.tenantId, offeringId],
  );
  const row = r.rows[0];
  if (!row) throw resourceNotFound();
  return { campusId: row.campus_id, departmentId: row.department_id, status: row.status };
}

/**
 * The scope a NEW offering will have: campus from the term; department from the cohort period's programme, else from the
 * course's owning department. The same derivation the migration guard performs (it overwrites whatever is inserted).
 */
async function newOfferingScope(
  tx: TenantTx,
  ctx: TrustedContext,
  termId: string,
  courseId: string,
  cohortPeriodId: string | null,
): Promise<Scope> {
  const t = await tx.query<{ campus_id: string }>(
    `SELECT campus_id FROM app.terms WHERE organization_id = $1 AND id = $2`,
    [ctx.tenantId, termId],
  );
  if (!t.rows[0]) throw resourceNotFound();
  const c = await tx.query<{ owning_department_id: string | null }>(
    `SELECT owning_department_id FROM app.courses WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [ctx.tenantId, courseId],
  );
  if (!c.rows[0]) throw resourceNotFound();
  let departmentId = c.rows[0].owning_department_id;
  if (cohortPeriodId) {
    const cp = await cohortPeriodScope(tx, ctx, cohortPeriodId);
    if (cp.termId !== termId) throw invalid('The cohort period does not run in this term.');
    departmentId = cp.departmentId;
  }
  if (!departmentId) {
    throw invalid(
      'An organization-wide course needs a cohort period to give the offering a department.',
    );
  }
  return { campusId: t.rows[0].campus_id, departmentId };
}

export class OfferingService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateOfferingBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Offering payload is required.');
    const termId = uuidOrThrow(input.termId, 'term');
    const courseId = uuidOrThrow(input.courseId, 'course');
    let cohortPeriodId = input.cohortPeriodId
      ? uuidOrThrow(input.cohortPeriodId, 'cohort period')
      : null;
    const sectionId = input.sectionId ? uuidOrThrow(input.sectionId, 'section') : null;
    const electiveGroupId = input.electiveGroupId
      ? uuidOrThrow(input.electiveGroupId, 'elective group')
      : null;
    const groupLabel = typeof input.groupLabel === 'string' ? input.groupLabel.trim() : null;
    if (groupLabel !== null && (groupLabel.length < 1 || groupLabel.length > 30)) {
      throw invalid('groupLabel must be 1 to 30 characters.');
    }
    const capacity = input.capacity ?? null;
    await AuthorizationEngine.assert(tx, ctx, MANAGE);

    if (sectionId) {
      // A section names its cohort period; a supplied cohort period must agree with it.
      const s = await tx.query<{ cohort_period_id: string }>(
        `SELECT cohort_period_id FROM app.sections WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, sectionId],
      );
      if (!s.rows[0]) throw resourceNotFound();
      if (cohortPeriodId && cohortPeriodId !== s.rows[0].cohort_period_id) {
        throw invalid('The section does not belong to that cohort period.');
      }
      cohortPeriodId = s.rows[0].cohort_period_id;
    }
    const scope = await newOfferingScope(tx, ctx, termId, courseId, cohortPeriodId);
    await assertScoped(tx, ctx, MANAGE, engineScope(scope));

    const id = uuidv7();
    try {
      // campus/department/snapshots are placeholders the guard overwrites from trusted rows.
      await tx.query(
        `INSERT INTO app.course_offerings
           (id, organization_id, campus_id, department_id, term_id, course_id, cohort_period_id, section_id,
            offering_kind, group_label, code_snapshot, title_snapshot, credits_snapshot, tracks_attendance,
            registration_policy, capacity, elective_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '', '', 0, true, $11, $12, $13)`,
        [
          id,
          ctx.tenantId,
          scope.campusId,
          scope.departmentId,
          termId,
          courseId,
          cohortPeriodId,
          sectionId,
          input.offeringKind,
          groupLabel,
          input.registrationPolicy,
          capacity,
          electiveGroupId,
        ],
      );
    } catch (err) {
      mapDbError(err, 'This course is already offered in the term for that section and group.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.offering.create',
        resourceType: 'course_offering',
        resourceId: id,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 1,
        changes: {
          termId: { old: null, new: termId },
          courseId: { old: null, new: courseId },
          cohortPeriodId: { old: null, new: cohortPeriodId },
          sectionId: { old: null, new: sectionId },
          offeringKind: { old: null, new: input.offeringKind },
          groupLabel: { old: null, new: groupLabel },
          registrationPolicy: { old: null, new: input.registrationPolicy },
          capacity: { old: null, new: capacity },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListOfferingsQuery = {},
  ): Promise<OfferingDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ);
    const scope = await departmentScopeFilter(tx, ctx, [READ, MANAGE]);
    if (!scope.orgWide && scope.departmentIds.length === 0) return [];
    const params: unknown[] = [ctx.tenantId];
    const where = ['organization_id = $1'];
    if (!scope.orgWide) {
      params.push(scope.departmentIds);
      where.push(`department_id = ANY($${params.length}::uuid[])`);
    }
    for (const [key, col] of [
      ['termId', 'term_id'],
      ['sectionId', 'section_id'],
      ['cohortPeriodId', 'cohort_period_id'],
      ['status', 'status'],
    ] as const) {
      const v = filter[key];
      if (v !== undefined) {
        params.push(key === 'status' ? v : lower(v));
        where.push(`${col} = $${params.length}`);
      }
    }
    const r = await tx.query<OfferingRow>(
      `SELECT ${OFFERING_COLS} FROM app.course_offerings WHERE ${where.join(' AND ')}
        ORDER BY term_id, code_snapshot, group_label NULLS FIRST, id`,
      params,
    );
    return r.rows.map(toOffering);
  }

  static async getById(tx: TenantTx, ctx: TrustedContext, id: string): Promise<OfferingDto> {
    ensureTrusted(ctx);
    const oid = uuidOrThrow(id, 'offering');
    await AuthorizationEngine.assert(tx, ctx, READ);
    const r = await tx.query<OfferingRow>(
      `SELECT ${OFFERING_COLS} FROM app.course_offerings WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, oid],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    await assertScoped(tx, ctx, READ, {
      campus_id: row.campus_id,
      department_id: row.department_id,
    });
    return toOffering(row);
  }

  /** Publication snapshots the catalogue (the guard copies code/title/credits); CLOSED and CANCELLED are final. */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateOfferingBody,
    options: UpdateOptions,
  ): Promise<OfferingDto> {
    ensureTrusted(ctx);
    const oid = uuidOrThrow(id, 'offering');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    await AuthorizationEngine.assert(tx, ctx, MANAGE);
    const scope = await offeringScope(tx, ctx, oid);
    await assertScoped(tx, ctx, MANAGE, engineScope(scope));

    const r = await tx.query<OfferingRow>(
      `SELECT ${OFFERING_COLS} FROM app.course_offerings WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, oid],
    );
    const cur = r.rows[0];
    if (!cur) throw resourceNotFound();
    checkVersion(options.expected, cur.version, 'Course offering');

    const status = input.status ?? cur.status;
    const capacity = input.capacity === undefined ? cur.capacity : input.capacity;
    const ending = status !== cur.status && (status === 'CANCELLED' || status === 'CLOSED');
    const reason = ending ? parseReason(input.reason) : undefined;
    if (status === cur.status && capacity === cur.capacity) return toOffering(cur);

    let updated: OfferingRow | undefined;
    try {
      const u = await tx.query<OfferingRow>(
        `UPDATE app.course_offerings SET status = $3, capacity = $4
          WHERE organization_id = $1 AND id = $2 RETURNING ${OFFERING_COLS}`,
        [ctx.tenantId, oid, status, capacity],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'Course offering conflict.');
    }
    if (!updated) throw resourceNotFound();
    const changes: Record<string, unknown> = {};
    if (status !== cur.status) changes['status'] = { old: cur.status, new: status };
    if (capacity !== cur.capacity) changes['capacity'] = { old: cur.capacity, new: capacity };
    if (status === 'PUBLISHED') {
      changes['snapshot'] = {
        old: null,
        new: {
          code: updated.code_snapshot,
          title: updated.title_snapshot,
          credits: updated.credits_snapshot,
        },
      };
    }
    await recordAudit(
      tx,
      ctx,
      {
        action:
          status === 'PUBLISHED' && cur.status !== 'PUBLISHED'
            ? 'academic.offering.publish'
            : 'academic.offering.update',
        resourceType: 'course_offering',
        resourceId: oid,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: ending ? 2 : 1,
        changes,
        ...(reason ? { reasonText: reason } : {}),
      },
      options.meta,
    );
    return toOffering(updated);
  }
}

// =============================================================================================
// Faculty assignments (A2: reason + risk tier 2 on every change)
// =============================================================================================
interface AssignmentRow {
  id: string;
  course_offering_id: string;
  employee_id: string;
  teaching_role: AssignmentDto['teachingRole'];
  valid_from: string;
  valid_to: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const ASSIGNMENT_COLS = `id, course_offering_id, employee_id, role AS teaching_role, valid_from::text AS valid_from,
  valid_to::text AS valid_to, version, created_at, updated_at`;
const toAssignment = (r: AssignmentRow): AssignmentDto => ({
  id: r.id,
  courseOfferingId: r.course_offering_id,
  employeeId: r.employee_id,
  teachingRole: r.teaching_role,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** Static SQL (the posting predicate is a constant fragment shared with the authorization engine). */
const POSTED_ON_CAMPUS_SQL = `SELECT 1 FROM app.employee_postings p
   JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
   JOIN app.campuses c ON c.organization_id = d.organization_id AND c.id = d.campus_id
  WHERE p.organization_id = $1 AND p.employee_id = $2 AND d.campus_id = $3 AND ${ACTIVE_PRIMARY_POSTING}`;

export class FacultyAssignmentService {
  /**
   * The employee must be ACTIVE (database guard) and, (A) doc 31 §3, hold an active PRIMARY posting on the offering's
   * campus (the same posting predicate the authorization engine uses for employee scope). One PRIMARY at a time per
   * offering and no duplicate period for one employee are enforced by the guard under the offering row lock.
   */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    offeringId: string,
    input: CreateAssignmentBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    const oid = uuidOrThrow(offeringId, 'offering');
    if (!input || typeof input !== 'object') throw invalid('Assignment payload is required.');
    const employeeId = uuidOrThrow(input.employeeId, 'employee');
    const validFrom = parseDate(input.validFrom, 'validFrom');
    const validTo = input.validTo === undefined ? null : parseDate(input.validTo, 'validTo');
    if (validTo !== null && validTo < validFrom)
      throw invalid('validTo must not be before validFrom.');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, ASSIGN);
    const scope = await offeringScope(tx, ctx, oid);
    await assertScoped(tx, ctx, ASSIGN, engineScope(scope));

    const emp = await tx.query<{ status: string }>(
      `SELECT status FROM app.employees WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, employeeId],
    );
    if (!emp.rows[0]) throw resourceNotFound();
    if (emp.rows[0].status !== 'ACTIVE') throw conflict('The employee is not ACTIVE.');
    const posted = await tx.query(POSTED_ON_CAMPUS_SQL, [ctx.tenantId, employeeId, scope.campusId]);
    if (posted.rows.length === 0) {
      throw conflict("The employee has no active primary posting on the offering's campus.");
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.faculty_assignments (id, organization_id, course_offering_id, employee_id, role, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.tenantId, oid, employeeId, input.teachingRole, validFrom, validTo],
      );
    } catch (err) {
      mapDbError(err, 'Faculty assignment conflict.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.faculty_assignment.create',
        resourceType: 'faculty_assignment',
        resourceId: id,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 2,
        reasonText: reason,
        changes: {
          courseOfferingId: { old: null, new: oid },
          employeeId: { old: null, new: employeeId },
          teachingRole: { old: null, new: input.teachingRole },
          validFrom: { old: null, new: validFrom },
          validTo: { old: null, new: validTo },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    offeringId: string,
  ): Promise<AssignmentDto[]> {
    ensureTrusted(ctx);
    const oid = uuidOrThrow(offeringId, 'offering');
    await AuthorizationEngine.assert(tx, ctx, READ);
    const scope = await offeringScope(tx, ctx, oid);
    await assertScoped(tx, ctx, READ, engineScope(scope));
    const r = await tx.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLS} FROM app.faculty_assignments
        WHERE organization_id = $1 AND course_offering_id = $2 ORDER BY valid_from, teaching_role, id`,
      [ctx.tenantId, oid],
    );
    return r.rows.map(toAssignment);
  }

  /** Ends an open assignment on `validTo` (doc 02 §5.3: faculty changes close one row and open another). */
  /**
   * The `/faculty` assignment and workload view of one employee (Task 9). Gate: the employee is visible under the
   * existing employee rules (EmployeeService.getById: 403 without employee.profile.read, 404 out of campus/department
   * scope or not this tenant's, SELF for a teacher's own record), and the caller reads offerings (academic.program.read,
   * 403 otherwise). Each row then passes the same per-offering scope check as GET
   * /course-offerings/:id/faculty-assignments, so this view never shows an assignment that route would hide.
   */
  static async listForEmployee(
    tx: TenantTx,
    ctx: TrustedContext,
    employeeId: string,
    filter: EmployeeAssignmentsQuery = {},
  ): Promise<EmployeeAssignmentDto[]> {
    ensureTrusted(ctx);
    const eid = uuidOrThrow(employeeId, 'employee');
    const termId = filter.termId === undefined ? null : uuidOrThrow(filter.termId, 'term');
    await EmployeeService.getById(tx, ctx, eid);
    await AuthorizationEngine.assert(tx, ctx, READ);
    const r = await tx.query<
      AssignmentRow & {
        term_id: string;
        code_snapshot: string;
        title_snapshot: string;
        offering_status: string;
      }
    >(
      `SELECT x.*, o.term_id, o.code_snapshot, o.title_snapshot, o.status AS offering_status
         FROM (SELECT ${ASSIGNMENT_COLS} FROM app.faculty_assignments
                WHERE organization_id = $1 AND employee_id = $2) x
         JOIN app.course_offerings o ON o.organization_id = $1 AND o.id = x.course_offering_id
        WHERE ($3::uuid IS NULL OR o.term_id = $3::uuid)
        ORDER BY x.valid_from, o.code_snapshot, x.id`,
      [ctx.tenantId, eid, termId],
    );
    const out: EmployeeAssignmentDto[] = [];
    for (const row of r.rows) {
      try {
        await assertScoped(
          tx,
          ctx,
          READ,
          engineScope(await offeringScope(tx, ctx, row.course_offering_id)),
        );
      } catch (err) {
        if (err instanceof AppError && (err.statusCode === 403 || err.statusCode === 404)) continue;
        throw err;
      }
      out.push({
        ...toAssignment(row),
        termId: row.term_id,
        offeringCode: row.code_snapshot,
        offeringTitle: row.title_snapshot,
        offeringStatus: row.offering_status,
      });
    }
    return out;
  }

  static async end(
    tx: TenantTx,
    ctx: TrustedContext,
    assignmentId: string,
    input: EndAssignmentBody,
    options: UpdateOptions,
  ): Promise<AssignmentDto> {
    ensureTrusted(ctx);
    const aid = uuidOrThrow(assignmentId, 'assignment');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const validTo = parseDate(input.validTo, 'validTo');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, ASSIGN);
    const probe = await tx.query<{ course_offering_id: string }>(
      `SELECT course_offering_id FROM app.faculty_assignments WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, aid],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    const scope = await offeringScope(tx, ctx, probe.rows[0].course_offering_id);
    await assertScoped(tx, ctx, ASSIGN, engineScope(scope));

    const r = await tx.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLS} FROM app.faculty_assignments WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, aid],
    );
    const cur = r.rows[0];
    if (!cur) throw resourceNotFound();
    checkVersion(options.expected, cur.version, 'Faculty assignment');
    if (cur.valid_to !== null) throw conflict('The assignment has already ended.');
    if (validTo < cur.valid_from) throw invalid('validTo must not be before validFrom.');

    let updated: AssignmentRow | undefined;
    try {
      const u = await tx.query<AssignmentRow>(
        `UPDATE app.faculty_assignments SET valid_to = $3 WHERE organization_id = $1 AND id = $2
         RETURNING ${ASSIGNMENT_COLS}`,
        [ctx.tenantId, aid, validTo],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'Faculty assignment conflict.');
    }
    if (!updated) throw resourceNotFound();
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.faculty_assignment.end',
        resourceType: 'faculty_assignment',
        resourceId: aid,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 2,
        reasonText: reason,
        changes: { validTo: { old: null, new: validTo } },
      },
      options.meta,
    );
    return toAssignment(updated);
  }
}

// =============================================================================================
// Timetable slots
// =============================================================================================
interface SlotRow {
  id: string;
  course_offering_id: string;
  room_id: string | null;
  faculty_assignment_id: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const SLOT_COLS = `id, course_offering_id, room_id, faculty_assignment_id, weekday,
  to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
  effective_from::text AS effective_from, effective_to::text AS effective_to, version, created_at, updated_at`;
const toSlot = (r: SlotRow): SlotDto => ({
  id: r.id,
  courseOfferingId: r.course_offering_id,
  roomId: r.room_id,
  facultyAssignmentId: r.faculty_assignment_id,
  weekday: r.weekday,
  startTime: r.start_time,
  endTime: r.end_time,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class TimetableSlotService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    offeringId: string,
    input: CreateSlotBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    const oid = uuidOrThrow(offeringId, 'offering');
    if (!input || typeof input !== 'object') throw invalid('Slot payload is required.');
    if (!Number.isInteger(input.weekday) || input.weekday < 1 || input.weekday > 7) {
      throw invalid('weekday must be an ISO weekday (1 = Monday ... 7 = Sunday).');
    }
    if (!TIME_RE.test(input.startTime) || !TIME_RE.test(input.endTime)) {
      throw invalid('startTime and endTime must be HH:MM (24-hour).');
    }
    if (input.startTime >= input.endTime) throw invalid('startTime must be before endTime.');
    const effectiveFrom = parseDate(input.effectiveFrom, 'effectiveFrom');
    const effectiveTo =
      input.effectiveTo === undefined ? null : parseDate(input.effectiveTo, 'effectiveTo');
    if (effectiveTo !== null && effectiveTo < effectiveFrom) {
      throw invalid('effectiveTo must not be before effectiveFrom.');
    }
    const roomId = input.roomId ? uuidOrThrow(input.roomId, 'room') : null;
    const assignmentId = input.facultyAssignmentId
      ? uuidOrThrow(input.facultyAssignmentId, 'faculty assignment')
      : null;
    await AuthorizationEngine.assert(tx, ctx, MANAGE);
    const scope = await offeringScope(tx, ctx, oid);
    await assertScoped(tx, ctx, MANAGE, engineScope(scope));

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.timetable_slots
           (id, organization_id, course_offering_id, room_id, faculty_assignment_id, weekday, start_time, end_time,
            effective_from, effective_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          ctx.tenantId,
          oid,
          roomId,
          assignmentId,
          input.weekday,
          input.startTime,
          input.endTime,
          effectiveFrom,
          effectiveTo,
        ],
      );
    } catch (err) {
      mapDbError(err, 'Timetable slot conflict.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.timetable_slot.create',
        resourceType: 'timetable_slot',
        resourceId: id,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 1,
        changes: {
          courseOfferingId: { old: null, new: oid },
          weekday: { old: null, new: input.weekday },
          startTime: { old: null, new: input.startTime },
          endTime: { old: null, new: input.endTime },
          effectiveFrom: { old: null, new: effectiveFrom },
          effectiveTo: { old: null, new: effectiveTo },
          roomId: { old: null, new: roomId },
          facultyAssignmentId: { old: null, new: assignmentId },
        },
      },
      meta,
    );
    return id;
  }

  static async list(tx: TenantTx, ctx: TrustedContext, offeringId: string): Promise<SlotDto[]> {
    ensureTrusted(ctx);
    const oid = uuidOrThrow(offeringId, 'offering');
    await AuthorizationEngine.assert(tx, ctx, READ);
    const scope = await offeringScope(tx, ctx, oid);
    await assertScoped(tx, ctx, READ, engineScope(scope));
    const r = await tx.query<SlotRow>(
      `SELECT ${SLOT_COLS} FROM app.timetable_slots
        WHERE organization_id = $1 AND course_offering_id = $2 ORDER BY weekday, start_time, effective_from, id`,
      [ctx.tenantId, oid],
    );
    return r.rows.map(toSlot);
  }

  static async end(
    tx: TenantTx,
    ctx: TrustedContext,
    slotId: string,
    input: EndSlotBody,
    options: UpdateOptions,
  ): Promise<SlotDto> {
    ensureTrusted(ctx);
    const sid = uuidOrThrow(slotId, 'slot');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const effectiveTo = parseDate(input.effectiveTo, 'effectiveTo');
    await AuthorizationEngine.assert(tx, ctx, MANAGE);
    const probe = await tx.query<{ course_offering_id: string }>(
      `SELECT course_offering_id FROM app.timetable_slots WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, sid],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    const scope = await offeringScope(tx, ctx, probe.rows[0].course_offering_id);
    await assertScoped(tx, ctx, MANAGE, engineScope(scope));

    const r = await tx.query<SlotRow>(
      `SELECT ${SLOT_COLS} FROM app.timetable_slots WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, sid],
    );
    const cur = r.rows[0];
    if (!cur) throw resourceNotFound();
    checkVersion(options.expected, cur.version, 'Timetable slot');
    if (cur.effective_to !== null) throw conflict('The slot has already ended.');
    if (effectiveTo < cur.effective_from)
      throw invalid('effectiveTo must not be before effectiveFrom.');

    let updated: SlotRow | undefined;
    try {
      const u = await tx.query<SlotRow>(
        `UPDATE app.timetable_slots SET effective_to = $3 WHERE organization_id = $1 AND id = $2
         RETURNING ${SLOT_COLS}`,
        [ctx.tenantId, sid, effectiveTo],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'Timetable slot conflict.');
    }
    if (!updated) throw resourceNotFound();
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.timetable_slot.end',
        resourceType: 'timetable_slot',
        resourceId: sid,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 1,
        changes: { effectiveTo: { old: null, new: effectiveTo } },
      },
      options.meta,
    );
    return toSlot(updated);
  }
}
