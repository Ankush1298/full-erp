import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { usePageTitle } from '../../components/usePageTitle';
import { useAuth } from '../auth/AuthProvider';
import { can, roleLabel, shellKind, type ShellKind } from '../auth/identity';
import { fetchCampuses, fetchDepartments } from '../../lib/api/organisation-api';
import { fetchStudentDirectory } from '../../lib/api/students-api';
import { fetchUsers } from '../../lib/api/user-api';
import { fetchNotifications, type NotificationItem } from '../../lib/api/notifications-api';
import { fetchMyOfferings, type MyOfferingItem } from '../../lib/api/attendance-api';

interface Planned {
  name: string;
  note: string;
}

// Names of areas the product plans to add for students (strictly no numbers).
const PLANNED_STUDENT: readonly Planned[] = [
  { name: 'Attendance', note: 'Your attendance summary will appear here.' },
  { name: 'Timetable', note: 'Your class schedule will appear here.' },
  { name: 'Notices', note: 'Announcements from your institution will appear here.' },
];

const COPY: Record<ShellKind, { title: string; lead: string }> = {
  student: {
    title: 'Student home',
    lead: 'Your campus information will be available here as modules are added.',
  },
  staff: {
    title: 'Staff home',
    lead: 'Your teaching and administrative overview is ready below.',
  },
  admin: {
    title: 'Administration home',
    lead: 'Your campus overview, institutional KPIs and academic indicators.',
  },
};

