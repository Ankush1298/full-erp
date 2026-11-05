import { AppError } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { invalid, parseDate } from '../people/validation.js';
import { StudentService } from './student.service.js';
import { READ as ENROLLMENT_READ } from './term-enrollment.service.js';
import type {
  StudentStatus,
  StudentTimelineDto,
  TimelineEventDto,
  TimelineEventType,
  TimelineLimitationDto,
  TimelinePositionTermDto,
} from './student.schemas.js';

/**
 * Student academic timeline and as-of-date position (M3 Part 16 "student timeline"; doc 34). READ-ONLY and DERIVED:
 * every event is computed from the authoritative rows (students, student_programs, term_enrollments,
 * section_memberships, course_registrations); there is no event store. Valid-time semantics (doc 02 §5.4): a record is
 * in effect on D when its effective span covers D, inclusive at both ends; a term enrolment has no effective dates of
 * its own and takes its term's span. Nothing is dated that the schema does not date: term-enrolment outcomes
 * (PROMOTED, DETAINED, ...) carry no date and are returned undated; only the LATEST student status change is dated
 * (audit_events is not readable by the runtime role), so the status before it is reported unknown.
 *
 * Authorization: the profile gate is exactly `StudentService.getById` (SELF, campus/department by the ACTIVE enrolment,
 * FACULTY ASSIGNED, one 404 for missing / other-tenant / out-of-scope). Academic rows are additionally filtered per
 * programme enrolment by `enrollment.term.read` against that enrolment's frozen campus/department, the same rule as
 * `TermEnrollmentService.listForStudent`, so a department-scoped holder never sees another department's history and a
 * holder without the permission (FACULTY) sees the profile-level events only.
 */

interface StudentRow {
  admission_date: string | null;
  status: string;
  status_changed_on: string | null;
  tz: string;
  today: string;
}
interface ProgramRow {
  id: string;
  program_id: string;
  program_name: string;
  program_code: string;
  cohort_id: string;
  cohort_name: string;
  campus_id: string;
  department_id: string;
  start_date: string;
  end_date: string | null;
  status: string;
  entry_type: string;
  exit_reason: string | null;
}
interface EnrollmentRow {
  id: string;
  student_program_id: string;
  term_id: string;
  term_code: string;
  term_name: string;
  term_start: string;
  term_end: string;
  /** effective span: the term clipped to the programme enrolment (set after the read) */
  from: string;
  to: string;
  period_no: number;
  period_label: string;
  status: string;
  enrollment_type: string;
  roll_number: string | null;
}
interface MembershipRow {
  id: string;
  term_enrollment_id: string;
  section_id: string;
  section_name: string;
  valid_from: string;
  valid_to: string | null;
}
interface RegistrationRow {
  id: string;
  term_enrollment_id: string;
  course_offering_id: string;
  code: string;
  title: string;
  credits: string;
  status: string;
  source: string;
  registration_kind: string;
  valid_from: string;
  valid_to: string | null;
}

/** Same-date order (lifecycle order), then source row id (UUIDv7, time-ordered), then event type. */
const RANK: Record<TimelineEventType, number> = {
  ADMISSION: 10,
  PROGRAMME_STARTED: 20,
  TERM_ENROLLED: 30,
  REPEAT_ENROLLED: 30,
  SECTION_PLACED: 40,
  SECTION_TRANSFERRED: 41,
  COURSE_REGISTERED: 50,
  COURSE_REREGISTERED: 50,
  COURSE_DROPPED: 60,
  COURSE_WITHDRAWN: 60,
  COURSE_COMPLETED: 60,
  COURSE_REJECTED: 60,
  PROGRAMME_ENDED: 80,
  STUDENT_STATUS_CHANGED: 90,
  PROMOTED: 100,
  DETAINED: 100,
  TERM_COMPLETED: 100,
  TERM_WITHDRAWN: 100,
  TERM_ON_LEAVE: 100,
};
const OUTCOME: Partial<Record<string, TimelineEventType>> = {
  PROMOTED: 'PROMOTED',
  DETAINED: 'DETAINED',
  COMPLETED: 'TERM_COMPLETED',
  WITHDRAWN: 'TERM_WITHDRAWN',
  ON_LEAVE: 'TERM_ON_LEAVE',
};
const COURSE_CLOSE: Partial<Record<string, TimelineEventType>> = {
  DROPPED: 'COURSE_DROPPED',
  WITHDRAWN: 'COURSE_WITHDRAWN',
  COMPLETED: 'COURSE_COMPLETED',
  REJECTED: 'COURSE_REJECTED',
};

