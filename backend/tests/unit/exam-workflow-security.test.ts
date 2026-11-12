import { describe, expect, it } from 'vitest';
import { ExamService } from '../../src/modules/examinations/exam.service.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';

const TENANT_ID = '01939a00-0000-7000-8000-000000000a01';
const PRINCIPAL_USER_ID = '01939a00-0000-7000-8000-00000000aa01';
const TEACHER_USER_ID = '01939a00-0000-7000-8000-00000000bb02';
const STUDENT_USER_ID = '01939a00-0000-7000-8000-00000000cc03';

const principalCtx = issueTrustedContext({
  tenantId: TENANT_ID,
  userId: PRINCIPAL_USER_ID,
  actorKind: 'STAFF',
});

const teacherCtx = issueTrustedContext({
  tenantId: TENANT_ID,
  userId: TEACHER_USER_ID,
  actorKind: 'STAFF',
});

interface MockSchedule {
  id: string;
  status: string;
  exam_date: string;
  max_marks: number;
  pass_marks: number;
  campus_id: string;
  course_offering_id: string;
  examination_id: string;
  marks_submitted_by_user_id: string | null;
  published_at?: string | null;
}

function createMockTx(options: {
  schedule: MockSchedule;
  candidateListStatus?: 'DRAFT' | 'APPROVED' | 'FROZEN' | null;
  marksCount?: number;
  existingMark?: {
    id: string;
    marks_obtained: string | null;
    status: string;
    marked_by_user_id: string;
  } | null;
  resultsWorkflow?: 'DRAFT_REVIEW_PUBLISH' | 'DIRECT_PUBLISH';
  governanceMode?: 'PRINCIPAL_FINAL_AUTHORITY' | 'INDEPENDENT_REVIEW' | 'DELEGATED_APPROVAL';
}): { tx: TenantTx; auditLogs: unknown[] } {
  const auditLogs: unknown[] = [];
  const sched = options.schedule;

  const tx = {
    query: (queryText: string, params?: unknown[]) => {
      const q = queryText.replace(/\s+/g, ' ').trim();

      // Effective administrator query (COLLEGE_ADMIN)
      if (q.includes("r.code = 'COLLEGE_ADMIN'")) {
        return Promise.resolve({
          rows: [{ user_id: PRINCIPAL_USER_ID }],
          rowCount: 1,
        });
      }

      // Authorization queries (allow all staff permissions for mock)
      if (q.includes('FROM app.role_assignments ra') && q.includes('app.role_permissions rp')) {
        return Promise.resolve({
          rows: [{ scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null }],
          rowCount: 1,
        });
      }

      // Schedule query
      if (q.includes('FROM app.exam_schedules s') && q.includes('s.id = $2')) {
        return Promise.resolve({
          rows: [
            {
              ...sched,
              organization_id: TENANT_ID,
              term_id: '01939a00-0000-7000-8000-000000000t01',
              start_time: '10:00',
              end_time: '12:00',
            },
          ],
          rowCount: 1,
        });
      }

      // Candidate list query
      if (q.includes('FROM app.exam_candidate_lists') && q.includes('ORDER BY created_at DESC LIMIT 1')) {
        if (options.candidateListStatus) {
          return Promise.resolve({
            rows: [
              {
                id: '01939a00-0000-7000-8000-000000000cl1',
                status: options.candidateListStatus,
              },
            ],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // Eligible candidates query
      if (q.includes('FROM app.exam_candidates c') && q.includes("final_status = 'ELIGIBLE'")) {
        return Promise.resolve({
          rows: [{ student_id: STUDENT_USER_ID }],
          rowCount: 1,
        });
      }

      // Marks count query
      if (q.includes('SELECT count(*)::text AS count FROM app.exam_marks')) {
        return Promise.resolve({
          rows: [{ count: String(options.marksCount ?? 1) }],
          rowCount: 1,
        });
      }

      // Existing mark query
      if (q.includes('FROM app.exam_marks') && q.includes('student_id = $3')) {
        if (options.existingMark) {
          return Promise.resolve({
            rows: [options.existingMark],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // Policy extended settings query
      if (q.includes('FROM app.organization_settings')) {
        return Promise.resolve({
          rows: [
            {
              value: {
                approval_rules: {
                  results_workflow: options.resultsWorkflow ?? 'DRAFT_REVIEW_PUBLISH',
                  governance_mode: options.governanceMode ?? 'PRINCIPAL_FINAL_AUTHORITY',
                },
              },
            },
          ],
          rowCount: 1,
        });
      }

      // Eligibility policies query
      if (q.includes('FROM app.exam_eligibility_policies')) {
        return Promise.resolve({
          rows: [
            {
              id: '01939a00-0000-7000-8000-000000000pol1',
              organization_id: TENANT_ID,
              min_attendance_percentage: 75,
              check_attendance: true,
              check_fees: false,
              attendance_cutoff_days_prior: 0,
            },
          ],
          rowCount: 1,
        });
      }

      // Audit insert
      if (q.includes('INSERT INTO app.audit_events') || q.includes('INSERT INTO platform.audit_log')) {
        auditLogs.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Updates and inserts to schedules or marks
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  } as unknown as TenantTx;

  return { tx, auditLogs };
}

describe('Examination Workflow Security & Lifecycle Controls', () => {
  const baseSchedule: MockSchedule = {
    id: '01939a00-0000-7000-8000-000000000501',
    status: 'SUBMITTED',
    exam_date: '2026-10-15',
    max_marks: 50,
    pass_marks: 20,
    campus_id: '01939a00-0000-7000-8000-000000000c01',
    course_offering_id: '01939a00-0000-7000-8000-000000000001',
    examination_id: '01939a00-0000-7000-8000-000000000e01',
    marks_submitted_by_user_id: TEACHER_USER_ID,
  };

  describe('publishResults Security & Integrity', () => {
    it('returns published status idempotently when schedule is already PUBLISHED', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, status: 'PUBLISHED', published_at: '2026-11-01T10:00:00Z' },
      });

      const res = await ExamService.publishResults(tx, principalCtx, baseSchedule.id);
      expect(res.success).toBe(true);
      expect(res.status).toBe('PUBLISHED');
      expect(res.published_at).toBe('2026-11-01T10:00:00Z');
    });

    it('rejects publication when candidate list is still in DRAFT status', async () => {
      const { tx } = createMockTx({
        schedule: baseSchedule,
        candidateListStatus: 'DRAFT',
      });

      await expect(
        ExamService.publishResults(tx, principalCtx, baseSchedule.id),
      ).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 422,
          code: 'CANDIDATE_LIST_NOT_APPROVED',
        }),
      );
    });

    it('rejects publication when examination marks have not been submitted', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, status: 'DRAFT_MARKS' },
        candidateListStatus: 'APPROVED',
      });

      await expect(
        ExamService.publishResults(tx, principalCtx, baseSchedule.id),
      ).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 422,
          code: 'MARKS_NOT_SUBMITTED',
        }),
      );
    });

    it('enforces maker-checker: marks submitter cannot publish without independent review', async () => {
      const { tx } = createMockTx({
        // Teacher is the marks submitter AND the caller attempting to publish
        schedule: { ...baseSchedule, marks_submitted_by_user_id: TEACHER_USER_ID },
        candidateListStatus: 'FROZEN',
        resultsWorkflow: 'DRAFT_REVIEW_PUBLISH',
        governanceMode: 'INDEPENDENT_REVIEW',
      });

      await expect(
        ExamService.publishResults(tx, teacherCtx, baseSchedule.id),
      ).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 403,
          code: 'MAKER_CHECKER_VIOLATION',
        }),
      );
    });

    it('permits Principal to self-publish when school is configured with PRINCIPAL_FINAL_AUTHORITY', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, marks_submitted_by_user_id: PRINCIPAL_USER_ID },
        candidateListStatus: 'FROZEN',
        marksCount: 1,
        governanceMode: 'PRINCIPAL_FINAL_AUTHORITY',
      });

      const res = await ExamService.publishResults(tx, principalCtx, baseSchedule.id);
      expect(res.success).toBe(true);
      expect(res.status).toBe('PUBLISHED');
    });

    it('rejects self-publishing under INDEPENDENT_REVIEW even for Principal', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, marks_submitted_by_user_id: PRINCIPAL_USER_ID },
        candidateListStatus: 'FROZEN',
        marksCount: 1,
        governanceMode: 'INDEPENDENT_REVIEW',
      });

      await expect(
        ExamService.publishResults(tx, principalCtx, baseSchedule.id),
      ).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 403,
          code: 'MAKER_CHECKER_VIOLATION',
        }),
      );
    });

    it('rejects non-Principal self-publishing even under PRINCIPAL_FINAL_AUTHORITY', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, marks_submitted_by_user_id: TEACHER_USER_ID },
        candidateListStatus: 'FROZEN',
        marksCount: 1,
        governanceMode: 'PRINCIPAL_FINAL_AUTHORITY',
      });

      await expect(
        ExamService.publishResults(tx, teacherCtx, baseSchedule.id),
      ).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 403,
          code: 'MAKER_CHECKER_VIOLATION',
        }),
      );
    });

    it('permits authorized Principal to publish results submitted by faculty', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, marks_submitted_by_user_id: TEACHER_USER_ID },
        candidateListStatus: 'FROZEN',
        marksCount: 1,
      });

      const res = await ExamService.publishResults(tx, principalCtx, baseSchedule.id);
      expect(res.success).toBe(true);
      expect(res.status).toBe('PUBLISHED');
    });
  });

  describe('saveMarks Lifecycle & Safeguards', () => {
    it('blocks ordinary saveMarks from silently overwriting SUBMITTED marks', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, status: 'SUBMITTED' },
      });

      await expect(
        ExamService.saveMarks(tx, teacherCtx, baseSchedule.id, {
          action: 'DRAFT',
          entries: [{ student_id: STUDENT_USER_ID, status: 'ENTERED', marks_obtained: 45 }],
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 409,
          code: 'MARKS_ALREADY_SUBMITTED',
        }),
      );
    });

    it('rejects early marks entry prior to examination date without authorization', async () => {
      const futureDate = '2099-12-31';
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, status: 'SCHEDULED', exam_date: futureDate },
      });

      await expect(
        ExamService.saveMarks(tx, teacherCtx, baseSchedule.id, {
          action: 'DRAFT',
          entries: [{ student_id: STUDENT_USER_ID, status: 'ENTERED', marks_obtained: 45 }],
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 422,
          code: 'EXAM_DATE_NOT_REACHED',
        }),
      );
    });

    it('permits early marks entry when authorized with required justification', async () => {
      const futureDate = '2099-12-31';
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, status: 'SCHEDULED', exam_date: futureDate },
      });

      const res = await ExamService.saveMarks(tx, principalCtx, baseSchedule.id, {
        action: 'DRAFT',
        allow_early_entry: true,
        early_entry_reason: 'Practical demonstration completed early in lab session',
        entries: [{ student_id: STUDENT_USER_ID, status: 'ENTERED', marks_obtained: 45 }],
      });

      expect(res.success).toBe(true);
      expect(res.status).toBe('DRAFT_MARKS');
    });

    it('rejects marks entry when candidate list exists in unapproved DRAFT status', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, status: 'SCHEDULED' },
        candidateListStatus: 'DRAFT',
      });

      await expect(
        ExamService.saveMarks(tx, teacherCtx, baseSchedule.id, {
          action: 'DRAFT',
          entries: [{ student_id: STUDENT_USER_ID, status: 'ENTERED', marks_obtained: 45 }],
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 422,
          code: 'CANDIDATE_LIST_NOT_APPROVED',
        }),
      );
    });
  });

  describe('correctMark Authorized Audit-Trail Process', () => {
    it('allows authorized administrative correction of submitted mark with mandatory reason', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, status: 'SUBMITTED' },
        existingMark: {
          id: '01939a00-0000-7000-8000-000000000m01',
          marks_obtained: '21',
          status: 'SUBMITTED',
          marked_by_user_id: TEACHER_USER_ID,
        },
      });

      const res = await ExamService.correctMark(tx, principalCtx, baseSchedule.id, {
        student_id: STUDENT_USER_ID,
        status: 'ENTERED',
        marks_obtained: 25,
        reason: 'Recounting of Section B answers confirmed 4 additional points',
        evidence_url: 'https://archive.school.internal/corrections/REQ-2026-001.pdf',
        evidence_exception: false,
        is_amendment: false,
      });

      expect(res.success).toBe(true);
      expect(res.student_id).toBe(STUDENT_USER_ID);
      expect(res.marks_obtained).toBe(25);
      expect(res.status).toBe('ENTERED');
    });

    it('allows authorized amendment of already PUBLISHED results with audit trail', async () => {
      const { tx, auditLogs } = createMockTx({
        schedule: { ...baseSchedule, status: 'PUBLISHED', published_at: '2026-11-01T10:00:00Z' },
        existingMark: {
          id: '01939a00-0000-7000-8000-000000000m01',
          marks_obtained: '21',
          status: 'SUBMITTED',
          marked_by_user_id: TEACHER_USER_ID,
        },
      });

      const res = await ExamService.correctMark(tx, principalCtx, baseSchedule.id, {
        student_id: STUDENT_USER_ID,
        status: 'ENTERED',
        marks_obtained: 35,
        reason: 'Post-publication re-evaluation confirmed clerical omission in Section C',
        evidence_url: 'https://archive.school.internal/corrections/REQ-2026-002.pdf',
        evidence_exception: false,
        is_amendment: true,
      });

      expect(res.success).toBe(true);
      expect(res.student_id).toBe(STUDENT_USER_ID);
      expect(res.marks_obtained).toBe(35);
      expect(res.is_amendment).toBe(true);

      const amendLog = auditLogs.find(
        (p: any) => Array.isArray(p) && p.includes('exam.marks.amend_published'),
      );
      expect(amendLog).toBeDefined();
    });

    it('rejects mark correction when mandatory reason is shorter than 5 characters', async () => {
      const { tx } = createMockTx({
        schedule: { ...baseSchedule, status: 'SUBMITTED' },
        existingMark: {
          id: '01939a00-0000-7000-8000-000000000m01',
          marks_obtained: '21',
          status: 'SUBMITTED',
          marked_by_user_id: TEACHER_USER_ID,
        },
      });

      await expect(
        ExamService.correctMark(tx, principalCtx, baseSchedule.id, {
          student_id: STUDENT_USER_ID,
          status: 'ENTERED',
          marks_obtained: 25,
          reason: 'err',
          evidence_exception: false,
          is_amendment: false,
        }),
      ).rejects.toThrow();
    });
  });
});
