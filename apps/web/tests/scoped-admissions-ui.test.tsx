import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from './helpers/render';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';

const ADMISSIONS_STAFF: MeData = {
  tenant_id: 't1',
  user_id: 'u-registrar',
  actor_kind: 'STAFF',
  display_name: 'Alex Admissions',
  roles: ['REGISTRAR'],
  capabilities: [
    'session.read',
    'student.record.create',
    'student.directory.search',
    'student.profile.read',
  ],
};

function setupWithInstitution(type: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY') {
  const b = createFakeBackend({ session: true, me: ADMISSIONS_STAFF });
  // Intercept GET /academics/terminology to return institutionType
  const originalFetch = b.fetch;
  b.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/academics/terminology')) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            labels: {
              program: type === 'SCHOOL' ? 'Class' : 'Programme',
              cohort: 'Batch',
              period: type === 'SCHOOL' ? 'Term' : 'Semester',
              section: 'Section',
              term: 'Term',
              course: type === 'SCHOOL' ? 'Subject' : 'Course',
            },
            customised: [],
            periodTypes: [],
            byCohort: {},
            institutionType: type,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  };
  return { b, user: userEvent.setup(), view: () => renderApp(b, '/students') };
}

describe('Scoped Admissions UI: Institution-Aware Terminology', () => {
  it('1. SCHOOL mode: displays pupil terminology, "New admission", and "Confirm admission"', async () => {
    const { view } = setupWithInstitution('SCHOOL');
    view();

    expect(await screen.findByRole('heading', { level: 1, name: 'Pupils & Admissions' })).toBeInTheDocument();
    expect(screen.getByText(/Manage school admissions and pupil records/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'New admission' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm admission' })).toBeInTheDocument();
  });

  it('2. COLLEGE mode: displays college student terminology and "Admit student"', async () => {
    const { view } = setupWithInstitution('COLLEGE');
    view();

    expect(await screen.findByRole('heading', { level: 1, name: 'Students & Admissions' })).toBeInTheDocument();
    expect(screen.getByText(/Manage college admissions and student records across campuses/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Admit student' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register student' })).toBeInTheDocument();
  });

  it('3. UNIVERSITY mode: displays university terminology and campus-scoped phrasing', async () => {
    const { view } = setupWithInstitution('UNIVERSITY');
    view();

    expect(await screen.findByRole('heading', { level: 2, name: 'Register student' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Students & Admissions' })).toBeInTheDocument();
    expect(screen.getByText(/Manage university admissions and student records within your authorized campus/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register student' })).toBeInTheDocument();
  });
});
