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
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { StatCard } from '../components/ui/StatCard';
import { StatusBadge } from '../components/ui/StatusBadge';
import { TextField } from '../components/ui/TextField';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { useStepUp } from '../features/auth/StepUp';
import { userErrorMessage, userLoadMessage } from '../lib/api/messages';
import {
  adminResetUserMfa,
  fetchUsers,
  inviteUser,
  issueMfaEnrollmentTicket,
  reactivateUser,
  suspendUser,
  USER_STATUSES,
  type IssueMfaTicketResult,
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
  const canResetMfa = Boolean(identity && can(identity, 'user.account.reset_mfa'));

  const [users, setUsers] = useState<User[]>([]);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [usersState, setUsersState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [usersError, setUsersError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [statusFilter, setStatusFilter] = useState<'ALL' | UserStatus>('ALL');
  const [searchFilter, setSearchFilter] = useState('');

  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [activeModal, setActiveModal] = useState<
    'invite' | 'suspend' | 'reactivate' | 'reset_mfa' | 'issue_ticket' | null
  >(null);
  const [ticketResult, setTicketResult] = useState<IssueMfaTicketResult | null>(null);
  const [ticketCopied, setTicketCopied] = useState(false);

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

  const openResetMfaModal = (user: User) => {
    setSelectedUser(user);
    setActiveModal('reset_mfa');
    setMutationReason('');
    setMutationError(null);
    setActionError(null);
    setNotice(null);
    setTicketResult(null);
  };

  const openIssueTicketModal = (user: User) => {
    setSelectedUser(user);
    setActiveModal('issue_ticket');
    setMutationReason('');
    setMutationError(null);
    setActionError(null);
    setNotice(null);
    setTicketResult(null);
    setTicketCopied(false);
  };

  const closeModal = () => {
    setActiveModal(null);
    setMutationReason('');
    setMutationError(null);
    setInviteErrors({});
    setTicketResult(null);
    setTicketCopied(false);
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

  // Submit MFA Reset
  const submitResetMfa = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selectedUser) return;

    if (identity && identity.userId === selectedUser.id) {
      setMutationError('You cannot reset MFA for your own account.');
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
      const result = await runWithStepUp(
        () => adminResetUserMfa(client, selectedUser.id, trimmedReason),
        'PASSWORD_MFA',
      );
      closeModal();
      setNotice({
        tone: 'success',
        message: `MFA reset successfully for ${selectedUser.displayName} (${selectedUser.email}). ${result.factorsRevoked} factor(s) and ${result.sessionsRevoked} session(s) revoked. User is provisioned to re-enroll MFA on next login.`,
      });
      loadUsers(undefined, statusFilter);
    } catch (err: unknown) {
      setActionError(userErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  // Submit Issue Re-enrollment Ticket
  const submitIssueTicket = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selectedUser) return;

    if (identity && identity.userId === selectedUser.id) {
      setMutationError('You cannot issue an enrollment ticket for your own account.');
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

    try {
      const result = await runWithStepUp(
        () => issueMfaEnrollmentTicket(client, selectedUser.id, trimmedReason),
        'PASSWORD_MFA',
      );
      setTicketResult(result);
      setNotice({
        tone: 'success',
        message: `A 24-hour MFA enrollment ticket has been generated for ${selectedUser.displayName}.`,
      });
    } catch (err: unknown) {
      setActionError(userErrorMessage(err));
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
      <PageHeader
        title="Users"
        subtitle="Manage user directory accounts, send invitations, and manage account status. Critical changes require step-up verification and are recorded in the audit log."
        actions={
          canInvite ? (
            <Button type="button" variant="primary" onClick={openInviteModal} disabled={pending}>
              Invite user
            </Button>
          ) : null
        }
      />

      <div className="stat-grid" style={{ marginBottom: 'var(--space-4)' }}>
        <StatCard
          label="Total Users"
          value={users.length}
          tone="purple"
          helper="Loaded directory accounts"
        />
        <StatCard
          label="Active Accounts"
          value={users.filter((u) => u.status === 'ACTIVE').length}
          tone="emerald"
          helper="Full access active users"
        />
        <StatCard
          label="Pending Invitations"
          value={users.filter((u) => u.status === 'INVITED').length}
          tone="amber"
          helper="Awaiting account setup"
        />
        <StatCard
          label="Suspended Accounts"
          value={users.filter((u) => u.status === 'SUSPENDED').length}
          tone="coral"
          helper="Access revoked"
        />
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

      {/* Reset MFA Confirmation Panel */}
      {activeModal === 'reset_mfa' && selectedUser ? (
        <Card title={`Reset Multi-Factor Authentication: ${selectedUser.displayName}`}>
          <form
            onSubmit={(e) => void submitResetMfa(e)}
            noValidate
            aria-label="Reset MFA for user"
            className="access-panel"
          >
            <p style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
              Resetting MFA will immediately revoke all registered authenticators, emergency
              recovery codes, and live sessions for {selectedUser.displayName} ({selectedUser.email}
              ).
            </p>
            <p className="field-hint" style={{ marginBottom: 'var(--space-3)' }}>
              A single-use 24-hour re-enrollment ticket will automatically be provisioned. When{' '}
              {selectedUser.displayName} signs in next, they will be prompted to configure their new
              authenticator app.
            </p>
            {isSelf ? (
              <Alert tone="error">
                You cannot reset MFA for your own account. Ask another administrator to perform this
                action.
              </Alert>
            ) : null}
            <TextField
              label="Reason for MFA reset"
              name="reason"
              value={mutationReason}
              onChange={(e) => setMutationReason(e.target.value)}
              hint="Required for security audit compliance (minimum 5 characters, e.g., 'Staff lost mobile phone')."
              error={mutationError ?? undefined}
              disabled={pending || isSelf}
              required
            />
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <Button type="submit" variant="primary" pending={pending} disabled={isSelf}>
                Confirm MFA reset
              </Button>
              <Button type="button" variant="secondary" disabled={pending} onClick={closeModal}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {/* Issue Re-enrollment Ticket Panel */}
      {activeModal === 'issue_ticket' && selectedUser ? (
        <Card title={`Issue MFA Enrollment Ticket: ${selectedUser.displayName}`}>
          {ticketResult ? (
            <div className="access-panel">
              <Alert tone="success">
                Enrollment ticket generated successfully for {selectedUser.displayName}.
              </Alert>
              <p className="field-hint" style={{ marginTop: 'var(--space-2)' }}>
                Ticket ID: <code>{ticketResult.ticketId}</code>
                <br />
                Expires at: <strong>{formatWhen(ticketResult.expiresAt)}</strong>
              </p>
              <div style={{ marginTop: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
                <label
                  htmlFor="ticket-token-display"
                  style={{ display: 'block', fontWeight: 600, marginBottom: 'var(--space-1)' }}
                >
                  64-character Ticket Token
                </label>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <input
                    id="ticket-token-display"
                    type="text"
                    readOnly
                    value={ticketResult.ticket}
                    style={{
                      fontFamily: 'var(--font-mono, monospace)',
                      width: '100%',
                      padding: 'var(--space-2)',
                      fontSize: '0.9rem',
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard?.writeText(ticketResult.ticket);
                      setTicketCopied(true);
                      setTimeout(() => setTicketCopied(false), 3000);
                    }}
                  >
                    {ticketCopied ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
              </div>
              <Button type="button" variant="primary" onClick={closeModal}>
                Done
              </Button>
            </div>
          ) : (
            <form
              onSubmit={(e) => void submitIssueTicket(e)}
              noValidate
              aria-label="Issue MFA Enrollment Ticket"
              className="access-panel"
            >
              <p className="field-hint" style={{ marginBottom: 'var(--space-3)' }}>
                Issues a single-use 24-hour ticket authorizing {selectedUser.displayName} to enroll
                or re-enroll multi-factor authentication.
              </p>
              {isSelf ? (
                <Alert tone="error">
                  You cannot issue an enrollment ticket for your own account.
                </Alert>
              ) : null}
              <TextField
                label="Reason for ticket issuance"
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
                  Generate ticket
                </Button>
                <Button type="button" variant="secondary" disabled={pending} onClick={closeModal}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
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
          <ErrorState
            title="User directory error"
            message={usersError ?? 'Failed to load users.'}
            onRetry={() => loadUsers(undefined, statusFilter)}
            retryLabel="Retry"
          />
        ) : null}

        {usersState === 'ready' && filteredUsers.length === 0 ? (
          <EmptyState
            title="No users found"
            description={users.length === 0 ? 'No users found.' : 'No users match your filter.'}
            compact
          />
        ) : null}

        {usersState === 'ready' && filteredUsers.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" aria-label="User directory">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Status</th>
                  <th scope="col">MFA</th>
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
                        <StatusBadge status={u.status} />
                      </td>
                      <td>
                        {u.mfaEnrolled ? (
                          <span
                            className="badge badge--success"
                            style={{
                              backgroundColor: 'var(--color-success-bg, #e6f4ea)',
                              color: 'var(--color-success-text, #137333)',
                              fontWeight: 600,
                            }}
                          >
                            Enrolled
                          </span>
                        ) : (
                          <span
                            className="badge"
                            style={{
                              backgroundColor: 'var(--color-surface-hover, #f1f3f4)',
                              color: 'var(--color-text-secondary, #5f6368)',
                            }}
                          >
                            Not enrolled
                          </span>
                        )}
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
              <StatusBadge status={selectedUser.status} />
            </dd>
            <dt style={{ fontWeight: 600 }}>Two-Factor (MFA):</dt>
            <dd>
              {selectedUser.mfaEnrolled ? (
                <span
                  className="badge badge--success"
                  style={{
                    backgroundColor: 'var(--color-success-bg, #e6f4ea)',
                    color: 'var(--color-success-text, #137333)',
                    fontWeight: 600,
                  }}
                >
                  Enrolled
                </span>
              ) : (
                <span
                  className="badge"
                  style={{
                    backgroundColor: 'var(--color-surface-hover, #f1f3f4)',
                    color: 'var(--color-text-secondary, #5f6368)',
                  }}
                >
                  Not enrolled
                </span>
              )}
            </dd>
            <dt style={{ fontWeight: 600 }}>Created at:</dt>
            <dd>{formatWhen(selectedUser.createdAt)}</dd>
            <dt style={{ fontWeight: 600 }}>Account version:</dt>
            <dd>{selectedUser.version}</dd>
          </dl>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            {canResetMfa && !isSelf ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => openResetMfaModal(selectedUser)}
                  title={`Reset MFA factors and sessions for ${selectedUser.displayName}`}
                >
                  Reset MFA
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => openIssueTicketModal(selectedUser)}
                  title={`Issue single-use MFA enrollment ticket for ${selectedUser.displayName}`}
                >
                  Issue MFA ticket
                </Button>
              </>
            ) : null}
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
