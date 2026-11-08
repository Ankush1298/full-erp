import { describe, expect, it } from 'vitest';
import { can, roleLabel, toIdentity } from '../src/features/auth/identity';

// Doc 44: the institution's role names are display only.
const me = (labels: Record<string, string>) =>
  toIdentity({
    tenant_id: 't',
    user_id: 'u',
    actor_kind: 'STAFF',
    display_name: 'Asha',
    roles: ['COLLEGE_ADMIN'],
    capabilities: ['org.settings.read'],
    institution_type: 'SCHOOL',
    role_labels: labels,
    csrf_token: 'x'.repeat(20),
  });

describe('role labels', () => {
  it('use the institution name when the server sends one, else the built-in name, else the code', () => {
    const school = me({ COLLEGE_ADMIN: 'Principal' });
    expect(roleLabel('COLLEGE_ADMIN', school)).toBe('Principal');
    expect(roleLabel('COLLEGE_ADMIN')).toBe('College administrator');
    expect(roleLabel('FACULTY', school)).toBe('Faculty');
    expect(roleLabel('UNKNOWN_ROLE', school)).toBe('UNKNOWN_ROLE');
  });

  it('a label never changes what the user can do: capabilities are identical whatever the labels say', () => {
    const a = me({ COLLEGE_ADMIN: 'Principal' });
    const b = me({ COLLEGE_ADMIN: 'University administrator' });
    expect([...a.capabilities]).toEqual([...b.capabilities]);
    expect(can(a, 'org.settings.manage')).toBe(false);
    expect(can(a, 'org.settings.read')).toBe(true);
    // a role CALLED "Principal" is not recognised by name anywhere: only capabilities decide
    expect(can(me({ FACULTY: 'Principal' }), 'org.settings.manage')).toBe(false);
  });
});
