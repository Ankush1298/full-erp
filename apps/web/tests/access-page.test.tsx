import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { AppRoutes } from '../src/App';
import { AuthProvider } from '../src/features/auth/AuthProvider';
import { StepUpProvider } from '../src/features/auth/StepUp';
import { ApiClient } from '../src/lib/api/client';
import { ADMIN, STAFF, createFakeBackend, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

type Backend = ReturnType<typeof createFakeBackend>;

const FUTURE_LOCAL = '2031-06-30T10:00';
const PAST_LOCAL = '2020-01-01T10:00';
const REVOKE_ONLY: MeData = {
  ...ADMIN,
  capabilities: ['session.read', 'role.assignment.revoke'],
};

const posts = (b: Backend, path: string) => b.callsTo('POST', path);
const patches = (b: Backend) => b.state.calls.filter((c) => c.method === 'PATCH');
const grants = (b: Backend, userId = 'user-nobody') =>
  posts(b, `/users/${userId}/role-assignments`);

async function openUser(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.click(await screen.findByRole('button', { name: `Manage access for ${email}` }));
}
const grantForm = () => within(screen.getByRole('form', { name: 'Grant a role' }));

async function verifyWithCode(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('dialog', { name: "Confirm it's you" });
  await user.type(screen.getByLabelText('Verification code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Verify' }));
}

describe('/access: users and role assignments', () => {
  it('shows loading, then the users, and an empty assignment list for a user without roles', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/access');
    expect(await screen.findByText('Loading users…')).toBeInTheDocument();
    expect(await screen.findByText('fiona.faculty@college.test')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Users of this organization' })).toBeInTheDocument();

    await openUser(user, 'nobody@college.test');
    expect(await screen.findByText('This user has no role assignments.')).toBeInTheDocument();
  });

  it('shows assignments with scope, state and expiry, and offers actions only where they can work', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'fiona.faculty@college.test');

    const table = await screen.findByRole('table', { name: 'Role assignments of Fiona Faculty' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2
    expect(within(rows[1]!).getByText('FACULTY')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Whole organization')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('EFFECTIVE')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('2030-01-01 00:00 UTC')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Department: Computer Science')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('REVOKED')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Never')).toBeInTheDocument();
    // a revoked row has no actions; an effective one has both
    expect(within(rows[2]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[1]!).getAllByRole('button')).toHaveLength(2);

    // an administrator assignment can be revoked but never takes an expiry
    await openUser(user, 'sam.staff@college.test');
    const samRows = within(
      await screen.findByRole('table', { name: 'Role assignments of Sam Staff' }),
    ).getAllByRole('row');
    expect(
      within(samRows[1]!).getByRole('button', { name: /^Revoke COLLEGE_ADMIN/ }),
    ).toBeInTheDocument();
    expect(
      within(samRows[1]!).queryByRole('button', { name: /Change expiry/ }),
    ).not.toBeInTheDocument();
  });

  it('filters the loaded users and pages the rest in on request', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    b.state.access.pageSize = 2;
    const user = userEvent.setup();
    renderApp(b, '/access');
    expect(await screen.findByText('sam.staff@college.test')).toBeInTheDocument();
    expect(screen.queryByText('nobody@college.test')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more users' }));
    expect(await screen.findByText('nobody@college.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more users' })).not.toBeInTheDocument();
    expect(b.state.calls.filter((c) => c.path.startsWith('/users?'))).toHaveLength(2);

    await user.type(screen.getByLabelText('Filter users'), 'sam');
    expect(screen.queryByText('fiona.faculty@college.test')).not.toBeInTheDocument();
    expect(screen.getByText('sam.staff@college.test')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Filter users'));
    await user.type(screen.getByLabelText('Filter users'), 'zzz');
    expect(screen.getByText('No loaded user matches the filter.')).toBeInTheDocument();
  });

  it('shows an empty state, an API error with retry, and the not-an-organization-administrator explanation', async () => {
    const empty = createFakeBackend({ session: true, me: ADMIN });
    empty.state.access.users = [];
    renderApp(empty, '/access');
    expect(await screen.findByText('No users yet.')).toBeInTheDocument();

    const broken = createFakeBackend({ session: true, me: ADMIN });
    broken.state.access.listMode = 'server';
    const user = userEvent.setup();
    renderApp(broken, '/access');
    expect(
      await screen.findByText('Users and roles could not be loaded. Please try again.'),
    ).toBeInTheDocument();
    broken.state.access.listMode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('fiona.faculty@college.test')).toBeInTheDocument();

    const scoped = createFakeBackend({ session: true, me: ADMIN });
    scoped.state.access.listMode = 'forbidden';
    renderApp(scoped, '/access');
    expect(
      (await screen.findAllByText(/Organization-level administrators can use this page/)).length,
    ).toBeGreaterThan(0);
  });

  it('is permission-aware: no capability, no page; revoke-only, no grant form and no expiry change', async () => {
    const denied = createFakeBackend({ session: true, me: STAFF });
    renderApp(denied, '/access');
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Roles & access' })).not.toBeInTheDocument(),
    );
    expect(denied.state.calls.some((c) => c.path.startsWith('/users'))).toBe(false);

    const b = createFakeBackend({ session: true, me: REVOKE_ONLY });
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'fiona.faculty@college.test');
    const table = await screen.findByRole('table', { name: 'Role assignments of Fiona Faculty' });
    expect(within(table).getByRole('button', { name: /^Revoke FACULTY/ })).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /Change expiry/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Grant a role' })).not.toBeInTheDocument();
  });
});

