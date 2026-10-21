import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import {
  parseIdempotencyKey,
  runIdempotent,
  type IdempotentResult,
} from '../../shared/idempotency/index.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { invalid, parseDate, parseReason } from '../people/validation.js';
import { checkVersion, conflict, iso, mapDbError } from '../academics/common.js';
import {
  ENROLLMENT_TYPES,
  ROLL_NUMBER_PATTERN,
  TARGET_STATUSES,
  TERMINAL_STATUSES,
  type CreateTermEnrollmentBody,
  type PlaceSectionBody,
  type TermEnrollmentDto,
  type UpdateTermEnrollmentBody,
} from './term-enrollment.schemas.js';

export const CREATE_TERM_ENROLLMENT_OPERATION = 'POST /api/v1/students/:id/term-enrollments';
export const READ = 'enrollment.term.read';
export const MANAGE = 'enrollment.term.manage';

const ROLL_RE = new RegExp(ROLL_NUMBER_PATTERN);
const ENROLLABLE_STUDENT_STATUSES: readonly string[] = ['ADMITTED', 'ACTIVE'];
const lower = (s: string): string => s.toLowerCase();

/** The status machine, mirrored by the migration 0033 guard (the database is the backstop). */
const TRANSITIONS: Record<string, readonly string[]> = {
  REGISTERED: ['ACTIVE', 'WITHDRAWN'],
  ACTIVE: ['WITHDRAWN', 'DETAINED', 'PROMOTED', 'COMPLETED', 'ON_LEAVE'],
  ON_LEAVE: ['ACTIVE', 'WITHDRAWN'],
  DETAINED: ['ACTIVE', 'WITHDRAWN'],
  WITHDRAWN: [],
  PROMOTED: [],
  COMPLETED: [],
};

interface EnrollmentRow {
  id: string;
  student_id: string;
  student_program_id: string;
  cohort_period_id: string;
  term_id: string;
  period_no: number;
  status: TermEnrollmentDto['status'];
  enrollment_type: TermEnrollmentDto['enrollmentType'];
  roll_number: string | null;
  registered_at: Date;
  version: number;
  created_at: Date;
  updated_at: Date;
  campus_id: string;
  department_id: string;
  section_id: string | null;
  section_name: string | null;
  section_from: string | null;
}
// Scope columns come from the enrolment's student_program (frozen campus/department), never from a caller value.
const SELECT = `e.id, e.student_id, e.student_program_id, e.cohort_period_id, e.term_id, e.period_no, e.status,
  e.enrollment_type, e.roll_number, e.registered_at, e.version, e.created_at, e.updated_at,
  sp.campus_id, sp.department_id,
  cur.section_id, cur.section_name, cur.valid_from AS section_from`;
const FROM = `app.term_enrollments e
  JOIN app.student_programs sp
    ON sp.organization_id = e.organization_id AND sp.student_id = e.student_id AND sp.id = e.student_program_id
  LEFT JOIN LATERAL (
    SELECT m.section_id, s.name AS section_name, m.valid_from::text AS valid_from
      FROM app.section_memberships m
      JOIN app.sections s ON s.organization_id = m.organization_id AND s.id = m.section_id
     WHERE m.organization_id = e.organization_id AND m.term_enrollment_id = e.id AND m.valid_to IS NULL
  ) cur ON true`;

const toDto = (r: EnrollmentRow): TermEnrollmentDto => ({
  id: r.id,
  studentId: r.student_id,
  studentProgramId: r.student_program_id,
  cohortPeriodId: r.cohort_period_id,
  termId: r.term_id,
  periodNo: r.period_no,
  status: r.status,
  enrollmentType: r.enrollment_type,
  rollNumber: r.roll_number,
  registeredAt: iso(r.registered_at),
  currentSection:
    r.section_id && r.section_name && r.section_from
      ? { sectionId: r.section_id, name: r.section_name, validFrom: r.section_from }
      : null,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

async function can(
  tx: TenantTx,
  ctx: TrustedContext,
  permission: string,
  resource: Parameters<typeof AuthorizationEngine.assert>[3],
): Promise<boolean> {
  try {
    await AuthorizationEngine.assert(tx, ctx, permission, resource);
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return false;
    throw err;
  }
}

/** Constraint names → 409 text. Only race losers of the database guards are mapped; everything else propagates. */
function mapEnrollmentError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505') {
    if (e.constraint === 'term_enrollments_student_period_uq') {
      throw conflict('The student already has an enrolment in this cohort period.');
    }
    if (e.constraint === 'term_enrollments_one_live_per_term_uq') {
      throw conflict('The student already has a live enrolment in this term.');
    }
    if (e.constraint === 'term_enrollments_roll_uq') {
      throw conflict('This roll number is already used in the cohort period.');
    }
  }
  return mapDbError(err, 'The enrolment conflicts with an existing record.');
}

