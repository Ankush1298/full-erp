import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { axe } from 'vitest-axe';
import { PlatformShell } from '../src/pages/platform/PlatformShell';
import { PlatformDashboardPage } from '../src/pages/platform/PlatformDashboardPage';
import { PlatformInstitutionsPage } from '../src/pages/platform/PlatformInstitutionsPage';
import { PlatformInstitutionDetailPage } from '../src/pages/platform/PlatformInstitutionDetailPage';
import { PlatformEntitlementsPage } from '../src/pages/platform/PlatformEntitlementsPage';
import { PlatformPlansPage } from '../src/pages/platform/PlatformPlansPage';
import { PlatformRolesPage } from '../src/pages/platform/PlatformRolesPage';

const MOCK_STATS = {
  institutions: {
    total: 3,
    active: 3,
    suspended: 0,
    archived: 0,
    schools: 1,
    colleges: 1,
    universities: 1,
  },
  subscriptions: {
    active: 3,
    trial: 1,
    expired: 0,
    overdue: 0,
  },
  moduleAdoption: {
    students: 3,
    academics: 3,
    attendance: 3,
    homework: 3,
    examinations: 3,
    finance: 2,
    parent_portal: 2,
    documents: 3,
    imports: 3,
    reports: 3,
    school_vault: 1,
    consents: 2,
    notifications: 3,
    ai_assistant: 1,
  },
  operationalHealth: {
    database: 'HEALTHY (PostgreSQL 16 Multi-Tenant RLS)',
    databaseConnections: 5,
    storageDriver: 'S3-Compatible Object Storage (Secure Isolated Buckets)',
    malwareScanner: 'ClamAV Active Antivirus Queue',
    emailDelivery: 'Transactional SMTP / In-Memory Mock Provider',
    serverUptimeSeconds: 1250,
  },
  securityAlertsCount: 4,
  recentAuditAlerts: [
    {
      id: 'alert-1',
      occurredAt: '2026-11-14T01:00:00.000Z',
      action: 'auth.mfa.challenge',
      resourceType: 'mfa_factor',
      riskTier: 2,
      actorType: 'USER',
      organizationName: 'Anesa Demo School',
    },
  ],
};

const MOCK_INSTITUTIONS = [
  {
    id: 'inst-1',
    name: 'Anesa Demo School',
    slug: 'anesa-demo-school',
    institutionType: 'SCHOOL',
    status: 'ACTIVE',
    campusesCount: 1,
    adminEmail: 'principal@anesademo.test',
    planName: 'Complete Institutional ERP',
    subscriptionStatus: 'ACTIVE',
    createdAt: '2026-11-08T18:34:08.231Z',
    updatedAt: '2026-11-08T18:34:08.231Z',
  },
  {
    id: 'inst-2',
    name: 'Apex Polytechnic College',
    slug: 'apex-poly',
    institutionType: 'COLLEGE',
    status: 'ACTIVE',
    campusesCount: 1,
    adminEmail: 'dean@apexpoly.test',
    planName: 'Academic Plus',
    subscriptionStatus: 'ACTIVE',
    createdAt: '2026-11-10T12:00:00.000Z',
    updatedAt: '2026-11-10T12:00:00.000Z',
  },
];

