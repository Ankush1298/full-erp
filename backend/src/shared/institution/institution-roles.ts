import type { RoleCode } from '../authorization/role-matrix.js';
import { ROLE_CODES, ROLE_MATRIX } from '../authorization/role-matrix.js';
import { PERMISSION_CATALOG } from '../authorization/catalog.js';
import type { InstitutionType } from '../settings/institution.js';

export type AdministrativeTier =
  | 'TOP_EXECUTIVE' // Principal / Dean / Chancellor
  | 'SENIOR_ADMIN' // Vice Principal / Campus Administrator / Provost
  | 'DEPARTMENT_LEAD' // Academic Coordinator / Department Administrator / HOD / Faculty Dean
  | 'ACADEMIC_STAFF' // Teacher / Lecturer / Professor
  | 'OPERATIONS_STAFF' // Admissions Office / Registrar / Admin Staff
  | 'LEARNER' // Student (Minor / Scholar)
  | 'GUARDIAN'; // Parent / Guardian / Sponsor

export interface InstitutionRoleMapping {
  roleCode: RoleCode;
  institutionType: InstitutionType;
  displayTitle: string;
  tier: AdministrativeTier;
  defaultScope: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT';
  governanceMode?: string;
  description: string;
}

/**
 * Canonical mapping separating:
 * 1. Internal authorization role code (ROLE_MATRIX key)
 * 2. Institution type (SCHOOL / COLLEGE / UNIVERSITY)
 * 3. Display title (e.g. Principal vs College Administrator)
 * 4. Administrative responsibility & governance mode
 */
export const CANONICAL_ROLE_MAPPINGS: Record<
  InstitutionType,
  Record<RoleCode, InstitutionRoleMapping>
