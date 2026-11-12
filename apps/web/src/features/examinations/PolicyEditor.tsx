import { useState, useMemo } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { PolicySettingRow } from './PolicySettingRow';
import type {
  AssessmentComponent,
  GradeBoundary,
  PolicyScope,
  PolicyStatus,
  ResultsApprovalGovernanceMode,
  SaveEligibilityPolicyInput,
} from '../../lib/api/examinations-api';

export interface PolicyEditorProps {
  initialPolicy?: Partial<SaveEligibilityPolicyInput> | undefined;
  onSave: (policy: SaveEligibilityPolicyInput) => Promise<void>;
  onCancel?: (() => void) | undefined;
  onSimulateImpact?: ((policy: SaveEligibilityPolicyInput) => Promise<void>) | undefined;
  isModal?: boolean | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
}

const DEFAULT_GRADE_SCALE: GradeBoundary[] = [
  { grade: 'A+', min_percentage: 90, max_percentage: 100, grade_point: 10, description: 'Outstanding', is_passing: true },
  { grade: 'A', min_percentage: 80, max_percentage: 89.99, grade_point: 9, description: 'Excellent', is_passing: true },
  { grade: 'B+', min_percentage: 70, max_percentage: 79.99, grade_point: 8, description: 'Very Good', is_passing: true },
  { grade: 'B', min_percentage: 60, max_percentage: 69.99, grade_point: 7, description: 'Good', is_passing: true },
  { grade: 'C', min_percentage: 50, max_percentage: 59.99, grade_point: 6, description: 'Above Average', is_passing: true },
  { grade: 'D', min_percentage: 40, max_percentage: 49.99, grade_point: 5, description: 'Pass', is_passing: true },
  { grade: 'F', min_percentage: 0, max_percentage: 39.99, grade_point: 0, description: 'Fail', is_passing: false },
];

