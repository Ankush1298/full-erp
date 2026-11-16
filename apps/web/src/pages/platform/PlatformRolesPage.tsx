import React, { useState } from 'react';

interface RoleTemplate {
  code: string;
  name: string;
  category: 'LEADERSHIP' | 'ACADEMIC' | 'OPERATIONS' | 'STUDENT_GUARDIAN';
  defaultScope: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT' | 'ASSIGNED' | 'SELF';
  schoolLabel: string;
  collegeLabel: string;
  universityLabel: string;
  summary: string;
  isSystem: boolean;
}

interface CapabilityDef {
  code: string;
  name: string;
  group: 'STUDENT' | 'ACADEMIC' | 'ATTENDANCE' | 'EXAM' | 'HOMEWORK' | 'FINANCE' | 'SYSTEM';
  actionType: 'READ' | 'WRITE' | 'APPROVE' | 'EXPORT';
  sensitivity: 'NORMAL' | 'SENSITIVE' | 'CRITICAL';
  roleGrants: Record<string, 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT' | 'ASSIGNED' | 'SELF' | null>;
}

const CANONICAL_ROLES: RoleTemplate[] = [
  {
    code: 'COLLEGE_ADMIN',
    name: 'Chief Executive Administrator',
    category: 'LEADERSHIP',
    defaultScope: 'ORGANIZATION',
    schoolLabel: 'Principal / Headmaster',
    collegeLabel: 'Director / Principal',
    universityLabel: 'Vice Chancellor / President',
    summary: 'Full executive institutional governance across curriculum, admissions, staff rosters, and compliance.',
    isSystem: true,
  },
  {
    code: 'REGISTRAR',
    name: 'Academic Registrar & Records Custodian',
    category: 'OPERATIONS',
    defaultScope: 'ORGANIZATION',
    schoolLabel: 'Vice Principal / Academic In-Charge',
    collegeLabel: 'Registrar',
    universityLabel: 'University Registrar',
    summary: 'Student directory, programs, cohorts, academic calendars, curriculum offerings, and verification.',
    isSystem: true,
  },
  {
    code: 'HOD',
    name: 'Head of Department / Discipline Lead',
    category: 'ACADEMIC',
    defaultScope: 'DEPARTMENT',
    schoolLabel: 'Subject Coordinator / Department Head',
    collegeLabel: 'Head of Department (HOD)',
    universityLabel: 'Dean of Faculty / Chair',
    summary: 'Curriculum delivery, faculty teaching assignments, department courses, and internal grade moderation.',
    isSystem: true,
  },
  {
    code: 'FACULTY',
    name: 'Teaching Faculty / Instructor',
    category: 'ACADEMIC',
    defaultScope: 'ASSIGNED',
    schoolLabel: 'Class Teacher / Subject Teacher',
    collegeLabel: 'Professor / Assistant Professor',
    universityLabel: 'Faculty Fellow / Lecturer',
    summary: 'Session attendance marking, homework publishing, student submission review, and term marks entry.',
    isSystem: true,
  },
  {
    code: 'EXAM_OFFICER',
    name: 'Controller of Examinations (COE)',
    category: 'OPERATIONS',
    defaultScope: 'ORGANIZATION',
    schoolLabel: 'Exam Coordinator / Examination In-Charge',
    collegeLabel: 'Controller of Examinations (COE)',
    universityLabel: 'Controller of Examinations',
    summary: 'Exam cycle scheduling, hall ticket generation, grade scales, mark sheet validation, and result release.',
    isSystem: true,
  },
  {
    code: 'FINANCE_OFFICER',
    name: 'Finance & Bursar Officer',
    category: 'OPERATIONS',
    defaultScope: 'ORGANIZATION',
    schoolLabel: 'Bursar / Accounts Officer',
    collegeLabel: 'Finance Officer',
    universityLabel: 'Comptroller / Finance Director',
    summary: 'Fee heads and quota policies, fee challan generation, transaction reconciliation, and ledger reporting.',
    isSystem: true,
  },
  {
    code: 'STUDENT',
    name: 'Enrolled Student Scholar',
    category: 'STUDENT_GUARDIAN',
    defaultScope: 'SELF',
    schoolLabel: 'Enrolled Pupil / Student',
    collegeLabel: 'Undergraduate / Postgraduate Student',
    universityLabel: 'University Candidate / Scholar',
    summary: 'Self academic timetable, homework submission, verified grade cards, and student documents.',
    isSystem: true,
  },
  {
    code: 'PARENT',
    name: 'Parent / Legal Guardian',
    category: 'STUDENT_GUARDIAN',
    defaultScope: 'SELF',
    schoolLabel: 'Parent / Primary Guardian',
    collegeLabel: 'Guardian / Sponsor',
    universityLabel: 'Guardian (Optional)',
    summary: 'Parent portal access, linked ward attendance tracking, homework oversight, and fee receipt downloads.',
    isSystem: true,
  },
];