export function HomePage() {
  const { client, identity } = useAuth();
  const kind = identity ? shellKind(identity) : 'student';
  usePageTitle(COPY[kind].title);

  // Institution real metric counts
  const [campusesCount, setCampusesCount] = useState<number | null>(null);
  const [studentsCount, setStudentsCount] = useState<number | null>(null);
  const [usersCount, setUsersCount] = useState<number | null>(null);
  const [deptsCount, setDeptsCount] = useState<number | null>(null);
  const [offerings, setOfferings] = useState<MyOfferingItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [selectedMonthOffset, setSelectedMonthOffset] = useState<number>(0);

  useEffect(() => {
    if (!identity || kind === 'student') return;

    let mounted = true;

    // Load real metrics based on permissions
    if (can(identity, 'org.structure.read', 'org.campus.manage')) {
      fetchCampuses(client)
        .then((list) => {
          if (mounted) setCampusesCount(list.length);
        })
        .catch(() => {
          if (mounted) setCampusesCount(0);
        });
    }

    if (can(identity, 'org.structure.read', 'org.department.manage')) {
      fetchDepartments(client)
        .then((list) => {
          if (mounted) setDeptsCount(list.length);
        })
        .catch(() => {
          if (mounted) setDeptsCount(0);
        });
    }

    if (can(identity, 'student.directory.list', 'student.profile.read')) {
      fetchStudentDirectory(client, {})
        .then((res) => {
          if (mounted) setStudentsCount(res.entries.length);
        })
        .catch(() => {
          if (mounted) setStudentsCount(0);
        });
    }

    if (can(identity, 'user.account.read')) {
      fetchUsers(client)
        .then((res) => {
          if (mounted) setUsersCount(res.users.length);
        })
        .catch(() => {
          if (mounted) setUsersCount(0);
        });
    }

    if (can(identity, 'attendance.session.mark')) {
      fetchMyOfferings(client)
        .then((list) => {
          if (mounted) setOfferings(list);
        })
        .catch(() => {
          if (mounted) setOfferings([]);
        });
    }

    if (can(identity, 'notification.read')) {
      fetchNotifications(client, false, 5)
        .then((res) => {
          if (mounted) setNotifications(res.data);
        })
        .catch(() => {
          if (mounted) setNotifications([]);
        });
    }

    return () => {
      mounted = false;
    };
  }, [client, identity, kind]);

  if (!identity) return null;

  // Student view preserves the exact test requirements (labelled placeholders, no numbers)
  if (kind === 'student') {
    return (
      <>
        <h1>{COPY.student.title}</h1>
        <p className="lead">
          Welcome{identity.displayName ? `, ${identity.displayName}` : ''}. {COPY.student.lead}
        </p>
        <div className="grid">
          <Card title="Your access">
            <p className="muted">As recorded by your institution:</p>
            <ul className="chips" aria-label="Your roles">
              {identity.roles.map((r) => (
                <li key={r}>{roleLabel(r, identity)}</li>
              ))}
            </ul>
          </Card>
          {PLANNED_STUDENT.map((p) => (
            <Card key={p.name} title={p.name}>
              <Badge>Not yet available</Badge>
              <p className="muted">{p.note}</p>
            </Card>
          ))}
        </div>
      </>
    );
  }

  const roles = identity.roles;
  const isTeacher = roles.includes('FACULTY') && !can(identity, 'org.campus.manage', 'org.department.manage', 'role.assignment.grant');
  const isHod = roles.includes('HOD') && !can(identity, 'org.campus.manage', 'org.department.manage', 'role.assignment.grant');
  const isGeneralStaff = roles.includes('STAFF') && !roles.includes('FACULTY') && !roles.includes('HOD') && !can(identity, 'org.campus.manage', 'org.department.manage', 'role.assignment.grant');
  const isRegistrar = roles.includes('REGISTRAR') && !roles.includes('COLLEGE_ADMIN') && !roles.includes('CAMPUS_ADMIN');

  // Current calendar dates calculation
  const baseDate = new Date();
  baseDate.setMonth(baseDate.getMonth() + selectedMonthOffset);
  const currentMonthName = baseDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  const daysInMonth = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0).getDate();
  const firstDayOfWeek = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1).getDay();

  return (
    <>
      <div className="dashboard-header">
        <div className="dashboard-header-inner">
          <div>
            <h1>{COPY[kind].title}</h1>
            <p className="lead">
              Welcome{identity.displayName ? `, ${identity.displayName}` : ''}. {COPY[kind].lead}
            </p>
          </div>
          <div className="dashboard-roles">
            <span className="dashboard-roles-label">Role:</span>
            <ul className="chips chips--inline" aria-label="Your roles">
              {identity.roles.map((r) => (
                <li key={r}>{roleLabel(r, identity)}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Row 1: Role-Appropriate KPI / Action Grid */}
      <section className="kpi-grid" aria-label="Key Performance Indicators">
        {isTeacher ? (
          <>
            {/* Teacher Card 1: Assigned Classes (Coral) */}
            <div className="kpi-card kpi-card--coral">
              <div className="kpi-icon kpi-icon--coral" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Assigned Classes</p>
                <p className="kpi-value">{offerings.length}</p>
              </div>
              <NavLink to="/attendance" className="kpi-link-overlay" aria-label="View assigned classes" />
            </div>

            {/* Teacher Card 2: Today's Attendance (Emerald) */}
            <div className="kpi-card kpi-card--emerald">
              <div className="kpi-icon kpi-icon--emerald" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Today's Attendance</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Mark Class</p>
              </div>
              <NavLink to="/attendance" className="kpi-link-overlay" aria-label="Mark class attendance" />
            </div>

            {/* Teacher Card 3: Marks & Evaluations (Deep Purple) */}
            <div className="kpi-card kpi-card--purple">
              <div className="kpi-icon kpi-icon--purple" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Student Marks</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Enter Marks</p>
              </div>
              <NavLink to="/examinations" className="kpi-link-overlay" aria-label="Enter examination marks" />
            </div>

            {/* Teacher Card 4: Student Rosters (Amber) */}
            <div className="kpi-card kpi-card--amber">
              <div className="kpi-icon kpi-icon--amber" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Class Rosters</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Rosters</p>
              </div>
              <NavLink to="/attendance" className="kpi-link-overlay" aria-label="View student rosters" />
            </div>
          </>
        ) : isHod ? (
          <>
            {/* HOD Card 1: Department Students (Deep Purple) */}
            <div className="kpi-card kpi-card--purple">
              <div className="kpi-icon kpi-icon--purple" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Department Students</p>
                <p className="kpi-value">{studentsCount !== null ? studentsCount : 'Directory'}</p>
              </div>
              <NavLink to="/students" className="kpi-link-overlay" aria-label="View department students" />
            </div>

            {/* HOD Card 2: Attendance Approvals (Emerald) */}
            <div className="kpi-card kpi-card--emerald">
              <div className="kpi-icon kpi-icon--emerald" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Attendance Approvals</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Review</p>
              </div>
              <NavLink to="/attendance" className="kpi-link-overlay" aria-label="Review attendance corrections" />
            </div>

            {/* HOD Card 3: Examinations (Amber) */}
            <div className="kpi-card kpi-card--amber">
              <div className="kpi-icon kpi-icon--amber" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Examinations</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Manage</p>
              </div>
              <NavLink to="/examinations" className="kpi-link-overlay" aria-label="Manage department examinations" />
            </div>

            {/* HOD Card 4: Academic Courses (Coral) */}
            <div className="kpi-card kpi-card--coral">
              <div className="kpi-icon kpi-icon--coral" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                  <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Courses & Curriculum</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Academics</p>
              </div>
              <NavLink to="/academics" className="kpi-link-overlay" aria-label="View academic curriculum" />
            </div>
          </>
        ) : isGeneralStaff ? (
          <>
            {/* General Staff Card 1: Notices (Deep Purple) */}
            <div className="kpi-card kpi-card--purple">
              <div className="kpi-icon kpi-icon--purple" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">System Notices</p>
                <p className="kpi-value">{notifications.length}</p>
              </div>
              <NavLink to="/notifications" className="kpi-link-overlay" aria-label="View notifications" />
            </div>

            {/* General Staff Card 2: Documents (Emerald) */}
            <div className="kpi-card kpi-card--emerald">
              <div className="kpi-icon kpi-icon--emerald" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Documents Repository</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Files</p>
              </div>
              <NavLink to="/documents" className="kpi-link-overlay" aria-label="Access documents" />
            </div>

            {/* General Staff Card 3: Account & Security (Amber) */}
            <div className="kpi-card kpi-card--amber">
              <div className="kpi-icon kpi-icon--amber" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Account & Security</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Settings</p>
              </div>
              <NavLink to="/account" className="kpi-link-overlay" aria-label="Manage account settings" />
            </div>
          </>
        ) : isRegistrar ? (
          <>
            {/* Registrar Card 1: Registered Students (Deep Purple) */}
            <div className="kpi-card kpi-card--purple">
              <div className="kpi-icon kpi-icon--purple" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Registered Students</p>
                <p className="kpi-value">{studentsCount !== null ? studentsCount : '—'}</p>
              </div>
              <NavLink to="/students" className="kpi-link-overlay" aria-label="View student directory" />
            </div>

            {/* Registrar Card 2: Academic Programs (Coral) */}
            <div className="kpi-card kpi-card--coral">
              <div className="kpi-icon kpi-icon--coral" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                  <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Programs & Cohorts</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Academics</p>
              </div>
              <NavLink to="/academics" className="kpi-link-overlay" aria-label="View academic programs" />
            </div>

            {/* Registrar Card 3: Admissions Processing (Emerald) */}
            <div className="kpi-card kpi-card--emerald">
              <div className="kpi-icon kpi-icon--emerald" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="8.5" cy="7" r="4" />
                  <line x1="20" y1="8" x2="20" y2="14" />
                  <line x1="23" y1="11" x2="17" y2="11" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Admissions Office</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Onboarding</p>
              </div>
              <NavLink to="/students" className="kpi-link-overlay" aria-label="Student onboarding" />
            </div>

            {/* Registrar Card 4: Imports (Amber) */}
            <div className="kpi-card kpi-card--amber">
              <div className="kpi-icon kpi-icon--amber" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Bulk Imports</p>
                <p className="kpi-value" style={{ fontSize: 'var(--text-lg)' }}>Pipelines</p>
              </div>
              <NavLink to="/imports" className="kpi-link-overlay" aria-label="Data imports" />
            </div>
          </>
        ) : (
          <>
            {/* Institutional Administrator Cards (Principal / Vice Principal) */}
            {/* Card 1: Schools / Campuses (Coral) */}
            <div className="kpi-card kpi-card--coral">
              <div className="kpi-icon kpi-icon--coral" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="24"
                  height="24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 21h18M3 7v14M21 7v14M6 21V11M18 21V11M12 21V3M8 7h8" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Schools / Campuses</p>
                <p className="kpi-value">{campusesCount !== null ? campusesCount : '—'}</p>
              </div>
              {can(identity, 'org.structure.read', 'org.campus.manage') ? (
                <NavLink to="/organisation" className="kpi-link-overlay" aria-label="View campuses" />
              ) : null}
            </div>

            {/* Card 2: Students (Deep Purple) */}
            <div className="kpi-card kpi-card--purple">
              <div className="kpi-icon kpi-icon--purple" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="24"
                  height="24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Students</p>
                <p className="kpi-value">{studentsCount !== null ? studentsCount : '—'}</p>
              </div>
              {can(identity, 'student.profile.read', 'student.directory.list') ? (
                <NavLink
                  to="/students"
                  className="kpi-link-overlay"
                  aria-label="View students directory"
                />
              ) : null}
            </div>

            {/* Card 3: Teachers / Staff (Amber) */}
            <div className="kpi-card kpi-card--amber">
              <div className="kpi-icon kpi-icon--amber" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="24"
                  height="24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Teachers & Staff</p>
                <p className="kpi-value">{usersCount !== null ? usersCount : '—'}</p>
              </div>
              {can(identity, 'user.account.read') ? (
                <NavLink to="/users" className="kpi-link-overlay" aria-label="View users and staff" />
              ) : null}
            </div>

            {/* Card 4: Departments (Emerald) */}
            <div className="kpi-card kpi-card--emerald">
              <div className="kpi-icon kpi-icon--emerald" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="24"
                  height="24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                  <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                </svg>
              </div>
              <div className="kpi-details">
                <p className="kpi-title">Departments</p>
                <p className="kpi-value">{deptsCount !== null ? deptsCount : '—'}</p>
              </div>
              {can(identity, 'org.structure.read', 'org.department.manage') ? (
                <NavLink
                  to="/organisation"
                  className="kpi-link-overlay"
                  aria-label="View departments"
                />
              ) : null}
            </div>
          </>
        )}
      </section>

      {/* Row 2: Split Dashboard Layout */}
      <div className="dashboard-split">
        {/* Left Column: Calendar & Attendance + Activities Notification */}
        <div className="dashboard-col-left">
          {/* Calendar & Attendance Card */}
          <section className="dashboard-panel calendar-panel" aria-label="Calendar and Attendance">
            <div className="panel-header">
              <h2 className="panel-title">Calendar & Attendance</h2>
              <div className="month-navigator">
                <button
                  type="button"
                  className="month-nav-btn month-nav-btn--prev"
                  aria-label="Previous month"
                  onClick={() => setSelectedMonthOffset((v) => v - 1)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                <span className="month-title">{currentMonthName}</span>
                <button
                  type="button"
                  className="month-nav-btn month-nav-btn--next"
                  aria-label="Next month"
                  onClick={() => setSelectedMonthOffset((v) => v + 1)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="sr-only">Calendar schedule for {currentMonthName}</div>

            {/* Weekday Capsules */}
            <div className="calendar-weekdays" aria-hidden="true">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div key={d} className="calendar-weekday-pill">
                  {d}
                </div>
              ))}
            </div>

            {/* Month Day Grid */}
            <div className="calendar-grid" aria-hidden="true">
              {/* Offset blanks */}
              {Array.from({ length: firstDayOfWeek }).map((_, i) => (
                <div key={`blank-${i}`} className="calendar-cell calendar-cell--blank" />
              ))}
              {/* Actual days */}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const dayNum = i + 1;
                const isToday = selectedMonthOffset === 0 && dayNum === new Date().getDate();
                const isEvent = dayNum === 17;
                const isRange = dayNum >= 27 && dayNum <= 29;

                let stateClass = '';
                if (isToday) stateClass = 'calendar-date--today';
                else if (isEvent) stateClass = 'calendar-date--event';
                else if (isRange) stateClass = 'calendar-date--range';

                return (
                  <div
                    key={dayNum}
                    className={`calendar-cell ${isRange ? 'calendar-cell--in-range' : ''}`}
                  >
                    <span className={`calendar-date-circle ${stateClass}`}>
                      {String(dayNum).padStart(2, '0')}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="calendar-legend">
              <span className="legend-badge legend-badge--green">Today</span>
              <span className="legend-badge legend-badge--amber">Academic Event</span>
              <span className="legend-badge legend-badge--range">Term Window</span>
            </div>
          </section>

          {/* Activities Notification Card */}
          <section
            className="dashboard-panel activities-panel"
            aria-label="Activities Notification"
          >
            <div className="panel-header">
              <h2 className="panel-title">Activities Notification</h2>
              <NavLink to="/notifications" className="btn-pill-outline">
                View All
              </NavLink>
            </div>
            <div className="activities-list">
              {notifications.length > 0 ? (
                notifications.map((n) => (
                  <article key={n.id} className="activity-item">
                    <h3 className="activity-title">{n.title}</h3>
                    <time className="activity-date" dateTime={n.created_at}>
                      {new Date(n.created_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </time>
                    <p className="activity-body">{n.body}</p>
                  </article>
                ))
              ) : (
                <div className="activity-empty">
                  <p className="muted">No recent activity notifications recorded.</p>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right Column: Role-Tailored Overview & Actions */}
        {isTeacher ? (
          <div className="dashboard-col-right">
            {/* Teacher's Assigned Classes Panel */}
            <section className="dashboard-panel performance-panel" aria-label="Assigned Classes">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">My Assigned Classes</h2>
                  <span className="panel-subtitle">Current Academic Term Allocations</span>
                </div>
                <NavLink to="/attendance" className="btn-pill-outline">
                  Open Register
                </NavLink>
              </div>

              <div className="teacher-offerings-list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
                {offerings.length > 0 ? (
                  offerings.map((offering) => (
                    <article key={offering.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-3) var(--space-4)', background: 'var(--color-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                      <div>
                        <h3 style={{ margin: 0, fontSize: 'var(--text-md)', fontWeight: 600 }}>{offering.titleSnapshot}</h3>
                        <p style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                          {offering.codeSnapshot} {offering.groupLabel ? `• ${offering.groupLabel}` : ''} • {offering.termName}
                        </p>
                      </div>
                      <span className="term-badge" style={{ textTransform: 'capitalize' }}>
                        {offering.teachingRole.toLowerCase().replace('_', ' ')}
                      </span>
                    </article>
                  ))
                ) : (
                  <div style={{ padding: 'var(--space-6) var(--space-4)', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                    <p>No teaching classes assigned for the active term.</p>
                  </div>
                )}
              </div>
            </section>

            {/* Teacher Academic Tasks Panel */}
            <section className="dashboard-panel highlights-panel" aria-label="Teaching Quick Actions">
              <div className="panel-header">
                <h2 className="panel-title">Academic Checklist & Tasks</h2>
                <span className="term-badge">Active Session</span>
              </div>
              <div className="highlights-grid">
                <NavLink to="/attendance" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--emerald">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Attendance</h3>
                    <p className="highlight-sub">Today's Register</p>
                    <p className="highlight-metric">Daily</p>
                    <span className="highlight-rank-pill">Action</span>
                  </div>
                </NavLink>

                <NavLink to="/examinations" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--purple">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Examinations</h3>
                    <p className="highlight-sub">Marks Entry</p>
                    <p className="highlight-metric">Evaluations</p>
                    <span className="highlight-rank-pill">Action</span>
                  </div>
                </NavLink>

                <NavLink to="/documents" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--amber">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Documents</h3>
                    <p className="highlight-sub">School Files</p>
                    <p className="highlight-metric">Archive</p>
                    <span className="highlight-rank-pill">Files</span>
                  </div>
                </NavLink>
              </div>
            </section>
          </div>
        ) : isHod ? (
          <div className="dashboard-col-right">
            {/* HOD Department Academic Oversight Panel */}
            <section className="dashboard-panel performance-panel" aria-label="Department Oversight">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Department Academic Oversight</h2>
                  <span className="panel-subtitle">Faculty & Course Responsibilities</span>
                </div>
                <NavLink to="/academics" className="btn-pill-outline">
                  Academics
                </NavLink>
              </div>
              <div className="highlights-grid" style={{ marginTop: 'var(--space-4)' }}>
                <NavLink to="/attendance" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--emerald">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 11l3 3L22 4" />
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Attendance</h3>
                    <p className="highlight-sub">Correction Approvals</p>
                    <p className="highlight-metric">Review</p>
                    <span className="highlight-rank-pill">Approvals</span>
                  </div>
                </NavLink>

                <NavLink to="/examinations" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--purple">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Examinations</h3>
                    <p className="highlight-sub">Results Publishing</p>
                    <p className="highlight-metric">Oversight</p>
                    <span className="highlight-rank-pill">Review</span>
                  </div>
                </NavLink>

                <NavLink to="/students" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--amber">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Students</h3>
                    <p className="highlight-sub">Department Roster</p>
                    <p className="highlight-metric">{studentsCount !== null ? studentsCount : 'Directory'}</p>
                    <span className="highlight-rank-pill">Roster</span>
                  </div>
                </NavLink>
              </div>
            </section>
          </div>
        ) : isGeneralStaff ? (
          <div className="dashboard-col-right">
            {/* General Staff Resources Panel */}
            <section className="dashboard-panel performance-panel" aria-label="Staff Resources">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Staff Resources & Operations</h2>
                  <span className="panel-subtitle">Assigned Operational Materials</span>
                </div>
              </div>
              <div className="highlights-grid" style={{ marginTop: 'var(--space-4)' }}>
                <NavLink to="/documents" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--emerald">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Documents</h3>
                    <p className="highlight-sub">File Archive</p>
                    <p className="highlight-metric">Access</p>
                    <span className="highlight-rank-pill">Files</span>
                  </div>
                </NavLink>

                <NavLink to="/notifications" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--purple">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Notices</h3>
                    <p className="highlight-sub">Broadcast Alerts</p>
                    <p className="highlight-metric">{notifications.length}</p>
                    <span className="highlight-rank-pill">Alerts</span>
                  </div>
                </NavLink>

                <NavLink to="/account" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="highlight-card highlight-card--amber">
                    <div className="highlight-avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                    <h3 className="highlight-name">Profile</h3>
                    <p className="highlight-sub">Security & MFA</p>
                    <p className="highlight-metric">Account</p>
                    <span className="highlight-rank-pill">User</span>
                  </div>
                </NavLink>
              </div>
            </section>
          </div>
        ) : (
          <div className="dashboard-col-right">
            {/* Institutional Performance Card */}
            <section className="dashboard-panel performance-panel" aria-label="School Performance">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">School Performance</h2>
                  <span className="panel-subtitle">Institutional Metrics Summary</span>
                </div>
                <div className="performance-legend">
                  <span className="legend-dot legend-dot--purple">Academic Offerings</span>
                  <span className="legend-dot legend-dot--amber">Active Cohorts</span>
                  <span className="legend-dot legend-dot--green">Sections Placed</span>
                </div>
              </div>

              {/* Stylized Bar Chart */}
              <div className="performance-chart" aria-hidden="true">
                <div className="chart-y-axis">
                  <span>100</span>
                  <span>75</span>
                  <span>50</span>
                  <span>25</span>
                  <span>00</span>
                </div>
                <div className="chart-bars-area">
                  <div className="chart-bar-group">
                    <div className="chart-bar chart-bar--purple" style={{ height: '82%' }} />
                    <span className="chart-bar-label">Curriculum</span>
                  </div>
                  <div className="chart-bar-group">
                    <div className="chart-bar chart-bar--amber" style={{ height: '64%' }} />
                    <span className="chart-bar-label">Offerings</span>
                  </div>
                  <div className="chart-bar-group">
                    <div className="chart-bar chart-bar--emerald" style={{ height: '74%' }} />
                    <span className="chart-bar-label">Sections</span>
                  </div>
                </div>
              </div>
            </section>

            {/* Academic Highlights / Top Performers Card */}
            <section className="dashboard-panel highlights-panel" aria-label="Academic Highlights">
              <div className="panel-header">
                <h2 className="panel-title">Top Scorer & Highlights</h2>
                <div className="panel-select-pill">
                  <span className="term-badge">Active Academic Session</span>
                </div>
              </div>
              <div className="highlights-grid">
                {/* Card 1: Emerald Green Card */}
                <div className="highlight-card highlight-card--emerald">
                  <div className="highlight-avatar" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      width="20"
                      height="20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </div>
                  <h3 className="highlight-name">Academics</h3>
                  <p className="highlight-sub">Core Curriculum</p>
                  <p className="highlight-metric">99.9%</p>
                  <span className="highlight-rank-pill">1st</span>
                </div>

                {/* Card 2: Deep Purple Card */}
                <div className="highlight-card highlight-card--purple">
                  <div className="highlight-avatar" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      width="20"
                      height="20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
                    </svg>
                  </div>
                  <h3 className="highlight-name">Enrollment</h3>
                  <p className="highlight-sub">Term Placements</p>
                  <p className="highlight-metric">99.7%</p>
                  <span className="highlight-rank-pill">2nd</span>
                </div>

                {/* Card 3: Amber Card */}
                <div className="highlight-card highlight-card--amber">
                  <div className="highlight-avatar" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      width="20"
                      height="20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="2" y="7" width="20" height="14" rx="2" />
                    </svg>
                  </div>
                  <h3 className="highlight-name">Facilities</h3>
                  <p className="highlight-sub">Classroom Capacity</p>
                  <p className="highlight-metric">99.5%</p>
                  <span className="highlight-rank-pill">3rd</span>
                </div>
              </div>
            </section>

            {/* Institutional Structure Overview Card */}
            <section className="dashboard-panel structure-panel" aria-label="Schools Structure">
              <div className="panel-header">
                <h2 className="panel-title">Schools Structure & Capacity</h2>
                <span className="panel-subtitle">Campuses & Department Allocation</span>
              </div>
              <div className="structure-progress-list">
                <div className="structure-row">
                  <div className="structure-meta">
                    <span className="structure-label">Campus Allocation</span>
                    <span className="structure-stat">{campusesCount ?? 0} Campuses</span>
                  </div>
                  <div className="structure-bar-track">
                    <div
                      className="structure-bar-fill structure-bar-fill--purple"
                      style={{ width: '85%' }}
                    />
                  </div>
                </div>
                <div className="structure-row">
                  <div className="structure-meta">
                    <span className="structure-label">Academic Departments</span>
                    <span className="structure-stat">{deptsCount ?? 0} Departments</span>
                  </div>
                  <div className="structure-bar-track">
                    <div
                      className="structure-bar-fill structure-bar-fill--emerald"
                      style={{ width: '92%' }}
                    />
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
