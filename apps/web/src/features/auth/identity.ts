import type { MeResponse } from '../../lib/api/schemas';

/** The verified identity as returned by the backend. Nothing here is ever derived on the client. */
export interface Identity {
  readonly userId: string;
  readonly displayName: string;
  readonly actorKind: 'STUDENT' | 'STAFF';
  readonly roles: readonly string[];
  readonly capabilities: ReadonlySet<string>;
  /** Display names for this user's roles as the institution chose (doc 44). Never consulted for access. */
  readonly roleLabels?: Readonly<Record<string, string>>;
  readonly institutionType?: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY' | null;
}

export function toIdentity(me: MeResponse): Identity {
  return {
    userId: me.user_id,
    displayName: me.display_name,
    actorKind: me.actor_kind,
    roles: me.roles,
    capabilities: new Set(me.capabilities),
    roleLabels: me.role_labels,
    institutionType: me.institution_type,
  };
}

export function can(identity: Identity, ...anyOf: readonly string[]): boolean {
  return anyOf.some((c) => identity.capabilities.has(c));
}

/** Capabilities that mean "this person administers part of the organisation" (landing shell only). */
const ADMIN_CAPABILITIES = [
  'role.assignment.grant',
  'org.settings.read',
  'org.campus.manage',
  'org.department.manage',
  'session.revoke_any',
] as const;

export type ShellKind = 'student' | 'staff' | 'admin';

/** Which landing shell to show. A UX choice only: every action is authorised by the backend. */
export function shellKind(identity: Identity): ShellKind {
  if (identity.actorKind === 'STUDENT') return 'student';
  return can(identity, ...ADMIN_CAPABILITIES) ? 'admin' : 'staff';
}

const ROLE_LABELS: Record<string, string> = {
  STUDENT: 'Student',
  FACULTY: 'Faculty',
  STAFF: 'Staff',
  HOD: 'Head of department',
  DEPARTMENT_ADMIN: 'Department administrator',
  CAMPUS_ADMIN: 'Campus administrator',
  COLLEGE_ADMIN: 'College administrator',
  REGISTRAR: 'Registrar',
};

/** The role's display name: the institution's (from the server) over the built-in default. Display only. */
export function roleLabel(code: string, identity?: Pick<Identity, 'roleLabels'> | null): string {
  return identity?.roleLabels?.[code] ?? ROLE_LABELS[code] ?? code;
}
