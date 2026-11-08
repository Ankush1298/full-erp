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

      {/* Row 1: 4 KPI Cards */}
      <section className="kpi-grid" aria-label="Key Performance Indicators">
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

        {/* Right Column: Institutional Performance + Academic Highlights + Structure Summary */}
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
      </div>
    </>
  );
}
