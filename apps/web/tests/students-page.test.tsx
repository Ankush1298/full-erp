import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderApp } from './helpers/render';
import {
  ACADEMIC_ADMIN,
  createFakeBackend,
  STAFF,
  STUDENT,
  type MeData,
} from './helpers/fakeBackend';

/** Organisation-level registrar: lists, searches and reads students, their identifiers and enrolments. */
const REGISTRAR: MeData = {
  tenant_id: 't1',
  user_id: 'u7',
  actor_kind: 'STAFF',
  display_name: 'Rita Registrar',
  roles: ['REGISTRAR'],
  capabilities: [
    'session.read',
    'student.profile.read',
    'student.profile.read_sensitive',
    'student.directory.list',
    'student.directory.search',
    'enrollment.term.read',
    'academic.program.read',
  ],
};

const ASHA = '01900000-0000-7000-8000-000000000001';
const HIDDEN = '01900000-0000-7000-8000-000000000004';
const OTHER_TENANT = '01900000-0000-7000-8000-000000000009';

type Backend = ReturnType<typeof createFakeBackend>;
const gets = (b: Backend, prefix: string) =>
  b.state.calls.filter((c) => c.method === 'GET' && c.path.startsWith(prefix));
const directoryCalls = (b: Backend) => gets(b, '/students/directory');

function setup(me: MeData = REGISTRAR, path = '/students') {
  const b = createFakeBackend({ session: true, me });
  return { b, user: userEvent.setup(), view: () => renderApp(b, path) };
}

const table = () => screen.findByRole('table', { name: 'Student directory' });
const rowsOf = (t: HTMLElement) =>
  within(t)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]?.textContent);