export function PolicyEditor({
  initialPolicy,
  onSave,
  onCancel,
  onSimulateImpact,
  isModal = false,
  title = 'Configure Eligibility Policy',
  subtitle = 'Define the automated rules for candidate eligibility, grading standards, and results publication.',
}: PolicyEditorProps) {
  // General & Scope
  const [name, setName] = useState(initialPolicy?.name ?? 'Default Eligibility Policy');
  const [description, setDescription] = useState(initialPolicy?.description ?? '');
  const [scope, setScope] = useState<PolicyScope>(initialPolicy?.scope ?? 'INSTITUTION');
  const [status, setStatus] = useState<PolicyStatus>(initialPolicy?.status ?? 'ACTIVE');

  // Attendance
  const [checkAttendance, setCheckAttendance] = useState(initialPolicy?.check_attendance ?? true);
  const [minAttendance, setMinAttendance] = useState(String(initialPolicy?.min_attendance_percentage ?? 75));
  const [attendanceCutoffDays, setAttendanceCutoffDays] = useState(
    String(initialPolicy?.attendance_cutoff_days_prior ?? 0),
  );
  const [calculationPeriod, setCalculationPeriod] = useState<'FULL_TERM' | 'SEMESTER' | 'CUSTOM'>(
    initialPolicy?.attendance_rules?.calculation_period ?? 'FULL_TERM',
  );
  const [excusedTreatment, setExcusedTreatment] = useState<'EXEMPT' | 'PRESENT' | 'ABSENT'>(
    initialPolicy?.attendance_rules?.excused_treatment ?? 'EXEMPT',
  );
  const [lateTreatment, setLateTreatment] = useState<'PRESENT' | 'HALF_DAY' | 'ABSENT'>(
    initialPolicy?.attendance_rules?.late_treatment ?? 'PRESENT',
  );
  const [excludeCancelled, setExcludeCancelled] = useState(
    initialPolicy?.attendance_rules?.cancelled_sessions_excluded ?? true,
  );
  const [prorateLateEnrolment, setProrateLateEnrolment] = useState(
    initialPolicy?.attendance_rules?.prorate_late_enrolment ?? true,
  );

  // Academic Eligibility
  const [requiredEnrolmentStatus, setRequiredEnrolmentStatus] = useState<'ACTIVE' | 'REGISTERED' | 'ANY'>(
    initialPolicy?.academic_rules?.required_enrolment_status ?? 'REGISTERED',
  );
  const [minEnrolmentDays, setMinEnrolmentDays] = useState(
    String(initialPolicy?.academic_rules?.min_enrolment_days ?? 0),
  );
  const [allowAcademicException, setAllowAcademicException] = useState(
    initialPolicy?.academic_rules?.allow_academic_exception ?? true,
  );
  const [supplementaryEligible, setSupplementaryEligible] = useState(
    initialPolicy?.academic_rules?.supplementary_eligible ?? true,
  );

  // Fee Clearance
  const [checkFees, setCheckFees] = useState(initialPolicy?.check_fees ?? false);
  const [feeTolerance, setFeeTolerance] = useState(String(initialPolicy?.fee_rules?.max_balance_tolerance ?? 0));
  const [allowConcessionExemption, setAllowConcessionExemption] = useState(
    initialPolicy?.fee_rules?.allow_concession_exemption ?? true,
  );
  const [feeDeadlineDays, setFeeDeadlineDays] = useState(
    String(initialPolicy?.fee_rules?.deadline_days_prior ?? 0),
  );
  const [requirePaymentVerification, setRequirePaymentVerification] = useState(
    initialPolicy?.fee_rules?.require_payment_verification ?? true,
  );

  // Exceptions and Special Cases
  const [allowLateEnrolmentReview, setAllowLateEnrolmentReview] = useState(
    initialPolicy?.allow_late_enrolment_review ?? true,
  );
  const [allowIndividualExemption, setAllowIndividualExemption] = useState(
    initialPolicy?.attendance_rules?.allow_exemption ?? true,
  );
  const [exemptionApproverRole, setExemptionApproverRole] = useState(
    initialPolicy?.attendance_rules?.exemption_approver_role ?? 'PRINCIPAL',
  );

  // Examination Components
  const [components, setComponents] = useState<AssessmentComponent[]>(
    initialPolicy?.assessment_rules?.components ?? [
      { name: 'Theory Paper', component_type: 'THEORY', max_marks: 70, pass_marks: 28, weight_percentage: 70 },
      { name: 'Internal Assessment', component_type: 'INTERNAL', max_marks: 30, pass_marks: 12, weight_percentage: 30 },
    ],
  );
  const [allowGraceMarks, setAllowGraceMarks] = useState(
    initialPolicy?.assessment_rules?.allow_grace_marks ?? false,
  );
  const [maxGraceMarks, setMaxGraceMarks] = useState(
    String(initialPolicy?.assessment_rules?.max_grace_marks ?? 0),
  );

  // Grading Rules
  const [gradingSystem, setGradingSystem] = useState<'PERCENTAGE' | 'LETTER_GRADE' | 'GRADE_POINT' | 'MARKS_ONLY'>(
    initialPolicy?.grading_rules?.grading_system ?? 'PERCENTAGE',
  );
  const [gradeScale, setGradeScale] = useState<GradeBoundary[]>(
    initialPolicy?.grading_rules?.grade_scale?.length
      ? initialPolicy.grading_rules.grade_scale
      : DEFAULT_GRADE_SCALE,
  );

  // Interactive Grading Calculator Preview State
  const [sampleScore, setSampleScore] = useState('75');

  // Candidate Approval & Results Governance
  const [requireCoordinatorReview, setRequireCoordinatorReview] = useState(
    initialPolicy?.approval_rules?.require_coordinator_review ?? true,
  );
  const [requirePrincipalApproval, setRequirePrincipalApproval] = useState(
    initialPolicy?.approval_rules?.require_principal_approval ?? true,
  );
  const [governanceMode, setGovernanceMode] = useState<ResultsApprovalGovernanceMode>(
    initialPolicy?.approval_rules?.governance_mode ??
      (initialPolicy?.approval_rules?.results_workflow === 'DIRECT_PUBLISH'
        ? 'PRINCIPAL_FINAL_AUTHORITY'
        : 'PRINCIPAL_FINAL_AUTHORITY'),
  );
  const [effectiveDate, setEffectiveDate] = useState<string>(
    initialPolicy?.approval_rules?.effective_date ?? new Date().toISOString().slice(0, 10),
  );
  const [approvalNotes, setApprovalNotes] = useState<string>(
    initialPolicy?.approval_rules?.notes ?? '',
  );
  const [resultsWorkflow, setResultsWorkflow] = useState<'DRAFT_REVIEW_PUBLISH' | 'DIRECT_PUBLISH'>(
    initialPolicy?.approval_rules?.results_workflow ?? 'DRAFT_REVIEW_PUBLISH',
  );

  // Submission state
  const [saving, setSaving] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Total weightage check
  const totalWeightage = useMemo(
    () => components.reduce((acc, c) => acc + (Number(c.weight_percentage) || 0), 0),
    [components],
  );

  // Calculated grade preview
  const calculatedGradePreview = useMemo(() => {
    const score = Number(sampleScore);
    if (isNaN(score)) return null;
    const match = gradeScale.find((b) => score >= b.min_percentage && score <= b.max_percentage);
    return match ?? null;
  }, [sampleScore, gradeScale]);

  function handleAddComponent() {
    setComponents((prev) => [
      ...prev,
      {
        name: `Component ${prev.length + 1}`,
        component_type: 'THEORY',
        max_marks: 100,
        pass_marks: 40,
        weight_percentage: Math.max(0, 100 - totalWeightage),
      },
    ]);
  }

  function handleRemoveComponent(index: number) {
    setComponents((prev) => prev.filter((_, i) => i !== index));
  }

  function handleUpdateComponent(index: number, updates: Partial<AssessmentComponent>) {
    setComponents((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...updates } : c)),
    );
  }

  function handleGradeBoundaryChange(index: number, field: keyof GradeBoundary, val: any) {
    setGradeScale((prev) =>
      prev.map((b, i) => (i === index ? { ...b, [field]: val } : b)),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const payload: SaveEligibilityPolicyInput = {
      name: name.trim() || 'Eligibility Policy',
      description: description.trim() || undefined,
      scope,
      status,
      min_attendance_percentage: Number(minAttendance),
      check_attendance: checkAttendance,
      check_fees: checkFees,
      attendance_cutoff_days_prior: Number(attendanceCutoffDays),
      allow_late_enrolment_review: allowLateEnrolmentReview,
      attendance_rules: {
        calculation_period: calculationPeriod,
        excused_treatment: excusedTreatment,
        late_treatment: lateTreatment,
        cancelled_sessions_excluded: excludeCancelled,
        prorate_late_enrolment: prorateLateEnrolment,
        min_sessions: 0,
        allow_exemption: allowIndividualExemption,
        exemption_approver_role: exemptionApproverRole,
      },
      fee_rules: {
        max_balance_tolerance: Number(feeTolerance),
        allow_concession_exemption: allowConcessionExemption,
        deadline_days_prior: Number(feeDeadlineDays),
        require_payment_verification: requirePaymentVerification,
      },
      academic_rules: {
        required_enrolment_status: requiredEnrolmentStatus,
        min_enrolment_days: Number(minEnrolmentDays),
        allow_academic_exception: allowAcademicException,
        supplementary_eligible: supplementaryEligible,
      },
      assessment_rules: {
        components,
        allow_grace_marks: allowGraceMarks,
        max_grace_marks: Number(maxGraceMarks),
      },
      grading_rules: {
        grading_system: gradingSystem,
        grade_scale: gradeScale,
      },
      approval_rules: {
        governance_mode: governanceMode,
        require_coordinator_review: requireCoordinatorReview,
        require_principal_approval: requirePrincipalApproval,
        allow_individual_override: allowIndividualExemption,
        results_workflow:
          governanceMode === 'PRINCIPAL_FINAL_AUTHORITY' ? 'DIRECT_PUBLISH' : resultsWorkflow,
        delegated_roles: [
          'COLLEGE_ADMIN',
          'CAMPUS_ADMIN',
          'REGISTRAR',
          'DEPARTMENT_ADMIN',
          'HOD',
        ],
        effective_date: effectiveDate,
        notes: approvalNotes || undefined,
      },
    };

    try {
      await onSave(payload);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save examination policy.');
    } finally {
      setSaving(false);
    }
  }

  const content = (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && <Alert tone="error">{error}</Alert>}

      {/* SECTION 1: General Policy & Scope */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h4 className="text-base font-bold text-foreground">1. General Policy & Scope</h4>
          <p className="text-xs text-muted">
            Configure institutional governance, target scope level, and activation lifecycle status.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label="Policy Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            hint="Unique descriptive title for this policy template."
          />

          <div className="space-y-1">
            <label className="text-xs font-semibold text-foreground uppercase tracking-wider block">
              Policy Scope
            </label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as PolicyScope)}
              className="w-full h-10 px-3 rounded-md border border-input bg-surface text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="INSTITUTION">Institution-Wide (All Campuses & Exams)</option>
              <option value="CAMPUS">Campus-Specific</option>
              <option value="EXAMINATION">Examination-Wide</option>
              <option value="SCHEDULE">Course Paper Schedule (Override)</option>
            </select>
            <span className="text-[11px] text-muted block">
              Precedence: Schedule &gt; Examination &gt; Campus &gt; Institution.
            </span>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-foreground uppercase tracking-wider block">
              Lifecycle Status
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as PolicyStatus)}
              className="w-full h-10 px-3 rounded-md border border-input bg-surface text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="ACTIVE">Active (Enforced during candidate generation)</option>
              <option value="DRAFT">Draft (Under review, not automatically applied)</option>
              <option value="ARCHIVED">Archived (Historical record only)</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-foreground uppercase tracking-wider block">
              Description / Notes
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Standard CBSE board policy for secondary wing"
              className="w-full h-10 px-3 rounded-md border border-input bg-surface text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>
      </div>

      {/* SECTION 2: Attendance Requirements */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h4 className="text-base font-bold text-foreground">2. Attendance Requirements</h4>
          <p className="text-xs text-muted">
            Establish automated session attendance thresholds and calculation rules.
          </p>
        </div>

        <PolicySettingRow
          label="Enforce minimum attendance requirement"
          description="Automatically verify that candidate session attendance meets or exceeds the required percentage before permitting examination entry."
          checked={checkAttendance}
          onChange={setCheckAttendance}
          badge="Core Rule"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextField
              type="number"
              label="Min Attendance %"
              value={minAttendance}
              onChange={(e) => setMinAttendance(e.target.value)}
              min="0"
              max="100"
              step="any"
              required={checkAttendance}
              hint="Percentage of held sessions the student must have attended."
            />

            <TextField
              type="number"
              label="Cutoff Days Prior"
              value={attendanceCutoffDays}
              onChange={(e) => setAttendanceCutoffDays(e.target.value)}
              min="0"
              max="365"
              required={checkAttendance}
              hint="Number of days prior to examination date to evaluate attendance (0 = exam day)."
            />

            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground block">
                Calculation Period
              </label>
              <select
                value={calculationPeriod}
                onChange={(e) => setCalculationPeriod(e.target.value as any)}
                className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
              >
                <option value="FULL_TERM">Full Term Cumulative</option>
                <option value="SEMESTER">Semester Segment</option>
                <option value="CUSTOM">Custom Cutoff Window</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground block">
                Excused Absence Treatment
              </label>
              <select
                value={excusedTreatment}
                onChange={(e) => setExcusedTreatment(e.target.value as any)}
                className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
              >
                <option value="EXEMPT">Exempt from denominator (Does not lower percentage)</option>
                <option value="PRESENT">Count as Present</option>
                <option value="ABSENT">Count as Absent</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground block">
                Late Arrival Treatment
              </label>
              <select
                value={lateTreatment}
                onChange={(e) => setLateTreatment(e.target.value as any)}
                className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
              >
                <option value="PRESENT">Count as Full Present</option>
                <option value="HALF_DAY">Count as 50% Half Day</option>
                <option value="ABSENT">Count as Absent</option>
              </select>
            </div>
          </div>

          <div className="pt-2 border-t border-border/40 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={excludeCancelled}
                onChange={(e) => setExcludeCancelled(e.target.checked)}
                className="rounded border-input text-brand-600 h-4 w-4"
              />
              <span className="text-foreground">Exclude cancelled or unscheduled class sessions</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={prorateLateEnrolment}
                onChange={(e) => setProrateLateEnrolment(e.target.checked)}
                className="rounded border-input text-brand-600 h-4 w-4"
              />
              <span className="text-foreground">Pro-rate attendance for students enrolled mid-term</span>
            </label>
          </div>
        </PolicySettingRow>
      </div>

      {/* SECTION 3: Academic Eligibility */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h4 className="text-base font-bold text-foreground">3. Academic Eligibility</h4>
          <p className="text-xs text-muted">
            Course registration criteria and enrolment validation.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-foreground block">
              Required Enrolment Status
            </label>
            <select
              value={requiredEnrolmentStatus}
              onChange={(e) => setRequiredEnrolmentStatus(e.target.value as any)}
              className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
            >
              <option value="REGISTERED">REGISTERED (Enrolled and rostered)</option>
              <option value="ACTIVE">ACTIVE (Full programme standing)</option>
              <option value="ANY">ANY (Include auditing or conditional students)</option>
            </select>
          </div>

          <TextField
            type="number"
            label="Minimum Enrolment Days Prior"
            value={minEnrolmentDays}
            onChange={(e) => setMinEnrolmentDays(e.target.value)}
            min="0"
            hint="Minimum days a student must have been enrolled in the course offering."
          />
        </div>

        <PolicySettingRow
          label="Allow academic exceptions and prerequisite waivers"
          description="Permit authorized coordinators to review and waive enrollment prerequisites for specific candidates."
          checked={allowAcademicException}
          onChange={setAllowAcademicException}
        />

        <PolicySettingRow
          label="Allow supplementary / re-examination eligibility"
          description="Permit failed or absent candidates to be enrolled in supplementary re-assessment papers."
          checked={supplementaryEligible}
          onChange={setSupplementaryEligible}
        />
      </div>

      {/* SECTION 4: Fee Clearance */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h4 className="text-base font-bold text-foreground">4. Fee Clearance</h4>
          <p className="text-xs text-muted">
            Configure financial clearance checks and permitted outstanding balance tolerances.
          </p>
        </div>

        <PolicySettingRow
          label="Enforce fee clearance requirement"
          description="Verify that students have cleared applicable term tuition and examination dues prior to hall ticket issuance."
          checked={checkFees}
          onChange={setCheckFees}
          badge="Finance Integration"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextField
              type="number"
              label="Balance Tolerance (₹ / Local Currency)"
              value={feeTolerance}
              onChange={(e) => setFeeTolerance(e.target.value)}
              min="0"
              hint="Permitted outstanding balance before flagging candidate for review (e.g. ₹500.00)."
            />

            <TextField
              type="number"
              label="Payment Deadline Days Prior"
              value={feeDeadlineDays}
              onChange={(e) => setFeeDeadlineDays(e.target.value)}
              min="0"
              hint="Dues must be recorded prior to this cutoff window."
            />
          </div>

          <div className="pt-2 border-t border-border/40 space-y-2 text-xs">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowConcessionExemption}
                onChange={(e) => setAllowConcessionExemption(e.target.checked)}
                className="rounded border-input text-brand-600 h-4 w-4"
              />
              <span className="text-foreground">
                Exempt approved scholarship, RTE, and fee concession recipients
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={requirePaymentVerification}
                onChange={(e) => setRequirePaymentVerification(e.target.checked)}
                className="rounded border-input text-brand-600 h-4 w-4"
              />
              <span className="text-foreground">
                Require official finance cashier receipt verification
              </span>
            </label>
          </div>
        </PolicySettingRow>
      </div>

      {/* SECTION 5: Exceptions and Special Cases */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h4 className="text-base font-bold text-foreground">5. Exceptions & Special Cases</h4>
          <p className="text-xs text-muted">
            Manage administrative discretion, medical exemptions, and late enrolment flags.
          </p>
        </div>

        <PolicySettingRow
          label="Flag late or mid-term enrolments for review (NEEDS_REVIEW)"
          description="Enrolments created after session start dates will be flagged for explicit coordinator sign-off rather than automatic disqualification."
          checked={allowLateEnrolmentReview}
          onChange={setAllowLateEnrolmentReview}
        />

        <PolicySettingRow
          label="Allow individual administrative exemptions and overrides"
          description="Authorized school staff can grant conditional approval or medical exemptions directly on candidate rosters with audit logging."
          checked={allowIndividualExemption}
          onChange={setAllowIndividualExemption}
        >
          <div className="space-y-1 max-w-xs">
            <label className="text-xs font-semibold text-foreground block">
              Required Exemption Approver Role
            </label>
            <select
              value={exemptionApproverRole}
              onChange={(e) => setExemptionApproverRole(e.target.value)}
              className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
            >
              <option value="PRINCIPAL">Principal / Head of Institution</option>
              <option value="EXAM_COORDINATOR">Examination Coordinator</option>
              <option value="ADMIN">Platform / School Administrator</option>
            </select>
          </div>
        </PolicySettingRow>
      </div>

      {/* SECTION 6: Examination Components */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2 flex items-center justify-between">
          <div>
            <h4 className="text-base font-bold text-foreground">6. Examination Components</h4>
            <p className="text-xs text-muted">
              Define assessment split (Theory, Practical, Internal, Viva, Project) and weightings.
            </p>
          </div>
          <Button type="button" variant="secondary" onClick={handleAddComponent}>
            + Add Component
          </Button>
        </div>

        <div className="space-y-3">
          {components.map((comp, idx) => (
            <div
              key={idx}
              className="p-3 border border-border rounded-lg bg-surface flex flex-wrap items-center gap-3"
            >
              <div className="flex-1 min-w-[140px]">
                <label className="text-[10px] font-semibold text-muted uppercase block">
                  Component Name
                </label>
                <input
                  type="text"
                  value={comp.name}
                  onChange={(e) => handleUpdateComponent(idx, { name: e.target.value })}
                  className="w-full h-8 px-2 rounded border border-input bg-surface text-xs text-foreground"
                  required
                />
              </div>

              <div className="w-32">
                <label className="text-[10px] font-semibold text-muted uppercase block">Type</label>
                <select
                  value={comp.component_type}
                  onChange={(e) =>
                    handleUpdateComponent(idx, { component_type: e.target.value as any })
                  }
                  className="w-full h-8 px-2 rounded border border-input bg-surface text-xs text-foreground"
                >
                  <option value="THEORY">Theory</option>
                  <option value="PRACTICAL">Practical</option>
                  <option value="INTERNAL">Internal</option>
                  <option value="VIVA">Viva / Oral</option>
                  <option value="ASSIGNMENT">Assignment</option>
                  <option value="PROJECT">Project</option>
                </select>
              </div>

              <div className="w-20">
                <label className="text-[10px] font-semibold text-muted uppercase block">Max Marks</label>
                <input
                  type="number"
                  value={comp.max_marks}
                  onChange={(e) =>
                    handleUpdateComponent(idx, { max_marks: Number(e.target.value) })
                  }
                  className="w-full h-8 px-2 rounded border border-input bg-surface text-xs text-foreground"
                  min="1"
                  required
                />
              </div>

              <div className="w-20">
                <label className="text-[10px] font-semibold text-muted uppercase block">Pass Marks</label>
                <input
                  type="number"
                  value={comp.pass_marks}
                  onChange={(e) =>
                    handleUpdateComponent(idx, { pass_marks: Number(e.target.value) })
                  }
                  className="w-full h-8 px-2 rounded border border-input bg-surface text-xs text-foreground"
                  min="0"
                  required
                />
              </div>

              <div className="w-20">
                <label className="text-[10px] font-semibold text-muted uppercase block">Weight %</label>
                <input
                  type="number"
                  value={comp.weight_percentage}
                  onChange={(e) =>
                    handleUpdateComponent(idx, { weight_percentage: Number(e.target.value) })
                  }
                  className="w-full h-8 px-2 rounded border border-input bg-surface text-xs text-foreground"
                  min="0"
                  max="100"
                  step="any"
                  required
                />
              </div>

              <div className="pt-4">
                <button
                  type="button"
                  onClick={() => handleRemoveComponent(idx)}
                  className="text-xs text-red-600 hover:text-red-700 underline"
                  disabled={components.length <= 1}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between text-xs p-2 rounded bg-surface-muted/30">
            <span className="font-semibold text-foreground">
              Total Weightage: {totalWeightage}%
            </span>
            {totalWeightage !== 100 ? (
              <span className="text-amber-600 font-medium">
                Note: Total component weightage is {totalWeightage}% (recommended: 100%).
              </span>
            ) : (
              <span className="text-emerald-600 font-medium">✓ Total weightage balanced (100%)</span>
            )}
          </div>
        </div>

        <PolicySettingRow
          label="Allow grace marks for borderline candidate cases"
          description="Grant limited moderation marks to candidates failing by a narrow margin."
          checked={allowGraceMarks}
          onChange={setAllowGraceMarks}
        >
          <div className="max-w-xs">
            <TextField
              type="number"
              label="Maximum Grace Marks Permitted"
              value={maxGraceMarks}
              onChange={(e) => setMaxGraceMarks(e.target.value)}
              min="0"
              max="20"
              hint="Up to 20 marks can be conditionally awarded to clear a subject."
            />
          </div>
        </PolicySettingRow>
      </div>

      {/* SECTION 7: Passing and Grading Rules */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h4 className="text-base font-bold text-foreground">7. Passing & Grading Rules</h4>
          <p className="text-xs text-muted">
            Configure institutional grading scale, letter boundaries, and interactive grade preview.
          </p>
        </div>

        <div className="space-y-2 max-w-xs">
          <label className="text-xs font-semibold text-foreground block">Grading System</label>
          <select
            value={gradingSystem}
            onChange={(e) => setGradingSystem(e.target.value as any)}
            className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
          >
            <option value="PERCENTAGE">Percentage Only (0% - 100%)</option>
            <option value="LETTER_GRADE">Letter Grade (A+, A, B, C, D, F)</option>
            <option value="GRADE_POINT">Grade Point Average (10-point GPA scale)</option>
            <option value="MARKS_ONLY">Raw Marks Only</option>
          </select>
        </div>

        {/* Grade scale table */}
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-xs text-left">
            <thead className="bg-surface-muted/50 text-muted uppercase font-semibold">
              <tr>
                <th className="p-2">Grade</th>
                <th className="p-2">Min %</th>
                <th className="p-2">Max %</th>
                <th className="p-2">Grade Point</th>
                <th className="p-2">Description</th>
                <th className="p-2">Passing?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {gradeScale.map((b, idx) => (
                <tr key={idx} className="hover:bg-surface-muted/20">
                  <td className="p-2 font-bold text-foreground">
                    <input
                      type="text"
                      value={b.grade}
                      onChange={(e) => handleGradeBoundaryChange(idx, 'grade', e.target.value)}
                      className="w-12 px-1 py-0.5 rounded border border-input bg-surface text-xs"
                    />
                  </td>
                  <td className="p-2">
                    <input
                      type="number"
                      value={b.min_percentage}
                      onChange={(e) =>
                        handleGradeBoundaryChange(idx, 'min_percentage', Number(e.target.value))
                      }
                      className="w-16 px-1 py-0.5 rounded border border-input bg-surface text-xs"
                      min="0"
                      max="100"
                      step="any"
                    />
                  </td>
                  <td className="p-2">
                    <input
                      type="number"
                      value={b.max_percentage}
                      onChange={(e) =>
                        handleGradeBoundaryChange(idx, 'max_percentage', Number(e.target.value))
                      }
                      className="w-16 px-1 py-0.5 rounded border border-input bg-surface text-xs"
                      min="0"
                      max="100"
                      step="any"
                    />
                  </td>
                  <td className="p-2">
                    <input
                      type="number"
                      value={b.grade_point ?? 0}
                      onChange={(e) =>
                        handleGradeBoundaryChange(idx, 'grade_point', Number(e.target.value))
                      }
                      className="w-14 px-1 py-0.5 rounded border border-input bg-surface text-xs"
                      min="0"
                      max="10"
                      step="0.1"
                    />
                  </td>
                  <td className="p-2">
                    <input
                      type="text"
                      value={b.description ?? ''}
                      onChange={(e) =>
                        handleGradeBoundaryChange(idx, 'description', e.target.value)
                      }
                      className="w-28 px-1 py-0.5 rounded border border-input bg-surface text-xs"
                    />
                  </td>
                  <td className="p-2">
                    <input
                      type="checkbox"
                      checked={b.is_passing}
                      onChange={(e) =>
                        handleGradeBoundaryChange(idx, 'is_passing', e.target.checked)
                      }
                      className="rounded border-input text-brand-600 h-4 w-4"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Interactive Grade Calculator Preview */}
        <div className="p-4 rounded-lg border border-brand-200 bg-brand-50/40 space-y-3">
          <div className="flex items-center justify-between">
            <h5 className="text-xs font-bold uppercase tracking-wider text-brand-800">
              Interactive Grading Scale Preview
            </h5>
            <span className="text-[11px] text-brand-700">Immediate feedback calculator</span>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label htmlFor="sample-score-input" className="text-xs font-semibold text-foreground">
                Test Score (%):
              </label>
              <input
                id="sample-score-input"
                type="number"
                value={sampleScore}
                onChange={(e) => setSampleScore(e.target.value)}
                min="0"
                max="100"
                step="any"
                className="w-20 h-8 px-2 rounded border border-brand-300 bg-surface text-xs font-bold text-foreground"
              />
            </div>
            {calculatedGradePreview ? (
              <div className="flex items-center gap-3 text-xs bg-surface px-3 py-1.5 rounded border border-brand-200 shadow-sm">
                <span>
                  Awarded Grade: <strong>{calculatedGradePreview.grade}</strong> (
                  {calculatedGradePreview.description})
                </span>
                <span>•</span>
                <span>
                  Grade Point: <strong>{calculatedGradePreview.grade_point ?? 'N/A'}</strong>
                </span>
                <span>•</span>
                <span
                  className={`font-bold ${
                    calculatedGradePreview.is_passing ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {calculatedGradePreview.is_passing ? 'PASS' : 'FAIL'}
                </span>
              </div>
            ) : (
              <span className="text-xs text-muted">Enter a percentage to test.</span>
            )}
          </div>
        </div>
      </div>

      {/* SECTION 8: Candidate Approval */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h4 className="text-base font-bold text-foreground">8. Candidate Approval Workflow</h4>
          <p className="text-xs text-muted">
            Configure multi-tier administrative sign-off before candidate rosters are frozen.
          </p>
        </div>

        <PolicySettingRow
          label="Require Examination Coordinator review before candidate list freeze"
          description="Examination coordinator must review and certify generated candidate lists."
          checked={requireCoordinatorReview}
          onChange={setRequireCoordinatorReview}
        />

        <PolicySettingRow
          label="Require Principal final approval"
          description="Principal holds final approval authority on candidate disqualifications and exemptions."
          checked={requirePrincipalApproval}
          onChange={setRequirePrincipalApproval}
        />
      </div>

      {/* SECTION 9: Result Approval Authority & Publication */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h4 className="text-base font-bold text-foreground">9. Results Approval Authority & Publication Workflow</h4>
          <p className="text-xs text-muted">
            Configure institutional governance authority, maker-checker separation rules, and result release workflows.
          </p>
        </div>

        <div className="space-y-3">
          <label className="text-xs font-semibold text-foreground block">
            Results Approval Governance Mode
          </label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div
              onClick={() => setGovernanceMode('PRINCIPAL_FINAL_AUTHORITY')}
              className={`p-3 rounded-lg border cursor-pointer transition-all ${
                governanceMode === 'PRINCIPAL_FINAL_AUTHORITY'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border bg-surface hover:border-border/80'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-foreground">Mode A: Principal Final Authority</span>
                {governanceMode === 'PRINCIPAL_FINAL_AUTHORITY' && (
                  <span className="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">Active</span>
                )}
              </div>
              <p className="text-[11px] text-muted leading-relaxed">
                Principal serves as final academic authority. No mandatory second-person approval required for Principal submitted marks. Suitable for single-administrator institutions.
              </p>
            </div>

            <div
              onClick={() => setGovernanceMode('INDEPENDENT_REVIEW')}
              className={`p-3 rounded-lg border cursor-pointer transition-all ${
                governanceMode === 'INDEPENDENT_REVIEW'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border bg-surface hover:border-border/80'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-foreground">Mode B: Independent Review</span>
                {governanceMode === 'INDEPENDENT_REVIEW' && (
                  <span className="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">Active</span>
                )}
              </div>
              <p className="text-[11px] text-muted leading-relaxed">
                Strict maker-checker separation: Marks submitter and publisher must be distinct authorized actors. Required for schools with formal examination committees.
              </p>
            </div>

            <div
              onClick={() => setGovernanceMode('DELEGATED_APPROVAL')}
              className={`p-3 rounded-lg border cursor-pointer transition-all ${
                governanceMode === 'DELEGATED_APPROVAL'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border bg-surface hover:border-border/80'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-foreground">Mode C: Delegated Authority</span>
                {governanceMode === 'DELEGATED_APPROVAL' && (
                  <span className="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">Active</span>
                )}
              </div>
              <p className="text-[11px] text-muted leading-relaxed">
                Principal authorizes designated leadership roles (Campus Admin, Registrar, HOD) to review and sign off results within their assigned academic scope.
              </p>
            </div>
          </div>
        </div>

        {/* Informative Governance Status Card */}
        <div className="p-3 border border-border/70 rounded-lg bg-surface/50 text-xs">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-foreground">Active Authority Summary:</span>
            <span className="font-mono text-[11px] bg-surface border border-border px-1.5 py-0.5 rounded">
              {governanceMode}
            </span>
          </div>
          {governanceMode === 'PRINCIPAL_FINAL_AUTHORITY' ? (
            <p className="text-muted text-[11px]">
              The Principal may enter marks, submit them, authorize corrections, and directly publish results. Faculty members require Principal review. All actions are immutably logged with audit risk tier 2.
            </p>
          ) : governanceMode === 'INDEPENDENT_REVIEW' ? (
            <p className="text-muted text-[11px]">
              Independent sign-off is mandatory. The user who submitted paper marks cannot authorize or publish results. An independent administrator or coordinator must certify the candidate list and marks register.
            </p>
          ) : (
            <p className="text-muted text-[11px]">
              Results approval is delegated to assigned roles: Principal, Campus Administrator, Registrar, Department Admin, and HOD.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-foreground block">
              Policy Effective Date
            </label>
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
            />
            <span className="text-[10px] text-muted">
              Documented date from which this governance configuration takes effect.
            </span>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-foreground block">
              Administrative Governance Notes
            </label>
            <input
              type="text"
              placeholder="e.g. Approved by School Academic Board for 2026-27"
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.target.value)}
              className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
            />
          </div>
        </div>

        {governanceMode !== 'PRINCIPAL_FINAL_AUTHORITY' && (
          <div className="space-y-1 max-w-sm pt-2">
            <label className="text-xs font-semibold text-foreground block">
              Intermediate Review Workflow
            </label>
            <select
              value={resultsWorkflow}
              onChange={(e) => setResultsWorkflow(e.target.value as any)}
              className="w-full h-9 px-2 rounded-md border border-input bg-surface text-xs text-foreground"
            >
              <option value="DRAFT_REVIEW_PUBLISH">
                Draft &rarr; Independent Review & Sign-Off &rarr; Verified Publish
              </option>
              <option value="DIRECT_PUBLISH">
                Direct Publish (Without intermediate draft review stage)
              </option>
            </select>
          </div>
        )}

        {onSimulateImpact && (
          <div className="p-3 border border-border rounded-lg bg-surface flex items-center justify-between">
            <div>
              <span className="text-xs font-bold text-foreground block">
                Simulate Policy Impact
              </span>
              <span className="text-[11px] text-muted block">
                Preview how this policy would evaluate currently enrolled candidates without modifying database state.
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={simulating}
              onClick={async () => {
                setSimulating(true);
                try {
                  const payload: SaveEligibilityPolicyInput = {
                    name,
                    description,
                    scope,
                    status,
                    min_attendance_percentage: Number(minAttendance),
                    check_attendance: checkAttendance,
                    check_fees: checkFees,
                    attendance_cutoff_days_prior: Number(attendanceCutoffDays),
                    allow_late_enrolment_review: allowLateEnrolmentReview,
                    attendance_rules: {
                      calculation_period: calculationPeriod,
                      excused_treatment: excusedTreatment,
                      late_treatment: lateTreatment,
                      cancelled_sessions_excluded: excludeCancelled,
                      prorate_late_enrolment: prorateLateEnrolment,
                      min_sessions: 0,
                      allow_exemption: allowIndividualExemption,
                      exemption_approver_role: exemptionApproverRole,
                    },
                    fee_rules: {
                      max_balance_tolerance: Number(feeTolerance),
                      allow_concession_exemption: allowConcessionExemption,
                      deadline_days_prior: Number(feeDeadlineDays),
                      require_payment_verification: requirePaymentVerification,
                    },
                    academic_rules: {
                      required_enrolment_status: requiredEnrolmentStatus,
                      min_enrolment_days: Number(minEnrolmentDays),
                      allow_academic_exception: allowAcademicException,
                      supplementary_eligible: supplementaryEligible,
                    },
                    assessment_rules: {
                      components,
                      allow_grace_marks: allowGraceMarks,
                      max_grace_marks: Number(maxGraceMarks),
                    },
                    grading_rules: {
                      grading_system: gradingSystem,
                      grade_scale: gradeScale,
                    },
                    approval_rules: {
                      governance_mode: governanceMode,
                      require_coordinator_review: requireCoordinatorReview,
                      require_principal_approval: requirePrincipalApproval,
                      allow_individual_override: allowIndividualExemption,
                      results_workflow:
                        governanceMode === 'PRINCIPAL_FINAL_AUTHORITY'
                          ? 'DIRECT_PUBLISH'
                          : resultsWorkflow,
                      delegated_roles: [
                        'COLLEGE_ADMIN',
                        'CAMPUS_ADMIN',
                        'REGISTRAR',
                        'DEPARTMENT_ADMIN',
                        'HOD',
                      ],
                      effective_date: effectiveDate,
                      notes: approvalNotes || undefined,
                    },
                  };
                  await onSimulateImpact(payload);
                } finally {
                  setSimulating(false);
                }
              }}
            >
              {simulating ? 'Simulating...' : 'Simulate Policy Impact'}
            </Button>
          </div>
        )}
      </div>

      {/* Action Footer */}
      <div className="flex items-center justify-end gap-3 pt-6 border-t border-border">
        {onCancel && (
          <Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving...' : 'Save Policy'}
        </Button>
      </div>
    </form>
  );

  if (isModal) {
    return (
      <div
        className="modal-card"
        style={{
          backgroundColor: 'var(--color-surface, #ffffff)',
          borderRadius: 'var(--radius-card, 0.5rem)',
          padding: 'var(--space-6, 1.5rem)',
          maxWidth: '48rem',
          width: '100%',
          boxShadow: 'var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1))',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-dialog-title"
      >
        <h3 id="policy-dialog-title" className="text-lg font-bold mb-1 text-foreground">
          {title}
        </h3>
        <p className="text-xs text-muted mb-4">{subtitle}</p>
        {content}
      </div>
    );
  }

  return (
    <div className="card p-6">
      <div className="mb-6">
        <h3 id="policy-dialog-title" className="text-xl font-bold text-foreground">
          {title}
        </h3>
        <p className="text-xs text-muted">{subtitle}</p>
      </div>
      {content}
    </div>
  );
}
