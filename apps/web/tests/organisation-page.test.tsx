import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ADMIN,
  FACULTY_TEACHER,
  createFakeBackend,
} from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

describe('Organisation Structure & Facilities: Role Visibility & Least Privilege', () => {
  const teacherWithStructureRead = {
    ...FACULTY_TEACHER,
    capabilities: [...FACULTY_TEACHER.capabilities, 'org.structure.read'],
  };

  it('renders Principal administration view with full facility controls for COLLEGE_ADMIN', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    renderApp(b, '/organisation');

    // Dynamic header for Principal
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Organisation Structure & Facilities Administration',
      }),
    ).toBeInTheDocument();

    // Contextual alert banner
    expect(
      screen.getByText(/Institution Administrator \(Principal\):/i),
    ).toBeInTheDocument();

    // Campuses and Departments tabs visible
    expect(screen.getByRole('button', { name: /Campuses/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Departments/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rooms/i })).toBeInTheDocument();

    // Switch to Rooms tab
    const roomsTab = screen.getByRole('button', { name: /Rooms/i });
    await userEvent.click(roomsTab);

    // Add Room button is visible for COLLEGE_ADMIN
    expect(await screen.findByRole('button', { name: 'Add Room' })).toBeInTheDocument();

    // Existing rooms rendered
    expect(screen.getByText('LH-101')).toBeInTheDocument();
  });

  it('renders read-only facilities directory for Teacher (FACULTY) without administrative mutation controls', async () => {
    const b = createFakeBackend({ session: true, me: teacherWithStructureRead });
    renderApp(b, '/organisation');

    // Dynamic header for Teacher
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Campus & Classroom Facilities Directory',
      }),
    ).toBeInTheDocument();

    // Contextual read-only directory banner
    expect(
      screen.getByText(/Teacher \/ Faculty Directory:/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Room provisioning is restricted to Campus Administrators and Principals/i),
    ).toBeInTheDocument();

    // Switch to Rooms tab
    const roomsTab = screen.getByRole('button', { name: /Rooms/i });
    await userEvent.click(roomsTab);

    // Read-only facility directory badge displayed
    expect(await screen.findByText('Read-only facility directory')).toBeInTheDocument();

    // Add Room button is strictly NOT rendered for teacher
    expect(screen.queryByRole('button', { name: 'Add Room' })).not.toBeInTheDocument();

    // Rooms directory is visible for timetable reference
    expect(screen.getByText('LH-101')).toBeInTheDocument();
  });

  it('displays educational explanation and admin action when 0 rooms are registered', async () => {
    // Custom backend with no rooms for camp-1
    const b = createFakeBackend({ session: true, me: ADMIN });
    // Override rooms route to return empty list
    const originalFetch = b.fetch.bind(b);
    b.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/rooms')) {
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    renderApp(b, '/organisation');
    const roomsTab = await screen.findByRole('button', { name: /Rooms/i });
    await userEvent.click(roomsTab);

    // Empty state title and educational explanation
    expect(await screen.findByText('No rooms configured')).toBeInTheDocument();
    expect(screen.getByText(/What are rooms used for\?/i)).toBeInTheDocument();
    expect(screen.getByText(/Who configures rooms\?/i)).toBeInTheDocument();

    // Admin action button visible
    expect(screen.getByRole('button', { name: '+ Create First Campus Room' })).toBeInTheDocument();
  });

  it('displays guidance badge and prevents room creation for faculty when 0 rooms are registered', async () => {
    const b = createFakeBackend({ session: true, me: teacherWithStructureRead });
    const originalFetch = b.fetch.bind(b);
    b.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/rooms')) {
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    renderApp(b, '/organisation');
    const roomsTab = await screen.findByRole('button', { name: /Rooms/i });
    await userEvent.click(roomsTab);

    expect(await screen.findByText('No rooms configured')).toBeInTheDocument();
    expect(screen.getByText('Restricted to Campus Administrators')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Create First Campus Room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Room' })).not.toBeInTheDocument();
  });
});