describe('/students: directory', () => {
  it('lists the first page of in-scope students only, with a link to each profile', async () => {
    const { b, view } = setup();
    const { container } = view();
    expect(await screen.findByText('Loading students…')).toBeInTheDocument();
    const t = await table();
    expect(rowsOf(t)).toEqual(['ADM-001', 'ADM-002']);
    expect(within(t).getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open profile of ADM-001' })).toHaveAttribute(
      'href',
      `/students/${ASHA}`,
    );
    // No tenant, campus or department is ever sent; the page size is bounded.
    const [call] = directoryCalls(b);
    expect(call?.path).toBe('/students/directory?limit=25');
    expect(screen.queryByText('Hidden Scope')).not.toBeInTheDocument();
    expect(screen.queryByText('Other Tenant')).not.toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('continues with the server cursor and stops when there is no next page', async () => {
    const { b, user, view } = setup();
    view();
    await table();
    await user.click(screen.getByRole('button', { name: 'Load more students' }));
    await waitFor(async () =>
      expect(rowsOf(await table())).toEqual(['ADM-001', 'ADM-002', 'ADM-003']),
    );
    expect(directoryCalls(b)[1]?.path).toBe(
      `/students/directory?${new URLSearchParams({ limit: '25', cursor: 'cur:u7::2' })}`,
    );
    expect(screen.queryByRole('button', { name: 'Load more students' })).not.toBeInTheDocument();
    // The cursor never reaches browser storage.
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('cur:');
  });

  it('filters by status on the server and restarts from the first page', async () => {
    const { b, user, view } = setup();
    view();
    await table();
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'ON_LEAVE');
    await waitFor(async () => expect(rowsOf(await table())).toEqual(['ADM-003']));
    expect(directoryCalls(b).at(-1)?.path).toBe('/students/directory?limit=25&status=ON_LEAVE');
  });

  it('shows an empty state', async () => {
    const { b, view } = setup();
    b.state.students.records = [];
    view();
    expect(await screen.findByText('No students to show.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Student directory' })).not.toBeInTheDocument();
  });

  it('reports an API failure with fixed wording and recovers on retry', async () => {
    const { b, user, view } = setup();
    b.state.students.directoryMode = 'server';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The student directory could not be loaded. Please try again.',
    );
    expect(screen.queryByText('server text that must never be shown')).not.toBeInTheDocument();
    b.state.students.directoryMode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(rowsOf(await table())).toEqual(['ADM-001', 'ADM-002']);
  });

  it('reports rate limiting with the server retry window', async () => {
    const { b, view } = setup();
    b.state.students.directoryMode = 'rate';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Please wait 30 seconds and try again.',
    );
  });

  it('reports a network failure', async () => {
    const { b, view } = setup();
    b.state.students.directoryMode = 'network';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server.');
  });

  it('an expired cursor fails closed and offers a restart from the first page', async () => {
    const { b, user, view } = setup();
    view();
    await table();
    b.state.students.expireCursor = true;
    await user.click(screen.getByRole('button', { name: 'Load more students' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The list position has expired. Start again from the first page.',
    );
    b.state.students.expireCursor = false;
    await user.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(async () => expect(rowsOf(await table())).toEqual(['ADM-001', 'ADM-002']));
    expect(directoryCalls(b).at(-1)?.path).toBe('/students/directory?limit=25');
  });

  // The real backend answers a disabled directory (route not registered) and a malformed directory request with the
  // same 400 BAD_REQUEST (observed against buildApp); only INVALID_CURSOR differs. The UI must not claim the flag is off.
  const REJECTED =
    'The student directory is not available: the server did not accept the request. It may not be enabled on this server. If this continues, contact your administrator.';

  it('a disabled directory fails closed with the neutral "not accepted" wording and no fallback listing', async () => {
    const { b, view } = setup();
    b.state.students.directoryEnabled = false;
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(REJECTED);
    expect(screen.queryByText(/is not enabled on this server/)).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Student directory' })).not.toBeInTheDocument();
    expect(screen.queryByText('server text that must never be shown')).not.toBeInTheDocument();
    // Exactly one directory request, and no other student listing was attempted.
    expect(directoryCalls(b)).toHaveLength(1);
    expect(gets(b, '/students').filter((c) => c.path !== '/students/directory?limit=25')).toEqual(
      [],
    );
  });

  it('a malformed-request 400 on an enabled server gets the same neutral wording, and retry works', async () => {
    const { b, user, view } = setup();
    b.state.students.directoryMode = 'badrequest';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(REJECTED);
    b.state.students.directoryMode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(rowsOf(await table())).toEqual(['ADM-001', 'ADM-002']);
  });

  it('INVALID_CURSOR is the only 400 treated as a cursor problem', async () => {
    const { b, user, view } = setup();
    view();
    await table();
    b.state.students.directoryMode = 'badrequest';
    await user.click(screen.getByRole('button', { name: 'Load more students' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(REJECTED);
    expect(screen.queryByText(/list position has expired/)).not.toBeInTheDocument();
    // The rows already shown stay visible.
    expect(rowsOf(await table())).toEqual(['ADM-001', 'ADM-002']);
  });

  it('a rate limit or network failure on "Load more" keeps the loaded rows and offers a restart', async () => {
    for (const [mode, text] of [
      ['rate', 'Too many requests. Please wait 30 seconds and try again.'],
      ['network', 'Cannot reach the server.'],
    ] as const) {
      const { b, user, view } = setup();
      const { unmount } = view();
      await table();
      b.state.students.directoryMode = mode;
      await user.click(screen.getByRole('button', { name: 'Load more students' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(rowsOf(await table())).toEqual(['ADM-001', 'ADM-002']);
      expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument();
      unmount();
    }
  });

  it('the fake backend rejects malformed directory queries like the real schema (contract pin for these tests)', async () => {
    const b = createFakeBackend({ session: true, me: REGISTRAR });
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'status=BOGUS', 'campusId=x']) {
      const r = await b.fetch(`/api/students/directory?${q}`);
      expect(r.status, q).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code, q).toBe('BAD_REQUEST');
    }
  });

  it('a server-side 403 is shown as a permission failure, never as data', async () => {
    const { b, view } = setup();
    b.state.students.directoryMode = 'forbidden';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to view the student directory.',
    );
  });

  it('accounts without student.directory.list never call the directory', async () => {
    const { b, view } = setup(STAFF);
    view();
    expect(
      await screen.findByText(/can open individual student profiles but cannot list or search/),
    ).toBeInTheDocument();
    expect(directoryCalls(b)).toEqual([]);
  });

  it('accounts with no student capability get the access-restricted page and no request', async () => {
    const { b, view } = setup(ACADEMIC_ADMIN);
    view();
    expect(await screen.findByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(gets(b, '/students')).toEqual([]);
  });
});

describe('/students: admission-number search', () => {
  it('finds one student by exact admission number', async () => {
    const { b, user, view } = setup();
    view();
    await user.type(await screen.findByLabelText('Admission number'), 'ADM-003');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const result = await screen.findByRole('table', { name: 'Search result' });
    expect(within(result).getByText('Chitra Nair')).toBeInTheDocument();
    expect(gets(b, '/students?')).toHaveLength(1);
    expect(gets(b, '/students?')[0]?.path).toBe('/students?admissionNumber=ADM-003');
  });

  it('out-of-scope and other-tenant numbers get the same answer as unknown ones', async () => {
    const { b, user, view } = setup();
    view();
    const input = await screen.findByLabelText('Admission number');
    const answer = 'No student was found, or the record is outside your access.';
    const numbers = ['ADM-404', 'ADM-004', 'ADM-009'];
    for (const [i, n] of numbers.entries()) {
      await user.clear(input);
      await user.type(input, n);
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await waitFor(() => expect(gets(b, '/students?')).toHaveLength(i + 1));
      expect(await screen.findByText(answer)).toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Search result' })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Hidden Scope')).not.toBeInTheDocument();
    expect(screen.queryByText('Other Tenant')).not.toBeInTheDocument();
  });

  it('rejects a malformed admission number without a request', async () => {
    const { b, user, view } = setup();
    view();
    await user.type(await screen.findByLabelText('Admission number'), 'bad number!');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Enter an admission number/)).toBeInTheDocument();
    expect(gets(b, '/students?')).toEqual([]);
  });
});

