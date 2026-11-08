import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import {
  parseIdempotencyKey,
  runIdempotent,
  type IdempotentResult,
} from '../../shared/idempotency/index.js';
import { conflict, ensureTrusted, invalid, iso, mapDbError } from '../academics/common.js';
import { approverIds, conductorUserId, notifyStaff } from './attendance.notifications.js';
import type {
  CancelSessionBody,
  CorrectionRequestDto,
  DecideRequestBody,
  ListCorrectionRequestsQuery,
  ListSessionsQuery,
  LockSessionBody,
  MyOfferingItemDto,
  CampusClockDto,
  MyOfferingQuery,
  MyRecordDto,
  MyRecordsQuery,
  MySummaryDto,
  CorrectRecordBody,
  CreateSessionBody,
  RecordDto,
  RevisionDto,
  SessionDto,
  SessionRosterItem,
  SubmitAttendanceBody,
} from './attendance.schemas.js';

export const CREATE_SESSION_OPERATION = 'POST /api/v1/attendance/sessions';
export const SUBMIT_ATTENDANCE_OPERATION = 'POST /api/v1/attendance/sessions/:id/attendance';
export const CANCEL_SESSION_OPERATION = 'POST /api/v1/attendance/sessions/:id/cancel';
export const CORRECT_RECORD_OPERATION = 'POST /api/v1/attendance/records/:id/corrections';
export const MARK = 'attendance.session.mark';
export const REQUEST_CORRECTION_OPERATION =
  'POST /api/v1/attendance/records/:id/correction-requests';
export const LOCK_SESSION_OPERATION = 'POST /api/v1/attendance/sessions/:id/lock';
export const CORRECT = 'attendance.record.correct';
export const APPROVE = 'attendance.correction.approve';
export const LOCK = 'attendance.session.lock';
export const CANCEL = 'attendance.session.cancel';
/** AD-2 (doc 43 §0): used when no attendance_policies row exists. */
export const DEFAULT_EDIT_WINDOW_DAYS = 3;
export const READ = 'attendance.record.read';

const lower = (s: string): string => s.toLowerCase();
/** A conflict/refusal with a STABLE machine-readable code the web app maps to wording (never parse messages). */
const coded = (status: number, code: string, message: string): AppError =>
  new AppError(status, code, message);

/** Class-session guard violations (migration 0040) as stable codes; anything else falls through to the generic mapper. */
const SESSION_CREATE_ERRORS: Record<string, [string, string]> = {
  class_sessions_local_date_ck: [
    'SESSION_TIME_OUTSIDE_DAY',
    'The start and end must both fall on the session date in the campus time zone (a class cannot cross midnight).',
  ],
  class_sessions_within_term_ck: [
    'SESSION_DATE_OUTSIDE_TERM',
    'The session date must lie within the term.',
  ],
  class_sessions_term_active_ck: ['TERM_NOT_OPEN', 'The term is not ACTIVE.'],
  class_sessions_holiday_ck: [
    'SESSION_ON_HOLIDAY',
    'A regular session cannot fall on a holiday or non-teaching day (use an EXTRA or MAKEUP session).',
  ],
  class_sessions_teacher_ck: [
    'TEACHER_NOT_ASSIGNED',
    'You hold no valid teaching assignment on this offering for that date.',
  ],
  class_sessions_slot_ck: [
    'TIMETABLE_SLOT_INVALID',
    'The timetable slot is not valid for this offering and date.',
  ],
  class_sessions_offering_published_ck: [
    'OFFERING_NOT_PUBLISHED',
    'The offering is not published.',
  ],
  class_sessions_offering_tracks_ck: [
    'OFFERING_NOT_TRACKED',
    'This offering does not track attendance.',
  ],
};
function mapSessionCreateError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505')
    throw coded(
      409,
      'SESSION_EXISTS',
      'A session already exists for this offering at this start time.',
    );
  const hit = e.constraint ? SESSION_CREATE_ERRORS[e.constraint] : undefined;
  if (hit) throw coded(409, hit[0], hit[1]);
  return mapDbError(err, 'A session already exists for this offering at this start time.');
}
const INITIAL_REASON = 'Initial marking';

interface SessionRow {
  id: string;
  organization_id: string;
  campus_id: string;
  department_id: string;
  course_offering_id: string;
  timetable_slot_id: string | null;
  conducted_by_employee_id: string;
  session_date: string;
  starts_at: Date;
  ends_at: Date;
  kind: SessionDto['kind'];
  topic: string | null;
  status: SessionDto['status'];
  attendance_state: SessionDto['attendanceState'];
  attendance_submitted_at: Date | null;
  version: number;
  term_status: string;
  offering_code: string;
  offering_title?: string;
  campus_timezone: string;
  campus_today: string;
  correction_window_days: number;
  inside_correction_window: boolean;
}

const SESSION_SELECT = `
  SELECT cs.id, cs.organization_id, cs.campus_id, o.department_id, cs.course_offering_id, cs.timetable_slot_id,
         cs.conducted_by_employee_id, cs.session_date::text AS session_date, cs.starts_at, cs.ends_at, cs.kind, cs.topic,
         cs.status, cs.attendance_state, cs.attendance_submitted_at, cs.version, t.status AS term_status,
         o.code_snapshot AS offering_code, o.title_snapshot AS offering_title,
         c.timezone AS campus_timezone, ((now() AT TIME ZONE c.timezone)::date)::text AS campus_today,
         w.days AS correction_window_days,
         (((now() AT TIME ZONE c.timezone)::date - cs.session_date) <= w.days) AS inside_correction_window
    FROM app.class_sessions cs
    JOIN app.course_offerings o ON o.organization_id = cs.organization_id AND o.id = cs.course_offering_id
    JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
    JOIN app.campuses c ON c.organization_id = cs.organization_id AND c.id = cs.campus_id
    CROSS JOIN LATERAL (
      SELECT COALESCE((SELECT p.edit_window_days FROM app.attendance_policies p
                        WHERE p.organization_id = cs.organization_id AND (p.campus_id = cs.campus_id OR p.campus_id IS NULL)
                        ORDER BY p.campus_id NULLS LAST LIMIT 1), ${DEFAULT_EDIT_WINDOW_DAYS}) AS days
    ) w`;

const toSessionDto = (
  r: SessionRow,
  counts?: { present: number; absent: number; late: number; excused: number; total: number },
): SessionDto => {
  const dto: SessionDto = {
    id: r.id,
    courseOfferingId: r.course_offering_id,
    campusId: r.campus_id,
    timetableSlotId: r.timetable_slot_id,
    conductedByEmployeeId: r.conducted_by_employee_id,
    sessionDate: r.session_date,
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    kind: r.kind,
    topic: r.topic,
    status: r.status,
    attendanceState: r.attendance_state,
    attendanceSubmittedAt: r.attendance_submitted_at ? iso(r.attendance_submitted_at) : null,
    version: r.version,
    // Read-only facts for display (doc 49 ATT-1/ATT-2). The server stays the only decision maker: these come from the same
    // campus time zone and policy that `correctRecord` and `requestCorrection` enforce, and a request still re-checks.
    campusTimezone: r.campus_timezone,
    campusToday: r.campus_today,
    correctionWindowDays: r.correction_window_days,
    insideCorrectionWindow: r.inside_correction_window,
  };
  if (r.offering_code !== undefined) dto.courseCode = r.offering_code;
  if (r.offering_title !== undefined) dto.courseTitle = r.offering_title;
  if (counts !== undefined) dto.counts = counts;
  return dto;
};

interface RecordRow {
  id: string;
  class_session_id: string;
  student_id: string;
  status: RecordDto['status'];
  source: string;
  marked_by_user_id: string;
  marked_at: Date;
  revision_no: number;
  remarks: string | null;
}

