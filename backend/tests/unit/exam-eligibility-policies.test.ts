import { describe, expect, it } from 'vitest';
import {
  SaveEligibilityPolicyInputSchema,
  PolicyPreviewImpactInputSchema,
  GradeBoundarySchema,
  AssessmentComponentSchema,
} from '../../src/modules/examinations/eligibility.schemas.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

describe('Examination Eligibility & Governance Schemas', () => {
  it('validates comprehensive examination policy with all governance rules', () => {
    const validPolicy = {
      name: 'Secondary Board Standard Policy',
      scope: 'INSTITUTION',
      status: 'ACTIVE',
      description: 'Comprehensive policy for secondary classes',
      min_attendance_percentage: 80,
      check_attendance: true,
      check_fees: true,
      attendance_cutoff_days_prior: 3,
      allow_late_enrolment_review: true,
      attendance_rules: {
        calculation_period: 'FULL_TERM',
        excused_treatment: 'EXEMPT',
        late_treatment: 'PRESENT',
        cancelled_sessions_excluded: true,
        prorate_late_enrolment: true,
        min_sessions: 10,
        allow_exemption: true,
        exemption_approver_role: 'PRINCIPAL',
      },
      fee_rules: {
        max_balance_tolerance: 500,
        allow_concession_exemption: true,
        deadline_days_prior: 7,
        require_payment_verification: true,
      },
      academic_rules: {
        required_enrolment_status: 'REGISTERED',
        min_enrolment_days: 14,
        allow_academic_exception: true,
        supplementary_eligible: true,
      },
      assessment_rules: {
        components: [
          { name: 'Theory Paper', component_type: 'THEORY', max_marks: 70, pass_marks: 28, weight_percentage: 70 },
          { name: 'Practical Assessment', component_type: 'PRACTICAL', max_marks: 30, pass_marks: 12, weight_percentage: 30 },
        ],
        allow_grace_marks: true,
        max_grace_marks: 5,
      },
      grading_rules: {
        grading_system: 'LETTER_GRADE',
        grade_scale: [
          { grade: 'A+', min_percentage: 90, max_percentage: 100, grade_point: 10, description: 'Outstanding', is_passing: true },
          { grade: 'A', min_percentage: 80, max_percentage: 89.99, grade_point: 9, description: 'Excellent', is_passing: true },
          { grade: 'B', min_percentage: 60, max_percentage: 79.99, grade_point: 7, description: 'Good', is_passing: true },
          { grade: 'F', min_percentage: 0, max_percentage: 59.99, grade_point: 0, description: 'Fail', is_passing: false },
        ],
      },
      approval_rules: {
        require_coordinator_review: true,
        require_principal_approval: true,
        allow_individual_override: true,
        results_workflow: 'DRAFT_REVIEW_PUBLISH',
      },
    };

    const parsed = SaveEligibilityPolicyInputSchema.safeParse(validPolicy);
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid attendance percentage boundaries', () => {
    const over100 = SaveEligibilityPolicyInputSchema.safeParse({
      name: 'Invalid Policy',
      min_attendance_percentage: 105,
    });
    expect(over100.success).toBe(false);

    const negative = SaveEligibilityPolicyInputSchema.safeParse({
      name: 'Invalid Policy',
      min_attendance_percentage: -5,
    });
    expect(negative.success).toBe(false);
  });

  it('validates assessment component configuration and types', () => {
    const validComponent = {
      name: 'Viva Voce',
      component_type: 'VIVA',
      max_marks: 25,
      pass_marks: 10,
      weight_percentage: 25,
    };
    expect(AssessmentComponentSchema.safeParse(validComponent).success).toBe(true);

    const invalidType = {
      ...validComponent,
      component_type: 'UNOFFICIAL_QUIZ',
    };
    expect(AssessmentComponentSchema.safeParse(invalidType).success).toBe(false);
  });

  it('validates grade scale boundaries and GPA points', () => {
    const validBoundary = {
      grade: 'Distinction',
      min_percentage: 75,
      max_percentage: 100,
      grade_point: 8.5,
      description: 'First Class with Distinction',
      is_passing: true,
    };
    expect(GradeBoundarySchema.safeParse(validBoundary).success).toBe(true);
  });

  it('validates policy preview impact request inputs', () => {
    const validScheduleId = uuidv7();
    const validImpactInput = {
      schedule_id: validScheduleId,
      policy: {
        name: 'Impact Test Policy',
        min_attendance_percentage: 75,
      },
    };
    expect(PolicyPreviewImpactInputSchema.safeParse(validImpactInput).success).toBe(true);

    const invalidUuid = {
      schedule_id: 'not-a-uuid',
    };
    expect(PolicyPreviewImpactInputSchema.safeParse(invalidUuid).success).toBe(false);
  });
});
