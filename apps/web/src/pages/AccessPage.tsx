import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { TextField } from '../components/ui/TextField';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { useStepUp } from '../features/auth/StepUp';
import {
  changeExpiry,
  fetchAccessRoles,
  fetchAccessUsers,
  fetchAssignments,
  grantRole,
  revokeAssignment,
  type AccessRole,
  type AccessUser,
  type Assignment,
  type ScopeType,
} from '../lib/api/access-api';
import { accessErrorMessage, accessLoadMessage } from '../lib/api/messages';
import {
  fetchCampuses,
  fetchDepartments,
  type CampusItem,
  type DepartmentItem,
} from '../lib/api/organisation-api';

/** An administrator assignment never expires (the server refuses it), so the page never offers an expiry for it. */
const NO_EXPIRY_ROLE = 'COLLEGE_ADMIN';
const MIN_REASON = 5;

/** Deterministic, locale-independent display of an instant. */
function formatWhen(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** True when the ISO instant lies in the future (module scope: the clock is read on submit, never while rendering). */
function isFuture(iso: string): boolean {
  return new Date(iso).getTime() > Date.now();
}

/** A `datetime-local` value (browser local time) to an ISO instant with an offset, or null when it is not a real date-time. */
function localToIso(value: string): string | null {
  if (value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function scopeLabel(a: Pick<Assignment, 'scopeType' | 'scopeName'>): string {
  if (a.scopeType === 'ORGANIZATION') return 'Whole organization';
  const kind = a.scopeType === 'CAMPUS' ? 'Campus' : 'Department';
  return `${kind}: ${a.scopeName ?? 'unknown'}`;
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  error,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  error?: string | undefined;
  children: ReactNode;
}) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
      >
        {children}
      </select>
      {error ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface GrantFormProps {
  roles: AccessRole[];
  campuses: CampusItem[];
  departments: DepartmentItem[];
  pending: boolean;
  onSubmit: (input: {
    roleId: string;
    scopeType: ScopeType;
    scopeId?: string;
    reason: string;
    validUntil?: string;
  }) => Promise<boolean>;
}

function GrantForm({ roles, campuses, departments, pending, onSubmit }: GrantFormProps) {
  const [roleId, setRoleId] = useState('');
  const [scopeTypeChoice, setScopeTypeChoice] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [expiry, setExpiry] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const grantable = useMemo(() => roles.filter((r) => r.grantable), [roles]);
  const role = grantable.find((r) => r.id === roleId);
  const allowed = role?.allowedScopeTypes ?? [];
  // The only allowed scope type is chosen for the user; otherwise the explicit choice counts if it is still allowed.
  const scopeType: string =
    allowed.length === 1
      ? (allowed[0] ?? '')
      : allowed.some((s) => s === scopeTypeChoice)
        ? scopeTypeChoice
        : '';
  const canExpire = role !== undefined && role.code !== NO_EXPIRY_ROLE;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!role) next['role'] = 'Choose a role.';
    if (role && scopeType === '') next['scopeType'] = 'Choose where the role applies.';
    if ((scopeType === 'CAMPUS' || scopeType === 'DEPARTMENT') && scopeId === '') {
      next['scope'] = scopeType === 'CAMPUS' ? 'Choose a campus.' : 'Choose a department.';
    }
    if (reason.trim().length < MIN_REASON) {
      next['reason'] = `Give a reason of at least ${MIN_REASON} characters.`;
    }
    let validUntil: string | undefined;
    if (canExpire && expiry !== '') {
      const iso = localToIso(expiry);
      if (!iso) next['expiry'] = 'Enter a valid date and time.';
      else if (!isFuture(iso)) next['expiry'] = 'The expiry must be in the future.';
      else validUntil = iso;
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || !role) return;

    const ok = await onSubmit({
      roleId: role.id,
      scopeType: scopeType as ScopeType,
      ...(scopeType !== 'ORGANIZATION' ? { scopeId } : {}),
      reason: reason.trim(),
      ...(validUntil ? { validUntil } : {}),
    });
    if (ok) {
      setRoleId('');
      setScopeTypeChoice('');
      setScopeId('');
      setExpiry('');
      setReason('');
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label="Grant a role">
      <SelectField
        label="Role"
        value={roleId}
        onChange={(v) => {
          setRoleId(v);
          setScopeTypeChoice('');
          setScopeId('');
        }}
        disabled={pending}
        error={errors['role']}
      >
        <option value="">Choose a role…</option>
        {grantable.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} ({r.code})
          </option>
        ))}
      </SelectField>
      {role ? (
        <p className="field-hint">
          {role.permissionCount} permissions, {role.criticalPermissionCount} of them critical.
        </p>
      ) : null}
      {allowed.length > 1 ? (
        <SelectField
          label="Applies to"
          value={scopeType}
          onChange={(v) => {
            setScopeTypeChoice(v);
            setScopeId('');
          }}
          disabled={pending}
          error={errors['scopeType']}
        >
          <option value="">Choose…</option>
          {allowed.map((s) => (
            <option key={s} value={s}>
              {s === 'ORGANIZATION'
                ? 'Whole organization'
                : s === 'CAMPUS'
                  ? 'One campus'
                  : 'One department'}
            </option>
          ))}
        </SelectField>
      ) : null}
      {scopeType === 'CAMPUS' ? (
        <SelectField
          label="Campus"
          value={scopeId}
          onChange={setScopeId}
          disabled={pending}
          error={errors['scope']}
        >
          <option value="">Choose a campus…</option>
          {campuses
            .filter((c) => c.status === 'ACTIVE')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </SelectField>
      ) : null}
      {scopeType === 'DEPARTMENT' ? (
        <SelectField
          label="Department"
          value={scopeId}
          onChange={setScopeId}
          disabled={pending}
          error={errors['scope']}
        >
          <option value="">Choose a department…</option>
          {departments
            .filter((d) => d.status === 'ACTIVE')
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </SelectField>
      ) : null}
      {canExpire ? (
        <TextField
          label="Expires (optional)"
          name="validUntil"
          type="datetime-local"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          hint="Leave empty for no expiry. Shown and checked in your local time."
          error={errors['expiry']}
          disabled={pending}
        />
      ) : null}
      {role && !canExpire ? (
        <p className="field-hint">An administrator assignment has no expiry.</p>
      ) : null}
      <TextField
        label="Reason"
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        hint="Recorded in the audit log."
        error={errors['reason']}
        disabled={pending}
        required
      />
      <Button type="submit" variant="primary" pending={pending}>
        {pending ? 'Granting…' : 'Grant role'}
      </Button>
    </form>
  );
}

type Panel = { kind: 'revoke' | 'expiry'; assignment: Assignment } | null;

function ActionPanel({
  panel,
  pending,
  onCancel,
  onRevoke,
  onExpiry,
}: {
  panel: NonNullable<Panel>;
  pending: boolean;
  onCancel: () => void;
  onRevoke: (a: Assignment, reason: string) => Promise<void>;
  onExpiry: (a: Assignment, validUntil: string | null, reason: string) => Promise<void>;
}) {
  const { assignment, kind } = panel;
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState('');
  const [permanent, setPermanent] = useState(assignment.validUntil === null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const checkboxId = useId();

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (reason.trim().length < MIN_REASON) {
      next['reason'] = `Give a reason of at least ${MIN_REASON} characters.`;
    }
    let validUntil: string | null = null;
    if (kind === 'expiry' && !permanent) {
      const iso = localToIso(expiry);
      if (!iso) next['expiry'] = 'Enter a valid date and time.';
      else if (!isFuture(iso)) next['expiry'] = 'The expiry must be in the future.';
      else validUntil = iso;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (kind === 'revoke') await onRevoke(assignment, reason.trim());
    else await onExpiry(assignment, validUntil, reason.trim());
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      noValidate
      aria-label={kind === 'revoke' ? 'Revoke assignment' : 'Change expiry'}
      className="access-panel"
    >
      <h3>
        {kind === 'revoke' ? 'Revoke' : 'Change the expiry of'} {assignment.roleCode} (
        {scopeLabel(assignment)})
      </h3>
      {kind === 'expiry' ? (
        <>
          <div className="field">
            <input
              id={checkboxId}
              type="checkbox"
              checked={permanent}
              disabled={pending}
              onChange={(e) => setPermanent(e.target.checked)}
            />{' '}
            <label htmlFor={checkboxId}>No expiry</label>
          </div>
          {!permanent ? (
            <TextField
              label="New expiry"
              name="validUntil"
              type="datetime-local"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              hint="Must be in the future. Shown and checked in your local time."
              error={errors['expiry']}
              disabled={pending}
            />
          ) : null}
        </>
      ) : null}
      <TextField
        label="Reason"
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        hint="Recorded in the audit log."
        error={errors['reason']}
        disabled={pending}
        required
      />
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button type="submit" variant="primary" pending={pending}>
          {kind === 'revoke' ? 'Confirm revoke' : 'Save expiry'}
        </Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function AccessPage() {
  usePageTitle('Roles & access');
  const { client, identity } = useAuth();
  const { runWithStepUp } = useStepUp();
  const canGrant = Boolean(identity && can(identity, 'role.assignment.grant'));
  const canRevoke = Boolean(identity && can(identity, 'role.assignment.revoke'));

  const [users, setUsers] = useState<AccessUser[]>([]);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [usersState, setUsersState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [usersError, setUsersError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState('');

  const [roles, setRoles] = useState<AccessRole[]>([]);
  const [campuses, setCampuses] = useState<CampusItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [supportError, setSupportError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AccessUser | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignState, setAssignState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [assignError, setAssignError] = useState<string | null>(null);

  const [panel, setPanel] = useState<Panel>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadUsers = useCallback(
    (after?: string) => {
      if (after) setLoadingMore(true);
      else setUsersState('loading');
      fetchAccessUsers(client, after)
        .then(({ users: page, nextAfterId }) => {
          setUsers((prev) => (after ? [...prev, ...page] : page));
          setNextAfter(nextAfterId);
          setUsersState('ready');
          setLoadingMore(false);
        })
        .catch((err: unknown) => {
          setUsersError(accessLoadMessage(err));
          setUsersState('error');
          setLoadingMore(false);
        });
    },
    [client],
  );

  const loadSupport = useCallback(() => {
    Promise.all([fetchAccessRoles(client), fetchCampuses(client), fetchDepartments(client)])
      .then(([r, c, d]) => {
        setRoles(r);
        setCampuses(c);
        setDepartments(d);
        setSupportError(null);
      })
      .catch((err: unknown) => setSupportError(accessLoadMessage(err)));
  }, [client]);

  const loadAssignments = useCallback(
    (user: AccessUser) => {
      setAssignState('loading');
      setAssignError(null);
      fetchAssignments(client, user.id)
        .then((list) => {
          setAssignments(list);
          setAssignState('ready');
        })
        .catch((err: unknown) => {
          setAssignError(accessErrorMessage(err));
          setAssignState('error');
        });
    },
    [client],
  );

  useEffect(() => {
    loadUsers();
    loadSupport();
  }, [loadUsers, loadSupport]);

  const select = (user: AccessUser): void => {
    setSelected(user);
    setPanel(null);
    setNotice(null);
    setActionError(null);
    loadAssignments(user);
  };

  /** Runs one mutation through the step-up flow, then reconciles the list from the server. */
  const act = async (work: () => Promise<unknown>, success: string): Promise<boolean> => {
    if (!selected) return false;
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await runWithStepUp(work, 'PASSWORD_MFA');
      setNotice(success);
      setPanel(null);
      loadAssignments(selected);
      return true;
    } catch (err) {
      setActionError(accessErrorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  };

  const visibleUsers = users.filter((u) => {
    const q = filter.trim().toLowerCase();
    return q === '' || u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q);
  });

  return (
    <>
      <h1>Roles &amp; access</h1>
      <p className="lead">
        See who holds which role, grant a role (optionally until a date), change an expiry, or
        revoke a role. Every change needs a reason, is recorded in the audit log, and asks you to
        confirm it is you.
      </p>
      {supportError ? <Alert tone="error">{supportError}</Alert> : null}

      <Card title="Users">
        {usersState === 'loading' ? <Spinner label="Loading users…" /> : null}
        {usersState === 'error' ? (
          <>
            <Alert tone="error">{usersError}</Alert>
            <Button type="button" variant="secondary" onClick={() => loadUsers()}>
              Try again
            </Button>
          </>
        ) : null}
        {usersState === 'ready' && users.length === 0 ? (
          <p className="muted">No users yet.</p>
        ) : null}
        {usersState === 'ready' && users.length > 0 ? (
          <>
            <TextField
              label="Filter users"
              name="userFilter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              hint="Filters the users loaded so far by name or e-mail."
            />
            {visibleUsers.length === 0 ? (
              <p className="muted">No loaded user matches the filter.</p>
            ) : (
              <table className="data-table">
                <caption className="sr-only">Users of this organization</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">E-mail</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((u) => (
                    <tr key={u.id}>
                      <td>{u.displayName}</td>
                      <td>{u.email}</td>
                      <td>
                        <Badge>{u.status}</Badge>
                      </td>
                      <td>
                        <Button
                          type="button"
                          variant="secondary"
                          aria-label={`Manage access for ${u.email}`}
                          aria-pressed={selected?.id === u.id}
                          onClick={() => select(u)}
                        >
                          Manage access
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {nextAfter ? (
              <Button
                type="button"
                variant="secondary"
                pending={loadingMore}
                onClick={() => loadUsers(nextAfter)}
              >
                {loadingMore ? 'Loading…' : 'Load more users'}
              </Button>
            ) : null}
          </>
        ) : null}
      </Card>

      {selected ? (
        <Card title={`Access of ${selected.displayName}`}>
          <p className="muted">{selected.email}</p>
          {notice ? <Alert tone="success">{notice}</Alert> : null}
          {actionError ? <Alert tone="error">{actionError}</Alert> : null}
          {assignState === 'loading' ? <Spinner label="Loading role assignments…" /> : null}
          {assignState === 'error' ? (
            <>
              <Alert tone="error">{assignError}</Alert>
              <Button type="button" variant="secondary" onClick={() => loadAssignments(selected)}>
                Try again
              </Button>
            </>
          ) : null}
          {assignState === 'ready' && assignments.length === 0 ? (
            <p className="muted">This user has no role assignments.</p>
          ) : null}
          {assignState === 'ready' && assignments.length > 0 ? (
            <table className="data-table">
              <caption className="sr-only">Role assignments of {selected.displayName}</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Applies to</th>
                  <th scope="col">State</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => {
                  const live = a.state === 'EFFECTIVE' || a.state === 'PENDING';
                  return (
                    <tr key={a.id}>
                      <td>{a.roleCode}</td>
                      <td>{scopeLabel(a)}</td>
                      <td>
                        <Badge>{a.state}</Badge>
                      </td>
                      <td>{a.validUntil ? formatWhen(a.validUntil) : 'Never'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                          {canGrant && a.state === 'EFFECTIVE' && a.roleCode !== NO_EXPIRY_ROLE ? (
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={pending}
                              aria-label={`Change expiry of ${a.roleCode} assignment, ${scopeLabel(a)}`}
                              onClick={() => {
                                setPanel({ kind: 'expiry', assignment: a });
                                setNotice(null);
                                setActionError(null);
                              }}
                            >
                              Change expiry
                            </Button>
                          ) : null}
                          {canRevoke && live ? (
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={pending}
                              aria-label={`Revoke ${a.roleCode} assignment, ${scopeLabel(a)}`}
                              onClick={() => {
                                setPanel({ kind: 'revoke', assignment: a });
                                setNotice(null);
                                setActionError(null);
                              }}
                            >
                              Revoke
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}

          {panel ? (
            <ActionPanel
              key={`${panel.kind}:${panel.assignment.id}`}
              panel={panel}
              pending={pending}
              onCancel={() => setPanel(null)}
              onRevoke={async (a, reason) => {
                await act(() => revokeAssignment(client, a.id, reason), `${a.roleCode} revoked.`);
              }}
              onExpiry={async (a, validUntil, reason) => {
                await act(
                  () => changeExpiry(client, a, { validUntil, reason }),
                  validUntil
                    ? `Expiry of ${a.roleCode} updated.`
                    : `${a.roleCode} no longer expires.`,
                );
              }}
            />
          ) : null}

          {canGrant ? (
            <section aria-labelledby="grant-heading">
              <h3 id="grant-heading">Grant a role</h3>
              {roles.length === 0 ? (
                <p className="muted">Roles are not available. Reload the page to try again.</p>
              ) : roles.every((r) => !r.grantable) ? (
                <p className="muted">Your role cannot grant any role.</p>
              ) : (
                <GrantForm
                  roles={roles}
                  campuses={campuses}
                  departments={departments}
                  pending={pending}
                  onSubmit={(input) =>
                    act(() => grantRole(client, selected.id, input), 'Role granted.')
                  }
                />
              )}
            </section>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