const RECORD_SELECT = `
  SELECT id, class_session_id, student_id, status, source, marked_by_user_id, marked_at, revision_no, remarks
    FROM app.attendance_records`;

const toRecordDto = (r: RecordRow): RecordDto => ({
  id: r.id,
  classSessionId: r.class_session_id,
  studentId: r.student_id,
  status: r.status,
  source: r.source,
  markedByUserId: r.marked_by_user_id,
  markedAt: iso(r.marked_at),
  revisionNo: r.revision_no,
  remarks: r.remarks,
});

interface RequestRow {
  id: string;
  attendance_record_id: string;
  class_session_id: string;
  student_id: string;
  status_before: RecordDto['status'];
  requested_status: RecordDto['status'];
  expected_revision_no: number;
  reason_code: string;
  reason_text: string | null;
  status: CorrectionRequestDto['status'];
  requested_by_user_id: string;
  requested_at: Date;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  applied_revision_no: number | null;
}

const REQUEST_SELECT = `
  SELECT id, attendance_record_id, class_session_id, student_id, status_before, requested_status, expected_revision_no,
         reason_code, reason_text, status, requested_by_user_id, requested_at, decided_by_user_id, decided_at,
         decision_note, applied_revision_no
    FROM app.attendance_correction_requests`;

const toRequestDto = (r: RequestRow): CorrectionRequestDto => ({
  id: r.id,
  attendanceRecordId: r.attendance_record_id,
  classSessionId: r.class_session_id,
  studentId: r.student_id,
  statusBefore: r.status_before,
  requestedStatus: r.requested_status,
  expectedRevisionNo: r.expected_revision_no,
  reasonCode: r.reason_code,
  reasonText: r.reason_text,
  status: r.status,
  requestedByUserId: r.requested_by_user_id,
  requestedAt: iso(r.requested_at),
  decidedByUserId: r.decided_by_user_id,
  decidedAt: r.decided_at ? iso(r.decided_at) : null,
  decisionNote: r.decision_note,
  appliedRevisionNo: r.applied_revision_no,
});

/** Every scope-bearing field comes from the database row, never from the request (doc 06 §3, X-12). */
const scopeOf = (r: SessionRow) => ({
  campus_id: r.campus_id,
  department_id: r.department_id,
  course_offering_id: r.course_offering_id,
  session_date: r.session_date,
});

/**
 * Attendance Slice 1 (doc 41). Reads of the scope are unlocked and re-verified under the session row lock where it
 * matters. Order in every method: staff actor, permission held at all (403), row exists, scoped assert (404 identical to
 * "missing"), then the mutation. A STUDENT actor never reaches a staff route (their own-records read is RLS-bounded and
 * has no route in this slice).
 */
export class AttendanceService {
  static async loadSession(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    lock: boolean | 'share' = false,
  ): Promise<SessionRow> {
    if (!isUuidV7(id)) throw invalid('Invalid session ID.');
    const res = await tx.query<SessionRow>(
      `${SESSION_SELECT} WHERE cs.organization_id = $1 AND cs.id = $2${lock === 'share' ? ' FOR SHARE OF cs' : lock ? ' FOR UPDATE OF cs' : ''}`,
      [ctx.tenantId, lower(id)],
    );
    const row = res.rows[0];
    if (!row) throw resourceNotFound();
    return row;
  }