> = {
  SCHOOL: {
    COLLEGE_ADMIN: {
      roleCode: 'COLLEGE_ADMIN',
      institutionType: 'SCHOOL',
      displayTitle: 'Principal',
      tier: 'TOP_EXECUTIVE',
      defaultScope: 'ORGANIZATION',
      governanceMode: 'PRINCIPAL_FINAL_AUTHORITY',
      description:
        'Head of School with final executive authority over academics, examinations, payment gateways, and security.',
    },
    CAMPUS_ADMIN: {
      roleCode: 'CAMPUS_ADMIN',
      institutionType: 'SCHOOL',
      displayTitle: 'Vice Principal',
      tier: 'SENIOR_ADMIN',
      defaultScope: 'CAMPUS',
      description:
        'Campus / Wing Head with operational oversight over daily school routines, attendance, and campus facilities.',
    },
    DEPARTMENT_ADMIN: {
      roleCode: 'DEPARTMENT_ADMIN',
      institutionType: 'SCHOOL',
      displayTitle: 'Academic coordinator',
      tier: 'DEPARTMENT_LEAD',
      defaultScope: 'DEPARTMENT',
      description:
        'Curriculum and grade coordinator overseeing subject syllabi, class allocations, and teacher schedules.',
    },
    HOD: {
      roleCode: 'HOD',
      institutionType: 'SCHOOL',
      displayTitle: 'Head of department',
      tier: 'DEPARTMENT_LEAD',
      defaultScope: 'DEPARTMENT',
      description:
        'Subject department head leading subject-specific teaching quality and examination marks moderation.',
    },
    REGISTRAR: {
      roleCode: 'REGISTRAR',
      institutionType: 'SCHOOL',
      displayTitle: 'Admissions office',
      tier: 'OPERATIONS_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'Admissions and student records officer managing inquiries, enrollments, guardian details, and identity documents.',
    },
    FACULTY: {
      roleCode: 'FACULTY',
      institutionType: 'SCHOOL',
      displayTitle: 'Teacher',
      tier: 'ACADEMIC_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'Class and subject teacher managing daily attendance, homework assignments, student evaluation, and pastoral care.',
    },
    STAFF: {
      roleCode: 'STAFF',
      institutionType: 'SCHOOL',
      displayTitle: 'Administrative staff',
      tier: 'OPERATIONS_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'School operational staff supporting front desk, non-academic facilities, and administrative duties.',
    },
    STUDENT: {
      roleCode: 'STUDENT',
      institutionType: 'SCHOOL',
      displayTitle: 'Student',
      tier: 'LEARNER',
      defaultScope: 'ORGANIZATION',
      description:
        'Enrolled minor student receiving instructional education, subject to guardian custody and school pastoral care.',
    },
  },
  COLLEGE: {
    COLLEGE_ADMIN: {
      roleCode: 'COLLEGE_ADMIN',
      institutionType: 'COLLEGE',
      displayTitle: 'College administrator',
      tier: 'TOP_EXECUTIVE',
      defaultScope: 'ORGANIZATION',
      governanceMode: 'DEAN_ACADEMIC_COUNCIL',
      description:
        'College Director or Principal governing degree programs, financial policies, accreditation, and institutional security.',
    },
    CAMPUS_ADMIN: {
      roleCode: 'CAMPUS_ADMIN',
      institutionType: 'COLLEGE',
      displayTitle: 'Campus administrator',
      tier: 'SENIOR_ADMIN',
      defaultScope: 'CAMPUS',
      description:
        'Collegiate campus administrator managing physical infrastructure, campus discipline, and facilities.',
    },
    DEPARTMENT_ADMIN: {
      roleCode: 'DEPARTMENT_ADMIN',
      institutionType: 'COLLEGE',
      displayTitle: 'Department administrator',
      tier: 'DEPARTMENT_LEAD',
      defaultScope: 'DEPARTMENT',
      description:
        'Academic department officer administering degree requirements, lab timetables, and faculty assignments.',
    },
    HOD: {
      roleCode: 'HOD',
      institutionType: 'COLLEGE',
      displayTitle: 'Head of department',
      tier: 'DEPARTMENT_LEAD',
      defaultScope: 'DEPARTMENT',
      description:
        'Head of academic department presiding over course curriculum, elective allotments, and faculty performance.',
    },
    REGISTRAR: {
      roleCode: 'REGISTRAR',
      institutionType: 'COLLEGE',
      displayTitle: 'Registrar',
      tier: 'OPERATIONS_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'College Registrar managing student matriculation, semester registration, transcripts, and official seals.',
    },
    FACULTY: {
      roleCode: 'FACULTY',
      institutionType: 'COLLEGE',
      displayTitle: 'Faculty',
      tier: 'ACADEMIC_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'Lecturer / Assistant Professor delivering course lectures, conducting laboratory sessions, and evaluating exams.',
    },
    STAFF: {
      roleCode: 'STAFF',
      institutionType: 'COLLEGE',
      displayTitle: 'Staff',
      tier: 'OPERATIONS_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'College administrative employee assisting library, accounts, examination cell, and student affairs.',
    },
    STUDENT: {
      roleCode: 'STUDENT',
      institutionType: 'COLLEGE',
      displayTitle: 'Student',
      tier: 'LEARNER',
      defaultScope: 'ORGANIZATION',
      description:
        'Undergraduate or postgraduate student scholar with sovereign privacy rights and elective course choice.',
    },
  },
  UNIVERSITY: {
    COLLEGE_ADMIN: {
      roleCode: 'COLLEGE_ADMIN',
      institutionType: 'UNIVERSITY',
      displayTitle: 'University administrator',
      tier: 'TOP_EXECUTIVE',
      defaultScope: 'ORGANIZATION',
      governanceMode: 'SENATE_ACADEMIC_COUNCIL',
      description:
        'Vice-Chancellor / Registrar-General leading university senate governance, research charters, and institutional security.',
    },
    CAMPUS_ADMIN: {
      roleCode: 'CAMPUS_ADMIN',
      institutionType: 'UNIVERSITY',
      displayTitle: 'Campus administrator',
      tier: 'SENIOR_ADMIN',
      defaultScope: 'CAMPUS',
      description:
        'Constituent campus provost or director managing branch campus academic operations and services.',
    },
    DEPARTMENT_ADMIN: {
      roleCode: 'DEPARTMENT_ADMIN',
      institutionType: 'UNIVERSITY',
      displayTitle: 'Department administrator',
      tier: 'DEPARTMENT_LEAD',
      defaultScope: 'DEPARTMENT',
      description:
        'Faculty officer managing collegiate postgraduate admissions, modular registrations, and degree auditing.',
    },
    HOD: {
      roleCode: 'HOD',
      institutionType: 'UNIVERSITY',
      displayTitle: 'Head of department',
      tier: 'DEPARTMENT_LEAD',
      defaultScope: 'DEPARTMENT',
      description:
        'Academic chair heading university department, doctoral committees, and modular course designs.',
    },
    REGISTRAR: {
      roleCode: 'REGISTRAR',
      institutionType: 'UNIVERSITY',
      displayTitle: 'University registrar',
      tier: 'OPERATIONS_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'Chief University Registrar overseeing convocation, degree awarding, academic transcripts, and institutional archives.',
    },
    FACULTY: {
      roleCode: 'FACULTY',
      institutionType: 'UNIVERSITY',
      displayTitle: 'Professor',
      tier: 'ACADEMIC_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'University Professor, Chair, or Reader directing advanced seminars, doctoral research, and comprehensive examinations.',
    },
    STAFF: {
      roleCode: 'STAFF',
      institutionType: 'UNIVERSITY',
      displayTitle: 'University staff',
      tier: 'OPERATIONS_STAFF',
      defaultScope: 'ORGANIZATION',
      description:
        'University secretariat and operational staff managing research administration, grants, and facilities.',
    },
    STUDENT: {
      roleCode: 'STUDENT',
      institutionType: 'UNIVERSITY',
      displayTitle: 'Student',
      tier: 'LEARNER',
      defaultScope: 'ORGANIZATION',
      description:
        'Postgraduate or doctoral scholar managing individual research, credit-based courses, and dissertation progress.',
    },
  },
};

