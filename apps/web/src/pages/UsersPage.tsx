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
import { userErrorMessage, userLoadMessage } from '../lib/api/messages';
import {
  fetchUsers,
  inviteUser,
  reactivateUser,
  suspendUser,
  USER_STATUSES,
  type User,
  type UserStatus,
} from '../lib/api/user-api';

const MIN_REASON = 5;

/** Deterministic display of an ISO instant. */
function formatWhen(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
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

interface Notice {
  tone: 'success' | 'info';
  message: string;
}

export function UsersPage() {
  usePageTitle('Users');
  const { client, identity } = useAuth();
  const { runWithStepUp } = useStepUp();

  const canInvite = Boolean(identity && can(identity, 'user.account.invite'));
  const canSuspend = Boolean(identity && can(identity, 'user.account.suspend'));

  const [users, setUsers] = useState<User[]>([]);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [usersState, setUsersState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [usersError, setUsersError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [statusFilter, setStatusFilter] = useState<'ALL' | UserStatus>('ALL');
  const [searchFilter, setSearchFilter] = useState('');

  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [activeModal, setActiveModal] = useState<'invite' | 'suspend' | 'reactivate' | null>(null);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteReason, setInviteReason] = useState('');
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});

  // Consequential mutation (suspend/reactivate) state
  const [mutationReason, setMutationReason] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadUsers = useCallback(
    (after?: string, currentStatus?: 'ALL' | UserStatus) => {
      if (after) setLoadingMore(true);
      else setUsersState('loading');
      setUsersError(null);

      const status = currentStatus ?? statusFilter;
      fetchUsers(client, {
        status: status === 'ALL' ? undefined : status,
        afterId: after,
      })
        .then(({ users: page, nextAfterId }) => {
          setUsers((prev) => (after ? [...prev, ...page] : page));
          setNextAfter(nextAfterId);
          setUsersState('ready');
          setLoadingMore(false);
        })
        .catch((err: unknown) => {
          setUsersError(userLoadMessage(err));
          setUsersState('error');
          setLoadingMore(false);
        });
    },
    [client, statusFilter],
  );

  useEffect(() => {
    loadUsers(undefined, statusFilter);
  }, [loadUsers, statusFilter]);

  const onStatusFilterChange = (newStatus: string) => {
    const val = newStatus as 'ALL' | UserStatus;
    setStatusFilter(val);
    setSelectedUser(null);
    setActiveModal(null);
    setNotice(null);
    setActionError(null);
  };

  const handleSelectUser = (user: User) => {
    setSelectedUser(user);
    setActiveModal(null);
    setNotice(null);
    setActionError(null);
  };

  const openInviteModal = () => {
    setActiveModal('invite');
    setInviteEmail('');
    setInviteName('');
    setInviteReason('');
    setInviteErrors({});
    setActionError(null);
    setNotice(null);
  };

  const openSuspendModal = (user: User) => {
    setSelectedUser(user);
    setActiveModal('suspend');
    setMutationReason('');
    setMutationError(null);
    setActionError(null);
    setNotice(null);
  };

  const openReactivateModal = (user: User) => {
    setSelectedUser(user);
    setActiveModal('reactivate');
    setMutationReason('');
    setMutationError(null);
    setActionError(null);
    setNotice(null);
  };

  const closeModal = () => {
    setActiveModal(null);
    setMutationReason('');
    setMutationError(null);
    setInviteErrors({});
  };

  // Submit invitation
  const submitInvite = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const nextErrors: Record<string, string> = {};

    const trimmedEmail = inviteEmail.trim();
    if (!trimmedEmail) {
      nextErrors['email'] = 'Email address is required.';
    } else if (!trimmedEmail.includes('@') || !trimmedEmail.includes('.')) {
      nextErrors['email'] = 'Enter a valid email address.';
    }

    const trimmedName = inviteName.trim();
    if (!trimmedName) {
      nextErrors['displayName'] = 'Full name is required.';
    }

    const trimmedReason = inviteReason.trim();
    if (trimmedReason.length < MIN_REASON) {
      nextErrors['reason'] = `Give a reason of at least ${MIN_REASON} characters.`;
    }

    setInviteErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    setActionError(null);
    setNotice(null);

    try {
      const res = await inviteUser(client, {
        email: trimmedEmail,
        displayName: trimmedName,
        reason: trimmedReason,
      });

      closeModal();
      if (res.delivery === 'SENT') {
        setNotice({
          tone: 'success',
          message: `Invitation created and sent via email to ${trimmedEmail}.`,
        });
      } else if (res.delivery === 'FAILED') {
        setNotice({
          tone: 'info',
          message: `Invitation created for ${trimmedEmail}, but email delivery failed (no email provider configured). The user is recorded with status INVITED.`,
        });
      } else {
        setNotice({
          tone: 'info',
          message: `Invitation recorded for ${trimmedEmail} (email delivery not attempted).`,
        });
      }
      loadUsers(undefined, statusFilter);
    } catch (err: unknown) {
      setActionError(userErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  // Submit suspend
  const submitSuspend = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selectedUser) return;

    if (identity && identity.userId === selectedUser.id) {
      setMutationError('You cannot suspend your own account.');
      return;
    }

    const trimmedReason = mutationReason.trim();
    if (trimmedReason.length < MIN_REASON) {
      setMutationError(`Give a reason of at least ${MIN_REASON} characters.`);
      return;
    }
    setMutationError(null);

    setPending(true);
    setActionError(null);
    setNotice(null);

    try {
      const updated = await runWithStepUp(
        () => suspendUser(client, selectedUser, { reason: trimmedReason }),
        'PASSWORD_MFA',
      );
      closeModal();
      setSelectedUser(updated);
      setNotice({
        tone: 'success',
        message: `Account for ${updated.displayName} (${updated.email}) has been suspended.`,
      });
      loadUsers(undefined, statusFilter);
    } catch (err: unknown) {
      // Never silently retry on conflict; notify and refresh
      setActionError(userErrorMessage(err));
      loadUsers(undefined, statusFilter);
    } finally {
      setPending(false);
    }
  };

  // Submit reactivate
  const submitReactivate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selectedUser) return;

    const trimmedReason = mutationReason.trim();
    if (trimmedReason.length < MIN_REASON) {
      setMutationError(`Give a reason of at least ${MIN_REASON} characters.`);
      return;
    }
    setMutationError(null);

    setPending(true);
    setActionError(null);
    setNotice(null);

    try {
      const updated = await runWithStepUp(
        () => reactivateUser(client, selectedUser, { reason: trimmedReason }),
        'PASSWORD_MFA',
      );
      closeModal();
      setSelectedUser(updated);
      setNotice({
        tone: 'success',
        message: `Account for ${updated.displayName} (${updated.email}) has been reactivated.`,
      });
      loadUsers(undefined, statusFilter);
    } catch (err: unknown) {
      // Never silently retry on conflict; notify and refresh
      setActionError(userErrorMessage(err));
      loadUsers(undefined, statusFilter);
    } finally {
      setPending(false);
    }
  };

  const filteredUsers = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q),
    );
  }, [users, searchFilter]);

  const isSelf = selectedUser ? identity?.userId === selectedUser.id : false;

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <div>
          <h1>Users</h1>
          <p className="lead">
            Manage user directory accounts, send invitations, and manage account status. Critical
            changes require step-up verification and are recorded in the audit log.
          </p>
        </div>
        {canInvite ? (
          <div>
            <Button type="button" variant="primary" onClick={openInviteModal} disabled={pending}>
              Invite user
            </Button>
          </div>
        ) : null}
      </div>

      {notice ? <Alert tone={notice.tone}>{notice.message}</Alert> : null}
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      {/* Invite Modal / Panel */}
      {activeModal === 'invite' ? (
        <Card title="Invite user">
          <form
            onSubmit={(e) => void submitInvite(e)}
            noValidate
            aria-label="Invite user"
            className="access-panel"
          >
            <p className="field-hint" style={{ marginBottom: 'var(--space-3)' }}>
              An invitation creates the user account in INVITED status and sends an activation email
              if email delivery is configured.
            </p>
            <TextField
              label="Email address"
              name="email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              error={inviteErrors['email']}
              disabled={pending}
              required
            />
            <TextField
              label="Full name"
              name="displayName"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              error={inviteErrors['displayName']}
              disabled={pending}
              required
            />
            <TextField
              label="Reason for invitation"
              name="reason"
              value={inviteReason}
              onChange={(e) => setInviteReason(e.target.value)}
              hint="Recorded in the tenant audit log (minimum 5 characters)."
              error={inviteErrors['reason']}
              disabled={pending}
              required
            />
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <Button type="submit" variant="primary" pending={pending}>
                Send invitation
              </Button>
              <Button type="button" variant="secondary" disabled={pending} onClick={closeModal}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {/* Suspend Confirmation Panel */}
      {activeModal === 'suspend' && selectedUser ? (
        <Card title={`Suspend user: ${selectedUser.displayName}`}>
          <form
            onSubmit={(e) => void submitSuspend(e)}
            noValidate
            aria-label="Suspend user account"
            className="access-panel"
          >
            <p style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
              Suspending this account will immediately revoke all active sessions for{' '}
              {selectedUser.displayName} ({selectedUser.email}). They will be unable to sign in
              until reactivated.
            </p>
            {isSelf ? (
              <Alert tone="error">
                You cannot suspend your own account. Ask another administrator to perform this
                action.
              </Alert>
            ) : null}
            <TextField
              label="Reason for suspension"
              name="reason"
              value={mutationReason}
              onChange={(e) => setMutationReason(e.target.value)}
              hint="Required for audit compliance (minimum 5 characters)."
              error={mutationError ?? undefined}
              disabled={pending || isSelf}
              required
            />
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <Button type="submit" variant="primary" pending={pending} disabled={isSelf}>
                Confirm suspension
              </Button>
              <Button type="button" variant="secondary" disabled={pending} onClick={closeModal}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {/* Reactivate Confirmation Panel */}
      {activeModal === 'reactivate' && selectedUser ? (
        <Card title={`Reactivate user: ${selectedUser.displayName}`}>
          <form
            onSubmit={(e) => void submitReactivate(e)}
            noValidate
            aria-label="Reactivate user account"
            className="access-panel"
          >
            <p style={{ marginBottom: 'var(--space-3)' }}>
              Reactivating this account will restore {selectedUser.displayName} (
              {selectedUser.email}) to ACTIVE status, allowing them to sign in again.
            </p>
            <TextField
              label="Reason for reactivation"
              name="reason"
              value={mutationReason}
              onChange={(e) => setMutationReason(e.target.value)}
              hint="Required for audit compliance (minimum 5 characters)."
              error={mutationError ?? undefined}
              disabled={pending}
              required
            />
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <Button type="submit" variant="primary" pending={pending}>
                Confirm reactivation
              </Button>
              <Button type="button" variant="secondary" disabled={pending} onClick={closeModal}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {/* User Directory */}
      <Card title="User directory">
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-4)',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            marginBottom: 'var(--space-3)',
          }}
        >
          <div style={{ minWidth: '12rem' }}>
            <SelectField
              label="Filter by status"
              value={statusFilter}
              onChange={onStatusFilterChange}
            >
              <option value="ALL">All statuses</option>
              {USER_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </SelectField>
          </div>
          <div style={{ flex: 1, minWidth: '15rem' }}>
            <TextField
              label="Search users"
              name="search"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              hint="Filter currently loaded users by name or email."
            />
          </div>
        </div>

        {usersState === 'loading' ? <Spinner label="Loading users…" /> : null}

        {usersState === 'error' ? (
          <div>
            <Alert tone="error">{usersError ?? 'Failed to load users.'}</Alert>
            <Button
              type="button"
              variant="secondary"
              onClick={() => loadUsers(undefined, statusFilter)}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {usersState === 'ready' && filteredUsers.length === 0 ? (
          <p className="field-hint">
            {users.length === 0 ? 'No users found.' : 'No users match your filter.'}
          </p>
        ) : null}

        {usersState === 'ready' && filteredUsers.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" aria-label="User directory">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => {
                  const isCurrentSelf = identity?.userId === u.id;
                  const isSelected = selectedUser?.id === u.id;
                  return (
                    <tr
                      key={u.id}
                      style={{
                        backgroundColor: isSelected ? 'var(--color-surface)' : undefined,
                      }}
                    >
                      <td>
                        <strong>{u.displayName}</strong>
                        {isCurrentSelf ? (
                          <span
                            className="badge"
                            style={{ marginLeft: 'var(--space-2)' }}
                            title="Your account"
                          >
                            You
                          </span>
                        ) : null}
                      </td>
                      <td>{u.email}</td>
                      <td>
                        <Badge>{u.status}</Badge>
                      </td>
                      <td>{formatWhen(u.createdAt)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => handleSelectUser(u)}
                            aria-label={`View details for ${u.email}`}
                          >
                            Details
                          </Button>
                          {canSuspend && u.status === 'ACTIVE' ? (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => openSuspendModal(u)}
                              disabled={isCurrentSelf}
                              aria-label={`Suspend ${u.email}`}
                              title={
                                isCurrentSelf
                                  ? 'You cannot suspend your own account'
                                  : `Suspend account for ${u.displayName}`
                              }
                            >
                              Suspend
                            </Button>
                          ) : null}
                          {canSuspend && u.status === 'SUSPENDED' ? (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => openReactivateModal(u)}
                              aria-label={`Reactivate ${u.email}`}
                              title={`Reactivate account for ${u.displayName}`}
                            >
                              Reactivate
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {nextAfter ? (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Button
              type="button"
              variant="secondary"
              pending={loadingMore}
              onClick={() => loadUsers(nextAfter, statusFilter)}
            >
              Load more users
            </Button>
          </div>
        ) : null}
      </Card>

      {/* Selected User Detail Card */}
      {selectedUser ? (
        <Card title={`Account details: ${selectedUser.displayName}`}>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              gap: 'var(--space-2) var(--space-4)',
              margin: 'var(--space-2) 0',
            }}
          >
            <dt style={{ fontWeight: 600 }}>Email:</dt>
            <dd>{selectedUser.email}</dd>
            <dt style={{ fontWeight: 600 }}>Display name:</dt>
            <dd>{selectedUser.displayName}</dd>
            <dt style={{ fontWeight: 600 }}>Status:</dt>
            <dd>
              <Badge>{selectedUser.status}</Badge>
            </dd>
            <dt style={{ fontWeight: 600 }}>Created at:</dt>
            <dd>{formatWhen(selectedUser.createdAt)}</dd>
            <dt style={{ fontWeight: 600 }}>Account version:</dt>
            <dd>{selectedUser.version}</dd>
          </dl>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            {canSuspend && selectedUser.status === 'ACTIVE' ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => openSuspendModal(selectedUser)}
                disabled={isSelf}
                title={
                  isSelf
                    ? 'You cannot suspend your own account'
                    : `Suspend account for ${selectedUser.displayName}`
                }
              >
                Suspend account
              </Button>
            ) : null}
            {canSuspend && selectedUser.status === 'SUSPENDED' ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => openReactivateModal(selectedUser)}
              >
                Reactivate account
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => setSelectedUser(null)}>
              Dismiss
            </Button>
          </div>
        </Card>
      ) : null}
    </>
  );
}