  static async createSession(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateSessionBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    if (!input || typeof input !== 'object') throw invalid('Session payload is required.');
    if (!isUuidV7(input.courseOfferingId)) throw invalid('Invalid course offering ID.');
    if (input.timetableSlotId !== undefined && !isUuidV7(input.timetableSlotId))
      throw invalid('Invalid timetable slot ID.');
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()))
      throw invalid('startsAt and endsAt must be valid instants.');
    if (endsAt <= startsAt) throw invalid('endsAt must be after startsAt.');
    const offeringId = lower(input.courseOfferingId);
    const kind = input.kind ?? 'REGULAR';
    const slotId = input.timetableSlotId === undefined ? null : lower(input.timetableSlotId);
    const topic = input.topic?.trim() || null;

    await AuthorizationEngine.assert(tx, ctx, MARK);
    const off = await tx.query<{ campus_id: string; department_id: string }>(
      `SELECT campus_id, department_id FROM app.course_offerings WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, offeringId],
    );
    const offering = off.rows[0];
    if (!offering) throw resourceNotFound();
    await AuthorizationEngine.assert(tx, ctx, MARK, {
      organization_id: ctx.tenantId,
      campus_id: offering.campus_id,
      department_id: offering.department_id,
      course_offering_id: offeringId,
      session_date: input.sessionDate,
    });
    // The teacher of a session is the ACTOR's own employee row, never a request value.
    const emp = await tx.query<{ id: string }>(
      `SELECT id FROM app.employees WHERE organization_id = $1 AND user_id = $2`,
      [ctx.tenantId, ctx.userId],
    );
    const employeeId = emp.rows[0]?.id;
    if (!employeeId) throw resourceNotFound();

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: CREATE_SESSION_OPERATION,
        request: {
          courseOfferingId: offeringId,
          sessionDate: input.sessionDate,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          kind,
          timetableSlotId: slotId,
          topic,
        },
      },
      async () => {
        const id = uuidv7();
        try {
          await tx.query(
            `INSERT INTO app.class_sessions
               (id, organization_id, campus_id, course_offering_id, timetable_slot_id, conducted_by_employee_id,
                session_date, starts_at, ends_at, kind, topic)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              id,
              ctx.tenantId,
              offering.campus_id,
              offeringId,
              slotId,
              employeeId,
              input.sessionDate,
              startsAt.toISOString(),
              endsAt.toISOString(),
              kind,
              topic,
            ],
          );
        } catch (err) {
          mapSessionCreateError(err);
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'attendance.session.create',
            resourceType: 'class_session',
            resourceId: id,
            campusId: offering.campus_id,
            departmentId: offering.department_id,
            riskTier: 1,
            metadata: { courseOfferingId: offeringId, sessionDate: input.sessionDate, kind },
          },
          meta,
        );
        return { status: 201, body: { success: true, data: { id } } };
      },
    );
  }

  /**
   * First submission of a session's attendance: one record + revision 1 per rostered student, and the session moves to
   * SUBMITTED, in ONE transaction. The roster is the live registrations on the session date; the request must name
   * exactly those students (a partial or padded list is a 409, so the stored roster is always the snapshot of the day).
   * A second submission (another key, another request) finds the state SUBMITTED under the row lock and is a 409;
   * changing a submitted value is a correction (a later slice), never an overwrite.
   */
  static async submitAttendance(
    tx: TenantTx,
    ctx: TrustedContext,
    sessionId: string,
    input: SubmitAttendanceBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    if (!input || !Array.isArray(input.records) || input.records.length === 0)
      throw invalid('records are required.');
    const seen = new Set<string>();
    const records = input.records.map((r) => {
      if (!isUuidV7(r.studentId)) throw invalid('Invalid student ID.');
      const studentId = lower(r.studentId);
      if (seen.has(studentId)) throw invalid('A student appears more than once.');
      seen.add(studentId);
      return { studentId, status: r.status, remarks: r.remarks?.trim() || null };
    });
    records.sort((a, b) => (a.studentId < b.studentId ? -1 : 1));

    await AuthorizationEngine.assert(tx, ctx, MARK);
    const unlocked = await this.loadSession(tx, ctx, sessionId);
    await AuthorizationEngine.assert(tx, ctx, MARK, {
      organization_id: ctx.tenantId,
      ...scopeOf(unlocked),
    });

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: SUBMIT_ATTENDANCE_OPERATION,
        request: { sessionId: unlocked.id, records },
      },
      async () => {
        const session = await this.loadSession(tx, ctx, unlocked.id, true);
        if (session.status === 'CANCELLED') throw conflict('The session was cancelled.');
        if (session.attendance_state !== 'NOT_STARTED' && session.attendance_state !== 'OPEN')
          throw conflict('Attendance for this session was already submitted.');

        const roster = await tx.query<{ id: string; student_id: string }>(
          `SELECT r.id, r.student_id
             FROM app.course_registrations r
             JOIN app.course_offerings o ON o.organization_id = r.organization_id AND o.id = r.course_offering_id
             JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
            WHERE r.organization_id = $1 AND r.course_offering_id = $2
              AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED')
              AND r.valid_from <= $3::date AND COALESCE(r.valid_to, t.end_date) >= $3::date`,
          [ctx.tenantId, session.course_offering_id, session.session_date],
        );
        const registrationOf = new Map(roster.rows.map((r) => [r.student_id, r.id]));
        if (
          registrationOf.size !== records.length ||
          records.some((r) => !registrationOf.has(r.studentId))
        ) {
          throw conflict(
            `records must name exactly the ${registrationOf.size} students registered on the session date.`,
          );
        }

        const ids = records.map(() => uuidv7());
        const revisionIds = records.map(() => uuidv7());
        try {
          await tx.query(
            `INSERT INTO app.attendance_records
               (id, organization_id, class_session_id, student_id, course_registration_id, course_offering_id,
                session_date, status, source, marked_by_user_id, remarks)
             SELECT u.id, $1, $2, u.student_id, u.registration_id, $3, $4::date, u.status, 'MANUAL', $5, u.remarks
               FROM unnest($6::uuid[], $7::uuid[], $8::uuid[], $9::text[], $10::text[])
                    AS u(id, student_id, registration_id, status, remarks)`,
            [
              ctx.tenantId,
              session.id,
              session.course_offering_id,
              session.session_date,
              ctx.userId,
              ids,
              records.map((r) => r.studentId),
              records.map((r) => registrationOf.get(r.studentId)),
              records.map((r) => r.status),
              records.map((r) => r.remarks),
            ],
          );
          await tx.query(
            `INSERT INTO app.attendance_record_revisions
               (id, organization_id, attendance_record_id, revision_no, status_before, status_after, source,
                changed_by_user_id, reason_code, reason_text)
             SELECT u.id, $1, u.record_id, 1, NULL, u.status, 'MANUAL', $2, 'OTHER', $3
               FROM unnest($4::uuid[], $5::uuid[], $6::text[]) AS u(id, record_id, status)`,
            [
              ctx.tenantId,
              ctx.userId,
              INITIAL_REASON,
              revisionIds,
              ids,
              records.map((r) => r.status),
            ],
          );
          await tx.query(
            `UPDATE app.class_sessions
                SET status = 'CONDUCTED', attendance_state = 'SUBMITTED', attendance_submitted_at = now(),
                    attendance_submitted_by = $3
              WHERE organization_id = $1 AND id = $2`,
            [ctx.tenantId, session.id, ctx.userId],
          );
        } catch (err) {
          mapDbError(err, 'Attendance for this session was already submitted.');
        }

        const counts = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
        for (const r of records) counts[r.status] += 1;
        await recordAudit(
          tx,
          ctx,
          {
            action: 'attendance.session.submit',
            resourceType: 'class_session',
            resourceId: session.id,
            campusId: session.campus_id,
            departmentId: session.department_id,
            riskTier: 1,
            metadata: {
              courseOfferingId: session.course_offering_id,
              recordCount: records.length,
              counts,
            },
          },
          meta,
        );
        return {
          status: 201,
          body: {
            success: true,
            data: { sessionId: session.id, recordCount: records.length, counts },
          },
        };
      },
    );
  }

  // ---- Slice 4 helpers (doc 41 §12) -------------------------------------------------------------------------------------

  /** Approved defaults when no policy row exists (AD-2, AD-4): 3 calendar days, approval required beyond them. */
  private static async editWindowDays(
    tx: TenantTx,
    ctx: TrustedContext,
    campusId: string,
  ): Promise<number> {
    const r = await tx.query<{ edit_window_days: number }>(
      `SELECT edit_window_days FROM app.attendance_policies
        WHERE organization_id = $1 AND (campus_id = $2 OR campus_id IS NULL)
        ORDER BY campus_id NULLS LAST LIMIT 1`,
      [ctx.tenantId, campusId],
    );
    return r.rows[0]?.edit_window_days ?? DEFAULT_EDIT_WINDOW_DAYS;
  }

  /** Inside the faculty window? Calendar days between the campus-local today and the session date (AD-2); day N is still inside. */
  private static async insideWindow(
    tx: TenantTx,
    ctx: TrustedContext,
    s: SessionRow,
  ): Promise<boolean> {
    const days = await this.editWindowDays(tx, ctx, s.campus_id);
    const r = await tx.query<{ age: number }>(
      `SELECT ((now() AT TIME ZONE c.timezone)::date - $3::date) AS age
         FROM app.campuses c WHERE c.organization_id = $1 AND c.id = $2`,
      [ctx.tenantId, s.campus_id, s.session_date],
    );
    const age = r.rows[0]?.age;
    return age !== undefined && age <= days;
  }

  /** Does a GRANTED (institutional) grant, not an ASSIGNED one, cover this session? Only that path is "administrative". */
  private static async hasInstitutionalGrant(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: string,
    s: SessionRow,
  ): Promise<boolean> {
    const grants = await AuthorizationEngine.loadGrants(tx, ctx, permission);
    return grants.some(
      (g) =>
        g.scope_mode === 'GRANTED' &&
        (g.scope_type === 'ORGANIZATION' ||
          (g.scope_type === 'CAMPUS' && g.scope_id === s.campus_id) ||
          (g.scope_type === 'DEPARTMENT' && g.scope_id === s.department_id)),
    );
  }

  /**
   * Term and session limits shared by direct correction, correction requests and approval (doc 02 line 168):
   * LOCKED (term or session) changes nothing; CLOSED is for institutional authority only; the session must be SUBMITTED.
   */
  private static assertCorrectable(s: SessionRow, institutional: boolean): void {
    if (s.term_status === 'LOCKED' || s.attendance_state === 'LOCKED')
      throw coded(
        409,
        'SESSION_LOCKED',
        'The session is locked; its attendance can no longer be changed.',
      );
    if (s.term_status !== 'ACTIVE' && !(s.term_status === 'CLOSED' && institutional))
      throw coded(
        409,
        s.term_status === 'CLOSED' ? 'TERM_CLOSED' : 'TERM_NOT_OPEN',
        s.term_status === 'CLOSED'
          ? 'The term is CLOSED; only institutional authority may correct its attendance.'
          : 'Corrections are available only while the term is ACTIVE.',
      );
    if (s.attendance_state !== 'SUBMITTED')
      throw coded(
        409,
        'ATTENDANCE_NOT_SUBMITTED',
        'Attendance for this session has not been submitted.',
      );
  }

  /**
   * Record UPDATE + revision N+1 in the caller's transaction. A direct correction has the actor as changer; an approved
   * request has the requester as changer and the approver on the revision (the database refuses approver = changer).
   */
  private static async applyRevision(
    tx: TenantTx,
    ctx: TrustedContext,
    record: RecordRow,
    next: {
      status: RecordDto['status'];
      reasonCode: string;
      reasonText: string | null;
      changedBy: string;
      approvedBy?: string;
      requestId?: string;
    },
  ): Promise<number> {
    const no = record.revision_no + 1;
    try {
      await tx.query(
        `UPDATE app.attendance_records
            SET status = $3, source = 'CORRECTION', marked_by_user_id = $4, marked_at = now(), revision_no = $5
          WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, record.id, next.status, next.changedBy, no],
      );
      await tx.query(
        `INSERT INTO app.attendance_record_revisions
           (id, organization_id, attendance_record_id, revision_no, status_before, status_after, source,
            changed_by_user_id, reason_code, reason_text, approved_by_user_id, correction_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'CORRECTION', $7, $8, $9, $10, $11)`,
        [
          uuidv7(),
          ctx.tenantId,
          record.id,
          no,
          record.status,
          next.status,
          next.changedBy,
          next.reasonCode,
          next.reasonText,
          next.approvedBy ?? null,
          next.requestId ?? null,
        ],
      );
    } catch (err) {
      mapDbError(err, 'The record changed since it was read.');
    }
    return no;
  }

  /** Validated body parts shared by the direct correction and the request. */
  private static parseCorrection(input: CorrectRecordBody, recordId: string) {
    if (!input || typeof input !== 'object') throw invalid('Correction payload is required.');
    if (!isUuidV7(recordId)) throw invalid('Invalid record ID.');
    const reasonText = input.reasonText?.trim() || null;
    if (input.reasonCode === 'OTHER' && reasonText === null)
      throw invalid('reasonText is required when reasonCode is OTHER.');
    return { id: lower(recordId), reasonText };
  }

  /** The record's session, authorised for `permission` on the session's own scope (403 not held, 404 out of scope). */
  private static async authorisedRecordSession(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: string,
    id: string,
  ): Promise<SessionRow> {
    await AuthorizationEngine.assert(tx, ctx, permission);
    const found = await tx.query<{ class_session_id: string }>(
      `SELECT class_session_id FROM app.attendance_records WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, id],
    );
    if (!found.rows[0]) throw resourceNotFound();
    const session = await this.loadSession(tx, ctx, found.rows[0].class_session_id);
    await AuthorizationEngine.assert(tx, ctx, permission, {
      organization_id: ctx.tenantId,
      ...scopeOf(session),
    });
    return session;
  }

  private static async auditCorrection(
    tx: TenantTx,
    ctx: TrustedContext,
    meta: AuditRequestMeta,
    session: SessionRow,
    record: RecordRow,
    next: { status: string; reasonCode: string; reasonText: string | null; no: number },
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await recordAudit(
      tx,
      ctx,
      {
        action: 'attendance.record.correct',
        resourceType: 'attendance_record',
        resourceId: record.id,
        subjectStudentId: record.student_id,
        campusId: session.campus_id,
        departmentId: session.department_id,
        riskTier: 2,
        reasonCode: next.reasonCode,
        ...(next.reasonText ? { reasonText: next.reasonText } : {}),
        changes: {
          status: { old: record.status, new: next.status },
          revisionNo: { old: record.revision_no, new: next.no },
        },
        metadata: {
          courseOfferingId: session.course_offering_id,
          sessionDate: session.session_date,
          ...metadata,
        },
      },
      meta,
    );
  }

  /**
   * Direct correction of a submitted value INSIDE the faculty window (AD-1 to AD-3): record UPDATE + revision N+1 + tier-2
   * audit in ONE transaction, never an overwrite. Faculty need an ASSIGNED PRIMARY/CO_INSTRUCTOR assignment and an ACTIVE
   * term; HOD, campus and college administrators correct inside their scope, also in a CLOSED term. LOCKED (term or session)
   * is absolute. Outside the window (AD-4) this path is a 409 and the caller files a correction request instead.
   * `expectedRevisionNo` must be current, so two concurrent corrections cannot both win. Lock order: session (share) ->
   * record (update), the same direction as submission; cancel and lock take the session FOR UPDATE.
   */
  static async correctRecord(
    tx: TenantTx,
    ctx: TrustedContext,
    recordId: string,
    input: CorrectRecordBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const { id, reasonText } = this.parseCorrection(input, recordId);
    const unlocked = await this.authorisedRecordSession(tx, ctx, CORRECT, id);

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: CORRECT_RECORD_OPERATION,
        request: {
          recordId: id,
          status: input.status,
          expectedRevisionNo: input.expectedRevisionNo,
          reasonCode: input.reasonCode,
          reasonText,
        },
      },
      async () => {
        const session = await this.loadSession(tx, ctx, unlocked.id, 'share');
        const institutional = await this.hasInstitutionalGrant(tx, ctx, CORRECT, session);
        this.assertCorrectable(session, institutional);
        if (!(await this.insideWindow(tx, ctx, session)))
          throw coded(
            409,
            'CORRECTION_WINDOW_PASSED',
            'The faculty correction window has passed; submit a correction request for independent approval.',
          );

        const cur = await tx.query<RecordRow>(
          `${RECORD_SELECT} WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [ctx.tenantId, id],
        );
        const record = cur.rows[0];
        if (!record) throw resourceNotFound();
        if (record.revision_no !== input.expectedRevisionNo) {
          throw coded(
            409,
            'RECORD_CHANGED',
            `The record changed since it was read (current revision ${record.revision_no}).`,
          );
        }
        if (record.status === input.status)
          throw coded(409, 'NO_CHANGE', 'The record already has this status.');

        const next = await this.applyRevision(tx, ctx, record, {
          status: input.status,
          reasonCode: input.reasonCode,
          reasonText,
          changedBy: ctx.userId,
        });
        await this.auditCorrection(
          tx,
          ctx,
          meta,
          session,
          record,
          { status: input.status, reasonCode: input.reasonCode, reasonText, no: next },
          { path: institutional ? 'GRANTED' : 'ASSIGNED' },
        );
        await notifyStaff(
          tx,
          ctx,
          await conductorUserId(tx, ctx, session.conducted_by_employee_id),
          {
            title: 'Attendance corrected',
            body: `Attendance for ${session.offering_code} on ${session.session_date} was corrected.`,
            entityType: 'class_session',
            entityId: session.id,
          },
        );
        const after = await tx.query<RecordRow>(
          `${RECORD_SELECT} WHERE organization_id = $1 AND id = $2`,
          [ctx.tenantId, id],
        );
        return { status: 200, body: { success: true, data: toRecordDto(after.rows[0]!) } };
      },
    );
  }

  private static async loadRequest(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    lock = false,
  ): Promise<RequestRow> {
    if (!isUuidV7(id)) throw invalid('Invalid correction request ID.');
    const r = await tx.query<RequestRow>(
      `${REQUEST_SELECT} WHERE organization_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
      [ctx.tenantId, lower(id)],
    );
    if (!r.rows[0]) throw resourceNotFound();
    return r.rows[0];
  }

  /**
   * AD-4: a correction OUTSIDE the faculty window is a request. Same authority as a direct correction to ask; it changes
   * nothing until a different, independently authorised person approves it. One open request per record.
   */
  static async requestCorrection(
    tx: TenantTx,
    ctx: TrustedContext,
    recordId: string,
    input: CorrectRecordBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const { id, reasonText } = this.parseCorrection(input, recordId);
    const unlocked = await this.authorisedRecordSession(tx, ctx, CORRECT, id);

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: REQUEST_CORRECTION_OPERATION,
        request: {
          recordId: id,
          status: input.status,
          expectedRevisionNo: input.expectedRevisionNo,
          reasonCode: input.reasonCode,
          reasonText,
        },
      },
      async () => {
        const session = await this.loadSession(tx, ctx, unlocked.id, 'share');
        const institutional = await this.hasInstitutionalGrant(tx, ctx, CORRECT, session);
        this.assertCorrectable(session, institutional);
        if (await this.insideWindow(tx, ctx, session))
          throw coded(
            409,
            'CORRECTION_WINDOW_OPEN',
            'The session is inside the faculty window; correct the record directly.',
          );

        const cur = await tx.query<RecordRow>(
          `${RECORD_SELECT} WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [ctx.tenantId, id],
        );
        const record = cur.rows[0];
        if (!record) throw resourceNotFound();
        if (record.revision_no !== input.expectedRevisionNo)
          throw coded(
            409,
            'RECORD_CHANGED',
            `The record changed since it was read (current revision ${record.revision_no}).`,
          );
        if (record.status === input.status)
          throw coded(409, 'NO_CHANGE', 'The record already has this status.');

        const requestId = uuidv7();
        try {
          await tx.query(
            `INSERT INTO app.attendance_correction_requests
               (id, organization_id, attendance_record_id, class_session_id, student_id, status_before, requested_status,
                expected_revision_no, reason_code, reason_text, requested_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              requestId,
              ctx.tenantId,
              id,
              session.id,
              record.student_id,
              record.status,
              input.status,
              record.revision_no,
              input.reasonCode,
              reasonText,
              ctx.userId,
            ],
          );
        } catch (err) {
          mapDbError(err, 'A correction request is already pending for this record.');
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'attendance.correction.request',
            resourceType: 'attendance_correction_request',
            resourceId: requestId,
            subjectStudentId: record.student_id,
            campusId: session.campus_id,
            departmentId: session.department_id,
            riskTier: 2,
            reasonCode: input.reasonCode,
            ...(reasonText ? { reasonText } : {}),
            changes: { status: { old: record.status, new: input.status } },
            metadata: {
              attendanceRecordId: id,
              courseOfferingId: session.course_offering_id,
              sessionDate: session.session_date,
            },
          },
          meta,
        );
        await notifyStaff(
          tx,
          ctx,
          await approverIds(tx, ctx, session.campus_id, session.department_id),
          {
            title: 'Attendance correction awaiting review',
            body: `A correction request for ${session.offering_code} on ${session.session_date} awaits review.`,
            entityType: 'attendance_correction_request',
            entityId: requestId,
          },
        );
        const created = await this.loadRequest(tx, ctx, requestId);
        return { status: 201, body: { success: true, data: toRequestDto(created) } };
      },
    );
  }

  /** The requests a decider may see: those whose session lies inside one of their approve grants. */
  static async listCorrectionRequests(
    tx: TenantTx,
    ctx: TrustedContext,
    query: ListCorrectionRequestsQuery,
  ): Promise<CorrectionRequestDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, APPROVE);
    const grants = await AuthorizationEngine.loadGrants(tx, ctx, APPROVE);
    const org = grants.some((g) => g.scope_mode === 'GRANTED' && g.scope_type === 'ORGANIZATION');
    const campuses = grants
      .filter((g) => g.scope_mode === 'GRANTED' && g.scope_type === 'CAMPUS' && g.scope_id)
      .map((g) => g.scope_id);
    const departments = grants
      .filter((g) => g.scope_mode === 'GRANTED' && g.scope_type === 'DEPARTMENT' && g.scope_id)
      .map((g) => g.scope_id);
    const res = await tx.query<RequestRow>(
      `SELECT r.id, r.attendance_record_id, r.class_session_id, r.student_id, r.status_before, r.requested_status,
              r.expected_revision_no, r.reason_code, r.reason_text, r.status, r.requested_by_user_id, r.requested_at,
              r.decided_by_user_id, r.decided_at, r.decision_note, r.applied_revision_no
         FROM app.attendance_correction_requests r
        JOIN app.class_sessions cs ON cs.organization_id = r.organization_id AND cs.id = r.class_session_id
        JOIN app.course_offerings o ON o.organization_id = cs.organization_id AND o.id = cs.course_offering_id
       WHERE r.organization_id = $1 AND ($2::text IS NULL OR r.status = $2)
         AND ($3::boolean OR o.campus_id = ANY($4::uuid[]) OR o.department_id = ANY($5::uuid[]))
       ORDER BY r.requested_at DESC, r.id DESC LIMIT 200`,
      [ctx.tenantId, query.status ?? null, org, campuses, departments],
    );
    return res.rows.map(toRequestDto);
  }

  /**
   * Approve or reject a request (AD-4). Authority: attendance.correction.approve on the session's scope; the requester can
   * never decide their own request (403, and the database refuses it too). Approval re-checks everything a direct
   * correction checks (not locked, term, submitted, revision unchanged) under row locks and writes the revision, the
   * decision and the audit in one transaction. A rejected or approved request never changes again.
   */
  static async decideRequest(
    tx: TenantTx,
    ctx: TrustedContext,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    input: DecideRequestBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const note = input?.note?.trim() || null;
    if (decision === 'REJECT' && note === null) throw invalid('note is required when rejecting.');

    await AuthorizationEngine.assert(tx, ctx, APPROVE);
    const probe = await this.loadRequest(tx, ctx, requestId);
    const unlocked = await this.loadSession(tx, ctx, probe.class_session_id);
    await AuthorizationEngine.assert(tx, ctx, APPROVE, {
      organization_id: ctx.tenantId,
      ...scopeOf(unlocked),
    });
    if (probe.requested_by_user_id === ctx.userId)
      throw new AppError(403, 'FORBIDDEN', 'You cannot decide your own correction request.');

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: `POST /api/v1/attendance/correction-requests/:id/${decision === 'APPROVE' ? 'approve' : 'reject'}`,
        request: { requestId: probe.id, note },
      },
      async () => {
        const session = await this.loadSession(tx, ctx, unlocked.id, 'share');
        const req = await this.loadRequest(tx, ctx, probe.id, true);
        if (req.status !== 'PENDING') throw conflict(`The request was already ${req.status}.`);

        let applied: number | null = null;
        if (decision === 'APPROVE') {
          this.assertCorrectable(session, true); // the approver is institutional by construction
          const cur = await tx.query<RecordRow>(
            `${RECORD_SELECT} WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
            [ctx.tenantId, req.attendance_record_id],
          );
          const record = cur.rows[0];
          if (!record) throw resourceNotFound();
          if (
            record.revision_no !== req.expected_revision_no ||
            record.status !== req.status_before
          )
            throw conflict(
              'The record changed since the request was made; reject this request and file a new one.',
            );
          applied = await this.applyRevision(tx, ctx, record, {
            status: req.requested_status,
            reasonCode: req.reason_code,
            reasonText: req.reason_text,
            changedBy: req.requested_by_user_id,
            approvedBy: ctx.userId,
            requestId: req.id,
          });
          await this.auditCorrection(
            tx,
            ctx,
            meta,
            session,
            record,
            {
              status: req.requested_status,
              reasonCode: req.reason_code,
              reasonText: req.reason_text,
              no: applied,
            },
            {
              path: 'APPROVED_REQUEST',
              correctionRequestId: req.id,
              requestedBy: req.requested_by_user_id,
            },
          );
        }
        try {
          await tx.query(
            `UPDATE app.attendance_correction_requests
                SET status = $3, decided_by_user_id = $4, decided_at = now(), decision_note = $5, applied_revision_no = $6
              WHERE organization_id = $1 AND id = $2 AND status = 'PENDING'`,
            [
              ctx.tenantId,
              req.id,
              decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
              ctx.userId,
              note,
              applied,
            ],
          );
        } catch (err) {
          mapDbError(err, 'The request was already decided.');
        }
        await recordAudit(
          tx,
          ctx,
          {
            action:
              decision === 'APPROVE'
                ? 'attendance.correction.approve'
                : 'attendance.correction.reject',
            resourceType: 'attendance_correction_request',
            resourceId: req.id,
            subjectStudentId: req.student_id,
            campusId: session.campus_id,
            departmentId: session.department_id,
            riskTier: 2,
            ...(note ? { reasonText: note } : {}),
            metadata: {
              attendanceRecordId: req.attendance_record_id,
              requestedBy: req.requested_by_user_id,
              ...(applied !== null ? { appliedRevisionNo: applied } : {}),
            },
          },
          meta,
        );
        await notifyStaff(tx, ctx, [req.requested_by_user_id], {
          title: `Attendance correction ${decision === 'APPROVE' ? 'approved' : 'rejected'}`,
          body: `Your correction request for ${session.offering_code} on ${session.session_date} was ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`,
          entityType: 'attendance_correction_request',
          entityId: req.id,
        });
        const done = await this.loadRequest(tx, ctx, req.id);
        return { status: 200, body: { success: true, data: toRequestDto(done) } };
      },
    );
  }

  /**
   * AD-5/AD-6: an authorised administrator locks a SUBMITTED session. Tier-3 audit with a mandatory reason. There is no
   * unlock: LOCKED is terminal (the 0040 guard makes the session and its records read-only for every writer).
   */
  static async lockSession(
    tx: TenantTx,
    ctx: TrustedContext,
    sessionId: string,
    input: LockSessionBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500)
      throw invalid('reason must be 5 to 500 characters.');

    await AuthorizationEngine.assert(tx, ctx, LOCK);
    const unlocked = await this.loadSession(tx, ctx, sessionId);
    await AuthorizationEngine.assert(tx, ctx, LOCK, {
      organization_id: ctx.tenantId,
      ...scopeOf(unlocked),
    });

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    return runIdempotent(
      tx,
      ctx,
      { key, operation: LOCK_SESSION_OPERATION, request: { sessionId: unlocked.id, reason } },
      async () => {
        const session = await this.loadSession(tx, ctx, unlocked.id, true);
        if (session.attendance_state === 'LOCKED') throw conflict('The session is already locked.');
        if (session.attendance_state !== 'SUBMITTED')
          throw conflict('Only a session with submitted attendance can be locked.');
        try {
          await tx.query(
            `UPDATE app.class_sessions
                SET attendance_state = 'LOCKED', locked_at = now(), locked_by_user_id = $3, lock_reason = $4
              WHERE organization_id = $1 AND id = $2`,
            [ctx.tenantId, session.id, ctx.userId, reason],
          );
        } catch (err) {
          mapDbError(err, 'The session could not be locked.');
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'attendance.session.lock',
            resourceType: 'class_session',
            resourceId: session.id,
            campusId: session.campus_id,
            departmentId: session.department_id,
            riskTier: 3,
            reasonText: reason,
            changes: { attendanceState: { old: 'SUBMITTED', new: 'LOCKED' } },
            metadata: {
              courseOfferingId: session.course_offering_id,
              sessionDate: session.session_date,
            },
          },
          meta,
        );
        await notifyStaff(
          tx,
          ctx,
          await conductorUserId(tx, ctx, session.conducted_by_employee_id),
          {
            title: 'Attendance session locked',
            body: `Attendance for ${session.offering_code} on ${session.session_date} was locked.`,
            entityType: 'class_session',
            entityId: session.id,
          },
        );
        const after = await this.loadSession(tx, ctx, session.id);
        return { status: 200, body: { success: true, data: toSessionDto(after) } };
      },
    );
  }

  /**
   * Cancel a session that has not taken attendance: SCHEDULED -> CANCELLED with a reason (doc 01 §3.7 lifecycle).
   * AD-7: the assigned faculty member who conducts the session may cancel it (attendance.session.mark, own session, ACTIVE
   * term); administrative cancellation is the separate attendance.session.cancel permission (GRANTED scope, ACTIVE or CLOSED
   * term). A conducted session cannot be cancelled by anyone; its attendance changes only by correction. Tier-2 audit (AD-9).
   */
  static async cancelSession(
    tx: TenantTx,
    ctx: TrustedContext,
    sessionId: string,
    input: CancelSessionBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500)
      throw invalid('reason must be 5 to 500 characters.');

    const administrative = await AuthorizationEngine.hasPermission(tx, ctx, CANCEL);
    const permission = administrative ? CANCEL : MARK;
    await AuthorizationEngine.assert(tx, ctx, permission);
    const unlocked = await this.loadSession(tx, ctx, sessionId);
    await AuthorizationEngine.assert(tx, ctx, permission, {
      organization_id: ctx.tenantId,
      ...scopeOf(unlocked),
    });
    if (!administrative) {
      // "their own": the session's conducting employee is the actor's own employee row, never a request value
      const own = await tx.query(
        `SELECT 1 FROM app.employees WHERE organization_id = $1 AND id = $2 AND user_id = $3`,
        [ctx.tenantId, unlocked.conducted_by_employee_id, ctx.userId],
      );
      if ((own.rowCount ?? 0) === 0) throw resourceNotFound();
    }

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    return runIdempotent(
      tx,
      ctx,
      { key, operation: CANCEL_SESSION_OPERATION, request: { sessionId: unlocked.id, reason } },
      async () => {
        const session = await this.loadSession(tx, ctx, unlocked.id, true);
        if (session.status === 'CANCELLED') throw conflict('The session is already cancelled.');
        if (
          session.status !== 'SCHEDULED' ||
          !['NOT_STARTED', 'OPEN'].includes(session.attendance_state)
        )
          throw conflict(
            'Attendance was already submitted; a conducted session cannot be cancelled.',
          );
        if (
          session.term_status !== 'ACTIVE' &&
          !(administrative && session.term_status === 'CLOSED')
        )
          throw conflict('The term is not open for this cancellation.');
        try {
          await tx.query(
            `UPDATE app.class_sessions SET status = 'CANCELLED', cancel_reason = $3
              WHERE organization_id = $1 AND id = $2`,
            [ctx.tenantId, session.id, reason],
          );
        } catch (err) {
          mapDbError(err, 'The session could not be cancelled.');
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'attendance.session.cancel',
            resourceType: 'class_session',
            resourceId: session.id,
            campusId: session.campus_id,
            departmentId: session.department_id,
            riskTier: 2,
            reasonText: reason,
            changes: { status: { old: 'SCHEDULED', new: 'CANCELLED' } },
            metadata: {
              courseOfferingId: session.course_offering_id,
              sessionDate: session.session_date,
              path: administrative ? 'GRANTED' : 'ASSIGNED',
            },
          },
          meta,
        );
        if (administrative)
          await notifyStaff(
            tx,
            ctx,
            await conductorUserId(tx, ctx, session.conducted_by_employee_id),
            {
              title: 'Class session cancelled',
              body: `The ${session.offering_code} session on ${session.session_date} was cancelled by an administrator.`,
              entityType: 'class_session',
              entityId: session.id,
            },
          );
        const after = await this.loadSession(tx, ctx, session.id);
        return { status: 200, body: { success: true, data: toSessionDto(after) } };
      },
    );
  }

  /**
   * The signed-in STUDENT's own student id, proved through the SELF branch of the engine (attendance.record.read, doc 03
   * line 41). Staff accounts are refused: these routes are the student's view, and a staff user is never a stand-in for one.
   * No request value selects the student; the id comes from the session's user.
   */
  private static async ownStudentId(tx: TenantTx, ctx: TrustedContext): Promise<string> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStudentActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ);
    const own = await tx.query<{ id: string }>(
      `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
      [ctx.tenantId, ctx.userId],
    );
    const id = own.rows[0]?.id;
    if (!id) throw resourceNotFound();
    await AuthorizationEngine.assert(tx, ctx, READ, {
      organization_id: ctx.tenantId,
      student_id: id,
    });
    return id;
  }

  /**
   * The student's own session-wise attendance, newest first (doc 03 line 237 `get_my_attendance_by_course`). Only the
   * student's own rows are ever selected (the WHERE names the student and the database policy backs it up). Current values
   * only: no revision history, remarks or marker. Dates are campus-local session dates.
   */
  static async listMyRecords(
    tx: TenantTx,
    ctx: TrustedContext,
    query: MyRecordsQuery,
  ): Promise<{ data: MyRecordDto[]; hasMore: boolean }> {
    const studentId = await this.ownStudentId(tx, ctx);
    if (query.courseOfferingId !== undefined && !isUuidV7(query.courseOfferingId))
      throw invalid('Invalid course offering ID.');
    if (query.from !== undefined && query.to !== undefined && query.from > query.to)
      throw invalid('from must not be after to.');
    const limit = query.limit ?? 100;
    const params: unknown[] = [ctx.tenantId, studentId];
    let where = '';
    if (query.courseOfferingId !== undefined) {
      params.push(lower(query.courseOfferingId));
      where += ` AND ar.course_offering_id = $${params.length}`;
    }
    if (query.from !== undefined) {
      params.push(query.from);
      where += ` AND ar.session_date >= $${params.length}::date`;
    }
    if (query.to !== undefined) {
      params.push(query.to);
      where += ` AND ar.session_date <= $${params.length}::date`;
    }
    params.push(limit + 1);
    const res = await tx.query<{
      class_session_id: string;
      course_offering_id: string;
      code_snapshot: string;
      title_snapshot: string;
      session_date: string;
      starts_at: Date;
      kind: MyRecordDto['kind'];
      status: MyRecordDto['status'];
    }>(
      `SELECT ar.class_session_id, ar.course_offering_id, o.code_snapshot, o.title_snapshot,
              ar.session_date::text AS session_date, cs.starts_at, cs.kind, ar.status
         FROM app.attendance_records ar
         JOIN app.class_sessions cs ON cs.organization_id = ar.organization_id AND cs.id = ar.class_session_id
         JOIN app.course_offerings o ON o.organization_id = ar.organization_id AND o.id = ar.course_offering_id
        WHERE ar.organization_id = $1 AND ar.student_id = $2${where}
        ORDER BY ar.session_date DESC, cs.starts_at DESC, ar.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const rows = res.rows.slice(0, limit);
    return {
      hasMore: res.rows.length > limit,
      data: rows.map((r) => ({
        classSessionId: r.class_session_id,
        courseOfferingId: r.course_offering_id,
        courseCode: r.code_snapshot,
        courseTitle: r.title_snapshot,
        sessionDate: r.session_date,
        startsAt: iso(r.starts_at),
        kind: r.kind,
        status: r.status,
      })),
    };
  }

  /**
   * The student's own per-offering counts (doc 02 `attendance_summaries`: held, present, late, excused, absent). Counts
   * only, taken from the current value of each record. NO percentage, warning level or eligibility is computed: those need
   * the attendance policy (status weights, minimum percentage), which is owner decision R-3 / AD-2 to AD-4 and is not built.
   */
  static async mySummary(
    tx: TenantTx,
    ctx: TrustedContext,
    query: MyOfferingQuery,
  ): Promise<MySummaryDto> {
    const studentId = await this.ownStudentId(tx, ctx);
    if (query.courseOfferingId !== undefined && !isUuidV7(query.courseOfferingId))
      throw invalid('Invalid course offering ID.');
    const params: unknown[] = [ctx.tenantId, studentId];
    let where = '';
    if (query.courseOfferingId !== undefined) {
      params.push(lower(query.courseOfferingId));
      where = ` AND ar.course_offering_id = $${params.length}`;
    }
    const res = await tx.query<{
      course_offering_id: string;
      code_snapshot: string;
      title_snapshot: string;
      present: string;
      late: string;
      excused: string;
      absent: string;
    }>(
      `SELECT ar.course_offering_id, o.code_snapshot, o.title_snapshot,
              count(*) FILTER (WHERE ar.status = 'PRESENT') AS present,
              count(*) FILTER (WHERE ar.status = 'LATE') AS late,
              count(*) FILTER (WHERE ar.status = 'EXCUSED') AS excused,
              count(*) FILTER (WHERE ar.status = 'ABSENT') AS absent
         FROM app.attendance_records ar
         JOIN app.course_offerings o ON o.organization_id = ar.organization_id AND o.id = ar.course_offering_id
        WHERE ar.organization_id = $1 AND ar.student_id = $2${where}
        GROUP BY ar.course_offering_id, o.code_snapshot, o.title_snapshot
        ORDER BY o.code_snapshot, ar.course_offering_id`,
      params,
    );
    const totals = { held: 0, present: 0, late: 0, excused: 0, absent: 0 };
    const offerings = res.rows.map((r) => {
      const present = Number(r.present);
      const late = Number(r.late);
      const excused = Number(r.excused);
      const absent = Number(r.absent);
      const held = present + late + excused + absent;
      totals.held += held;
      totals.present += present;
      totals.late += late;
      totals.excused += excused;
      totals.absent += absent;
      return {
        courseOfferingId: r.course_offering_id,
        courseCode: r.code_snapshot,
        courseTitle: r.title_snapshot,
        held,
        present,
        late,
        excused,
        absent,
      };
    });
    return { offerings, totals };
  }

  static async getSession(tx: TenantTx, ctx: TrustedContext, id: string): Promise<SessionDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ);
    const row = await this.loadSession(tx, ctx, id);
    await AuthorizationEngine.assert(tx, ctx, READ, {
      organization_id: ctx.tenantId,
      ...scopeOf(row),
    });
    return toSessionDto(row);
  }

  static async listRecords(
    tx: TenantTx,
    ctx: TrustedContext,
    sessionId: string,
  ): Promise<RecordDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ);
    const row = await this.loadSession(tx, ctx, sessionId);
    await AuthorizationEngine.assert(tx, ctx, READ, {
      organization_id: ctx.tenantId,
      ...scopeOf(row),
    });
    const res = await tx.query<RecordRow>(
      `${RECORD_SELECT} WHERE organization_id = $1 AND class_session_id = $2 ORDER BY student_id`,
      [ctx.tenantId, row.id],
    );
    return res.rows.map(toRecordDto);
  }

  /** Full, ordered revision history of one record (doc 04 M4 "Done": a disputed record shows its whole history). */
  static async listRevisions(
    tx: TenantTx,
    ctx: TrustedContext,
    recordId: string,
  ): Promise<RevisionDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    if (!isUuidV7(recordId)) throw invalid('Invalid record ID.');
    await AuthorizationEngine.assert(tx, ctx, READ);
    const rec = await tx.query<{ class_session_id: string }>(
      `SELECT class_session_id FROM app.attendance_records WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(recordId)],
    );
    if (!rec.rows[0]) throw resourceNotFound();
    const row = await this.loadSession(tx, ctx, rec.rows[0].class_session_id);
    await AuthorizationEngine.assert(tx, ctx, READ, {
      organization_id: ctx.tenantId,
      ...scopeOf(row),
    });
    const res = await tx.query<{
      revision_no: number;
      status_before: RevisionDto['statusBefore'];
      status_after: RevisionDto['statusAfter'];
      source: string;
      changed_by_user_id: string;
      changed_at: Date;
      reason_code: string;
      reason_text: string | null;
    }>(
      `SELECT revision_no, status_before, status_after, source, changed_by_user_id, changed_at, reason_code, reason_text
         FROM app.attendance_record_revisions WHERE organization_id = $1 AND attendance_record_id = $2
        ORDER BY revision_no`,
      [ctx.tenantId, lower(recordId)],
    );
    return res.rows.map((r) => ({
      revisionNo: r.revision_no,
      statusBefore: r.status_before,
      statusAfter: r.status_after,
      source: r.source,
      changedByUserId: r.changed_by_user_id,
      changedAt: iso(r.changed_at),
      reasonCode: r.reason_code,
      reasonText: r.reason_text,
    }));
  }

  /** Assigned offerings for the authenticated faculty member. */
  static async listMyOfferings(tx: TenantTx, ctx: TrustedContext): Promise<MyOfferingItemDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, MARK);

    const emp = await tx.query<{ id: string }>(
      `SELECT id FROM app.employees WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [ctx.tenantId, ctx.userId],
    );
    const employeeId = emp.rows[0]?.id;
    if (!employeeId) return [];

    const res = await tx.query<{
      id: string;
      code_snapshot: string;
      title_snapshot: string;
      group_label: string | null;
      status: string;
      term_id: string;
      term_name: string;
      teaching_role: string;
      valid_from: string;
      valid_to: string | null;
      campus_id: string;
      campus_timezone: string;
      campus_today: string;
    }>(
      `SELECT o.id, o.code_snapshot, o.title_snapshot, o.group_label, o.status,
              t.id AS term_id, t.name AS term_name,
              fa."role" AS teaching_role, fa.valid_from::text, fa.valid_to::text,
              c.id AS campus_id, c.timezone AS campus_timezone, ((now() AT TIME ZONE c.timezone)::date)::text AS campus_today
         FROM app.faculty_assignments fa
         JOIN app.course_offerings o ON o.organization_id = fa.organization_id AND o.id = fa.course_offering_id
         JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
         JOIN app.campuses c ON c.organization_id = o.organization_id AND c.id = o.campus_id
        WHERE fa.organization_id = $1 AND fa.employee_id = $2
          AND o.status IN ('PUBLISHED', 'CLOSED')
        ORDER BY o.code_snapshot, o.group_label NULLS FIRST, o.id`,
      [ctx.tenantId, employeeId],
    );

    return res.rows.map((r) => ({
      id: r.id,
      codeSnapshot: r.code_snapshot,
      titleSnapshot: r.title_snapshot,
      groupLabel: r.group_label,
      status: r.status,
      termId: r.term_id,
      termName: r.term_name,
      teachingRole: r.teaching_role,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      campusId: r.campus_id,
      campusTimezone: r.campus_timezone,
      campusToday: r.campus_today,
    }));
  }

  /**
   * Campuses whose attendance the caller may read through an institutional (GRANTED) grant, each with its clock. Read-only,
   * derived from the same grants `attendance.record.read` is judged by; assigned faculty get theirs from `my-offerings`.
   */
  static async listReadableCampuses(tx: TenantTx, ctx: TrustedContext): Promise<CampusClockDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ);
    const grants = (await AuthorizationEngine.loadGrants(tx, ctx, READ)).filter(
      (g) => g.scope_mode === 'GRANTED',
    );
    const org = grants.some((g) => g.scope_type === 'ORGANIZATION');
    const campusIds = grants
      .filter((g) => g.scope_type === 'CAMPUS' && g.scope_id)
      .map((g) => g.scope_id);
    const deptIds = grants
      .filter((g) => g.scope_type === 'DEPARTMENT' && g.scope_id)
      .map((g) => g.scope_id);
    if (!org && campusIds.length === 0 && deptIds.length === 0) return [];
    const res = await tx.query<{ id: string; name: string; timezone: string; today: string }>(
      `SELECT c.id, c.name, c.timezone, ((now() AT TIME ZONE c.timezone)::date)::text AS today
         FROM app.campuses c
        WHERE c.organization_id = $1 AND c.status = 'ACTIVE'
          AND ($2::boolean OR c.id = ANY($3::uuid[])
               OR c.id IN (SELECT d.campus_id FROM app.departments d WHERE d.organization_id = $1 AND d.id = ANY($4::uuid[])))
        ORDER BY c.name, c.id`,
      [ctx.tenantId, org, campusIds, deptIds],
    );
    return res.rows;
  }

  /** Staff session search with aggregate attendance counts, filtered to authorized scope. */
  static async listSessions(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListSessionsQuery = {},
  ): Promise<SessionDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ);

    const where: string[] = ['cs.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (filter.courseOfferingId) {
      if (!isUuidV7(filter.courseOfferingId)) throw invalid('Invalid course offering ID.');
      params.push(lower(filter.courseOfferingId));
      where.push(`cs.course_offering_id = $${params.length}`);
    }
    if (filter.sessionDate) {
      params.push(filter.sessionDate);
      where.push(`cs.session_date = $${params.length}::date`);
    }
    if (filter.from) {
      params.push(filter.from);
      where.push(`cs.session_date >= $${params.length}::date`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`cs.session_date <= $${params.length}::date`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`cs.status = $${params.length}`);
    }
    if (filter.attendanceState) {
      params.push(filter.attendanceState);
      where.push(`cs.attendance_state = $${params.length}`);
    }

    const limit = filter.limit ?? 50;
    params.push(limit);
    const limitClause = `LIMIT $${params.length}`;

    const res = await tx.query<SessionRow>(
      `${SESSION_SELECT} WHERE ${where.join(' AND ')}
       ORDER BY cs.session_date DESC, cs.starts_at DESC, cs.id DESC
       ${limitClause}`,
      params,
    );

    const sessionIds = res.rows.map((r) => r.id);
    const countsMap = new Map<
      string,
      { present: number; absent: number; late: number; excused: number; total: number }
    >();

    if (sessionIds.length > 0) {
      const countsRes = await tx.query<{
        class_session_id: string;
        status: string;
        cnt: string;
      }>(
        `SELECT class_session_id, status, count(*)::text AS cnt
           FROM app.attendance_records
          WHERE organization_id = $1 AND class_session_id = ANY($2::uuid[])
          GROUP BY class_session_id, status`,
        [ctx.tenantId, sessionIds],
      );
      for (const row of countsRes.rows) {
        let entry = countsMap.get(row.class_session_id);
        if (!entry) {
          entry = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
          countsMap.set(row.class_session_id, entry);
        }
        const countNum = parseInt(row.cnt, 10) || 0;
        if (row.status === 'PRESENT') entry.present += countNum;
        else if (row.status === 'ABSENT') entry.absent += countNum;
        else if (row.status === 'LATE') entry.late += countNum;
        else if (row.status === 'EXCUSED') entry.excused += countNum;
        entry.total += countNum;
      }
    }

    const authorized: SessionDto[] = [];
    for (const row of res.rows) {
      try {
        await AuthorizationEngine.assert(tx, ctx, READ, {
          organization_id: ctx.tenantId,
          ...scopeOf(row),
        });
        authorized.push(toSessionDto(row, countsMap.get(row.id)));
      } catch (err) {
        if (err instanceof AppError && (err.statusCode === 403 || err.statusCode === 404)) continue;
        throw err;
      }
    }
    return authorized;
  }

  /** Permitted student roster for session marking/inspection. */
  static async getSessionRoster(
    tx: TenantTx,
    ctx: TrustedContext,
    sessionId: string,
  ): Promise<SessionRosterItem[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ);
    const session = await this.loadSession(tx, ctx, sessionId);
    await AuthorizationEngine.assert(tx, ctx, READ, {
      organization_id: ctx.tenantId,
      ...scopeOf(session),
    });

    const res = await tx.query<{
      student_id: string;
      admission_number: string;
      display_name: string;
      roll_number: string | null;
    }>(
      `SELECT s.id AS student_id,
              s.admission_number,
              u.display_name,
              te.roll_number
         FROM app.course_registrations r
         JOIN app.students s ON s.organization_id = r.organization_id AND s.id = r.student_id
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
         JOIN app.term_enrollments te ON te.organization_id = r.organization_id AND te.id = r.term_enrollment_id
         JOIN app.course_offerings o ON o.organization_id = r.organization_id AND o.id = r.course_offering_id
         JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
        WHERE r.organization_id = $1 AND r.course_offering_id = $2
          AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED')
          AND r.valid_from <= $3::date AND COALESCE(r.valid_to, t.end_date) >= $3::date
        ORDER BY te.roll_number NULLS LAST, s.admission_number, u.display_name`,
      [ctx.tenantId, session.course_offering_id, session.session_date],
    );

    return res.rows.map((r) => ({
      studentId: r.student_id,
      admissionNumber: r.admission_number,
      displayName: r.display_name,
      rollNumber: r.roll_number,
    }));
  }
}
