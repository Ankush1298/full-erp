import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import {
  FeatureUnavailableState,
  InstitutionSuspendedState,
} from '../src/components/ui/FeatureUnavailableState';
import {
  ApiError,
  isInstitutionSuspended,
  isModuleNotEntitled,
  kindForStatus,
} from '../src/lib/api/errors';
import { MODULE_PREVIEWS, resolveModuleError } from '../src/lib/api/module-state';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const TEST_ADMIN: MeData = {
  tenant_id: 't1',
  user_id: 'u-admin',
  actor_kind: 'STAFF',
  display_name: 'Test Administrator',
  roles: ['COLLEGE_ADMIN'],
  capabilities: [
    'session.read',
    'session.revoke',
    'exam.manage',
    'exam.marks.enter',
    'result.publish',
    'result.read',
    'homework.manage',
    'homework.read',
    'fee.structure.read',
    'fee.structure.manage',
    'fee.dues.read',
    'fee.receipt.read',
    'student.directory.list',
    'attendance.record.read',
    'document.read',
    'document.upload',
  ],
};

describe('Disabled ERP Module UX & FeatureUnavailableState Component', () => {
  describe('Error Classification & Mapping', () => {
    it('correctly maps 403 MODULE_NOT_ENTITLED to module_not_entitled kind', () => {
      const kind = kindForStatus(403, 'MODULE_NOT_ENTITLED');
      expect(kind).toBe('module_not_entitled');

      const err = new ApiError('module_not_entitled', 403, { code: 'MODULE_NOT_ENTITLED' });
      expect(isModuleNotEntitled(err)).toBe(true);
      expect(isInstitutionSuspended(err)).toBe(false);
    });

    it('correctly maps 403 INSTITUTION_SUSPENDED to institution_suspended kind', () => {
      const kind = kindForStatus(403, 'INSTITUTION_SUSPENDED');
      expect(kind).toBe('institution_suspended');

      const err = new ApiError('institution_suspended', 403, { code: 'INSTITUTION_SUSPENDED' });
      expect(isInstitutionSuspended(err)).toBe(true);
      expect(isModuleNotEntitled(err)).toBe(false);
    });

    it('distinguishes generic 403 forbidden and 401 unauthenticated from module errors', () => {
      expect(kindForStatus(403, 'FORBIDDEN')).toBe('forbidden');
      expect(kindForStatus(401, 'UNAUTHENTICATED')).toBe('unauthenticated');

      const forbiddenErr = new ApiError('forbidden', 403, { code: 'FORBIDDEN' });
      expect(isModuleNotEntitled(forbiddenErr)).toBe(false);
      expect(isInstitutionSuspended(forbiddenErr)).toBe(false);
    });

    it('resolves module error states correctly via resolveModuleError', () => {
      const notEntitledErr = new ApiError('module_not_entitled', 403, {
        code: 'MODULE_NOT_ENTITLED',
      });
      const res1 = resolveModuleError(notEntitledErr, 'examinations');
      expect(res1.kind).toBe('not_entitled');
      if (res1.kind === 'not_entitled') {
        expect(res1.moduleName).toBe('Examinations & Results');
      }

      const suspendedErr = new ApiError('institution_suspended', 403, {
        code: 'INSTITUTION_SUSPENDED',
      });
      const res2 = resolveModuleError(suspendedErr, 'examinations');
      expect(res2.kind).toBe('suspended');

      const genericErr = new Error('Network timeout');
      const res3 = resolveModuleError(genericErr, 'examinations');
      expect(res3.kind).toBe('error');
      if (res3.kind === 'error') {
        expect(res3.message).toBe('Network timeout');
      }
    });

    it('has comprehensive capability previews for all 5 enterprise modules', () => {
      expect(MODULE_PREVIEWS.examinations).toBeDefined();
      expect(MODULE_PREVIEWS.homework).toBeDefined();
      expect(MODULE_PREVIEWS.finance).toBeDefined();
      expect(MODULE_PREVIEWS.reports).toBeDefined();
      expect(MODULE_PREVIEWS.documents).toBeDefined();

      for (const [, preview] of Object.entries(MODULE_PREVIEWS)) {
        expect(preview.name).toBeTruthy();
        expect(preview.category).toBeTruthy();
        expect(preview.capabilities.length).toBeGreaterThanOrEqual(4);
      }
    });
  });

  describe('FeatureUnavailableState Component Presentation & Accessibility', () => {
    it('renders the friendly feature not active messaging and capability preview', () => {
      render(
        <MemoryRouter>
          <FeatureUnavailableState moduleKey="examinations" moduleName="Examinations & Results" />
        </MemoryRouter>,
      );

      // Reassuring title
      expect(screen.getByText('This feature is not currently active')).toBeInTheDocument();

      // Clear, positive body copy
      expect(
        screen.getByText(
          /Examinations & Results is available when this module is enabled for your institution/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /Your workspace is working normally — this feature is simply not active right now/,
        ),
      ).toBeInTheDocument();

      // Supporting guidance
      expect(
        screen.getByText(
          /This feature is managed centrally for your institution. You can continue using your available Anesa Campus OS features as normal./,
        ),
      ).toBeInTheDocument();

      // Capability preview card
      expect(screen.getByText(/What's included in Examinations & Results/)).toBeInTheDocument();
      expect(screen.getByText(/Examination Setup & Scheduling/)).toBeInTheDocument();
      expect(screen.getByText(/Review & Publish/)).toBeInTheDocument();

      // Primary buttons
      expect(screen.getByRole('button', { name: 'Back to Dashboard' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Contact Administrator' })).toBeInTheDocument();
    });

    it('never contains raw 403 or raw technical error strings', () => {
      render(
        <MemoryRouter>
          <FeatureUnavailableState moduleKey="finance" moduleName="Fees & Finance Ledger" />
        </MemoryRouter>,
      );

      expect(screen.queryByText(/403/)).not.toBeInTheDocument();
      expect(screen.queryByText(/API forbidden/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/MODULE_NOT_ENTITLED/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
    });

    it('opens contact administrator modal when requested and allows closing', async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <FeatureUnavailableState moduleKey="homework" moduleName="Homework & Coursework" />
        </MemoryRouter>,
      );

      const contactBtn = screen.getByRole('button', { name: 'Contact Administrator' });
      await user.click(contactBtn);

      expect(
        screen.getByRole('heading', { name: 'Contact Campus Administrator' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Module availability is managed by the Anesa Platform team/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/contact your institution's designated administrator/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/subscription tier/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/School Principal, Registrar/i)).not.toBeInTheDocument();

      // Close modal
      const closeBtn = screen.getByRole('button', { name: 'Close' });
      await user.click(closeBtn);

      expect(
        screen.queryByRole('heading', { name: 'Contact Campus Administrator' }),
      ).not.toBeInTheDocument();
    });

    it('passes automated axe accessibility checks with 0 violations', async () => {
      const { container } = render(
        <MemoryRouter>
          <FeatureUnavailableState
            moduleKey="reports"
            moduleName="Institutional Analytics & Reports"
          />
        </MemoryRouter>,
      );

      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('renders InstitutionSuspendedState properly and passes a11y', async () => {
      const { container } = render(
        <MemoryRouter>
          <InstitutionSuspendedState />
        </MemoryRouter>,
      );

      expect(screen.getByText('Institution Access Suspended')).toBeInTheDocument();
      expect(screen.getByText(/records are securely preserved/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Back to Dashboard' })).toBeInTheDocument();

      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('Module Page Integration with 403 MODULE_NOT_ENTITLED', () => {
    it('ExaminationsPage renders FeatureUnavailableState when module is not entitled', async () => {
      const backend = createFakeBackend({ me: TEST_ADMIN, session: true });
      const origFetch = backend.fetch;

      // Mock examinations endpoint to return 403 MODULE_NOT_ENTITLED
      backend.fetch = vi.fn((input: RequestInfo | URL, reqInit?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/v1/examinations')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'MODULE_NOT_ENTITLED',
                  message: 'Examinations module is not enabled for this institution',
                  requestId: 'req-exam-test',
                },
              }),
              { status: 403, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return origFetch(input, reqInit);
      });

      renderApp(backend, '/examinations');

      // Page header is visible
      expect(
        await screen.findByRole('heading', { name: 'Examinations, Marks & Results' }),
      ).toBeInTheDocument();

      // Feature unavailable state is rendered
      expect(await screen.findByText('This feature is not currently active')).toBeInTheDocument();
      expect(
        screen.getByText(/Examinations & Results is available when this module is enabled/),
      ).toBeInTheDocument();

      // No raw error banner
      expect(screen.queryByText(/API forbidden \(403\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/MODULE_NOT_ENTITLED/)).not.toBeInTheDocument();
    });

    it('HomeworkPage renders FeatureUnavailableState when module is not entitled', async () => {
      const backend = createFakeBackend({ me: TEST_ADMIN, session: true });
      const origFetch = backend.fetch;

      backend.fetch = vi.fn((input: RequestInfo | URL, reqInit?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/v1/homework')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'MODULE_NOT_ENTITLED',
                  message: 'Homework module is not entitled',
                  requestId: 'req-hw-test',
                },
              }),
              { status: 403, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return origFetch(input, reqInit);
      });

      renderApp(backend, '/homework');

      expect(
        await screen.findByRole('heading', { name: 'Homework & Assignments' }),
      ).toBeInTheDocument();
      expect(await screen.findByText('This feature is not currently active')).toBeInTheDocument();
      expect(
        screen.getByText(/Homework & Coursework is available when this module is enabled/),
      ).toBeInTheDocument();

      // Does not show raw error
      expect(screen.queryByText(/API forbidden \(403\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/MODULE_NOT_ENTITLED/)).not.toBeInTheDocument();
    });

    it('FeesPage renders FeatureUnavailableState when module is not entitled', async () => {
      const backend = createFakeBackend({ me: TEST_ADMIN, session: true });
      const origFetch = backend.fetch;

      backend.fetch = vi.fn((input: RequestInfo | URL, reqInit?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/v1/finance')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'MODULE_NOT_ENTITLED',
                  message: 'Finance module is not entitled',
                  requestId: 'req-fin-test',
                },
              }),
              { status: 403, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return origFetch(input, reqInit);
      });

      renderApp(backend, '/fees');

      expect(
        await screen.findByRole('heading', { name: 'Fees & Finance Management' }),
      ).toBeInTheDocument();
      expect(await screen.findByText('This feature is not currently active')).toBeInTheDocument();
      expect(
        screen.getByText(/Fees & Finance Ledger is available when this module is enabled/),
      ).toBeInTheDocument();

      expect(screen.queryByText(/API forbidden \(403\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/MODULE_NOT_ENTITLED/)).not.toBeInTheDocument();
    });

    it('ReportsPage renders FeatureUnavailableState when module is not entitled', async () => {
      const backend = createFakeBackend({ me: TEST_ADMIN, session: true });
      const origFetch = backend.fetch;

      backend.fetch = vi.fn((input: RequestInfo | URL, reqInit?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/v1/reports')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'MODULE_NOT_ENTITLED',
                  message: 'Reports module is not entitled',
                  requestId: 'req-rep-test',
                },
              }),
              { status: 403, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return origFetch(input, reqInit);
      });

      renderApp(backend, '/reports');

      expect(
        await screen.findByRole('heading', { name: 'Executive & Administrative Reports' }),
      ).toBeInTheDocument();
      expect(await screen.findByText('This feature is not currently active')).toBeInTheDocument();
      expect(
        screen.getByText(
          /Institutional Analytics & Reports is available when this module is enabled/,
        ),
      ).toBeInTheDocument();

      expect(screen.queryByText(/API forbidden \(403\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/MODULE_NOT_ENTITLED/)).not.toBeInTheDocument();
    });

    it('DocumentsPage renders FeatureUnavailableState when module is not entitled', async () => {
      const backend = createFakeBackend({ me: TEST_ADMIN, session: true });
      const origFetch = backend.fetch;

      backend.fetch = vi.fn((input: RequestInfo | URL, reqInit?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/v1/documents')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'MODULE_NOT_ENTITLED',
                  message: 'Documents module is not entitled',
                  requestId: 'req-doc-test',
                },
              }),
              { status: 403, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return origFetch(input, reqInit);
      });

      renderApp(backend, '/documents');

      expect(await screen.findByRole('heading', { name: 'Document Center' })).toBeInTheDocument();
      expect(await screen.findByText('This feature is not currently active')).toBeInTheDocument();
      expect(
        screen.getByText(/Document Center & Storage is available when this module is enabled/),
      ).toBeInTheDocument();

      expect(screen.queryByText(/API forbidden \(403\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/MODULE_NOT_ENTITLED/)).not.toBeInTheDocument();
    });
  });
});
