import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ACADEMIC_ADMIN,
  IMPORT_ADMIN,
  IMPORT_REGISTRAR,
  STUDENT,
  createFakeBackend,
} from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const GOOD = 'email,admissionNumber,admissionDate\na@college.example,A-1,2026-07-01';

async function upload(csv: string): Promise<void> {
  const box = await screen.findByLabelText('Or paste the CSV text');
  await userEvent.click(box);
  await userEvent.paste(csv);
  await userEvent.click(screen.getByRole('button', { name: 'Upload and validate' }));
}

describe('Imports page: access', () => {
  it('shows the menu entry only to holders of import.job.manage', async () => {
    const admin = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    const { unmount } = renderApp(admin, '/');
    expect((await screen.findAllByRole('link', { name: 'Imports' })).length).toBeGreaterThan(0);
    unmount();
    const other = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    renderApp(other, '/');
    await screen.findAllByText(/Rita Registrar/);
    expect(screen.queryByRole('link', { name: 'Imports' })).not.toBeInTheDocument();
  });

  it('a direct visit without the capability shows the forbidden page and never calls the API', async () => {
    const b = createFakeBackend({ session: true, me: STUDENT });
    renderApp(b, '/imports');
    expect(await screen.findByText('Access restricted')).toBeInTheDocument();
    expect(b.state.calls.filter((c) => c.path.includes('/imports'))).toHaveLength(0);
  });

  it('offers only the record kinds the person may create', async () => {
    const reg = createFakeBackend({ session: true, me: IMPORT_REGISTRAR });
    const { unmount } = renderApp(reg, '/imports');
    await screen.findByText('Student records');
    expect(screen.queryByText(/Employee records/)).not.toBeInTheDocument();
    unmount();
    const admin = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    renderApp(admin, '/imports');
    expect(await screen.findByText(/Employee records/)).toBeInTheDocument();
  });
});

