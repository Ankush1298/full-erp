import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderApp } from './helpers/render';
import { createFakeBackend, STAFF, STUDENT, USER_ADMIN, type MeData } from './helpers/fakeBackend';

type Backend = ReturnType<typeof createFakeBackend>;

const posts = (b: Backend, path: string) => b.callsTo('POST', path);

async function verifyWithMfa(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('dialog', { name: "Confirm it's you" });
  await user.type(screen.getByLabelText('Verification code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Verify' }));
}

describe('/users: user directory and account management', () => {
  it('renders loading state, user directory table, status badges, and details drawer', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/users');

    expect(await screen.findByText('Loading users…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'User directory' })).toBeInTheDocument();

    // Verify loaded users
    expect(screen.getByText('Fiona Faculty')).toBeInTheDocument();
    expect(screen.getByText('fiona.faculty@college.test')).toBeInTheDocument();
    expect(screen.getByText('Sam Staff')).toBeInTheDocument();
    expect(screen.getByText('sam.staff@college.test')).toBeInTheDocument();

    // Open user details drawer
    await user.click(
      screen.getByRole('button', { name: 'View details for fiona.faculty@college.test' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Account details: Fiona Faculty' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Account version:')).toBeInTheDocument();

    // Dismiss drawer
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByRole('heading', { name: 'Account details: Fiona Faculty' }),
    ).not.toBeInTheDocument();
  });

  it('filters users locally by search query and remotely by status dropdown', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    // Add an invited user and a suspended user to test dataset
    b.state.access.users.push(
      {
        id: 'user-ivan',
        email: 'ivan.invited@college.test',
        displayName: 'Ivan Invited',
        status: 'INVITED',
        version: 1,
        createdAt: '2026-10-04T09:00:00.000Z',
      },
      {
        id: 'user-sue',
        email: 'sue.suspended@college.test',
        displayName: 'Sue Suspended',
        status: 'SUSPENDED',
        version: 2,
        createdAt: '2026-10-05T09:00:00.000Z',
      },
    );

    const user = userEvent.setup();
    renderApp(b, '/users');

    expect(await screen.findByText('fiona.faculty@college.test')).toBeInTheDocument();
    expect(screen.getByText('ivan.invited@college.test')).toBeInTheDocument();
    expect(screen.getByText('sue.suspended@college.test')).toBeInTheDocument();

    // Local search filter
    await user.type(screen.getByLabelText('Search users'), 'fiona');
    expect(screen.getByText('fiona.faculty@college.test')).toBeInTheDocument();
    expect(screen.queryByText('ivan.invited@college.test')).not.toBeInTheDocument();
    expect(screen.queryByText('sue.suspended@college.test')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Search users'));

    // Remote status filter: select SUSPENDED
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'SUSPENDED');
    await waitFor(() => {
      expect(screen.getByText('sue.suspended@college.test')).toBeInTheDocument();
      expect(screen.queryByText('fiona.faculty@college.test')).not.toBeInTheDocument();
    });

    const calls = b.state.calls.filter((c) => c.path.includes('/users?'));
    expect(calls.some((c) => c.path.includes('status=SUSPENDED'))).toBe(true);
  });

  it('pages user directory on demand using afterId', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    b.state.access.pageSize = 2;
    const user = userEvent.setup();
    renderApp(b, '/users');

    expect(await screen.findByText('fiona.faculty@college.test')).toBeInTheDocument();
    expect(screen.getByText('sam.staff@college.test')).toBeInTheDocument();
    expect(screen.queryByText('nobody@college.test')).not.toBeInTheDocument();

    const loadMoreBtn = screen.getByRole('button', { name: 'Load more users' });
    await user.click(loadMoreBtn);

    expect(await screen.findByText('nobody@college.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more users' })).not.toBeInTheDocument();

    const userCalls = b.state.calls.filter((c) => c.path.startsWith('/users?'));
    expect(userCalls.length).toBeGreaterThanOrEqual(2);
    expect(userCalls[1]!.path).toContain('afterId=user-sam');
  });

  it('handles load failure with error alert and retry button', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    b.state.access.listMode = 'server';
    const user = userEvent.setup();
    renderApp(b, '/users');

    expect(
      await screen.findByText('Users could not be loaded. Please try again.'),
    ).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });

    // Fix error and retry
    b.state.access.listMode = 'ok';
    await user.click(retryBtn);

    expect(await screen.findByText('fiona.faculty@college.test')).toBeInTheDocument();
  });

  it('validates invitation inputs and enforces minimum reason length', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/users');

    await user.click(await screen.findByRole('button', { name: 'Invite user' }));
    expect(await screen.findByRole('heading', { name: 'Invite user' })).toBeInTheDocument();

    const inviteForm = within(screen.getByRole('form', { name: 'Invite user' }));

    // Submit empty
    await user.click(inviteForm.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Email address is required.')).toBeInTheDocument();
    expect(screen.getByText('Full name is required.')).toBeInTheDocument();
    expect(screen.getByText('Give a reason of at least 5 characters.')).toBeInTheDocument();

    // Invalid email & short reason
    await user.type(inviteForm.getByLabelText('Email address'), 'notanemail');
    await user.type(inviteForm.getByLabelText('Full name'), 'New Person');
    await user.type(inviteForm.getByLabelText('Reason for invitation'), 'hi');
    await user.click(inviteForm.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Give a reason of at least 5 characters.')).toBeInTheDocument();

    // Cancel closes modal
    await user.click(inviteForm.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Invite user' })).not.toBeInTheDocument();
  });

  it('accurately represents email delivery when mailer is disabled (delivery=FAILED)', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    b.state.users.inviteDelivery = 'FAILED';
    const user = userEvent.setup();
    renderApp(b, '/users');

    await user.click(await screen.findByRole('button', { name: 'Invite user' }));
    const form = within(screen.getByRole('form', { name: 'Invite user' }));

    await user.type(form.getByLabelText('Email address'), 'clara.clerk@college.test');
    await user.type(form.getByLabelText('Full name'), 'Clara Clerk');
    await user.type(form.getByLabelText('Reason for invitation'), 'New employee onboarding');
    await user.click(form.getByRole('button', { name: 'Send invitation' }));

    // Does NOT claim email was sent
    expect(screen.queryByText(/sent via email/i)).not.toBeInTheDocument();
    expect(
      await screen.findByText(/email delivery failed \(no email provider configured\)/i),
    ).toBeInTheDocument();

    // Verify newly invited user appears in table
    expect(await screen.findByText('clara.clerk@college.test')).toBeInTheDocument();
    expect(screen.getByText('Clara Clerk')).toBeInTheDocument();

    // Verify backend call
    const inviteCalls = posts(b, '/users/invite');
    expect(inviteCalls).toHaveLength(1);
    expect(inviteCalls[0]!.body).toEqual({
      email: 'clara.clerk@college.test',
      displayName: 'Clara Clerk',
      reason: 'New employee onboarding',
    });
  });

  it('displays delivery success when mailer successfully delivers email (delivery=SENT)', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    b.state.users.inviteDelivery = 'SENT';
    const user = userEvent.setup();
    renderApp(b, '/users');

    await user.click(await screen.findByRole('button', { name: 'Invite user' }));
    const form = within(screen.getByRole('form', { name: 'Invite user' }));

    await user.type(form.getByLabelText('Email address'), 'dave.dean@college.test');
    await user.type(form.getByLabelText('Full name'), 'Dave Dean');
    await user.type(form.getByLabelText('Reason for invitation'), 'Appointed faculty dean');
    await user.click(form.getByRole('button', { name: 'Send invitation' }));

    expect(
      await screen.findByText('Invitation created and sent via email to dave.dean@college.test.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('dave.dean@college.test')).toBeInTheDocument();
  });

  it('handles invitation conflict (already existing user) gracefully', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/users');

    await user.click(await screen.findByRole('button', { name: 'Invite user' }));
    const form = within(screen.getByRole('form', { name: 'Invite user' }));

    // Attempt to invite fiona whose status is already ACTIVE
    await user.type(form.getByLabelText('Email address'), 'fiona.faculty@college.test');
    await user.type(form.getByLabelText('Full name'), 'Fiona Duplicate');
    await user.type(form.getByLabelText('Reason for invitation'), 'Re-invite request');
    await user.click(form.getByRole('button', { name: 'Send invitation' }));

    expect(
      await screen.findByText(/This conflicts with the current state: the user may already exist/i),
    ).toBeInTheDocument();
  });

  it('suspends an active account with step-up verification and concurrency If-Match header', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    b.state.stepUp.enforce = true; // Demands PASSWORD_MFA step-up for critical action
    const user = userEvent.setup();
    renderApp(b, '/users');

    expect(await screen.findByText('fiona.faculty@college.test')).toBeInTheDocument();

    // Click Suspend button for Fiona
    await user.click(screen.getByRole('button', { name: 'Suspend fiona.faculty@college.test' }));
    expect(
      await screen.findByRole('heading', { name: 'Suspend user: Fiona Faculty' }),
    ).toBeInTheDocument();

    const form = within(screen.getByRole('form', { name: 'Suspend user account' }));
    await user.type(form.getByLabelText('Reason for suspension'), 'Pending security review');
    await user.click(form.getByRole('button', { name: 'Confirm suspension' }));

    // Step-up verification dialog appears
    await verifyWithMfa(user);

    expect(
      await screen.findByText(
        'Account for Fiona Faculty (fiona.faculty@college.test) has been suspended.',
      ),
    ).toBeInTheDocument();

    // Verify mutation was called with exact If-Match header
    const suspendCalls = posts(b, '/users/user-fiona/suspend');
    expect(suspendCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = suspendCalls[suspendCalls.length - 1]!;
    expect(lastCall.headers['if-match']).toBe('"1"');
    expect(lastCall.body).toEqual({ reason: 'Pending security review' });

    // Status updated in table
    const fionaRow = within(screen.getByRole('table', { name: 'User directory' }))
      .getByText('fiona.faculty@college.test')
      .closest('tr');
    expect(within(fionaRow!).getByText('SUSPENDED')).toBeInTheDocument();
  });

  it('reactivates a suspended account with step-up verification and concurrency header', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    b.state.stepUp.enforce = true;
    // Set Sam Staff to SUSPENDED with version 2
    const sam = b.state.access.users.find((u) => u['id'] === 'user-sam')!;
    sam['status'] = 'SUSPENDED';
    sam['version'] = 2;

    const user = userEvent.setup();
    renderApp(b, '/users');

    expect(await screen.findByText('sam.staff@college.test')).toBeInTheDocument();

    // Click Reactivate button for Sam
    await user.click(screen.getByRole('button', { name: 'Reactivate sam.staff@college.test' }));
    expect(
      await screen.findByRole('heading', { name: 'Reactivate user: Sam Staff' }),
    ).toBeInTheDocument();

    const form = within(screen.getByRole('form', { name: 'Reactivate user account' }));
    await user.type(form.getByLabelText('Reason for reactivation'), 'Security review cleared');
    await user.click(form.getByRole('button', { name: 'Confirm reactivation' }));

    // Step-up prompt
    await verifyWithMfa(user);

    expect(
      await screen.findByText(
        'Account for Sam Staff (sam.staff@college.test) has been reactivated.',
      ),
    ).toBeInTheDocument();

    const reactivateCalls = posts(b, '/users/user-sam/reactivate');
    expect(reactivateCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = reactivateCalls[reactivateCalls.length - 1]!;
    expect(lastCall.headers['if-match']).toBe('"2"');
    expect(lastCall.body).toEqual({ reason: 'Security review cleared' });

    const samRow = within(screen.getByRole('table', { name: 'User directory' }))
      .getByText('sam.staff@college.test')
      .closest('tr');
    expect(within(samRow!).getByText('ACTIVE')).toBeInTheDocument();
  });

  it('prevents self-suspension in UI and blocks it with forbidden error if attempted', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    // Add current authenticated user to the directory
    b.state.access.users.unshift({
      id: 'u3',
      email: 'ada.admin@college.test',
      displayName: 'Ada Admin',
      status: 'ACTIVE',
      version: 1,
      createdAt: '2026-09-01T09:00:00.000Z',
    });

    renderApp(b, '/users');
    expect(await screen.findByText('ada.admin@college.test')).toBeInTheDocument();

    // Find the row for Ada Admin
    const row = screen.getByText('ada.admin@college.test').closest('tr');
    expect(within(row!).getByText('You')).toBeInTheDocument();

    // The Suspend button in the table should be disabled for the user's own account
    const suspendBtn = within(row!).getByRole('button', { name: 'Suspend ada.admin@college.test' });
    expect(suspendBtn).toBeDisabled();
    expect(suspendBtn).toHaveAttribute('title', 'You cannot suspend your own account');
  });

  it('protects the last active administrator with LAST_ADMINISTRATOR notice', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    // Mark user-sam as the designated last admin
    b.state.users.lastAdminId = 'user-sam';
    const user = userEvent.setup();
    renderApp(b, '/users');

    expect(await screen.findByText('sam.staff@college.test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Suspend sam.staff@college.test' }));

    const form = within(screen.getByRole('form', { name: 'Suspend user account' }));
    await user.type(form.getByLabelText('Reason for suspension'), 'Attempted admin suspension');
    await user.click(form.getByRole('button', { name: 'Confirm suspension' }));

    expect(
      await screen.findByText(
        'The organization must keep at least one active administrator. This user cannot be suspended.',
      ),
    ).toBeInTheDocument();
  });

  it('handles stale version conflict (409 CONFLICT) without silently retrying', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/users');

    expect(await screen.findByText('fiona.faculty@college.test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Suspend fiona.faculty@college.test' }));

    // Simulate concurrent modification before user submits
    const fiona = b.state.access.users.find((u) => u['id'] === 'user-fiona')!;
    fiona['version'] = 999;

    const form = within(screen.getByRole('form', { name: 'Suspend user account' }));
    await user.type(form.getByLabelText('Reason for suspension'), 'Routine suspension review');
    await user.click(form.getByRole('button', { name: 'Confirm suspension' }));

    expect(
      await screen.findByText(
        /This conflicts with the current state: the user may already exist, or another administrator modified this record./i,
      ),
    ).toBeInTheDocument();

    // It should have called suspend exactly once and NOT retried
    expect(posts(b, '/users/user-fiona/suspend')).toHaveLength(1);
  });

  it('enforces capability gating: hides buttons when actor lacks permission and restricts unauthorized visits', async () => {
    // Read-only user (has user.account.read, lacks invite and suspend)
    const READ_ONLY_USER: MeData = {
      ...STAFF,
      user_id: 'u-read',
      capabilities: ['session.read', 'user.account.read'],
    };

    const b = createFakeBackend({ session: true, me: READ_ONLY_USER });
    renderApp(b, '/users');

    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
    expect(await screen.findByText('fiona.faculty@college.test')).toBeInTheDocument();

    // Invite button and Suspend/Reactivate action buttons are hidden
    expect(screen.queryByRole('button', { name: 'Invite user' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suspend fiona/i })).not.toBeInTheDocument();

    // Student without any user.account capabilities gets access restricted
    const studentBackend = createFakeBackend({ session: true, me: STUDENT });
    const { unmount } = renderApp(studentBackend, '/users');
    expect(await screen.findByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    unmount();
  });

  it('passes axe accessibility audit with no violations', async () => {
    const b = createFakeBackend({ session: true, me: USER_ADMIN });
    const { container } = renderApp(b, '/users');

    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});
