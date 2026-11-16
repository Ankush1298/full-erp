import { can, isModuleEntitled, type Identity } from '../auth/identity';

export interface NavItem {
  id: string;
  label: string;
  to: string;
  /** Visible when the backend lists ANY of these capabilities (omitted = every signed-in user). */
  anyOf?: readonly string[];
  /** Restrict to students or to non-students where the wording differs. */
  audience?: 'student' | 'staff';
  /** Canonical module key in ERP_MODULE_CATALOG; hidden if not entitled for the institution. */
  moduleKey?: string;
}

/**
 * The menu is computed from capabilities and institution entitlements returned by the backend,
 * never from role names typed in the client. Hiding an item is a convenience; the backend still
 * authorises every request.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home', to: '/' },
  {
    id: 'notifications',
    label: 'Notifications',
    to: '/notifications',
    anyOf: ['notification.read'],
    moduleKey: 'notifications',
  },
  {
    id: 'documents',
    label: 'Documents',
    to: '/documents',
    anyOf: ['document.read', 'document.upload'],
    moduleKey: 'documents',
  },
  {
    id: 'consents',
    label: 'Privacy & consents',
    to: '/consents',
    anyOf: ['consent.read'],
    moduleKey: 'consents',
  },
  {
    id: 'my-profile',
    label: 'My profile',
    to: '/profile',
    anyOf: ['student.profile.read'],
    audience: 'student',
    moduleKey: 'students',
  },
  {
    id: 'parent-portal',
    label: 'Parent Portal',
    to: '/parent',
    anyOf: ['parent.portal.access'],
    moduleKey: 'parent_portal',
  },
  {
    id: 'students',
    label: 'Students',
    to: '/students',
    anyOf: ['student.profile.read', 'student.directory.list', 'student.directory.search'],
    audience: 'staff',
    moduleKey: 'students',
  },
  {
    id: 'academics',
    label: 'Academics',
    to: '/academics',
    anyOf: [
      'academic.term.manage',
      'academic.course.manage',
      'academic.section.manage',
      'enrollment.term.manage',
      'enrollment.term.read',
    ],
    audience: 'staff',
    moduleKey: 'academics',
  },
  {
    id: 'attendance',
    label: 'Attendance',
    to: '/attendance',
    anyOf: ['attendance.session.mark', 'attendance.record.read', 'attendance.correction.approve'],
    audience: 'staff',
    moduleKey: 'attendance',
  },
  {
    id: 'homework',
    label: 'Homework',
    to: '/homework',
    anyOf: ['homework.manage', 'homework.read'],
    moduleKey: 'homework',
  },
  {
    id: 'examinations',
    label: 'Examinations',
    to: '/examinations',
    anyOf: ['exam.manage', 'exam.marks.enter', 'result.publish', 'result.read'],
    moduleKey: 'examinations',
  },
  {
    id: 'finance',
    label: 'Fees & Finance',
    to: '/fees',
    anyOf: ['fee.structure.read', 'fee.dues.read', 'fee.receipt.read'],
    moduleKey: 'finance',
  },
  {
    id: 'reports',
    label: 'Reports',
    to: '/reports',
    anyOf: ['student.directory.list', 'attendance.record.read', 'result.read', 'fee.receipt.read'],
    audience: 'staff',
    moduleKey: 'reports',
  },
  {
    id: 'imports',
    label: 'Imports',
    to: '/imports',
    anyOf: ['import.job.manage'],
    audience: 'staff',
    moduleKey: 'imports',
  },
  {
    id: 'organisation',
    label: 'Organisation',
    to: '/organisation',
    anyOf: ['org.structure.read', 'org.campus.manage', 'org.department.manage'],
    audience: 'staff',
  },
  {
    id: 'users',
    label: 'Users',
    to: '/users',
    anyOf: ['user.account.read', 'user.account.invite', 'user.account.suspend'],
    audience: 'staff',
  },
  {
    id: 'access',
    label: 'Roles & access',
    to: '/access',
    anyOf: ['role.assignment.grant', 'role.assignment.revoke'],
  },
  {
    id: 'security-center',
    label: 'Security Center',
    to: '/security-center',
    anyOf: ['vault.authority.read', 'vault.authority.manage', 'vault.device.manage'],
    audience: 'staff',
    moduleKey: 'school_vault',
  },
];

/** Route -> capabilities required to see the page (UX guard; the API enforces the real rule). */
export const ROUTE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  NAV_ITEMS.filter((i) => i.anyOf).map((i) => [i.to, i.anyOf as readonly string[]]),
);

export function visibleNav(identity: Identity): NavItem[] {
  const audience = identity.actorKind === 'STUDENT' ? 'student' : 'staff';
  return NAV_ITEMS.filter((i) => {
    // 1. Audience restriction (student vs staff)
    if (i.audience && i.audience !== audience) return false;
    // 2. User permission check (anyOf capabilities)
    if (i.anyOf && !can(identity, ...i.anyOf)) return false;
    // 3. Institution entitlement check (module enabled centrally by platform owner)
    if (i.moduleKey && !isModuleEntitled(identity, i.moduleKey)) return false;
    return true;
  });
}