const covers = (from: string, to: string | null, d: string): boolean =>
  from <= d && (to === null || d <= to);

function compareEvents(a: TimelineEventDto, b: TimelineEventDto): number {
  const da = a.eventDate ?? '9999-12-31';
  const dbb = b.eventDate ?? '9999-12-31';
  if (da !== dbb) return da < dbb ? -1 : 1;
  if (RANK[a.eventType] !== RANK[b.eventType]) return RANK[a.eventType] - RANK[b.eventType];
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  return a.eventType < b.eventType ? -1 : a.eventType > b.eventType ? 1 : 0;
}

/** A 403 (permission not held) or 404 (out of scope) means "not visible", never an error of the whole read. */
async function canRead(
  tx: TenantTx,
  ctx: TrustedContext,
  resource: Parameters<typeof AuthorizationEngine.assert>[3],
): Promise<boolean> {
  try {
    await AuthorizationEngine.assert(tx, ctx, ENROLLMENT_READ, resource);
    return true;
  } catch (err) {
    if (err instanceof AppError && (err.statusCode === 403 || err.statusCode === 404)) return false;
    throw err;
  }
}

export class StudentTimelineService {
  static async getTimeline(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    rawAsOf?: string,
  ): Promise<StudentTimelineDto> {
    // The profile gate (trusted context, UUID, permission, tenant, scope, 404 hiding) is the profile read itself.
    const record = await StudentService.getById(tx, ctx, studentId);
    const sid = record.id;

    // "Today" and timestamp-to-date conversion use the campus calendar of the student's latest programme enrolment
    // (UTC when there is none), never the database session's zone.
    const st = (
      await tx.query<StudentRow>(
        `SELECT s.admission_date::text AS admission_date, s.status,
                (s.status_changed_at AT TIME ZONE z.tz)::date::text AS status_changed_on,
                z.tz, (now() AT TIME ZONE z.tz)::date::text AS today
           FROM app.students s
           CROSS JOIN LATERAL (
             SELECT coalesce((SELECT c.timezone FROM app.student_programs sp
                                JOIN app.campuses c ON c.organization_id = sp.organization_id AND c.id = sp.campus_id
                               WHERE sp.organization_id = s.organization_id AND sp.student_id = s.id
                               ORDER BY sp.start_date DESC, sp.id DESC LIMIT 1), 'UTC') AS tz) z
          WHERE s.organization_id = $1 AND s.id = $2`,
        [ctx.tenantId, sid],
      )
    ).rows[0]!;
    const asOf = rawAsOf === undefined ? st.today : parseDate(rawAsOf, 'asOf');
    if (asOf > st.today) throw invalid('asOf must not be after today.');

    const programs = (
      await tx.query<ProgramRow>(
        `SELECT sp.id, sp.program_id, p.name AS program_name, p.code AS program_code, sp.cohort_id,
                co.name AS cohort_name, sp.campus_id, sp.department_id, sp.start_date::text AS start_date,
                sp.end_date::text AS end_date, sp.status, sp.entry_type, sp.exit_reason
           FROM app.student_programs sp
           JOIN app.programs p ON p.organization_id = sp.organization_id AND p.id = sp.program_id
           JOIN app.cohorts co ON co.organization_id = sp.organization_id AND co.id = sp.cohort_id
          WHERE sp.organization_id = $1 AND sp.student_id = $2
          ORDER BY sp.start_date, sp.id`,
        [ctx.tenantId, sid],
      )
    ).rows;
    const visible: ProgramRow[] = [];
    for (const p of programs) {
      if (
        await canRead(tx, ctx, {
          organization_id: ctx.tenantId,
          campus_id: p.campus_id,
          department_id: p.department_id,
          student_id: sid,
          user_id: record.userId,
        })
      )
        visible.push(p);
    }
    const programById = new Map(visible.map((p) => [p.id, p]));
    const visibleIds = [...programById.keys()];

    const enrollments = (
      await tx.query<EnrollmentRow>(
        `SELECT e.id, e.student_program_id, e.term_id, t.code AS term_code, t.name AS term_name,
                t.start_date::text AS term_start, t.end_date::text AS term_end, e.period_no,
                pt.label AS period_label, e.status, e.enrollment_type, e.roll_number
           FROM app.term_enrollments e
           JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
           JOIN app.student_programs sp ON sp.organization_id = e.organization_id AND sp.id = e.student_program_id
           JOIN app.programs p ON p.organization_id = sp.organization_id AND p.id = sp.program_id
           JOIN app.period_types pt ON pt.organization_id = p.organization_id AND pt.id = p.period_type_id
          WHERE e.organization_id = $1 AND e.student_id = $2 AND e.student_program_id = ANY($3::uuid[])
          ORDER BY t.start_date, e.id`,
        [ctx.tenantId, sid, visibleIds],
      )
    ).rows;
    // A term enrolment has no effective dates of its own: it is in effect for its term's span, clipped to its programme
    // enrolment's span (a mid-term joiner is not enrolled before joining; a mid-term leaver not after leaving).
    for (const e of enrollments) {
      const p = programById.get(e.student_program_id)!;
      e.from = p.start_date > e.term_start ? p.start_date : e.term_start;
      e.to = p.end_date !== null && p.end_date < e.term_end ? p.end_date : e.term_end;
    }
    const enrollmentIds = enrollments.map((e) => e.id);
    const memberships = (
      await tx.query<MembershipRow>(
        `SELECT m.id, m.term_enrollment_id, m.section_id, s.name AS section_name,
                m.valid_from::text AS valid_from, m.valid_to::text AS valid_to
           FROM app.section_memberships m
           JOIN app.sections s ON s.organization_id = m.organization_id AND s.id = m.section_id
          WHERE m.organization_id = $1 AND m.student_id = $2 AND m.term_enrollment_id = ANY($3::uuid[])
          ORDER BY m.valid_from, m.id`,
        [ctx.tenantId, sid, enrollmentIds],
      )
    ).rows;
    const registrations = (
      await tx.query<RegistrationRow>(
        `SELECT r.id, r.term_enrollment_id, r.course_offering_id, o.code_snapshot AS code,
                o.title_snapshot AS title, o.credits_snapshot::text AS credits, r.status, r.source,
                r.registration_kind, r.valid_from::text AS valid_from, r.valid_to::text AS valid_to
           FROM app.course_registrations r
           JOIN app.course_offerings o ON o.organization_id = r.organization_id AND o.id = r.course_offering_id
          WHERE r.organization_id = $1 AND r.student_id = $2 AND r.term_enrollment_id = ANY($3::uuid[])
          ORDER BY r.valid_from, r.id`,
        [ctx.tenantId, sid, enrollmentIds],
      )
    ).rows;

    // A membership or registration never outlives its term enrolment: an open one ends with the enrolment's span (the
    // same rule as the X-12 resolver's COALESCE(valid_to, term end)); `until` is that effective last day.
    const enrollmentById = new Map(enrollments.map((e) => [e.id, e]));
    const until = (row: { term_enrollment_id: string; valid_to: string | null }): string => {
      const to = enrollmentById.get(row.term_enrollment_id)!.to;
      return row.valid_to !== null && row.valid_to < to ? row.valid_to : to;
    };

    // ---- events (valid time). `all` holds every dated event; those after asOf are excluded and counted.
    const base = (
      type: TimelineEventType,
      sourceId: string,
      eventDate: string | null,
      current: boolean,
      description: string,
    ): TimelineEventDto => ({
      id: `${type}:${sourceId}`,
      sourceId,
      eventType: type,
      eventDate,
      temporal: eventDate === null ? 'UNDATED' : current ? 'CURRENT' : 'HISTORICAL',
      description,
      programme: null,
      cohortName: null,
      term: null,
      periodNo: null,
      periodLabel: null,
      section: null,
      course: null,
      status: null,
    });
    const withEnrollment = (ev: TimelineEventDto, e: EnrollmentRow): TimelineEventDto => {
      const p = programById.get(e.student_program_id)!;
      return {
        ...ev,
        programme: { id: p.program_id, name: p.program_name, code: p.program_code },
        cohortName: p.cohort_name,
        term: { id: e.term_id, code: e.term_code, name: e.term_name },
        periodNo: e.period_no,
        periodLabel: e.period_label,
      };
    };

    const all: TimelineEventDto[] = [];
    const undated: TimelineEventDto[] = [];
    if (st.admission_date !== null) {
      all.push(
        base('ADMISSION', sid, st.admission_date, false, `Admitted (${record.admissionNumber}).`),
      );
    }
    if (st.status !== 'ADMITTED' && st.status_changed_on !== null) {
      all.push({
        ...base(
          'STUDENT_STATUS_CHANGED',
          sid,
          st.status_changed_on,
          true,
          `Student status recorded as ${st.status}. Earlier status changes are not recorded.`,
        ),
        status: st.status,
      });
    }
    for (const p of visible) {
      const prog = { id: p.program_id, name: p.program_name, code: p.program_code };
      all.push({
        ...base(
          'PROGRAMME_STARTED',
          p.id,
          p.start_date,
          covers(p.start_date, p.end_date, asOf),
          `Joined ${p.program_name} (${p.cohort_name}) as ${p.entry_type}.`,
        ),
        programme: prog,
        cohortName: p.cohort_name,
        status: 'ACTIVE',
      });
      if (p.end_date !== null) {
        all.push({
          ...base(
            'PROGRAMME_ENDED',
            p.id,
            p.end_date,
            false,
            `Left ${p.program_name}: ${p.status}${p.exit_reason ? ` (${p.exit_reason})` : ''}. Last day ${p.end_date}.`,
          ),
          programme: prog,
          cohortName: p.cohort_name,
          status: p.status,
        });
      }
    }
    for (const e of enrollments) {
      const repeat = e.enrollment_type === 'REPEAT';
      all.push({
        ...withEnrollment(
          base(
            repeat ? 'REPEAT_ENROLLED' : 'TERM_ENROLLED',
            e.id,
            e.from,
            covers(e.from, e.to, asOf),
            `${repeat ? 'Repeating' : 'Enrolled in'} ${e.period_label} ${e.period_no}, ${e.term_name} (${e.enrollment_type}).`,
          ),
          e,
        ),
        status: e.status,
      });
      const outcome = OUTCOME[e.status];
      // An outcome has no recorded date; it is listed (undated) once its term has started on asOf.
      if (outcome && e.from <= asOf) {
        undated.push({
          ...withEnrollment(
            base(
              outcome,
              e.id,
              null,
              false,
              `Recorded outcome of ${e.period_label} ${e.period_no} (${e.term_name}): ${e.status}. The date of this decision is not recorded.`,
            ),
            e,
          ),
          status: e.status,
        });
      }
    }
    const seenEnrollment = new Set<string>();
    for (const m of memberships) {
      const e = enrollmentById.get(m.term_enrollment_id)!;
      const transfer = seenEnrollment.has(m.term_enrollment_id);
      seenEnrollment.add(m.term_enrollment_id);
      all.push(
        withEnrollment(
          {
            ...base(
              transfer ? 'SECTION_TRANSFERRED' : 'SECTION_PLACED',
              m.id,
              m.valid_from,
              covers(m.valid_from, until(m), asOf),
              `${transfer ? 'Moved to' : 'Placed in'} section ${m.section_name}${m.valid_to ? ` until ${m.valid_to}` : ''}.`,
            ),
            section: { id: m.section_id, name: m.section_name },
          },
          e,
        ),
      );
    }
    const seenOffering = new Set<string>();
    for (const r of registrations) {
      const e = enrollmentById.get(r.term_enrollment_id)!;
      const k = `${r.term_enrollment_id}:${r.course_offering_id}`;
      const again = seenOffering.has(k);
      seenOffering.add(k);
      const course = {
        offeringId: r.course_offering_id,
        code: r.code,
        title: r.title,
        credits: r.credits,
      };
      const pending = r.status === 'PENDING_APPROVAL' || r.status === 'REJECTED';
      all.push(
        withEnrollment(
          {
            ...base(
              again ? 'COURSE_REREGISTERED' : 'COURSE_REGISTERED',
              r.id,
              r.valid_from,
              covers(r.valid_from, until(r), asOf),
              `${again ? 'Registered again for' : pending ? 'Requested' : 'Registered for'} ${r.code} ${r.title} (${r.registration_kind}, ${r.source}).`,
            ),
            course,
            status: pending ? 'PENDING_APPROVAL' : 'REGISTERED',
          },
          e,
        ),
      );
      const close = COURSE_CLOSE[r.status];
      if (close && r.valid_to !== null) {
        all.push(
          withEnrollment(
            {
              ...base(
                close,
                r.id,
                r.valid_to,
                false,
                `${r.code} ${r.title}: ${r.status}. Last day ${r.valid_to}.`,
              ),
              course,
              status: r.status,
            },
            e,
          ),
        );
      }
    }
    const events = all.filter((ev) => ev.eventDate! <= asOf).sort(compareEvents);
    undated.sort(compareEvents);

    // ---- position on asOf
    const programme = visible.filter((p) => covers(p.start_date, p.end_date, asOf)).at(-1) ?? null;
    const terms: TimelinePositionTermDto[] = enrollments
      .filter((e) => covers(e.from, e.to, asOf))
      .map((e) => {
        const m = memberships.find(
          (x) => x.term_enrollment_id === e.id && covers(x.valid_from, until(x), asOf),
        );
        return {
          termEnrollmentId: e.id,
          term: {
            id: e.term_id,
            code: e.term_code,
            name: e.term_name,
            startDate: e.term_start,
            endDate: e.term_end,
          },
          periodNo: e.period_no,
          periodLabel: e.period_label,
          enrollmentType: e.enrollment_type,
          recordedStatus: e.status,
          rollNumber: e.roll_number,
          section: m
            ? {
                id: m.section_id,
                name: m.section_name,
                validFrom: m.valid_from,
                validTo: m.valid_to,
              }
            : null,
          registrations: registrations
            .filter((r) => r.term_enrollment_id === e.id && covers(r.valid_from, until(r), asOf))
            .map((r) => ({
              registrationId: r.id,
              offeringId: r.course_offering_id,
              code: r.code,
              title: r.title,
              credits: r.credits,
              registrationKind: r.registration_kind,
              source: r.source,
              validFrom: r.valid_from,
              validTo: r.valid_to,
              recordedStatus: r.status,
              statusOnDate:
                r.status === 'PENDING_APPROVAL' || r.status === 'REJECTED'
                  ? 'PENDING_APPROVAL'
                  : 'REGISTERED',
            })),
        };
      });

    const limitations: TimelineLimitationDto[] = [];
    const admitted: boolean | null = st.admission_date === null ? null : st.admission_date <= asOf;
    let studentStatus: StudentStatus | null = null;
    if (st.admission_date === null) {
      limitations.push({
        code: 'ADMISSION_DATE_NOT_RECORDED',
        message:
          'The admission date is not recorded, so the timeline cannot show when the student was admitted.',
      });
    }
    if (admitted === false) {
      limitations.push({
        code: 'BEFORE_ADMISSION',
        message: `The student was admitted on ${st.admission_date}.`,
      });
    } else if (st.status === 'ADMITTED') {
      studentStatus = 'ADMITTED'; // nothing transitions into ADMITTED: it is the only status ever held
    } else if (st.status_changed_on !== null && asOf >= st.status_changed_on) {
      studentStatus = st.status as StudentStatus;
    } else {
      limitations.push({
        code: 'STATUS_BEFORE_LAST_CHANGE_UNKNOWN',
        message: st.status_changed_on
          ? `Only the latest status change (${st.status_changed_on}) is recorded; the status on ${asOf} is unknown.`
          : `The date of the student's status is not recorded; the status on ${asOf} is unknown.`,
      });
    }
    if (undated.length > 0) {
      limitations.push({
        code: 'TERM_OUTCOMES_UNDATED',
        message:
          'Promotion, detention, completion and withdrawal decisions are not dated. They are listed separately and may have been recorded after the selected date.',
      });
    }
    if (
      asOf < st.today &&
      terms.some((t) => t.registrations.some((r) => r.statusOnDate === 'REGISTERED'))
    ) {
      limitations.push({
        code: 'REGISTRATION_APPROVAL_UNDATED',
        message:
          'Approval of a pending registration is not dated; a registration approved after the selected date is shown as registered from its start date.',
      });
    }

    return {
      studentId: sid,
      asOfDate: asOf,
      today: st.today,
      timezone: st.tz,
      position: {
        admitted,
        studentStatus,
        programme: programme
          ? {
              studentProgramId: programme.id,
              id: programme.program_id,
              name: programme.program_name,
              code: programme.program_code,
              cohortId: programme.cohort_id,
              cohortName: programme.cohort_name,
              entryType: programme.entry_type,
              startDate: programme.start_date,
              endDate: programme.end_date,
            }
          : null,
        terms,
      },
      events,
      undatedOutcomes: undated,
      futureEventsExcluded: all.length - events.length,
      limitations,
    };
  }
}
