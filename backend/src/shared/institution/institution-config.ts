import { AppError } from '../errors/http-errors.js';
import type { TenantTx } from '../database/index.js';

export type InstitutionType = 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';

export interface InstitutionTerminology {
  level: string;
  leaderTitle: string;
  educatorTitle: string;
  cohortTerm: string;
  courseTerm: string;
  assessmentTerm: string;
  assignmentTerm: string;
  feeTerm: string;
  gradingScheme: 'MARKS_PERCENTAGE' | 'PERCENTAGE_CREDITS' | 'GPA_CGPA';
}

export const INSTITUTION_TERMINOLOGY: Record<InstitutionType, InstitutionTerminology> = {
  SCHOOL: {
    level: 'Primary / Secondary School',
    leaderTitle: 'Principal',
    educatorTitle: 'Teacher',
    cohortTerm: 'Class & Section',
    courseTerm: 'Subject',
    assessmentTerm: 'Examination',
    assignmentTerm: 'Homework',
    feeTerm: 'School Fees',
    gradingScheme: 'MARKS_PERCENTAGE',
  },
  COLLEGE: {
    level: 'Undergraduate College / Institute',
    leaderTitle: 'Dean / Principal',
    educatorTitle: 'Lecturer / Assistant Professor',
    cohortTerm: 'Program & Semester / Batch',
    courseTerm: 'Course / Paper',
    assessmentTerm: 'Semester Exam / Mid-term',
    assignmentTerm: 'Assignment / Coursework',
    feeTerm: 'Tuition & College Fees',
    gradingScheme: 'PERCENTAGE_CREDITS',
  },
  UNIVERSITY: {
    level: 'Autonomous University / Postgraduate Institute',
    leaderTitle: 'Vice-Chancellor / Chancellor',
    educatorTitle: 'Professor / Chair',
    cohortTerm: 'Faculty / Program / Cohort',
    courseTerm: 'Module / Course',
    assessmentTerm: 'Comprehensive Assessment',
    assignmentTerm: 'Coursework / Project',
    feeTerm: 'University Tuition & Dues',
    gradingScheme: 'GPA_CGPA',
  },
};

/**
 * Returns the terminology configuration for an institution type.
 */
export function getInstitutionTerminology(type: InstitutionType = 'SCHOOL'): InstitutionTerminology {
  return INSTITUTION_TERMINOLOGY[type] || INSTITUTION_TERMINOLOGY.SCHOOL;
}

/**
 * Calculates academic grade and performance metrics based on institution type.
 */
export interface CourseScoreInput {
  courseId: string;
  courseName: string;
  credits?: number;
  maxMarks: number;
  obtainedMarks: number;
}

export interface AcademicEvaluationOutput {
  scheme: 'MARKS_PERCENTAGE' | 'PERCENTAGE_CREDITS' | 'GPA_CGPA';
  totalMaxMarks: number;
  totalObtainedMarks: number;
  percentage: number;
  letterGrade: string;
  gradePoints?: number;
  sgpa?: number;
  totalCredits?: number;
  passed: boolean;
}

export function calculateAcademicStanding(
  institutionType: InstitutionType,
  scores: CourseScoreInput[],
): AcademicEvaluationOutput {
  if (scores.length === 0) {
    return {
      scheme: INSTITUTION_TERMINOLOGY[institutionType].gradingScheme,
      totalMaxMarks: 0,
      totalObtainedMarks: 0,
      percentage: 0,
      letterGrade: 'N/A',
      passed: true,
    };
  }

  let totalMax = 0;
  let totalObtained = 0;
  let totalCredits = 0;
  let totalWeightedGradePoints = 0;

  for (const s of scores) {
    totalMax += s.maxMarks;
    totalObtained += s.obtainedMarks;
    const itemPct = s.maxMarks > 0 ? (s.obtainedMarks / s.maxMarks) * 100 : 0;
    const credits = s.credits ?? 3;
    totalCredits += credits;

    // 10-point scale grade points
    let gp = 0;
    if (itemPct >= 90) gp = 10;
    else if (itemPct >= 80) gp = 9;
    else if (itemPct >= 70) gp = 8;
    else if (itemPct >= 60) gp = 7;
    else if (itemPct >= 50) gp = 6;
    else if (itemPct >= 40) gp = 5;
    else gp = 0;

    totalWeightedGradePoints += gp * credits;
  }

  const overallPercentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 10000) / 100 : 0;

  // Grade determination
  let letterGrade = 'F';
  if (overallPercentage >= 90) letterGrade = 'A+';
  else if (overallPercentage >= 80) letterGrade = 'A';
  else if (overallPercentage >= 70) letterGrade = 'B';
  else if (overallPercentage >= 60) letterGrade = 'C';
  else if (overallPercentage >= 50) letterGrade = 'D';
  else letterGrade = 'F';

  const passed = overallPercentage >= 40;

  if (institutionType === 'UNIVERSITY') {
    const sgpa = totalCredits > 0 ? Math.round((totalWeightedGradePoints / totalCredits) * 100) / 100 : 0;
    return {
      scheme: 'GPA_CGPA',
      totalMaxMarks: totalMax,
      totalObtainedMarks: totalObtained,
      percentage: overallPercentage,
      letterGrade,
      gradePoints: Math.round((overallPercentage / 10) * 10) / 10,
      sgpa,
      totalCredits,
      passed,
    };
  }

  if (institutionType === 'COLLEGE') {
    return {
      scheme: 'PERCENTAGE_CREDITS',
      totalMaxMarks: totalMax,
      totalObtainedMarks: totalObtained,
      percentage: overallPercentage,
      letterGrade,
      totalCredits,
      passed,
    };
  }

  // SCHOOL
  return {
    scheme: 'MARKS_PERCENTAGE',
    totalMaxMarks: totalMax,
    totalObtainedMarks: totalObtained,
    percentage: overallPercentage,
    letterGrade,
    passed,
  };
}