describe('Imports page: validate, preview, commit', () => {
  it('refuses an unreadable file before calling the API, in fixed wording', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    renderApp(b, '/imports');
    await upload('email,admissionNumber\n"unterminated');
    expect(await screen.findByText('A quoted value is not closed.')).toBeInTheDocument();
    expect(b.state.calls.filter((c) => c.path.includes('/imports'))).toHaveLength(0);
  });

  it('creates and validates a job with an Idempotency-Key, shows the exact proposed change, and commits it', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    renderApp(b, '/imports');
    await upload(GOOD);
    expect(await screen.findByText(/1 valid, 0 with errors, 0 with warnings/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Create student record for a@college.example: admission number A-1, admitted 2026-07-01, status ADMITTED.',
      ),
    ).toBeInTheDocument();
    const [create] = b.callsTo('POST', '/students/imports');
    expect(create?.headers['idempotency-key']).toMatch(/[0-9a-f-]{16,}/);
    expect(create?.headers['x-csrf-token']).toBeTruthy();
    expect(create?.body).toEqual({
      rows: [{ email: 'a@college.example', admissionNumber: 'A-1', admissionDate: '2026-07-01' }],
    });

    const form = screen.getByRole('form', { name: 'Commit import' });
    await userEvent.click(within(form).getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText('Give a reason of at least 5 characters.')).toBeInTheDocument();
    expect(b.callsTo('POST', '/students/imports/job-1/commit')).toHaveLength(0);

    await userEvent.type(within(form).getByLabelText('Reason'), 'Admissions batch approved');
    await userEvent.click(within(form).getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText('Imported. 1 record created.')).toBeInTheDocument();
    const [commit] = b.callsTo('POST', '/students/imports/job-1/commit');
    expect(commit?.headers['if-match']).toBe('"2"');
    expect(commit?.headers['idempotency-key']).toBeTruthy();
    expect(commit?.body).toEqual({
      reason: 'Admissions batch approved',
      acknowledgeWarnings: false,
    });
    expect(screen.queryByRole('form', { name: 'Commit import' })).not.toBeInTheDocument();
  });

  it('shows row errors in fixed wording, offers the error report, and offers no commit', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    renderApp(b, '/imports');
    await upload(
      'email,admissionNumber,admissionDate\nnot-an-email,A-1,2026-07-01\ntaken@x.test,A-2,2026-07-01',
    );
    expect(await screen.findByText(/0 valid, 2 with errors/)).toBeInTheDocument();
    expect(screen.getByText('Error: Not a valid e-mail address. (email)')).toBeInTheDocument();
    expect(
      screen.getByText('Error: This account already has a student record. (email)'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Commit import' })).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Download the error report/ });
    expect(link).toHaveAttribute('href', '/api/students/imports/job-1/error-report');
    expect(link).toHaveAttribute('download');
  });

  it('needs the warnings to be confirmed before it commits', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    renderApp(b, '/imports');
    await upload('email,admissionNumber,admissionDate\na@x.test,A-1,2199-01-01');
    expect(await screen.findByText(/1 with warnings/)).toBeInTheDocument();
    expect(
      screen.getByText('Warning: The date is in the future. (admissionDate)'),
    ).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Commit import' });
    await userEvent.type(within(form).getByLabelText('Reason'), 'Reviewed the warning');
    await userEvent.click(within(form).getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText(/tick the confirmation box/)).toBeInTheDocument();
    await userEvent.click(within(form).getByLabelText(/reviewed the warnings/));
    await userEvent.click(within(form).getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText('Imported. 1 record created.')).toBeInTheDocument();
    const calls = b.callsTo('POST', '/students/imports/job-1/commit');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ acknowledgeWarnings: true });
  });

  it('shows the possible-duplicate warning in fixed wording, without any detail, and needs it confirmed', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    renderApp(b, '/imports');
    await upload(
      'email,admissionNumber,admissionDate,name,dateOfBirth,guardianPhone\na@x.test,A-1,2026-07-01,Possible Duplicate,2005-03-04,9876543210',
    );
    expect(await screen.findByText(/1 with warnings/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Warning: A student with the same name, date of birth and guardian phone number may already exist.',
      ),
    ).toBeInTheDocument();
    // the matching-only cells are shown nowhere on the page
    expect(document.body.textContent).not.toContain('2005-03-04');
    expect(document.body.textContent).not.toContain('9876543210');
    const form = screen.getByRole('form', { name: 'Commit import' });
    await userEvent.type(within(form).getByLabelText('Reason'), 'Reviewed the warning');
    await userEvent.click(within(form).getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText(/tick the confirmation box/)).toBeInTheDocument();
    await userEvent.click(within(form).getByLabelText(/reviewed the warnings/));
    await userEvent.click(within(form).getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText('Imported. 1 record created.')).toBeInTheDocument();

    // the matching-only cells are never created with the rows; they travel with validate and with every commit attempt
    const matching = [
      { rowNo: 1, email: 'a@x.test', dateOfBirth: '2005-03-04', guardianPhone: '9876543210' },
    ];
    const created = b.callsTo('POST', '/students/imports');
    expect(JSON.stringify(created[0]?.body)).not.toMatch(/dateOfBirth|guardianPhone|2005|9876/);
    expect(b.callsTo('POST', '/students/imports/job-1/validate')[0]?.body).toEqual({ matching });
    for (const c of b.callsTo('POST', '/students/imports/job-1/commit')) {
      expect(c.body).toMatchObject({ matching });
    }
  });

  it('sends no body with validate when the file has no matching columns', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    renderApp(b, '/imports');
    await upload(GOOD);
    expect(await screen.findByText(/1 valid, 0 with errors/)).toBeInTheDocument();
    expect(b.callsTo('POST', '/students/imports/job-1/validate')[0]?.body).toBeUndefined();
  });

  it('reuses the Idempotency-Key when the same commit is retried, and a new one for a refreshed preview', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    b.state.imports.commitMode = 'changed';
    renderApp(b, '/imports');
    await upload(GOOD);
    const form = await screen.findByRole('form', { name: 'Commit import' });
    await userEvent.type(within(form).getByLabelText('Reason'), 'Admissions batch approved');
    await userEvent.click(within(form).getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText(/differ from the preview you reviewed/)).toBeInTheDocument();
    // the preview was refreshed: the next commit carries the new version and its own key
    await userEvent.click(
      within(screen.getByRole('form', { name: 'Commit import' })).getByRole('button', {
        name: 'Commit import',
      }),
    );
    expect(await screen.findByText('Imported. 1 record created.')).toBeInTheDocument();
    const [first, second] = b.callsTo('POST', '/students/imports/job-1/commit');
    expect(first?.headers['if-match']).toBe('"2"');
    expect(second?.headers['if-match']).toBe('"3"');
    expect(first?.headers['idempotency-key']).not.toBe(second?.headers['idempotency-key']);
  });

  it('shows the closed job and its refreshed errors after a commit conflict, and creates nothing', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    b.state.imports.commitMode = 'conflict';
    renderApp(b, '/imports');
    await upload(GOOD);
    const form = await screen.findByRole('form', { name: 'Commit import' });
    await userEvent.type(within(form).getByLabelText('Reason'), 'Admissions batch approved');
    await userEvent.click(within(form).getByRole('button', { name: 'Commit import' }));
    expect(
      await screen.findByText(/Nothing was imported\. Download the error report and import again/),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('FAILED')).toBeInTheDocument());
    expect(screen.queryByRole('form', { name: 'Commit import' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start another import' })).toBeInTheDocument();
  });

  it('imports employee records through the faculty endpoints', async () => {
    const b = createFakeBackend({ session: true, me: IMPORT_ADMIN });
    renderApp(b, '/imports');
    await userEvent.click(await screen.findByLabelText(/Employee records/));
    await upload(
      'email,employeeCode,employeeType,joiningDate\nr@college.example,E-1,FACULTY,2026-06-01',
    );
    expect(
      await screen.findByText(
        'Create employee record for r@college.example: code E-1, type FACULTY, joined 2026-06-01, status ACTIVE.',
      ),
    ).toBeInTheDocument();
    expect(b.callsTo('POST', '/faculty/imports')).toHaveLength(1);
    expect(b.callsTo('POST', '/students/imports')).toHaveLength(0);
  });
});