const CAPABILITIES_CATALOG: CapabilityDef[] = [
  // Student Management
  {
    code: 'student.profile.read',
    name: 'View Student Profiles',
    group: 'STUDENT',
    actionType: 'READ',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: 'DEPARTMENT',
      FACULTY: 'ASSIGNED',
      EXAM_OFFICER: 'ORGANIZATION',
      FINANCE_OFFICER: 'ORGANIZATION',
      STUDENT: 'SELF',
      PARENT: 'SELF',
    },
  },
  {
    code: 'student.record.create',
    name: 'Create & Admit Student Record',
    group: 'STUDENT',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'student.record.update',
    name: 'Update Student Demographics',
    group: 'STUDENT',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'student.record.export',
    name: 'Bulk Export Student Directory',
    group: 'STUDENT',
    actionType: 'EXPORT',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'student.status.change',
    name: 'Change Admission Status (Suspend/Alumni)',
    group: 'STUDENT',
    actionType: 'APPROVE',
    sensitivity: 'CRITICAL',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },

  // Academic Operations
  {
    code: 'academic.program.manage',
    name: 'Configure Programs & Degree Specs',
    group: 'ACADEMIC',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: 'DEPARTMENT',
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'academic.faculty.assign',
    name: 'Assign Teaching Faculty to Courses',
    group: 'ACADEMIC',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: 'DEPARTMENT',
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },

  // Attendance
  {
    code: 'attendance.session.mark',
    name: 'Mark Daily / Period Attendance',
    group: 'ATTENDANCE',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: 'DEPARTMENT',
      FACULTY: 'ASSIGNED',
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'attendance.record.read',
    name: 'Inspect Attendance Registers',
    group: 'ATTENDANCE',
    actionType: 'READ',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: 'DEPARTMENT',
      FACULTY: 'ASSIGNED',
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: 'SELF',
      PARENT: 'SELF',
    },
  },
  {
    code: 'attendance.correction.approve',
    name: 'Approve Attendance Corrections',
    group: 'ATTENDANCE',
    actionType: 'APPROVE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: 'DEPARTMENT',
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },

  // Examinations
  {
    code: 'exam.cycle.manage',
    name: 'Schedule Examination Cycles',
    group: 'EXAM',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: 'ORGANIZATION',
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'exam.marks.enter',
    name: 'Enter Student Examination Marks',
    group: 'EXAM',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: null,
      HOD: 'DEPARTMENT',
      FACULTY: 'ASSIGNED',
      EXAM_OFFICER: 'ORGANIZATION',
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'exam.results.publish',
    name: 'Publish Official Grade Reports',
    group: 'EXAM',
    actionType: 'APPROVE',
    sensitivity: 'CRITICAL',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: 'ORGANIZATION',
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },

  // Homework
  {
    code: 'homework.publish',
    name: 'Create & Publish Homework Tasks',
    group: 'HOMEWORK',
    actionType: 'WRITE',
    sensitivity: 'NORMAL',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: null,
      HOD: 'DEPARTMENT',
      FACULTY: 'ASSIGNED',
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'homework.submission.review',
    name: 'Grade Student Submissions & Feedback',
    group: 'HOMEWORK',
    actionType: 'WRITE',
    sensitivity: 'NORMAL',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: null,
      HOD: 'DEPARTMENT',
      FACULTY: 'ASSIGNED',
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'homework.submission.submit',
    name: 'Upload & Submit Homework Assignment',
    group: 'HOMEWORK',
    actionType: 'WRITE',
    sensitivity: 'NORMAL',
    roleGrants: {
      COLLEGE_ADMIN: null,
      REGISTRAR: null,
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: 'SELF',
      PARENT: null,
    },
  },

  // Finance
  {
    code: 'finance.fee_structure.manage',
    name: 'Define Fee Heads & Quota Slabs',
    group: 'FINANCE',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: null,
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: 'ORGANIZATION',
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'finance.challan.generate',
    name: 'Generate Student Fee Invoices',
    group: 'FINANCE',
    actionType: 'WRITE',
    sensitivity: 'SENSITIVE',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: null,
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: 'ORGANIZATION',
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'finance.receipt.download',
    name: 'Download Verified Fee Receipts',
    group: 'FINANCE',
    actionType: 'READ',
    sensitivity: 'NORMAL',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: 'ORGANIZATION',
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: 'ORGANIZATION',
      STUDENT: 'SELF',
      PARENT: 'SELF',
    },
  },

  // Platform & System
  {
    code: 'org.settings.manage',
    name: 'Modify Institutional Preferences',
    group: 'SYSTEM',
    actionType: 'WRITE',
    sensitivity: 'CRITICAL',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: null,
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
  {
    code: 'audit.log.read',
    name: 'Inspect Security Audit Log',
    group: 'SYSTEM',
    actionType: 'READ',
    sensitivity: 'CRITICAL',
    roleGrants: {
      COLLEGE_ADMIN: 'ORGANIZATION',
      REGISTRAR: null,
      HOD: null,
      FACULTY: null,
      EXAM_OFFICER: null,
      FINANCE_OFFICER: null,
      STUDENT: null,
      PARENT: null,
    },
  },
];

