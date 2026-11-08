import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { renderApp } from './helpers/render';
import { createFakeBackend } from './helpers/fakeBackend';
import { ErrorPage, NotFoundPage, ForbiddenPage } from '../src/pages/StatePages';
import { EmptyState } from '../src/components/ui/EmptyState';
import { ErrorState } from '../src/components/ui/ErrorState';
import { PageHeader } from '../src/components/ui/PageHeader';
import { StatCard } from '../src/components/ui/StatCard';
import { StatusBadge } from '../src/components/ui/StatusBadge';
import { Dialog } from '../src/components/ui/Dialog';

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('StatePages — Canonical Branded Experience', () => {
  it('renders the canonical branded session recovery layout in ErrorPage', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();

    renderWithRouter(<ErrorPage onRetry={onRetry} />);

    // 1. Accessibility: alert role is present
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();

    // 2. Contains brand logo
    expect(screen.getByText('Anesa')).toBeInTheDocument();

    // 3. Warm, friendly coffee-break headline
    expect(
      screen.getByRole('heading', {
        name: /Oops! Your campus took a little coffee break\./i,
      }),
    ).toBeInTheDocument();

    // 4. Non-technical explanation & preserved error title for test compatibility
    expect(alert).toHaveTextContent('Something went wrong');
    expect(screen.getByText(/We couldn't reconnect to your session just now/i)).toBeInTheDocument();

    // 5. Working recovery controls: "Try again" button
    const retryBtn = within(alert).getByRole('button', { name: 'Try again' });
    expect(retryBtn).toBeInTheDocument();
    await user.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // 6. Working recovery controls: "Sign in again" link to /login
    const signInLink = within(alert).getByRole('link', { name: 'Sign in again' });
    expect(signInLink).toBeInTheDocument();
    expect(signInLink).toHaveAttribute('href', '/login');
  });

  it('renders branded NotFoundPage with friendly timetable message', () => {
    renderWithRouter(<NotFoundPage />);

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByText(/Looks like this page missed the timetable!/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  });

  it('renders branded ForbiddenPage with role explanation', () => {
    renderWithRouter(<ForbiddenPage />);

    expect(screen.getByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(screen.getByText('403')).toBeInTheDocument();
    expect(
      screen.getByText(/This area is reserved for another campus role\./i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  });

  it('renders branded NoAccessPage with sign out control', async () => {
    const b = createFakeBackend({ session: true });
    b.state.meMode = 'noaccess';
    renderApp(b, '/');

    expect(await screen.findByRole('heading', { name: 'No access assigned' })).toBeInTheDocument();
    expect(screen.getByText('Anesa')).toBeInTheDocument();
    expect(screen.getByText(/no role has been assigned to your account yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});

describe('Shared UI Primitives', () => {
  it('renders EmptyState with title, description, and action', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();

    renderWithRouter(
      <EmptyState
        title="No students found"
        description="Try adjusting your filters or register a new student."
        action={<button onClick={onAction}>Register student</button>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No students found' })).toBeInTheDocument();
    expect(screen.getByText(/Try adjusting your filters/i)).toBeInTheDocument();
    const actionBtn = screen.getByRole('button', { name: 'Register student' });
    await user.click(actionBtn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('renders ErrorState in-shell with retry action', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();

    renderWithRouter(
      <ErrorState
        title="Unable to load roster"
        message="Could not reach the server to load current attendees."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Unable to load roster')).toBeInTheDocument();
    expect(screen.getByText(/Could not reach the server/i)).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Try again' });
    await user.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders PageHeader with title, subtitle, badge and actions', () => {
    renderWithRouter(
      <PageHeader
        title="Examinations & Results"
        subtitle="Schedule terms, manage papers, and publish grade sheets."
        badge={<StatusBadge status="ACTIVE" />}
        actions={<button>Create Exam</button>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Examinations & Results' })).toBeInTheDocument();
    expect(screen.getByText(/Schedule terms, manage papers/i)).toBeInTheDocument();
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Exam' })).toBeInTheDocument();
  });

  it('renders StatCard with value, helper, and trend', () => {
    renderWithRouter(
      <StatCard
        label="Total Students"
        value="1,248"
        helper="Enrolled across 12 grades"
        trend={{ text: '+5.4% this term', tone: 'positive' }}
        tone="purple"
      />,
    );

    expect(screen.getByText('Total Students')).toBeInTheDocument();
    expect(screen.getByText('1,248')).toBeInTheDocument();
    expect(screen.getByText('Enrolled across 12 grades')).toBeInTheDocument();
    expect(screen.getByText('+5.4% this term')).toBeInTheDocument();
  });

  it('renders Dialog modal and handles close and Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    const { rerender } = renderWithRouter(
      <Dialog
        open={true}
        onClose={onClose}
        title="Confirm Publication"
        description="This will make results visible to all students."
      >
        <p>Are you sure you want to proceed?</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Confirm Publication')).toBeInTheDocument();
    expect(screen.getByText(/This will make results visible/i)).toBeInTheDocument();

    // Close button
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape key
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);

    // Rerender closed
    rerender(
      <Dialog open={false} onClose={onClose} title="Confirm Publication">
        <p>Hidden</p>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