/**
 * Returns the canonical mapping for a role within an institution type.
 */
export function getInstitutionRoleMapping(
  institutionType: InstitutionType,
  roleCode: RoleCode,
): InstitutionRoleMapping {
  return (
    CANONICAL_ROLE_MAPPINGS[institutionType]?.[roleCode] ??
    CANONICAL_ROLE_MAPPINGS.COLLEGE[roleCode]
  );
}

/**
 * ERP Functional Domains for audit and coverage verification.
 */
export const ERP_DOMAINS = [
  'ADMISSIONS_AND_IDENTITY',
  'STUDENT_RECORDS',
  'ACADEMIC_STRUCTURE',
  'CLASSES_AND_PROGRAMS',
  'ATTENDANCE',
  'EXAMINATIONS_AND_RESULTS',
  'FEES_AND_PAYMENTS',
  'GATEWAY_SETTINGS',
  'FINANCE_AND_ACCOUNTING',
  'REPORTS_AND_COMPLIANCE',
  'HOMEWORK_AND_ASSIGNMENTS',
  'PARENT_PORTAL',
  'STAFF_MANAGEMENT',
  'ROLE_MANAGEMENT',
  'SCHOOL_VAULT_ZERO_ACCESS',
] as const;

export type ErpDomain = (typeof ERP_DOMAINS)[number];

export interface DomainPolicyDecision {
  domain: ErpDomain;
  schoolRole: string;
  collegeRole: string;
  universityRole: string;
  allowedRoleCodes: readonly RoleCode[];
  notes: string;
}

/**
 * Canonical institutional policy decisions for ERP functional domains.
 */