describe('/access: granting a role', () => {
  async function fillGrant(
    user: ReturnType<typeof userEvent.setup>,
    o: { role?: string; applies?: string; expiry?: string; reason?: string } = {},
  ) {
    const form = grantForm();
    await user.selectOptions(form.getByLabelText('Role'), o.role ?? 'role-faculty');
    if (o.applies) await user.selectOptions(form.getByLabelText('Applies to'), o.applies);
    if (o.expiry) fireEvent.change(form.getByLabelText(/Expires/), { target: { value: o.expiry } });
    if (o.reason !== '')
      await user.type(form.getByLabelText('Reason'), o.reason ?? 'Covering the department');
  }

  it('grants after a step-up, with the expiry as an ISO instant, retrying the grant exactly once', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    b.state.stepUp.enforce = true; // the backend answers 403 STEP_UP_REQUIRED until a second factor is verified
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'nobody@college.test');
    await screen.findByText('This user has no role assignments.');
    await fillGrant(user, { applies: 'ORGANIZATION', expiry: FUTURE_LOCAL });
    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));

    await verifyWithCode(user);
    expect(await screen.findByText('Role granted.')).toBeInTheDocument();
    expect(grants(b)).toHaveLength(2); // refused once, then exactly one retry
    const body = grants(b)[1]!.body as {
      roleId: string;
      scopeType: string;
      reason: string;
      validUntil: string;
    };
    expect(body).toMatchObject({
      roleId: 'role-faculty',
      scopeType: 'ORGANIZATION',
      reason: 'Covering the department',
    });
    expect(new Date(body.validUntil).getTime()).toBeGreaterThan(Date.now());
    expect(body.validUntil).toMatch(/Z$/);
    // reconciled from the server: the new row is listed, the form is reset
    const table = await screen.findByRole('table', { name: 'Role assignments of Nobody Yet' });
    expect(within(table).getByText('FACULTY')).toBeInTheDocument();
    expect(grantForm().getByLabelText('Reason')).toHaveValue('');
  });

  it('does not grant when the step-up is cancelled, and says nothing changed', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    b.state.stepUp.enforce = true;
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'nobody@college.test');
    await screen.findByText('This user has no role assignments.');
    await fillGrant(user, { applies: 'ORGANIZATION' });
    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));
    await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByText(/Re-verification is required before continuing/),
    ).toBeInTheDocument();
    expect(grants(b)).toHaveLength(1); // the refused attempt only
    expect(screen.getByText('This user has no role assignments.')).toBeInTheDocument();
  });

  it('works under React StrictMode (development) with one retry', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    b.state.stepUp.enforce = true;
    const client = new ApiClient({ basePath: '/api', fetchImpl: b.fetch });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/access']}>
          <AuthProvider client={client}>
            <StepUpProvider>
              <AppRoutes />
            </StepUpProvider>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    );
    const user = userEvent.setup();
    await openUser(user, 'nobody@college.test');
    await screen.findByText('This user has no role assignments.');
    await fillGrant(user, { applies: 'ORGANIZATION' });
    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));
    await verifyWithCode(user);
    expect(await screen.findByText('Role granted.')).toBeInTheDocument();
    expect(grants(b)).toHaveLength(2);
  });

  it('validates before sending: role, scope, department, reason and a future expiry; nothing is requested', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'nobody@college.test');
    await screen.findByText('This user has no role assignments.');

    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));
    expect(grantForm().getByText('Choose a role.')).toBeInTheDocument();
    expect(grantForm().getByText(/Give a reason of at least 5 characters/)).toBeInTheDocument();

    // HOD is department-scoped: a department must be chosen
    await user.selectOptions(grantForm().getByLabelText('Role'), 'role-hod');
    expect(grantForm().queryByLabelText('Applies to')).not.toBeInTheDocument(); // the only scope type is implied
    await user.type(grantForm().getByLabelText('Reason'), 'Heads the department');
    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));
    expect(grantForm().getByText('Choose a department.')).toBeInTheDocument();

    // an expiry in the past is refused locally (the server would refuse it too)
    await user.selectOptions(grantForm().getByLabelText('Role'), 'role-faculty');
    await user.selectOptions(grantForm().getByLabelText('Applies to'), 'ORGANIZATION');
    fireEvent.change(grantForm().getByLabelText(/Expires/), { target: { value: PAST_LOCAL } });
    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));
    expect(grantForm().getByText('The expiry must be in the future.')).toBeInTheDocument();
    expect(grants(b)).toHaveLength(0);
  });

  it('offers only grantable roles, and no expiry field for an administrator role', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'nobody@college.test');
    await screen.findByText('This user has no role assignments.');
    const options = within(grantForm().getByLabelText('Role'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options.join('|')).not.toContain('STUDENT');
    expect(options.join('|')).toContain('COLLEGE_ADMIN');
    await user.selectOptions(grantForm().getByLabelText('Role'), 'role-admin');
    expect(grantForm().queryByLabelText(/Expires/)).not.toBeInTheDocument();
    expect(grantForm().getByText('An administrator assignment has no expiry.')).toBeInTheDocument();
  });

  it('shows a fixed message for a duplicate, a conflict or a refused grant, and keeps the form for another try', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'nobody@college.test');
    await screen.findByText('This user has no role assignments.');
    await fillGrant(user, { applies: 'ORGANIZATION' });
    b.state.access.failNext = { status: 409, code: 'CONFLICT' };
    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));
    const alert = await screen.findByText(/This conflicts with the current state/);
    expect(alert.textContent).not.toContain('server text that must never be shown');
    expect(grantForm().getByLabelText('Reason')).toHaveValue('Covering the department');

    b.state.access.failNext = { status: 403, code: 'FORBIDDEN' };
    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));
    expect(await screen.findByText(/You are not allowed to make this change/)).toBeInTheDocument();

    b.state.access.failNext = { status: 404, code: 'NOT_FOUND' };
    await user.click(grantForm().getByRole('button', { name: 'Grant role' }));
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
  });
});