describe('/students: permission combinations', () => {
  const only = (...caps: string[]): MeData => ({
    ...REGISTRAR,
    capabilities: ['session.read', ...caps],
  });

  it('student.directory.list only: lists, but has no search and cannot open profiles', async () => {
    const { b, view } = setup(only('student.directory.list'));
    view();
    expect(rowsOf(await table())).toEqual(['ADM-001', 'ADM-002']);
    expect(screen.queryByLabelText('Admission number')).not.toBeInTheDocument();
    expect(gets(b, '/students?')).toEqual([]);
  });

  it('student.directory.list only: a direct profile URL is refused before any request', async () => {
    const { b, view } = setup(only('student.directory.list'), `/students/${ASHA}`);
    view();
    expect(await screen.findByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(gets(b, `/students/${ASHA}`)).toEqual([]);
  });

  it('student.directory.search only: searches, but never calls the directory', async () => {
    const { b, user, view } = setup(only('student.directory.search'));
    view();
    await user.type(await screen.findByLabelText('Admission number'), 'ADM-001');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('table', { name: 'Search result' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Student directory' })).not.toBeInTheDocument();
    expect(directoryCalls(b)).toEqual([]);
  });

  it('student.profile.read only: opens a permitted profile, no directory, search or sensitive sections', async () => {
    const me = only('student.profile.read');
    const list = setup(me);
    const { unmount } = list.view();
    expect(await screen.findByText(/cannot list or search/)).toBeInTheDocument();
    expect(directoryCalls(list.b)).toEqual([]);
    unmount();

    const { b, view } = setup(me, `/students/${ASHA}`);
    view();
    expect(await screen.findByRole('heading', { name: 'Student ADM-001' })).toBeInTheDocument();
    expect(gets(b, `/students/${ASHA}/`)).toEqual([]);
    expect(gets(b, '/academics/')).toEqual([]);
  });

  it('client capabilities do not bypass the server: a held capability still meets a server 403', async () => {
    const { b, view } = setup(only('student.profile.read'), `/students/${ASHA}`);
    b.state.students.profileMode = 'forbidden';
    view();
    expect(await screen.findByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(screen.queryByText('ADM-001')).not.toBeInTheDocument();
  });
});

describe('/students/:id: profile', () => {
  function withEnrolment(b: Backend) {
    b.state.academics.sections.push({ id: 'sec-1', name: 'CSE-A' });
    b.state.academics.enrollments[ASHA] = [
      {
        id: 'e-1',
        studentId: ASHA,
        cohortPeriodId: 'cp1',
        termId: 't1',
        periodNo: 1,
        status: 'ACTIVE',
        enrollmentType: 'REGULAR',
        rollNumber: 'R-17',
        currentSection: { sectionId: 'sec-1', name: 'CSE-A', validFrom: '2026-06-10' },
        version: 1,
      },
    ];
  }

  it('renders the record, identifiers and term enrolments read-only', async () => {
    const { b, view } = setup(REGISTRAR, `/students/${ASHA}`);
    withEnrolment(b);
    const { container } = view();
    expect(await screen.findByRole('heading', { name: 'Student ADM-001' })).toBeInTheDocument();
    expect(screen.getByText('2026-06-01')).toBeInTheDocument();
    const ids = await screen.findByRole('table', { name: 'Identifiers' });
    expect(within(ids).getByText('University PRN')).toBeInTheDocument();
    expect(within(ids).getByText('PRN-2026-0001')).toBeInTheDocument();
    const enr = await screen.findByRole('table', { name: 'Term enrolments' });
    expect(within(enr).getByText('Odd semester (ODD)')).toBeInTheDocument();
    expect(within(enr).getByText('R-17')).toBeInTheDocument();
    expect(within(enr).getByText('CSE-A (from 2026-06-10)')).toBeInTheDocument();
    // Internal identifiers (organisation, account) are never displayed; nothing is editable.
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent(/0000000000aa|0000000000bb/);
    expect(within(main).queryByRole('textbox')).not.toBeInTheDocument();
    expect(b.state.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows empty identifier and enrolment sections', async () => {
    const { b, view } = setup(REGISTRAR, `/students/01900000-0000-7000-8000-000000000002`);
    view();
    expect(await screen.findByRole('heading', { name: 'Student ADM-002' })).toBeInTheDocument();
    expect(
      await screen.findByText('No identifiers are recorded for this student.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('No term enrolments are recorded for this student.'),
    ).toBeInTheDocument();
    // No enrolments: no reason to ask for term names.
    expect(gets(b, '/academics/terms')).toEqual([]);
  });

  it.each([
    ['missing', '01900000-0000-7000-8000-0000000000ff'],
    ['outside the caller scope', HIDDEN],
    ['another tenant', OTHER_TENANT],
    ['malformed', 'not-a-student-id'],
  ])('%s record: one not-found state, and no section is requested', async (_label, id) => {
    const { b, view } = setup(REGISTRAR, `/students/${id}`);
    view();
    expect(await screen.findByRole('heading', { name: 'Student not found' })).toBeInTheDocument();
    expect(
      screen.getByText('No student was found, or the record is outside your access.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Hidden Scope')).not.toBeInTheDocument();
    expect(screen.queryByText('Other Tenant')).not.toBeInTheDocument();
    expect(gets(b, `/students/${id}/`)).toEqual([]);
    expect(gets(b, '/academics/')).toEqual([]);
  });

  it('an account without student.profile.read gets the access-restricted page and no request', async () => {
    const { b, view } = setup(ACADEMIC_ADMIN, `/students/${ASHA}`);
    view();
    expect(await screen.findByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(gets(b, '/students')).toEqual([]);
  });

  it('a server-side 403 shows the access-restricted page', async () => {
    const { b, view } = setup(REGISTRAR, `/students/${ASHA}`);
    b.state.students.profileMode = 'forbidden';
    view();
    expect(await screen.findByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(gets(b, `/students/${ASHA}/`)).toEqual([]);
  });

  it('reports a profile API failure and recovers on retry', async () => {
    const { b, user, view } = setup(REGISTRAR, `/students/${ASHA}`);
    b.state.students.profileMode = 'server';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The student record could not be loaded. Please try again.',
    );
    b.state.students.profileMode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Student ADM-001' })).toBeInTheDocument();
  });

  it('a failing identifiers section does not hide the rest of the profile, and retries alone', async () => {
    const { b, user, view } = setup(REGISTRAR, `/students/${ASHA}`);
    withEnrolment(b);
    b.state.students.identifiersMode = 'server';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Identifiers could not be loaded. Please try again.',
    );
    expect(await screen.findByRole('table', { name: 'Term enrolments' })).toBeInTheDocument();
    const enrolmentCalls = gets(b, `/students/${ASHA}/term-enrollments`).length;
    b.state.students.identifiersMode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Retry identifiers' }));
    expect(await screen.findByRole('table', { name: 'Identifiers' })).toBeInTheDocument();
    expect(gets(b, `/students/${ASHA}/term-enrollments`)).toHaveLength(enrolmentCalls);
  });

  it('a failing enrolments section does not hide identifiers, and retries alone', async () => {
    const { b, user, view } = setup(REGISTRAR, `/students/${ASHA}`);
    withEnrolment(b);
    b.state.academics.enrollmentsMode = 'server';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Term enrolments could not be loaded. Please try again.',
    );
    expect(await screen.findByRole('table', { name: 'Identifiers' })).toBeInTheDocument();
    expect(gets(b, '/academics/terms')).toEqual([]);
    const identifierCalls = gets(b, `/students/${ASHA}/identifiers`).length;
    b.state.academics.enrollmentsMode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Retry term enrolments' }));
    const enr = await screen.findByRole('table', { name: 'Term enrolments' });
    expect(await within(enr).findByText('Odd semester (ODD)')).toBeInTheDocument();
    expect(gets(b, `/students/${ASHA}/identifiers`)).toHaveLength(identifierCalls);
  });

  it('failing term details keep the enrolments visible and retry on their own', async () => {
    const { b, user, view } = setup(REGISTRAR, `/students/${ASHA}`);
    withEnrolment(b);
    b.state.academics.termsMode = 'server';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Term details could not be loaded. Please try again.',
    );
    const enr = screen.getByRole('table', { name: 'Term enrolments' });
    expect(within(enr).getByText('Term details unavailable')).toBeInTheDocument();
    expect(within(enr).getByText('R-17')).toBeInTheDocument();
    const enrolmentCalls = gets(b, `/students/${ASHA}/term-enrollments`).length;
    b.state.academics.termsMode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Retry term details' }));
    expect(await within(enr).findByText('Odd semester (ODD)')).toBeInTheDocument();
    expect(gets(b, `/students/${ASHA}/term-enrollments`)).toHaveLength(enrolmentCalls);
  });

  it('sections the account may not read are neither requested nor shown', async () => {
    // HOD-like: profile only. No identifiers (read_sensitive), no enrolments, no term names.
    const { b, view } = setup(STAFF, `/students/${ASHA}`);
    view();
    expect(await screen.findByRole('heading', { name: 'Student ADM-001' })).toBeInTheDocument();
    expect(screen.getByText(/Some sections are not shown/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Identifiers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Term enrolments' })).not.toBeInTheDocument();
    expect(gets(b, `/students/${ASHA}/`)).toEqual([]);
    expect(gets(b, '/academics/')).toEqual([]);
  });

  it('without academic.program.read, term names are not fetched and shown as unavailable', async () => {
    const me = {
      ...REGISTRAR,
      capabilities: REGISTRAR.capabilities.filter((c) => c !== 'academic.program.read'),
    };
    const { b, view } = setup(me, `/students/${ASHA}`);
    withEnrolment(b);
    view();
    const enr = await screen.findByRole('table', { name: 'Term enrolments' });
    expect(within(enr).getByText('Term details unavailable')).toBeInTheDocument();
    expect(gets(b, '/academics/terms')).toEqual([]);
  });

  it('nothing from the profile is written to browser storage', async () => {
    const { view } = setup(REGISTRAR, `/students/${ASHA}`);
    view();
    await screen.findByRole('table', { name: 'Identifiers' });
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored).not.toContain('PRN-2026-0001');
    expect(stored).not.toContain('ADM-001');
  });

  it('a student account is not shown the staff Students menu', async () => {
    const { view } = setup(STUDENT, '/');
    view();
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('link', { name: 'Students' })).not.toBeInTheDocument();
  });
});