/**
 * Term enrolments and section placement (`app.term_enrollments`, `app.section_memberships`, migration 0033).
 *
 * AUTHORIZATION. `enrollment.term.manage` (writes) / `enrollment.term.read` (reads) are GRANTED within the campus and
 * department of the student's program enrolment (its FROZEN `campus_id` / `department_id`, read from the database),
 * or SELF for a student reading their own. Not held at all ⇒ 403; out of scope, missing or another student's ⇒ the
 * same 404. Writes are staff-only (`assertStaffActor`) before any lock.
 *
 * LOCK ORDER. create: student (no key update) -> campus (share) -> cohort period / term (share, by the migration guard)
 * -> insert. Placement: term enrolment (no key update) -> section (update) -> membership insert (its guard re-locks the
 * enrolment, already held). A section PATCH locks only the section, so no path takes them in the opposite order.
 */
export class TermEnrollmentService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    input: CreateTermEnrollmentBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    if (!input || typeof input !== 'object') throw invalid('Enrolment payload is required.');
    if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');
    if (!isUuidV7(input.cohortPeriodId)) throw invalid('Invalid cohort period ID.');
    const type = input.enrollmentType ?? 'REGULAR';
    if (!(ENROLLMENT_TYPES as readonly string[]).includes(type))
      throw invalid('Invalid enrollmentType.');
    const rollNumber = input.rollNumber === undefined ? null : input.rollNumber.trim();
    if (rollNumber !== null && !ROLL_RE.test(rollNumber))
      throw invalid('rollNumber has an invalid format.');
    const reason = parseReason(input.reason);
    const student = lower(studentId);
    const cohortPeriodId = lower(input.cohortPeriodId);

    await AuthorizationEngine.assert(tx, ctx, MANAGE);
    // Scope: the student's ACTIVE program enrolment (frozen campus/department). Unlocked read; re-verified under lock below.
    const sp = await tx.query<{
      id: string;
      campus_id: string;
      department_id: string;
      cohort_id: string;
    }>(
      `SELECT id, campus_id, department_id, cohort_id FROM app.student_programs
        WHERE organization_id = $1 AND student_id = $2 AND status = 'ACTIVE'`,
      [ctx.tenantId, student],
    );
    const program = sp.rows[0];
    if (!program) {
      // Without a program there is no campus/department proof: only an ORGANIZATION-wide holder may learn anything.
      await AuthorizationEngine.assert(tx, ctx, MANAGE, { organization_id: ctx.tenantId });
      const exists = await tx.query(
        `SELECT 1 FROM app.students WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, student],
      );
      if (!exists.rows[0]) throw resourceNotFound();
      throw conflict('The student has no active program enrolment.');
    }
    await AuthorizationEngine.assert(tx, ctx, MANAGE, {
      organization_id: ctx.tenantId,
      campus_id: program.campus_id,
      department_id: program.department_id,
      student_id: student,
    });

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: CREATE_TERM_ENROLLMENT_OPERATION,
        request: { studentId: student, cohortPeriodId, enrollmentType: type, rollNumber, reason },
      },
      async () => {
        const s = await tx.query<{ status: string }>(
          `SELECT status FROM app.students WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
          [ctx.tenantId, student],
        );
        if (!s.rows[0]) throw resourceNotFound();
        if (!ENROLLABLE_STUDENT_STATUSES.includes(s.rows[0].status)) {
          throw conflict('The student cannot be enrolled for a term.');
        }
        // Re-read the active program under the student lock: it must still be the one we authorized against.
        const again = await tx.query<{ id: string; cohort_id: string }>(
          `SELECT id, cohort_id FROM app.student_programs
            WHERE organization_id = $1 AND student_id = $2 AND status = 'ACTIVE' AND id = $3 FOR SHARE`,
          [ctx.tenantId, student, program.id],
        );
        if (!again.rows[0]) throw conflict('The student has no active program enrolment.');

        const cp = await tx.query<{
          cohort_id: string;
          term_id: string;
          period_no: number;
          status: string;
          term_status: string;
        }>(
          `SELECT cp.cohort_id, cp.term_id, cp.period_no, cp.status, t.status AS term_status
             FROM app.cohort_periods cp
             JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
            WHERE cp.organization_id = $1 AND cp.id = $2 FOR SHARE OF cp`,
          [ctx.tenantId, cohortPeriodId],
        );
        const period = cp.rows[0];
        if (!period) throw resourceNotFound();
        if (period.cohort_id !== program.cohort_id) {
          throw conflict(
            "The cohort period belongs to a different cohort than the student's program enrolment.",
          );
        }
        if (period.status !== 'ACTIVE') throw conflict('The cohort period is not ACTIVE.');
        if (period.term_status !== 'PLANNED' && period.term_status !== 'ACTIVE') {
          throw conflict('The term is not open for enrolment.');
        }

        const id = uuidv7();
        try {
          await tx.query(
            `INSERT INTO app.term_enrollments
               (id, organization_id, student_id, student_program_id, cohort_period_id, term_id, period_no,
                enrollment_type, roll_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              id,
              ctx.tenantId,
              student,
              program.id,
              cohortPeriodId,
              period.term_id,
              period.period_no,
              type,
              rollNumber,
            ],
          );
        } catch (err) {
          mapEnrollmentError(err);
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'enrollment.term.create',
            resourceType: 'term_enrollment',
            resourceId: id,
            subjectStudentId: student,
            campusId: program.campus_id,
            departmentId: program.department_id,
            riskTier: 2,
            reasonText: reason,
            changes: {
              cohortPeriodId: { old: null, new: cohortPeriodId },
              periodNo: { old: null, new: period.period_no },
              enrollmentType: { old: null, new: type },
              rollNumber: { old: null, new: rollNumber },
              status: { old: null, new: 'REGISTERED' },
            },
          },
          meta,
        );
        return { status: 201, body: { success: true, data: { id } } };
      },
    );
  }

  /** Enrolments of one student, newest first. Only rows whose program scope the caller may read are returned. */
  static async listForStudent(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
  ): Promise<TermEnrollmentDto[]> {
    ensureTrusted(ctx);
    if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');
    const student = lower(studentId);
    await AuthorizationEngine.assert(tx, ctx, READ);
    const r = await tx.query<EnrollmentRow>(
      `SELECT ${SELECT} FROM ${FROM}
        WHERE e.organization_id = $1 AND e.student_id = $2
        ORDER BY e.registered_at DESC, e.id DESC`,
      [ctx.tenantId, student],
    );
    const seen = new Map<string, boolean>();
    const visible: EnrollmentRow[] = [];
    for (const row of r.rows) {
      const k = `${row.campus_id}:${row.department_id}`;
      if (!seen.has(k)) {
        seen.set(
          k,
          await can(tx, ctx, READ, {
            organization_id: ctx.tenantId,
            campus_id: row.campus_id,
            department_id: row.department_id,
            student_id: student,
          }),
        );
      }
      if (seen.get(k)) visible.push(row);
    }
    if (visible.length === 0) {
      // Existence of the student must not leak to an out-of-scope caller: authorize the student itself.
      const progs = await tx.query<{ campus_id: string; department_id: string }>(
        `SELECT DISTINCT campus_id, department_id FROM app.student_programs
          WHERE organization_id = $1 AND student_id = $2`,
        [ctx.tenantId, student],
      );
      let ok = false;
      for (const p of progs.rows) {
        ok ||= await can(tx, ctx, READ, {
          organization_id: ctx.tenantId,
          campus_id: p.campus_id,
          department_id: p.department_id,
          student_id: student,
        });
      }
      if (progs.rows.length === 0) {
        ok = await can(tx, ctx, READ, { organization_id: ctx.tenantId, student_id: student });
      }
      const exists = await tx.query(
        `SELECT 1 FROM app.students WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, student],
      );
      if (!ok || !exists.rows[0]) throw resourceNotFound();
    }
    return visible.map(toDto);
  }

  private static async loadScoped(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    permission: string,
    lock: boolean,
    owner?: string,
  ): Promise<EnrollmentRow> {
    // The enrolment's own frozen program scope, then the lock (top of the placement lock order).
    const r = await tx.query<EnrollmentRow>(
      `SELECT ${SELECT} FROM ${FROM} WHERE e.organization_id = $1 AND e.id = $2`,
      [ctx.tenantId, id],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    await AuthorizationEngine.assert(tx, ctx, permission, {
      organization_id: ctx.tenantId,
      campus_id: row.campus_id,
      department_id: row.department_id,
      student_id: row.student_id,
    });
    // A route that names the student in its path: an enrolment of another student is "not found under that student".
    if (owner !== undefined && lower(owner) !== row.student_id) throw resourceNotFound();
    if (!lock) return row;
    await tx.query(
      `SELECT 1 FROM app.term_enrollments WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, id],
    );
    const fresh = await tx.query<EnrollmentRow>(
      `SELECT ${SELECT} FROM ${FROM} WHERE e.organization_id = $1 AND e.id = $2`,
      [ctx.tenantId, id],
    );
    if (!fresh.rows[0]) throw resourceNotFound();
    return fresh.rows[0];
  }

  static async getById(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    owner?: string,
  ): Promise<TermEnrollmentDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid term enrolment ID.');
    await AuthorizationEngine.assert(tx, ctx, READ);
    return toDto(await TermEnrollmentService.loadScoped(tx, ctx, lower(id), READ, false, owner));
  }

  /** Status change and/or roll number. A final status also closes the open section membership (same transaction). */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateTermEnrollmentBody,
    options: { expected: ExpectedVersion; studentId?: string; meta?: AuditRequestMeta },
  ): Promise<TermEnrollmentDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid term enrolment ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const reason = parseReason(input.reason);
    if (
      input.status !== undefined &&
      !(TARGET_STATUSES as readonly string[]).includes(input.status)
    ) {
      throw invalid('Invalid status.');
    }
    let roll: string | null | undefined;
    if (input.rollNumber !== undefined) {
      roll = input.rollNumber === null ? null : input.rollNumber.trim();
      if (roll !== null && !ROLL_RE.test(roll)) throw invalid('rollNumber has an invalid format.');
    }
    await AuthorizationEngine.assert(tx, ctx, MANAGE);
    const row = await TermEnrollmentService.loadScoped(
      tx,
      ctx,
      lower(id),
      MANAGE,
      true,
      options.studentId,
    );
    checkVersion(options.expected, row.version, 'Term enrolment');

    const status = input.status ?? row.status;
    if (status !== row.status && !TRANSITIONS[row.status]?.includes(status)) {
      throw conflict(`A term enrolment cannot move from ${row.status} to ${status}.`);
    }
    if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
      throw conflict(`A ${row.status} term enrolment is final.`);
    }
    const newRoll = roll === undefined ? row.roll_number : roll;
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (status !== row.status) changes.status = { old: row.status, new: status };
    if (newRoll !== row.roll_number) changes.rollNumber = { old: row.roll_number, new: newRoll };
    if (Object.keys(changes).length === 0) return toDto(row);

    try {
      const u = await tx.query(
        `UPDATE app.term_enrollments SET status = $3, roll_number = $4
          WHERE organization_id = $1 AND id = $2 AND version = $5`,
        [ctx.tenantId, row.id, status, newRoll, row.version],
      );
      if (u.rowCount !== 1) throw conflict('Term enrolment version mismatch.');
    } catch (err) {
      if (err instanceof AppError) throw err;
      mapEnrollmentError(err);
    }

    // A final status closes the open section membership: migration 0033 does it in the same statement, for every writer.
    await recordAudit(
      tx,
      ctx,
      {
        action: 'enrollment.term.update',
        resourceType: 'term_enrollment',
        resourceId: row.id,
        subjectStudentId: row.student_id,
        campusId: row.campus_id,
        departmentId: row.department_id,
        riskTier: 2,
        reasonText: reason,
        changes,
      },
      options.meta ?? {},
    );
    return toDto(await TermEnrollmentService.loadScoped(tx, ctx, row.id, MANAGE, false));
  }

  /**
   * Places the student in a section from `validFrom`, or moves them: the open membership is closed the day before
   * (valid_to = validFrom - 1) and a new one opens, atomically. The capacity check runs under the section row lock.
   */
  static async placeSection(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: PlaceSectionBody,
    options: { studentId?: string; meta?: AuditRequestMeta } = {},
  ): Promise<TermEnrollmentDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid term enrolment ID.');
    if (!input || typeof input !== 'object') throw invalid('Placement payload is required.');
    if (!isUuidV7(input.sectionId)) throw invalid('Invalid section ID.');
    const validFrom = parseDate(input.validFrom, 'validFrom');
    const reasonText = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reasonText.length < 5 || reasonText.length > 100)
      throw invalid('Reason must be 5 to 100 characters.');
    const sectionId = lower(input.sectionId);

    await AuthorizationEngine.assert(tx, ctx, MANAGE);
    const row = await TermEnrollmentService.loadScoped(
      tx,
      ctx,
      lower(id),
      MANAGE,
      true,
      options.studentId,
    );
    if (row.status !== 'REGISTERED' && row.status !== 'ACTIVE') {
      throw conflict('Only a REGISTERED or ACTIVE term enrolment can be placed in a section.');
    }

    // Section row lock: serialises capacity decisions and section PATCHes. Must belong to this enrolment's cohort period.
    const sec = await tx.query<{ status: string; capacity: number | null; name: string }>(
      `SELECT status, capacity, name FROM app.sections
        WHERE organization_id = $1 AND cohort_period_id = $2 AND id = $3 FOR UPDATE`,
      [ctx.tenantId, row.cohort_period_id, sectionId],
    );
    const section = sec.rows[0];
    if (!section) throw resourceNotFound();
    if (section.status !== 'ACTIVE') throw conflict('The section is not ACTIVE.');

    const open = await tx.query<{ id: string; section_id: string; valid_from: string }>(
      `SELECT id, section_id, valid_from::text AS valid_from FROM app.section_memberships
        WHERE organization_id = $1 AND term_enrollment_id = $2 AND valid_to IS NULL`,
      [ctx.tenantId, row.id],
    );
    const current = open.rows[0];
    if (current && current.section_id === sectionId)
      throw conflict('The student is already in this section.');

    if (section.capacity !== null) {
      const n = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.section_memberships
          WHERE organization_id = $1 AND section_id = $2 AND valid_to IS NULL`,
        [ctx.tenantId, sectionId],
      );
      if (Number(n.rows[0]?.n ?? 0) >= section.capacity)
        throw conflict('The section is at capacity.');
    }

    if (current) {
      if (validFrom <= current.valid_from) {
        throw invalid('validFrom must be after the start of the current section membership.');
      }
      await tx.query(
        `UPDATE app.section_memberships SET valid_to = ($3::date - 1)
          WHERE organization_id = $1 AND id = $2 AND valid_to IS NULL`,
        [ctx.tenantId, current.id, validFrom],
      );
    }
    try {
      await tx.query(
        `INSERT INTO app.section_memberships
           (id, organization_id, term_enrollment_id, student_id, cohort_period_id, section_id, valid_from,
            change_reason, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)`,
        [
          uuidv7(),
          ctx.tenantId,
          row.id,
          row.student_id,
          row.cohort_period_id,
          sectionId,
          validFrom,
          reasonText,
          ctx.userId,
        ],
      );
    } catch (err) {
      mapEnrollmentError(err);
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: current ? 'enrollment.section.move' : 'enrollment.section.place',
        resourceType: 'term_enrollment',
        resourceId: row.id,
        subjectStudentId: row.student_id,
        campusId: row.campus_id,
        departmentId: row.department_id,
        riskTier: 2,
        reasonText,
        changes: {
          sectionId: { old: current?.section_id ?? null, new: sectionId },
          validFrom: { old: current?.valid_from ?? null, new: validFrom },
        },
      },
      options.meta ?? {},
    );
    return toDto(await TermEnrollmentService.loadScoped(tx, ctx, row.id, MANAGE, false));
  }
}