const MOCK_INSTITUTION_DETAIL = {
  id: 'inst-1',
  name: 'Anesa Demo School',
  slug: 'anesa-demo-school',
  institutionType: 'SCHOOL',
  status: 'ACTIVE',
  createdAt: '2026-11-08T18:34:08.231Z',
  updatedAt: '2026-11-08T18:34:08.231Z',
  campuses: [
    {
      id: 'camp-1',
      name: 'Main Campus',
      code: 'MAIN',
      status: 'ACTIVE',
      timezone: 'Asia/Kolkata',
    },
  ],
  subscription: {
    planName: 'Complete Institutional ERP',
    billingCycle: 'ANNUAL',
    status: 'ACTIVE',
    priceInr: 150000,
    startsAt: '2026-11-08T18:34:08.231Z',
    expiresAt: '2027-11-08T18:34:08.231Z',
    maxStudents: 5000,
    maxFaculty: 250,
  },
  entitlements: {
    planBundle: 'COMPLETE_ERP',
    modules: [
      {
        key: 'students',
        name: 'Student Management & Directory',
        category: 'CORE',
        description: 'Admitted student onboarding, student profiles, identifiers.',
        enabled: true,
        isTrial: false,
        dependencies: [],
        targetRoutes: ['/students'],
        requiredCapabilities: ['student.profile.read'],
      },
      {
        key: 'academics',
        name: 'Academics & Cohort Management',
        category: 'ACADEMIC',
        description: 'Degree programs, academic terms, courses, syllabus.',
        enabled: true,
        isTrial: false,
        dependencies: [],
        targetRoutes: ['/academics'],
        requiredCapabilities: ['academic.program.read'],
      },
    ],
  },
  settings: {
    'academic.grading_scale': 'PERCENTAGE_100',
    'attendance.threshold_percent': 75,
  },
  roles: [
    { id: 'r1', code: 'COLLEGE_ADMIN', name: 'COLLEGE_ADMIN', isSystem: true, permissionCount: 74 },
    { id: 'r2', code: 'FACULTY', name: 'FACULTY', isSystem: true, permissionCount: 27 },
    { id: 'r3', code: 'STUDENT', name: 'STUDENT', isSystem: true, permissionCount: 30 },
  ],
  firstAdminOnboarding: {
    userId: 'admin-1',
    email: 'principal@anesademo.test',
    designation: 'Principal',
    accountStatus: 'PENDING',
    activationStatus: 'PENDING_ACTIVATION',
    invitationStatus: 'NONE',
    invitationExpiresAt: undefined as string | undefined,
    mfaEnrolled: false,
    mfaBootstrapEligible: false,
    canIssueInvitation: true,
    canRevokeInvitation: false,
  },
};

const MOCK_MODULES_CATALOG = [
  {
    key: 'students',
    name: 'Student Management & Directory',
    category: 'CORE',
    description:
      'Admitted student onboarding, student profiles, identifiers, and scope-restricted directory lookups.',
    dependencies: [],
    targetRoutes: ['/students', '/profile'],
    requiredCapabilities: ['student.profile.read', 'student.directory.search'],
  },
  {
    key: 'school_vault',
    name: 'School Vault (Zero-Access Security)',
    category: 'SECURITY_AI',
    description:
      'Hardware WebAuthn FIDO2 authenticator-protected secret storage with 2-of-3 threshold quorum recovery.',
    dependencies: [],
    targetRoutes: ['/security-center'],
    requiredCapabilities: ['vault.authority.read', 'vault.device.enroll'],
  },
];

const MOCK_PLAN_BUNDLES = [
  {
    id: 'STARTER_CORE',
    name: 'Starter Core',
    tier: 'STARTER_CORE',
    description: 'Essential student directory, academic cohorts, and document management.',
    priceInrAnnual: 49999,
    maxStudents: 1000,
    maxFaculty: 50,
    includedModules: ['students', 'academics', 'attendance'],
  },
  {
    id: 'COMPLETE_ERP',
    name: 'Complete Institutional ERP',
    tier: 'COMPLETE_ERP',
    description: 'All-inclusive campus management with fees, parent portal, reporting, and vault.',
    priceInrAnnual: 149999,
    maxStudents: 5000,
    maxFaculty: 250,
    includedModules: [
      'students',
      'academics',
      'attendance',
      'homework',
      'examinations',
      'finance',
      'school_vault',
    ],
  },
];