/**
 * Adult Student Privacy Guard:
 * Under higher education regulations (FERPA, GDPR, Indian Higher Ed Norms), once a student
 * reaches adulthood (age >= 18) or is enrolled in a College/University, parents/guardians
 * cannot unilaterally access their academic, attendance, or sensitive records without explicit
 * active student authorization (`app.adult_guardian_consents`).
 */
export async function assertGuardianAccessAuthorized(
  tx: TenantTx,
  tenantId: string,
  studentId: string,
  guardianUserId: string,
  scope: 'ALL' | 'ACADEMICS_ONLY' | 'FINANCE_ONLY' = 'ALL',
): Promise<void> {
  // 1. Fetch organization institution type
  const orgRes = await tx.query<{ institution_type: string }>(
    `SELECT COALESCE(institution_type, 'SCHOOL') AS institution_type
       FROM app.organizations
      WHERE id = $1`,
    [tenantId],
  );
  const institutionType = (orgRes.rows[0]?.institution_type || 'SCHOOL') as InstitutionType;

  // 2. Fetch student details including date of birth
  const studentRes = await tx.query<{
    user_id: string;
    date_of_birth: string | null;
  }>(
    `SELECT s.user_id, u.date_of_birth::text AS date_of_birth
       FROM app.students s
       JOIN app.users u ON u.id = s.user_id AND u.organization_id = s.organization_id
      WHERE s.organization_id = $1 AND s.id = $2`,
    [tenantId, studentId],
  );

  if (!studentRes.rows[0]) {
    throw new AppError(404, 'NOT_FOUND', 'Student record not found.');
  }

  const dobStr = studentRes.rows[0].date_of_birth;
  let isAdult = false;

  if (dobStr) {
    const dob = new Date(dobStr);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    if (age >= 18) {
      isAdult = true;
    }
  }

  // In Colleges and Universities, students are presumed adults by default unless proven otherwise
  if (institutionType === 'COLLEGE' || institutionType === 'UNIVERSITY') {
    isAdult = true;
  }

  // If the student is a minor in a School, standard parental custody applies
  if (!isAdult) {
    return;
  }

  // 3. For adult students, check for active student consent
  const consentRes = await tx.query<{
    id: string;
    status: string;
    consent_scope: string;
  }>(
    `SELECT agc.id, agc.status, agc.consent_scope
       FROM app.adult_guardian_consents agc
       JOIN app.guardians g ON g.id = agc.guardian_id AND g.organization_id = agc.organization_id
      WHERE agc.organization_id = $1
        AND agc.student_id = $2
        AND g.user_id = $3
        AND agc.status = 'ACTIVE'
        AND (agc.consent_scope = 'ALL' OR agc.consent_scope = $4)
        AND (agc.expires_at IS NULL OR agc.expires_at > clock_timestamp())`,
    [tenantId, studentId, guardianUserId, scope],
  );

  if (consentRes.rows.length === 0) {
    throw new AppError(
      403,
      'ADULT_STUDENT_PRIVACY_RESTRICTION',
      `Access to this adult student's records is restricted under privacy protection regulations. Explicit student consent is required.`,
    );
  }
}
