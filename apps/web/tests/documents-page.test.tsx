import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { STUDENT, PARENT, ACADEMIC_ADMIN, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

describe('Document Center: navigation and access', () => {
  const studentWithDocs = {
    ...STUDENT,
    capabilities: [...STUDENT.capabilities, 'document.read'],
  };

  const parentWithDocs = {
    ...PARENT,
    capabilities: [...PARENT.capabilities, 'document.read'],
  };

  it('renders Document Center page header and governance explanation banner', async () => {
    const b = createFakeBackend({ session: true, me: studentWithDocs });
    renderApp(b, '/documents');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Document Center' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Institutional Document Governance & Verification'),
    ).toBeInTheDocument();
    expect(screen.getByText('Tenant Isolation')).toBeInTheDocument();
    expect(screen.getByText('Antimalware Verification')).toBeInTheDocument();
    expect(screen.getByText('Signed Downloads')).toBeInTheDocument();
    expect(screen.getByText('Zero-Access Distinction')).toBeInTheDocument();
  });

  it('displays category tabs and shows documents returned from the API', async () => {
    const b = createFakeBackend({ session: true, me: studentWithDocs });
    renderApp(b, '/documents');

    // Wait for the document card to be visible
    expect(await screen.findByText('Academic_Transcript_2026.pdf')).toBeInTheDocument();
    expect(screen.getByText('✓ VERIFIED CLEAN')).toBeInTheDocument();
    expect(screen.getByText('INTERNAL')).toBeInTheDocument();
  });

  it('opens document details modal with SHA-256 digest and security scan details', async () => {
    const b = createFakeBackend({ session: true, me: studentWithDocs });
    renderApp(b, '/documents');

    await screen.findByText('Academic_Transcript_2026.pdf');
    const detailsBtn = screen.getByRole('button', { name: 'Details' });
    await userEvent.click(detailsBtn);

    expect(await screen.findByText('Document Verification & Security Details')).toBeInTheDocument();
    expect(
      screen.getByText('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
    ).toBeInTheDocument();
    expect(screen.getByText('CLEAN (Inspected)')).toBeInTheDocument();
  });

  it('switches to Financial tab and displays official receipts or empty state', async () => {
    const b = createFakeBackend({ session: true, me: studentWithDocs });
    renderApp(b, '/documents');

    await screen.findByText('Academic_Transcript_2026.pdf');
    const financialTab = screen.getByRole('button', { name: /Fee Receipts & Dues/i });
    await userEvent.click(financialTab);

    expect(await screen.findByText('No Fee Receipts Available')).toBeInTheDocument();
  });

  it('allows guardians to switch between verified linked children', async () => {
    const b = createFakeBackend({ session: true, me: parentWithDocs });
    renderApp(b, '/documents');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Document Center' }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText(/Viewing Records For Linked Child/i)).toBeInTheDocument();
    expect(screen.getByText(/Verified Legal Guardianship Linkage/i)).toBeInTheDocument();
  });

  it('hides upload button from users without document.upload capability', async () => {
    const b = createFakeBackend({ session: true, me: studentWithDocs });
    renderApp(b, '/documents');

    await screen.findByRole('heading', { level: 1, name: 'Document Center' });
    expect(screen.queryByRole('button', { name: /\+ Upload Document/i })).not.toBeInTheDocument();
  });

  it('shows upload button to administrators with document.upload capability', async () => {
    const adminMe = {
      ...ACADEMIC_ADMIN,
      capabilities: [...ACADEMIC_ADMIN.capabilities, 'document.upload', 'document.read'],
    };
    const b = createFakeBackend({ session: true, me: adminMe });
    renderApp(b, '/documents');

    expect(await screen.findByRole('button', { name: /\+ Upload Document/i })).toBeInTheDocument();
  });

  it('allows switching between Institutional Documents and My Documents workspace', async () => {
    const adminMe = {
      ...ACADEMIC_ADMIN,
      capabilities: [...ACADEMIC_ADMIN.capabilities, 'document.upload', 'document.read'],
    };
    const b = createFakeBackend({ session: true, me: adminMe });
    renderApp(b, '/documents');

    expect(
      await screen.findByRole('button', { name: 'Institutional Documents' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My Documents' })).toBeInTheDocument();
    expect(await screen.findByText(/Institutional Document Requirements/i)).toBeInTheDocument();

    const myDocsBtn = screen.getByRole('button', { name: 'My Documents' });
    await userEvent.click(myDocsBtn);
    expect(myDocsBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens role-aware upload modal with accessible controls and passes axe audit', async () => {
    const adminMe = {
      ...ACADEMIC_ADMIN,
      capabilities: [...ACADEMIC_ADMIN.capabilities, 'document.upload', 'document.read'],
    };
    const b = createFakeBackend({ session: true, me: adminMe });
    const view = renderApp(b, '/documents');

    const uploadBtn = await screen.findByRole('button', { name: /\+ Upload Document/i });
    await userEvent.click(uploadBtn);

    expect(await screen.findByText('Upload Institutional Document')).toBeInTheDocument();
    expect(screen.getByLabelText(/Target Entity Context/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Document Purpose/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason for Upload/i)).toBeInTheDocument();

    const results = await axe(view.container);
    expect(results.violations).toEqual([]);
  });

  it('has no detectable axe accessibility violations on Document Center', async () => {
    const b = createFakeBackend({ session: true, me: studentWithDocs });
    const view = renderApp(b, '/documents');

    await screen.findByRole('heading', { level: 1, name: 'Document Center' });
    await screen.findByText('Academic_Transcript_2026.pdf');

    const results = await axe(view.container);
    expect(results.violations).toEqual([]);
  });
});