describe('Platform Owner Control Center - Frontend Web Component Tests', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', (url: string | URL | { url: string }) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (u.includes('/api/v1/platform/stats')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_STATS }),
        });
      }
      if (u.includes('/api/v1/platform/institutions/inst-1')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_INSTITUTION_DETAIL }),
        });
      }
      if (u.includes('/api/v1/platform/institutions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_INSTITUTIONS }),
        });
      }
      if (u.includes('/api/v1/platform/catalog/modules')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_MODULES_CATALOG }),
        });
      }
      if (u.includes('/api/v1/platform/catalog/bundles')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_PLAN_BUNDLES }),
        });
      }
      if (u.includes('/api/v1/platform/audit')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_STATS.recentAuditAlerts }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: {} }),
      });
    });
  });

  it('renders PlatformShell navigation, operator badge, and trust banner', () => {
    render(
      <MemoryRouter initialEntries={['/platform']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route index element={<PlatformDashboardPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('ANESA CAMPUS OS')).toBeInTheDocument();
    expect(screen.getByText('Platform Owner Control Center')).toBeInTheDocument();
    expect(screen.getByText('Zero-Access Isolation: Active')).toBeInTheDocument();
    expect(screen.getByText('OPERATOR')).toBeInTheDocument();
    expect(screen.getByText(/Switch to School ERP/)).toBeInTheDocument();
    expect(screen.getByText('Executive Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Institutions Directory')).toBeInTheDocument();
    expect(screen.getByText('Module Marketplace')).toBeInTheDocument();
  });

  it('renders Executive Dashboard with live operational health and stats', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/platform']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route index element={<PlatformDashboardPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Executive Control Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Total Institutions')).toBeInTheDocument();
    expect(screen.getByText('Active Subscriptions')).toBeInTheDocument();
    expect(screen.getByText('Operational Health')).toBeInTheDocument();
    expect(screen.getByText('HEALTHY (PostgreSQL 16 Multi-Tenant RLS)')).toBeInTheDocument();
    expect(screen.getByText('ClamAV Active Antivirus Queue')).toBeInTheDocument();

    // Verify structured grid design system classes
    expect(container.querySelector('.platform-dashboard-grid')).toBeInTheDocument();
    expect(container.querySelector('.platform-dashboard-main')).toBeInTheDocument();
    expect(container.querySelector('.platform-dashboard-sidebar')).toBeInTheDocument();
    expect(container.querySelector('.module-adoption-grid')).toBeInTheDocument();
  });

  it('renders Institutions Directory and provision button', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/platform/institutions']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="institutions" element={<PlatformInstitutionsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Institutions Directory' }),
    ).toBeInTheDocument();
    expect(screen.getByText('+ Provision New Tenant')).toBeInTheDocument();
    expect(await screen.findByText('Anesa Demo School')).toBeInTheDocument();
    expect(screen.getByText('Apex Polytechnic College')).toBeInTheDocument();

    // Verify directory toolbar and table action styling
    expect(container.querySelector('.platform-filter-bar')).toBeInTheDocument();
    expect(container.querySelector('.table-actions')).toBeInTheDocument();
    expect(container.querySelector('.action-manage')).toBeInTheDocument();
  });

  it('renders Institution Detail with sub-tabs and module entitlements', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/platform/institutions/inst-1']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="institutions/:id" element={<PlatformInstitutionDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Anesa Demo School' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Overview & Campuses')).toBeInTheDocument();
    expect(screen.getByText(/Module Entitlements/)).toBeInTheDocument();
    expect(screen.getByText('SaaS Subscription & Limits')).toBeInTheDocument();
    expect(screen.getByText('Roles & Permissions Matrix')).toBeInTheDocument();
    expect(screen.getAllByText('Main Campus').length).toBeGreaterThanOrEqual(1);

    // Verify segmented tabs navigation
    expect(container.querySelector('.platform-tabs-nav')).toBeInTheDocument();
    expect(container.querySelectorAll('.platform-tab-btn').length).toBeGreaterThanOrEqual(5);

    // Click Sensitive Authorities tab and verify design improvements
    const authoritiesTab = screen.getByRole('button', { name: /Sensitive Authorities/ });
    fireEvent.click(authoritiesTab);

    expect(screen.getByText(/High-Privilege Security Delegation/)).toBeInTheDocument();
    expect(container.querySelector('.security-callout-banner')).toBeInTheDocument();
    expect(container.querySelector('.platform-textarea')).toBeInTheDocument();
  });

  it('renders Module Marketplace catalog with route and capability mappings', async () => {
    render(
      <MemoryRouter initialEntries={['/platform/entitlements']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="entitlements" element={<PlatformEntitlementsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('ERP Module Marketplace & Capability Catalog'),
    ).toBeInTheDocument();
    expect(screen.getByText('Student Management & Directory')).toBeInTheDocument();
    expect(screen.getByText('School Vault (Zero-Access Security)')).toBeInTheDocument();
  });

  it('renders SaaS Plans and Pricing with INR amounts', async () => {
    render(
      <MemoryRouter initialEntries={['/platform/plans']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="plans" element={<PlatformPlansPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('SaaS Subscription Plans & Billing Tiers')).toBeInTheDocument();
    expect(screen.getByText('Starter Core')).toBeInTheDocument();
    expect(screen.getByText('Complete Institutional ERP')).toBeInTheDocument();
    expect(screen.getByText('1,49,999')).toBeInTheDocument();
  });

  it('renders Universal Role Matrix and Scope explainer', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/platform/roles']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="roles" element={<PlatformRolesPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('Universal Role Templates & Scope Architecture'),
    ).toBeInTheDocument();
    expect(screen.getByText('ORGANIZATION')).toBeInTheDocument();
    expect(screen.getByText('CAMPUS')).toBeInTheDocument();
    expect(screen.getByText('DEPARTMENT')).toBeInTheDocument();
    expect(screen.getByText('ASSIGNED')).toBeInTheDocument();
    expect(screen.getByText('SELF')).toBeInTheDocument();
    expect(screen.getByText('Chief Executive Administrator')).toBeInTheDocument();

    // Verify role cards and capabilities matrix
    expect(container.querySelector('.role-templates-grid')).toBeInTheDocument();
    expect(container.querySelector('.permissions-matrix-table')).toBeInTheDocument();
  });

  it('passes automated accessibility audit with zero WCAG violations', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/platform']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route index element={<PlatformDashboardPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // Wait for content
    await screen.findByText('Executive Control Dashboard');

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('omits Content-Type header on bodyless suspend/reactivate requests and shows inline error without alert() on failure', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const fetchCalls: Array<{
      url: string;
      method: string | undefined;
      contentType: string | null;
    }> = [];
    let shouldFailSuspend = true;

    vi.stubGlobal('fetch', (url: string | URL | { url: string }, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const headers = new Headers(init?.headers || {});
      fetchCalls.push({
        url: u,
        method: init?.method,
        contentType: headers.get('Content-Type'),
      });

      if (u.includes('/suspend')) {
        if (shouldFailSuspend) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ message: 'Simulated suspend failure' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ success: true, data: { id: 'inst-1', status: 'SUSPENDED' } }),
        });
      }
      if (u.includes('/api/v1/platform/institutions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_INSTITUTIONS }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      });
    });

    render(
      <MemoryRouter initialEntries={['/platform/institutions']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="institutions" element={<PlatformInstitutionsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Anesa Demo School');
    const suspendBtns = screen.getAllByRole('button', { name: 'Suspend' });
    fireEvent.click(suspendBtns[0]!);

    const confirmBtn = await screen.findByRole('button', { name: 'Confirm Suspension' });
    fireEvent.click(confirmBtn);

    // Inline error appears and window.alert was NOT called
    expect(await screen.findByRole('alert')).toHaveTextContent('Simulated suspend failure');
    expect(alertSpy).not.toHaveBeenCalled();

    // Loading state resets cleanly so Confirm Suspension is clickable again
    const retryBtn = screen.getByRole('button', { name: 'Confirm Suspension' });
    expect(retryBtn).not.toBeDisabled();

    // Verify no Content-Type: application/json header was sent on bodyless POST /suspend
    const suspendCall = fetchCalls.find((c) => c.url.includes('/suspend'));
    expect(suspendCall).toBeDefined();
    expect(suspendCall?.method).toBe('POST');
    expect(suspendCall?.contentType).toBeNull();

    // Retry succeeds cleanly
    shouldFailSuspend = false;
    fireEvent.click(retryBtn);
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    alertSpy.mockRestore();
  });

  it('shows inline error banners instead of window.alert on PlatformInstitutionDetailPage action failures', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    vi.stubGlobal('fetch', (url: string | URL | { url: string }, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes('/entitlements') && init?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ message: 'Entitlement dependency missing' }),
        });
      }
      if (u.includes('/api/v1/platform/institutions/inst-1')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_INSTITUTION_DETAIL }),
        });
      }
      if (u.includes('/api/v1/platform/catalog/bundles')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_PLAN_BUNDLES }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      });
    });

    render(
      <MemoryRouter initialEntries={['/platform/institutions/inst-1']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="institutions/:id" element={<PlatformInstitutionDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Anesa Demo School' });
    fireEvent.click(screen.getByRole('button', { name: /Module Entitlements/i }));
    // Toggle first module checkbox so Save button is enabled
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);
    const saveBtn = await screen.findByRole('button', { name: /Save & Enforce Entitlements/i });
    fireEvent.click(saveBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent('Entitlement dependency missing');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(saveBtn).not.toBeDisabled();

    alertSpy.mockRestore();
  });

  it('supports First Administrator Onboarding lifecycle (issue, copy, revoke, MFA ticket) on PlatformInstitutionDetailPage', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const mockInviteCode = ['sample', 'invite', 'once'].join('-');
    const mockAcceptUrlObj = new URL('/accept-invite', 'https://campus.example.edu');
    mockAcceptUrlObj.searchParams.set('token', mockInviteCode);
    const mockAcceptUrl = mockAcceptUrlObj.toString();

    let currentDetail = structuredClone(MOCK_INSTITUTION_DETAIL);

    vi.stubGlobal('fetch', (url: string | URL | { url: string }, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes('/first-admin/invite/revoke') && init?.method === 'POST') {
        currentDetail = {
          ...currentDetail,
          firstAdminOnboarding: {
            ...currentDetail.firstAdminOnboarding,
            invitationStatus: 'REVOKED',
            canIssueInvitation: true,
            canRevokeInvitation: false,
          },
        };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { tenantId: 'inst-1', revoked: 1 } }),
        });
      }
      if (u.includes('/first-admin/invite') && init?.method === 'POST') {
        currentDetail = {
          ...currentDetail,
          firstAdminOnboarding: {
            ...currentDetail.firstAdminOnboarding,
            invitationStatus: 'PENDING',
            invitationExpiresAt: '2026-11-28T12:00:00.000Z',
            canIssueInvitation: true,
            canRevokeInvitation: true,
          },
        };
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                tenantId: 'inst-1',
                userId: 'admin-1',
                invitationId: 'inv-1',
                expiresAt: '2026-11-28T12:00:00.000Z',
                reissued: false,
                token: mockInviteCode,
                acceptUrl: mockAcceptUrl,
                emailDelivery: 'NOT_CONFIGURED',
              },
            }),
        });
      }
      if (u.includes('/first-admin/mfa-ticket') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                tenantId: 'inst-1',
                userId: 'admin-1',
                ticketId: 'ticket-1',
                ticket: 'MFA-BOOTSTRAP-ONCE',
                expiresAt: '2026-11-25T18:00:00.000Z',
              },
            }),
        });
      }
      if (u.includes('/api/v1/platform/institutions/inst-1')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: currentDetail }),
        });
      }
      if (u.includes('/api/v1/platform/catalog/bundles')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_PLAN_BUNDLES }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      });
    });

    const { unmount } = render(
      <MemoryRouter initialEntries={['/platform/institutions/inst-1']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="institutions/:id" element={<PlatformInstitutionDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('First Administrator Onboarding')).toBeInTheDocument();
    expect(screen.getByText('principal@anesademo.test')).toBeInTheDocument();
    expect(screen.getByText('Principal')).toBeInTheDocument();
    expect(screen.getByText('Pending Activation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Generate Invitation' }));

    expect(await screen.findByText(mockAcceptUrl)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy Activation Link' }));
    expect(writeText).toHaveBeenCalledWith(mockAcceptUrl);

    const revokeBtn = await screen.findByRole('button', { name: 'Revoke Invitation' });
    fireEvent.click(revokeBtn);
    expect(await screen.findByText(/Revoked 1 unused invitation/i)).toBeInTheDocument();

    // Simulate activated account eligible for MFA bootstrap ticket
    unmount();
    currentDetail = {
      ...currentDetail,
      firstAdminOnboarding: {
        ...currentDetail.firstAdminOnboarding,
        accountStatus: 'ACTIVE',
        activationStatus: 'ACTIVATED',
        invitationStatus: 'ACCEPTED',
        mfaEnrolled: false,
        mfaBootstrapEligible: true,
        canIssueInvitation: false,
        canRevokeInvitation: false,
      },
    };

    render(
      <MemoryRouter initialEntries={['/platform/institutions/inst-1']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="institutions/:id" element={<PlatformInstitutionDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const mfaBtn = await screen.findByRole('button', { name: 'Issue MFA Bootstrap Ticket' });
    fireEvent.click(mfaBtn);
    expect(await screen.findByText('MFA-BOOTSTRAP-ONCE')).toBeInTheDocument();
  });

  it('displays administrator onboarding next-step banner after provisioning an institution', async () => {
    vi.stubGlobal('fetch', (url: string | URL | { url: string }, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes('/api/v1/platform/institutions') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: { id: 'inst-new', name: 'New Pilot School', slug: 'new-pilot' },
            }),
        });
      }
      if (u.includes('/api/v1/platform/institutions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: MOCK_INSTITUTIONS }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      });
    });

    render(
      <MemoryRouter initialEntries={['/platform/institutions']}>
        <Routes>
          <Route path="/platform" element={<PlatformShell />}>
            <Route path="institutions" element={<PlatformInstitutionsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Anesa Demo School');
    fireEvent.click(screen.getByRole('button', { name: '+ Provision New Tenant' }));
    fireEvent.change(screen.getByLabelText(/Institution Legal/i), {
      target: { value: 'New Pilot School' },
    });
    fireEvent.change(screen.getByLabelText(/URL Slug/i), {
      target: { value: 'new-pilot' },
    });
    fireEvent.change(screen.getByLabelText(/First Administrator Work Email/i), {
      target: { value: 'head@newpilot.edu' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Provision Institution' }));

    expect(await screen.findByText('New Pilot School provisioned.')).toBeInTheDocument();
    const onboardingLink = screen.getByRole('link', {
      name: /Manage Administrator Onboarding/i,
    });
    expect(onboardingLink).toHaveAttribute('href', '/platform/institutions/inst-new');
  });
});
