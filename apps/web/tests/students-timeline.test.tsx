import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderApp } from './helpers/render';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';

const REGISTRAR: MeData = {
  tenant_id: 't1',
  user_id: 'u7',
  actor_kind: 'STAFF',
  display_name: 'Rita Registrar',
  roles: ['REGISTRAR'],
  capabilities: [
    'session.read',
    'student.profile.read',
    'enrollment.term.read',
    'academic.program.read',
  ],
};
const FACULTY: MeData = {
  ...REGISTRAR,
  display_name: 'Farah Faculty',
  roles: ['FACULTY'],
  capabilities: ['session.read', 'student.profile.read'],
};
const ASHA = '01900000-0000-7000-8000-000000000001';

function setup(me: MeData = REGISTRAR) {
  const b = createFakeBackend({ session: true, me });
  return { b, user: userEvent.setup(), view: () => renderApp(b, `/students/${ASHA}`) };
}
const timelineCalls = (b: ReturnType<typeof createFakeBackend>) =>
  b.state.calls.filter((c) => c.path.includes('/timeline')).map((c) => c.path);

describe('student academic timeline (profile)', () => {
  it('shows today’s position, the dated events, undated outcomes and incomplete-history notes', async () => {
    const { b, view } = setup();
    const { container } = view();
    expect(
      await screen.findByRole('heading', { name: /Position on 2026-11-02/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(
      screen.getByText(/Session 2026-27 \(2026-04-01 to 2027-03-31\): Grade 6/),
    ).toBeInTheDocument();
    expect(screen.getByText(/MATH6 Mathematics: registered/)).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Academic timeline' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual([
      'Admission',
      'Joined programme',
      'Term enrolment',
      'Section placement',
      'Section transfer',
      'Term enrolment',
      'Course registration',
    ]);
    expect(within(rows[4]!).getByText('Session 2025-26, Grade 5')).toBeInTheDocument();
    expect(within(rows[6]!).getByText('In effect')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Historical')).toBeInTheDocument();

    const undated = screen.getByRole('table', { name: 'Recorded outcomes without a date' });
    expect(within(undated).getByText('Promoted')).toBeInTheDocument();
    expect(within(undated).getByText('Not recorded')).toBeInTheDocument();
    expect(screen.getByText(/decisions are not dated/)).toBeInTheDocument();

    expect(timelineCalls(b)).toEqual([`/students/${ASHA}/timeline`]);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('reconstructs a historical date and returns to today', async () => {
    const { b, user, view } = setup();
    view();
    await screen.findByRole('heading', { name: /Position on 2026-11-02/ });
    const input = screen.getByLabelText('Position as of');
    expect(input).toHaveAttribute('max', '2026-11-02');
    await user.type(input, '2025-06-01');
    await user.click(screen.getByRole('button', { name: 'Show' }));

    expect(
      await screen.findByRole('heading', { name: /Position on 2025-06-01/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Historical view')).toBeInTheDocument();
    expect(screen.getByText(/Session 2025-26 .*: Grade 5/)).toBeInTheDocument();
    expect(screen.getByText('A (from 2025-04-01)')).toBeInTheDocument();
    expect(screen.getByText('Unknown on this date')).toBeInTheDocument();
    expect(screen.getByText(/the status on 2025-06-01 is unknown/)).toBeInTheDocument();
    expect(screen.getByText('3 later events are not shown.')).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Academic timeline' })).getAllByRole(
      'row',
    );
    expect(rows).toHaveLength(1 + 4);
    expect(timelineCalls(b)).toContain(`/students/${ASHA}/timeline?asOf=2025-06-01`);

    await user.click(screen.getByRole('button', { name: 'Back to today' }));
    expect(
      await screen.findByRole('heading', { name: /Position on 2026-11-02/ }),
    ).toBeInTheDocument();
    expect(timelineCalls(b).at(-1)).toBe(`/students/${ASHA}/timeline`);
  });

  it('before admission: not admitted, no events', async () => {
    const { user, view } = setup();
    view();
    await user.type(await screen.findByLabelText('Position as of'), '2024-01-15');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Not yet admitted')).toBeInTheDocument();
    expect(screen.getByText('No events on or before this date.')).toBeInTheDocument();
    expect(screen.getByText(/Not enrolled in a term on this date/)).toBeInTheDocument();
  });

  it('uses the configured terminology for display only', async () => {
    const { b, view } = setup();
    b.state.academics.terminology = {
      program: 'School',
      term: 'Session',
      section: 'Class',
      course: 'Subject',
    };
    view();
    const table = await screen.findByRole('table', { name: 'Academic timeline' });
    await waitFor(() =>
      expect(within(table).getByRole('columnheader', { name: 'Class' })).toBeInTheDocument(),
    );
    expect(
      within(table).getByRole('columnheader', { name: 'Session / Semester' }),
    ).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Subject' })).toBeInTheDocument();
    // the period label comes from each programme's own period type, not the terminology fallback
    expect(within(table).getAllByText('Session 2025-26, Grade 5').length).toBeGreaterThan(0);
  });

  it('a reader without enrolment or programme access still gets the card (server filters the rows)', async () => {
    const { b, view } = setup(FACULTY);
    view();
    expect(
      await screen.findByRole('heading', { name: /Position on 2026-11-02/ }),
    ).toBeInTheDocument();
    expect(b.state.calls.some((c) => c.path.includes('/academics/terminology'))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Term enrolments' })).not.toBeInTheDocument();
  });

  it('a server failure is shown in the card with its own retry', async () => {
    const { b, user, view } = setup();
    b.state.students.timelineMode = 'server';
    view();
    const retry = await screen.findByRole('button', { name: 'Retry academic timeline' });
    b.state.students.timelineMode = 'ok';
    await user.click(retry);
    expect(
      await screen.findByRole('heading', { name: /Position on 2026-11-02/ }),
    ).toBeInTheDocument();
  });
});