describe('/access: revoking and changing an expiry', () => {
  it('revokes with a reason after a step-up and reconciles the list', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    b.state.stepUp.enforce = true;
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'fiona.faculty@college.test');
    await user.click(await screen.findByRole('button', { name: /^Revoke FACULTY/ }));
    const form = within(screen.getByRole('form', { name: 'Revoke assignment' }));

    await user.click(form.getByRole('button', { name: 'Confirm revoke' }));
    expect(form.getByText(/Give a reason of at least 5 characters/)).toBeInTheDocument(); // nothing sent yet
    expect(posts(b, '/role-assignments/asg-1/revoke')).toHaveLength(0);

    await user.type(form.getByLabelText('Reason'), 'Left the department');
    await user.click(form.getByRole('button', { name: 'Confirm revoke' }));
    await verifyWithCode(user);
    expect(await screen.findByText('FACULTY revoked.')).toBeInTheDocument();
    expect(posts(b, '/role-assignments/asg-1/revoke')).toHaveLength(2); // refused, then exactly one retry
    expect(posts(b, '/role-assignments/asg-1/revoke')[1]!.body).toEqual({
      reason: 'Left the department',
    });
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Revoke assignment' })).not.toBeInTheDocument(),
    );
    const row = within(
      await screen.findByRole('table', { name: 'Role assignments of Fiona Faculty' }),
    ).getAllByRole('row')[1]!;
    expect(within(row).getByText('REVOKED')).toBeInTheDocument();
  });

  it('shows the last-administrator refusal and keeps the assignment', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'sam.staff@college.test');
    await user.click(await screen.findByRole('button', { name: /^Revoke COLLEGE_ADMIN/ }));
    const panel = within(screen.getByRole('form', { name: 'Revoke assignment' }));
    await user.type(panel.getByLabelText('Reason'), 'Removing the only admin');
    b.state.access.failNext = { status: 409, code: 'LAST_ADMINISTRATOR' };
    await user.click(panel.getByRole('button', { name: 'Confirm revoke' }));
    expect(
      await screen.findByText(/last effective administrator of the organization cannot be removed/),
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Revoke assignment' })).toBeInTheDocument(); // still open: retry or cancel
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Revoke assignment' })).not.toBeInTheDocument();
  });

  it('changes the expiry with If-Match, and clears it with "No expiry"', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    b.state.stepUp.enforce = true;
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'fiona.faculty@college.test');
    await user.click(await screen.findByRole('button', { name: /^Change expiry of FACULTY/ }));
    const form = () => within(screen.getByRole('form', { name: 'Change expiry' }));

    fireEvent.change(form().getByLabelText('New expiry'), { target: { value: PAST_LOCAL } });
    await user.type(form().getByLabelText('Reason'), 'Extend the cover');
    await user.click(form().getByRole('button', { name: 'Save expiry' }));
    expect(form().getByText('The expiry must be in the future.')).toBeInTheDocument();
    expect(patches(b)).toHaveLength(0);

    fireEvent.change(form().getByLabelText('New expiry'), { target: { value: FUTURE_LOCAL } });
    await user.click(form().getByRole('button', { name: 'Save expiry' }));
    await verifyWithCode(user);
    expect(await screen.findByText('Expiry of FACULTY updated.')).toBeInTheDocument();
    expect(patches(b)).toHaveLength(2); // refused once, then exactly one retry
    expect(patches(b)[1]!.headers['if-match']).toBe('"1"');
    expect((patches(b)[1]!.body as { validUntil: string }).validUntil).toMatch(/Z$/);

    // the list was reloaded: the version is now 2, so the next change carries the new If-Match
    await user.click(await screen.findByRole('button', { name: /^Change expiry of FACULTY/ }));
    await user.click(form().getByLabelText('No expiry'));
    await user.type(form().getByLabelText('Reason'), 'Make it permanent');
    await user.click(form().getByRole('button', { name: 'Save expiry' }));
    expect(await screen.findByText('FACULTY no longer expires.')).toBeInTheDocument();
    expect(patches(b)).toHaveLength(3);
    expect(patches(b)[2]!.headers['if-match']).toBe('"2"');
    expect(patches(b)[2]!.body).toEqual({ validUntil: null, reason: 'Make it permanent' });
  });

  it('reports a stale assignment (409) and an expired one with fixed messages', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    const user = userEvent.setup();
    renderApp(b, '/access');
    await openUser(user, 'fiona.faculty@college.test');
    await user.click(await screen.findByRole('button', { name: /^Change expiry of FACULTY/ }));
    const panel = within(screen.getByRole('form', { name: 'Change expiry' }));
    fireEvent.change(panel.getByLabelText('New expiry'), { target: { value: FUTURE_LOCAL } });
    await user.type(panel.getByLabelText('Reason'), 'Extend the cover');
    b.state.access.failNext = { status: 409, code: 'ASSIGNMENT_NOT_EFFECTIVE' };
    await user.click(panel.getByRole('button', { name: 'Save expiry' }));
    expect(
      await screen.findByText(/has already expired. Grant the role again instead/),
    ).toBeInTheDocument();
    b.state.access.failNext = { status: 409, code: 'CONFLICT' };
    await user.click(panel.getByRole('button', { name: 'Save expiry' }));
    expect(await screen.findByText(/This conflicts with the current state/)).toBeInTheDocument();
  });
});

describe('/access: accessibility', () => {
  it('has no detectable axe violations with a user, its assignments and an open panel', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    const user = userEvent.setup();
    const view = renderApp(b, '/access');
    await openUser(user, 'fiona.faculty@college.test');
    await user.click(await screen.findByRole('button', { name: /^Revoke FACULTY/ }));
    await screen.findByRole('form', { name: 'Revoke assignment' });
    expect((await axe(view.container)).violations).toEqual([]);
  });
});
