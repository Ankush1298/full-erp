import { Route, Routes } from 'react-router';
import { LoginPage } from './features/auth/LoginPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { RequireAuth, RequireCapability } from './features/auth/guards';
import { HomePage } from './features/home/Homes';
import { AppShell } from './features/shell/AppShell';
import { InformationalShell } from './features/shell/InformationalShell';
import { ROUTE_REQUIREMENTS } from './features/shell/navigation';
import { AccountPage } from './pages/AccountPage';
import { AcademicsPage } from './pages/AcademicsPage';
import { ComingSoonPage } from './pages/ComingSoon';
import { ConsentsPage } from './pages/ConsentsPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { AccessPage } from './pages/AccessPage';
import { UsersPage } from './pages/UsersPage';
import { ImportsPage } from './pages/ImportsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrganisationPage } from './pages/OrganisationPage';
import { NotFoundPage } from './pages/StatePages';
import { StudentProfilePage } from './pages/StudentProfilePage';
import { StudentsPage } from './pages/StudentsPage';
import {
  AboutPage,
  AccessibilityPage,
  ContactPage,
  CookiesPage,
  FaqPage,
  HelpPage,
  PrivacyPage,
  TermsPage,
} from './pages/info';

function Guarded({
  path,
  title,
  description,
}: {
  path: string;
  title: string;
  description: string;
}) {
  return (
    <RequireCapability anyOf={ROUTE_REQUIREMENTS[path] ?? []}>
      <ComingSoonPage title={title} description={description} />
    </RequireCapability>
  );
}

/** Router must be provided by the caller (BrowserRouter in main.tsx, MemoryRouter in tests). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route element={<InformationalShell />}>
        <Route path="about" element={<AboutPage />} />
        <Route path="help" element={<HelpPage />} />
        <Route path="faq" element={<FaqPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="cookies" element={<CookiesPage />} />
        <Route path="accessibility" element={<AccessibilityPage />} />
        <Route path="contact" element={<ContactPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="account" element={<AccountPage />} />
          <Route
            path="notifications"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/notifications'] ?? []}>
                <NotificationsPage />
              </RequireCapability>
            }
          />
          <Route
            path="documents"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/documents'] ?? []}>
                <DocumentsPage />
              </RequireCapability>
            }
          />
          <Route
            path="consents"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/consents'] ?? []}>
                <ConsentsPage />
              </RequireCapability>
            }
          />
          <Route
            path="profile"
            element={
              <Guarded
                path="/profile"
                title="My profile"
                description="Your student profile will be shown here."
              />
            }
          />
          <Route
            path="students"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/students'] ?? []}>
                <StudentsPage />
              </RequireCapability>
            }
          />
          <Route
            path="students/:id"
            element={
              <RequireCapability anyOf={['student.profile.read']}>
                <StudentProfilePage />
              </RequireCapability>
            }
          />
          <Route
            path="organisation"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/organisation'] ?? []}>
                <OrganisationPage />
              </RequireCapability>
            }
          />
          <Route
            path="academics"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/academics'] ?? []}>
                <AcademicsPage />
              </RequireCapability>
            }
          />
          <Route
            path="imports"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/imports'] ?? []}>
                <ImportsPage />
              </RequireCapability>
            }
          />
          <Route
            path="users"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/users'] ?? []}>
                <UsersPage />
              </RequireCapability>
            }
          />
          <Route
            path="access"
            element={
              <RequireCapability anyOf={ROUTE_REQUIREMENTS['/access'] ?? []}>
                <AccessPage />
              </RequireCapability>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
