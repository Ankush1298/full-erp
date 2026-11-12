import { screen, within } from '@testing-library/react';
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

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pupils & Admissions' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Manage school admissions and pupil records/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'New admission' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm admission' })).toBeInTheDocument();
  });

  it('2. COLLEGE mode: displays college student terminology and "Admit student"', async () => {
    const { view } = setupWithInstitution('COLLEGE');
    view();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Students & Admissions' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Manage college admissions and student records across campuses/),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Admit student' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register student' })).toBeInTheDocument();
  });

  it('3. UNIVERSITY mode: displays university terminology and campus-scoped phrasing', async () => {
    const { view } = setupWithInstitution('UNIVERSITY');
    view();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Register student' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Students & Admissions' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Manage university admissions and student records within your authorized campus/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register student' })).toBeInTheDocument();
  });

  it('4. SCHOOL mode: admits pupil without User Account ID UUID and validates pupil name', async () => {
    let capturedPayload: Record<string, unknown> | null = null;
    let capturedHeaders: Record<string, string> | null = null;
    const { b, user, view } = setupWithInstitution('SCHOOL');
    const originalFetch = b.fetch;
    b.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/v1/students') && init?.method === 'POST') {
        capturedPayload = JSON.parse(init.body as string) as Record<string, unknown>;
        capturedHeaders = init.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            success: true,
            data: { id: '01900000-0000-7000-8000-000000000099' },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    view();

    // Verify Pupil name field is present and required; User ID is optional
    const newAdmHeading = await screen.findByRole('heading', { level: 2, name: 'New admission' });
    const card = newAdmHeading.closest('.card') as HTMLElement;
    const cardEl = within(card);

    expect(cardEl.getByLabelText(/Pupil name/i)).toBeInTheDocument();
    expect(cardEl.getByLabelText(/Pupil name/i)).toBeRequired();
    expect(cardEl.getByLabelText(/User account ID \(UUID\)/i)).not.toBeRequired();

    // 1. Validation test: empty form submission requires pupil name, not user ID
    await user.click(cardEl.getByRole('button', { name: 'Confirm admission' }));
    expect(await cardEl.findByText('Pupil name is required.')).toBeInTheDocument();
    expect(cardEl.queryByText('User account ID is required.')).not.toBeInTheDocument();

    // 2. Successful admission without user ID
    await user.type(cardEl.getByLabelText(/Pupil name/i), 'Aarav Patel');
    await user.type(cardEl.getByLabelText(/Admission number/i), 'SCH-2026-001');
    await user.click(cardEl.getByRole('button', { name: 'Confirm admission' }));

    // Verify success banner appears
    expect(
      await cardEl.findByText(
        /Pupil successfully admitted \(ID: 01900000-0000-7000-8000-000000000099\)/,
      ),
    ).toBeInTheDocument();

    // Verify backend received student creation payload WITHOUT userId and WITH Idempotency-Key header
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload?.['name']).toBe('Aarav Patel');
    expect(capturedPayload?.['admissionNumber']).toBe('SCH-2026-001');
    expect(capturedPayload?.['userId']).toBeUndefined();
    expect(capturedHeaders?.['Idempotency-Key']).toBeDefined();
    expect(capturedHeaders?.['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('5. SCHOOL mode: displays actionable explanation when server returns HTTP 428 precondition error', async () => {
    const { b, user, view } = setupWithInstitution('SCHOOL');
    const originalFetch = b.fetch;
    b.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/v1/students') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'IDEMPOTENCY_KEY_REQUIRED',
              message: 'The Idempotency-Key header is required.',
            },
          }),
          { status: 428, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    view();

    const newAdmHeading = await screen.findByRole('heading', { level: 2, name: 'New admission' });
    const card = newAdmHeading.closest('.card') as HTMLElement;
    const cardEl = within(card);

    await user.type(cardEl.getByLabelText(/Pupil name/i), 'Meera Sen');
    await user.type(cardEl.getByLabelText(/Admission number/i), 'SCH-2026-002');
    await user.click(cardEl.getByRole('button', { name: 'Confirm admission' }));

    // Verify actionable message appears, NOT generic 'API validation (428)'
    expect(
      await cardEl.findByText(/A required transaction identifier \(Idempotency-Key\) was missing/),
    ).toBeInTheDocument();
    expect(cardEl.queryByText(/API validation \(428\)/i)).not.toBeInTheDocument();
  });
});
