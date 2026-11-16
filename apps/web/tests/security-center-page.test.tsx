import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';
import { VaultClientCrypto } from '../src/lib/crypto/vault-client';

const VAULT_ADMIN_ME: MeData = {
  tenant_id: 't1',
  user_id: 'usr_vault_admin',
  display_name: 'Principal Dr. Sharma',
  actor_kind: 'STAFF',
  roles: ['COLLEGE_ADMIN'],
  capabilities: [
    'session.read',
    'session.revoke',
    'vault.authority.manage',
    'vault.authority.read',
    'vault.device.enroll',
    'vault.device.manage',
    'vault.grant.issue',
    'vault.record.read',
    'vault.record.write',
    'vault.recovery.initiate',
  ],
};

describe('School Vault — Zero-Access Security Center Page & Client Crypto', () => {
  it('renders Security Center with ISA details, badges, and segmented tabs', async () => {
    const backend = createFakeBackend({ session: true, me: VAULT_ADMIN_ME });
    const { container } = renderApp(backend, '/security-center');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Anesa School Vault — Zero-Access Security Center/i }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('Zero-Access Active')).toBeInTheDocument();
    expect(screen.getByText('SCHOOL MODE')).toBeInTheDocument();
    expect(screen.getByText('2-of-3 Quorum')).toBeInTheDocument();

    // Verify tabs exist
    expect(screen.getByRole('button', { name: 'Security Authority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hardware Authenticators' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capability Key Grants' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2-of-3 Recovery Quorum' })).toBeInTheDocument();

    // WCAG accessibility check
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('manages hardware authenticators: verifies 2-device policy and enrollment', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ session: true, me: VAULT_ADMIN_ME });
    renderApp(backend, '/security-center');

    // Switch to Hardware Authenticators tab
    const devicesTab = await screen.findByRole('button', { name: 'Hardware Authenticators' });
    await user.click(devicesTab);

    // Initial state: 1 of 2 Enrolled
    await waitFor(() => {
      expect(screen.getByText('1 of 2 Enrolled')).toBeInTheDocument();
      expect(screen.getByText('Admin MacBook Pro Touch ID')).toBeInTheDocument();
    });

    // Enroll 2nd device
    const labelInput = screen.getByPlaceholderText(/MacBook Pro Touch ID, YubiKey 5C NFC/i);
    await user.type(labelInput, 'Backup YubiKey 5C');

    const enrollBtn = screen.getByRole('button', { name: /Enroll Hardware Authenticator/i });
    await user.click(enrollBtn);

    // Verify 2nd device enrolled and limit reached (2 of 2)
    await waitFor(() => {
      expect(screen.getByText('2 of 2 Enrolled (Limit Reached)')).toBeInTheDocument();
      expect(screen.getByText('Backup YubiKey 5C')).toBeInTheDocument();
    });

    // Verify third enrollment is blocked
    expect(
      screen.getByText(/To enroll a replacement hardware authenticator, you must first revoke/i),
    ).toBeInTheDocument();
  });

  it('switches to Capability Key Grants and shows scoped keys', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ session: true, me: VAULT_ADMIN_ME });
    renderApp(backend, '/security-center');

    const grantsTab = await screen.findByRole('button', { name: 'Capability Key Grants' });
    await user.click(grantsTab);

    await waitFor(() => {
      expect(screen.getByText('CWK_STUDENTS_PII')).toBeInTheDocument();
      expect(screen.getByText('CWK_ACADEMICS_MARKS')).toBeInTheDocument();
      expect(screen.getByText('CWK_HOMEWORK_SUBMISSIONS')).toBeInTheDocument();
      expect(screen.getByText('CWK_FINANCE_PRIVATE')).toBeInTheDocument();
    });
  });

  it('switches to 2-of-3 Recovery Quorum and initiates ceremony', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ session: true, me: VAULT_ADMIN_ME });
    renderApp(backend, '/security-center');

    const recoveryTab = await screen.findByRole('button', { name: '2-of-3 Recovery Quorum' });
    await user.click(recoveryTab);

    await waitFor(() => {
      expect(screen.getByText('Custodian #1')).toBeInTheDocument();
      expect(screen.getByText('Custodian #2')).toBeInTheDocument();
      expect(screen.getByText('Custodian #3')).toBeInTheDocument();
    });

    // Initiate recovery ceremony
    const initBtn = screen.getByRole('button', {
      name: /Initiate 2-of-3 Key Reconstruction Ceremony/i,
    });
    await user.click(initBtn);

    await waitFor(() => {
      expect(screen.getByText(/Ceremony Active/i)).toBeInTheDocument();
    });

    // Present share
    const shareInput = screen.getByPlaceholderText(/Paste Base64 custodian share payload/i);
    await user.type(shareInput, 'MOCK_SHARE_DATA_BASE64_PAYLOAD_CUSTODIAN_1');

    const submitShareBtn = screen.getByRole('button', { name: /Submit Custodian Share/i });
    await user.click(submitShareBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Quorum reached! Secret key reconstructed locally/i),
      ).toBeInTheDocument();
    });
  });

  describe('Client-Side Cryptographic Standing Engine', () => {
    const sampleCourses = [
      { courseId: 'c1', maxMarks: 100, obtainedMarks: 95, credits: 4 },
      { courseId: 'c2', maxMarks: 100, obtainedMarks: 85, credits: 3 },
      { courseId: 'c3', maxMarks: 100, obtainedMarks: 90, credits: 3 },
    ];

    it('calculates school standing locally on the client device', async () => {
      const standing = await VaultClientCrypto.computeStanding('SCHOOL', sampleCourses);
      expect(standing.institutionType).toBe('SCHOOL');
      expect(standing.percentage).toBe(90);
      expect(standing.letterGrade).toBe('A+');
      expect(standing.verificationDigest).toBeDefined();
      expect(standing.verificationDigest.length).toBe(64); // SHA-256 hex string
    });

    it('calculates university standing with SGPA locally on the client device', async () => {
      const standing = await VaultClientCrypto.computeStanding('UNIVERSITY', sampleCourses);
      expect(standing.institutionType).toBe('UNIVERSITY');
      expect(standing.totalCredits).toBe(10);
      // c1: 95% -> gp 10 * 4 = 40
      // c2: 85% -> gp 9 * 3 = 27
      // c3: 90% -> gp 10 * 3 = 30
      // sum = 97 / 10 = 9.7
      expect(standing.sgpa).toBe(9.7);
      expect(standing.letterGrade).toBe('A+');
      expect(standing.verificationDigest).toBeDefined();
    });
  });
});