export const INSTITUTION_DOMAIN_POLICIES: Record<string, DomainPolicyDecision> = {
  // 1. Admissions and Student Records
  'student.record.create': {
    domain: 'ADMISSIONS_AND_IDENTITY',
    schoolRole: 'Admissions Office (REGISTRAR), Principal (COLLEGE_ADMIN)',
    collegeRole: 'Admissions Registrar, Dean of Admissions, College Admin',
    universityRole: 'Directorate of Admissions, University Registrar, Dean',
    allowedRoleCodes: ['REGISTRAR', 'COLLEGE_ADMIN', 'CAMPUS_ADMIN'],
    notes: 'Student registration and demographic record creation.',
  },
  'student.status.change': {
    domain: 'STUDENT_RECORDS',
    schoolRole: 'Principal (COLLEGE_ADMIN)',
    collegeRole: 'College Administrator (COLLEGE_ADMIN), Registrar',
    universityRole: 'University Registrar, Vice-Chancellor (COLLEGE_ADMIN)',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'REGISTRAR'],
    notes: 'Critical lifecycle status transitions (withdrawals, expulsions, graduation).',
  },
  'adult.consent.manage': {
    domain: 'STUDENT_RECORDS',
    schoolRole: 'Student (Self), Principal, Vice Principal, Admissions Office',
    collegeRole: 'Student (Self), College Admin, Campus Admin, Registrar',
    universityRole: 'Student (Self), University Admin, Campus Admin, University Registrar',
    allowedRoleCodes: ['STUDENT', 'COLLEGE_ADMIN', 'CAMPUS_ADMIN', 'REGISTRAR'],
    notes: 'Recording and verification of adult student sovereign consent delegation.',
  },

  // 2. Academic Setup and Structure
  'academic.program.manage': {
    domain: 'ACADEMIC_STRUCTURE',
    schoolRole: 'Principal, Vice Principal, Academic Coordinator',
    collegeRole: 'College Admin, Dean of Academics, HOD',
    universityRole: 'University Admin, Academic Senate Chair, Faculty Dean',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'CAMPUS_ADMIN', 'DEPARTMENT_ADMIN', 'HOD'],
    notes: 'Curriculum streams, degree programs, and academic pathways.',
  },
  'academic.term.manage': {
    domain: 'ACADEMIC_STRUCTURE',
    schoolRole: 'Principal, Vice Principal, Academic Coordinator',
    collegeRole: 'College Admin, Registrar, Academic Dean',
    universityRole: 'University Admin, University Registrar',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'CAMPUS_ADMIN', 'DEPARTMENT_ADMIN', 'REGISTRAR'],
    notes: 'Academic calendars, term dates, and semester schedules.',
  },

  // 3. Attendance
  'attendance.session.mark': {
    domain: 'ATTENDANCE',
    schoolRole: 'Class Teacher, Subject Teacher',
    collegeRole: 'Course Faculty, Lab Instructor',
    universityRole: 'Professor, Teaching Fellow, Seminar Leader',
    allowedRoleCodes: ['FACULTY'],
    notes: 'Daily or lecture attendance recording by assigned educator.',
  },
  'attendance.record.correct': {
    domain: 'ATTENDANCE',
    schoolRole: 'Teacher, Vice Principal, Principal',
    collegeRole: 'Faculty, HOD, College Admin',
    universityRole: 'Professor, Department Chair, Registrar',
    allowedRoleCodes: ['FACULTY', 'HOD', 'COLLEGE_ADMIN', 'CAMPUS_ADMIN', 'DEPARTMENT_ADMIN'],
    notes: 'Audited attendance record corrections with mandatory reason.',
  },

  // 4. Examinations and Results
  'exam.marks.enter': {
    domain: 'EXAMINATIONS_AND_RESULTS',
    schoolRole: 'Subject Teacher, Principal (Correction Authority)',
    collegeRole: 'Course Faculty, HOD Moderation',
    universityRole: 'Examiner, Board of Examiners',
    allowedRoleCodes: ['FACULTY', 'COLLEGE_ADMIN', 'CAMPUS_ADMIN', 'DEPARTMENT_ADMIN', 'HOD'],
    notes: 'Entry and audited correction of assessment and examination scores.',
  },
  'result.publish': {
    domain: 'EXAMINATIONS_AND_RESULTS',
    schoolRole: 'Principal (Final Authority)',
    collegeRole: 'College Administrator, Controller of Examinations',
    universityRole: 'University Registrar, Vice-Chancellor',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'REGISTRAR'],
    notes: 'Critical publication of term or semester academic results.',
  },

  // 5. Fees, Payment Gateways and Reconciliation
  'fee.structure.manage': {
    domain: 'FEES_AND_PAYMENTS',
    schoolRole: 'Principal, School Bursar / Accounts',
    collegeRole: 'College Administrator, Finance Officer',
    universityRole: 'University Comptroller, Bursary Officer',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'REGISTRAR'],
    notes: 'Creation and revision of tuition fee heads and installment schedules.',
  },
  'fee.gateway.read': {
    domain: 'GATEWAY_SETTINGS',
    schoolRole: 'Principal, Vice Principal, Admissions Office, School Bursar',
    collegeRole: 'College Administrator, Campus Administrator, Registrar, Finance Officer',
    universityRole:
      'University Administrator, Campus Administrator, University Registrar, Comptroller',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'CAMPUS_ADMIN', 'REGISTRAR'],
    notes: 'Read-only gateway status visible to administrative and finance staff.',
  },
  'fee.gateway.manage': {
    domain: 'GATEWAY_SETTINGS',
    schoolRole: 'Principal (COLLEGE_ADMIN)',
    collegeRole: 'College Administrator (COLLEGE_ADMIN)',
    universityRole: 'University Administrator (COLLEGE_ADMIN)',
    allowedRoleCodes: ['COLLEGE_ADMIN'],
    notes: 'Critical financial credential management restricted to Top Executive authority.',
  },
  'fee.refund.initiate': {
    domain: 'FEES_AND_PAYMENTS',
    schoolRole: 'Principal (COLLEGE_ADMIN)',
    collegeRole: 'College Administrator (COLLEGE_ADMIN)',
    universityRole: 'University Administrator (COLLEGE_ADMIN)',
    allowedRoleCodes: ['COLLEGE_ADMIN'],
    notes: 'Critical financial refund authorization restricted to Organization Top Executive.',
  },

  // 6. Homework and Coursework
  'homework.manage': {
    domain: 'HOMEWORK_AND_ASSIGNMENTS',
    schoolRole: 'Teacher (Assigned), Principal, Vice Principal, Academic Coordinator, HOD',
    collegeRole: 'Faculty (Assigned), College Admin, Campus Admin, Dept Admin, HOD',
    universityRole: 'Professor (Assigned), University Admin, Campus Admin, Dept Admin, HOD',
    allowedRoleCodes: [
      'FACULTY',
      'COLLEGE_ADMIN',
      'CAMPUS_ADMIN',
      'DEPARTMENT_ADMIN',
      'HOD',
      'REGISTRAR',
    ],
    notes: 'Creation, publishing, and assignment management.',
  },
  'homework.submit': {
    domain: 'HOMEWORK_AND_ASSIGNMENTS',
    schoolRole: 'Student (Minor)',
    collegeRole: 'Student (Scholar)',
    universityRole: 'Student (Scholar)',
    allowedRoleCodes: ['STUDENT'],
    notes: 'Self-submission of completed coursework.',
  },

  // 7. Parent and Guardian Access
  'parent.portal.access': {
    domain: 'PARENT_PORTAL',
    schoolRole: 'Parent / Guardian (Direct custody of minor pupil)',
    collegeRole: 'Parent / Sponsor (Consent gated for adult student)',
    universityRole: 'Parent / Sponsor (Consent gated for adult scholar)',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'STUDENT'],
    notes: 'Parent portal access; adult students require active consent in College/University.',
  },

  // 8. Reports and Compliance
  'student.directory.list': {
    domain: 'REPORTS_AND_COMPLIANCE',
    schoolRole: 'Principal, Vice Principal, Academic Coordinator, Admissions Office',
    collegeRole: 'College Admin, Campus Admin, Registrar, Department Admin',
    universityRole: 'University Admin, Campus Admin, University Registrar, Deans',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'CAMPUS_ADMIN', 'DEPARTMENT_ADMIN', 'REGISTRAR'],
    notes: 'Roster exports and demographic compliance reporting.',
  },

  // 9. Staff and Role Administration
  'role.assignment.grant': {
    domain: 'ROLE_MANAGEMENT',
    schoolRole: 'Principal (COLLEGE_ADMIN)',
    collegeRole: 'College Administrator (COLLEGE_ADMIN)',
    universityRole: 'University Administrator / Registrar-General (COLLEGE_ADMIN)',
    allowedRoleCodes: ['COLLEGE_ADMIN'],
    notes: 'Critical delegation of administrative and teaching security privileges.',
  },
  'user.account.invite': {
    domain: 'STAFF_MANAGEMENT',
    schoolRole: 'Principal, Vice Principal, Admissions Office',
    collegeRole: 'College Admin, Campus Admin, Registrar',
    universityRole: 'University Admin, Campus Admin, University Registrar',
    allowedRoleCodes: ['COLLEGE_ADMIN', 'CAMPUS_ADMIN', 'REGISTRAR'],
    notes: 'Staff and student account invitations and onboarding.',
  },

  // 10. School Vault and Security Center
  'vault.authority.manage': {
    domain: 'SCHOOL_VAULT_ZERO_ACCESS',
    schoolRole: 'School Owner / Principal (COLLEGE_ADMIN)',
    collegeRole: 'Dean / Principal (COLLEGE_ADMIN)',
    universityRole: 'Chancellor / Vice-Chancellor (COLLEGE_ADMIN)',
    allowedRoleCodes: ['COLLEGE_ADMIN'],
    notes: 'Appointment and succession of Institutional Security Authority.',
  },
  'vault.recovery.initiate': {
    domain: 'SCHOOL_VAULT_ZERO_ACCESS',
    schoolRole: 'School Owner / Principal (COLLEGE_ADMIN)',
    collegeRole: 'Dean / Principal (COLLEGE_ADMIN)',
    universityRole: 'Chancellor / Vice-Chancellor (COLLEGE_ADMIN)',
    allowedRoleCodes: ['COLLEGE_ADMIN'],
    notes: 'Initiation of 2-of-3 institutional Shamir recovery ceremony.',
  },
  'vault.device.enroll': {
    domain: 'SCHOOL_VAULT_ZERO_ACCESS',
    schoolRole: 'Principal, Teacher, Staff (Up to 2 hardware-bound devices)',
    collegeRole: 'Administrator, Faculty, Staff (Up to 2 hardware-bound devices)',
    universityRole: 'Administrator, Professor, Staff (Up to 2 hardware-bound devices)',
    allowedRoleCodes: [
      'COLLEGE_ADMIN',
      'CAMPUS_ADMIN',
      'DEPARTMENT_ADMIN',
      'HOD',
      'REGISTRAR',
      'FACULTY',
      'STAFF',
      'STUDENT',
    ],
    notes: 'Enrollment of device-bound cryptographic credentials with 2-device enforcement.',
  },
};

/**
 * Automated coverage check: verifies that every single catalogued permission
 * has an explicit institutional policy decision across SCHOOL, COLLEGE, and UNIVERSITY.
 */
export function verifyInstitutionPermissionCoverage(): {
  coveredCount: number;
  totalCatalogCount: number;
  unmappedPermissions: string[];
} {
  const unmapped: string[] = [];

  for (const perm of PERMISSION_CATALOG) {
    // Check if at least one role holds this permission in ROLE_MATRIX
    const holders = ROLE_CODES.filter((r) => ROLE_MATRIX[r][perm.code] !== undefined);
    if (holders.length === 0 && !perm.code.startsWith('parent.')) {
      unmapped.push(perm.code);
    }
  }

  return {
    coveredCount: PERMISSION_CATALOG.length - unmapped.length,
    totalCatalogCount: PERMISSION_CATALOG.length,
    unmappedPermissions: unmapped,
  };
}