export const PlatformRolesPage: React.FC = () => {
  const [selectedInstType, setSelectedInstType] = useState<'SCHOOL' | 'COLLEGE' | 'UNIVERSITY'>('COLLEGE');
  const [searchQuery, setSearchQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('ALL');

  const filteredCapabilities = CAPABILITIES_CATALOG.filter((cap) => {
    const matchesGroup = groupFilter === 'ALL' || cap.group === groupFilter;
    const matchesQuery =
      searchQuery === '' ||
      cap.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cap.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesGroup && matchesQuery;
  });

  const getRoleLabel = (role: RoleTemplate) => {
    if (selectedInstType === 'SCHOOL') return role.schoolLabel;
    if (selectedInstType === 'UNIVERSITY') return role.universityLabel;
    return role.collegeLabel;
  };

  return (
    <div className="platform-page">
      <div className="platform-page-header">
        <div>
          <h2 className="platform-page-title">Universal Role Templates & Scope Architecture</h2>
          <p className="platform-page-desc">
            Anesa's canonical multi-tier institutional authorization model: role scopes, institution vocabulary mapping, and granular capability matrices.
          </p>
        </div>

        {/* Institution Type Preview Selector */}
        <div className="institution-type-toggle">
          <span className="text-xs font-semibold text-slate-500 uppercase mr-2">Vocabulary View:</span>
          <div className="filter-pill-group">
            <button
              type="button"
              className={`filter-pill-btn ${selectedInstType === 'SCHOOL' ? 'active' : ''}`}
              onClick={() => setSelectedInstType('SCHOOL')}
            >
              School (K-12)
            </button>
            <button
              type="button"
              className={`filter-pill-btn ${selectedInstType === 'COLLEGE' ? 'active' : ''}`}
              onClick={() => setSelectedInstType('COLLEGE')}
            >
              College / Polytechnic
            </button>
            <button
              type="button"
              className={`filter-pill-btn ${selectedInstType === 'UNIVERSITY' ? 'active' : ''}`}
              onClick={() => setSelectedInstType('UNIVERSITY')}
            >
              University
            </button>
          </div>
        </div>
      </div>

      {/* Scope Hierarchy Explainer */}
      <div className="platform-card mb-6">
        <h3 className="card-title">Enforced Authorization Scope Hierarchy</h3>
        <p className="card-subtitle">
          Permissions in Anesa Campus OS are evaluated with strict resource-level scoping.
        </p>
        <div className="scopes-explainer-grid mt-4">
          <div className="scope-box">
            <span className="scope-name">ORGANIZATION</span>
            <p>Institution-wide authority spanning all campuses, departments, programs, and staff.</p>
          </div>
          <div className="scope-box">
            <span className="scope-name">CAMPUS</span>
            <p>Restricted to physical campus facilities, students admitted to that campus, and local staff.</p>
          </div>
          <div className="scope-box">
            <span className="scope-name">DEPARTMENT</span>
            <p>Bound to academic department (e.g. Physics, Computer Science) and its offerings.</p>
          </div>
          <div className="scope-box">
            <span className="scope-name">ASSIGNED</span>
            <p>Bound strictly to classes, sections, and courses assigned directly to the faculty member.</p>
          </div>
          <div className="scope-box">
            <span className="scope-name">SELF</span>
            <p>Restricted strictly to the authenticated user's own identity or explicitly verified wards.</p>
          </div>
        </div>
      </div>

      {/* Interactive Roles Directory */}
      <div className="platform-card mb-6">
        <div className="platform-card-header">
          <div>
            <h3 className="card-title">Canonical Roles ({CANONICAL_ROLES.length})</h3>
            <p className="card-subtitle">
              Role codes and their vocabulary mappings for <strong>{selectedInstType}</strong>
            </p>
          </div>
        </div>

        <div className="role-templates-grid mt-4">
          {CANONICAL_ROLES.map((role) => (
            <div key={role.code} className="template-card">
              <div className="template-top">
                <code className="template-code">{role.code}</code>
                <span className="template-scope font-mono">Scope: {role.defaultScope}</span>
              </div>
              <h4 className="template-name">{getRoleLabel(role)}</h4>
              <p className="text-xs text-indigo-600 font-semibold mb-2">{role.name}</p>
              <p className="template-summary">{role.summary}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Interactive Capabilities & Permissions Matrix */}
      <div className="platform-card">
        <div className="platform-card-header">
          <div>
            <h3 className="card-title">Interactive Capabilities & Grants Matrix</h3>
            <p className="card-subtitle">
              Inspect granular permissions across roles with capability search, action type tags, and scope indicators.
            </p>
          </div>

          <div className="matrix-search-box">
            <input
              type="text"
              placeholder="Search capability (e.g. homework, export, exam)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="platform-input font-medium"
            />
          </div>
        </div>

        {/* Group Filter Pills */}
        <div className="category-pills-row mt-4">
          {['ALL', 'STUDENT', 'ACADEMIC', 'ATTENDANCE', 'EXAM', 'HOMEWORK', 'FINANCE', 'SYSTEM'].map(
            (grp) => (
              <button
                key={grp}
                type="button"
                className={`category-filter-btn ${groupFilter === grp ? 'active' : ''}`}
                onClick={() => setGroupFilter(grp)}
              >
                {grp}
              </button>
            )
          )}
        </div>

        {/* Matrix Table */}
        <div className="permissions-matrix-wrap mt-6">
          <table className="permissions-matrix-table">
            <thead>
              <tr>
                <th className="th-cap">Capability & Action</th>
                {CANONICAL_ROLES.map((r) => (
                  <th key={r.code} className="th-role">
                    <span className="role-header-title">{getRoleLabel(r)}</span>
                    <code className="role-header-code">{r.code}</code>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredCapabilities.map((cap) => (
                <tr key={cap.code}>
                  <td className="td-cap-info">
                    <div className="cap-title-row">
                      <span className="cap-name">{cap.name}</span>
                      <span className={`action-tag action-${cap.actionType.toLowerCase()}`}>
                        {cap.actionType}
                      </span>
                      <span className={`sens-tag sens-${cap.sensitivity.toLowerCase()}`}>
                        {cap.sensitivity}
                      </span>
                    </div>
                    <code className="cap-code">{cap.code}</code>
                  </td>

                  {CANONICAL_ROLES.map((role) => {
                    const grantScope = cap.roleGrants[role.code];
                    return (
                      <td key={role.code} className="td-grant-cell">
                        {grantScope ? (
                          <span className={`scope-badge scope-${grantScope.toLowerCase()}`}>
                            {grantScope === 'ORGANIZATION'
                              ? 'ORG'
                              : grantScope === 'CAMPUS'
                              ? 'CAMP'
                              : grantScope === 'DEPARTMENT'
                              ? 'DEPT'
                              : grantScope === 'ASSIGNED'
                              ? 'ASSIGNED_ROLE'
                              : 'SELF_USER'}
                          </span>
                        ) : (
                          <span className="grant-empty">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
