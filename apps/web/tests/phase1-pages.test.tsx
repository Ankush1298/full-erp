import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createFakeBackend, ADMIN, STUDENT } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

describe('Phase 1 Pages (Web Integration)', () => {
  describe('NotificationsPage', () => {
    it('renders notification list and handles mark as read', async () => {
      const b = createFakeBackend({
        session: true,
        me: { ...STUDENT, capabilities: [...STUDENT.capabilities, 'notification.read'] },
      });
      renderApp(b, '/notifications');

      expect(await screen.findByText('Campus Orientation')).toBeInTheDocument();
      expect(screen.getByText('Orientation will be held in Hall A.')).toBeInTheDocument();
      expect(screen.getByText('Unread')).toBeInTheDocument();

      const markBtn = screen.getByRole('button', { name: 'Mark as read' });
      await userEvent.click(markBtn);

      await waitFor(() => {
        expect(screen.queryByText('Unread')).not.toBeInTheDocument();
      });
    });

    it('toggles unread only view', async () => {
      const b = createFakeBackend({
        session: true,
        me: { ...STUDENT, capabilities: [...STUDENT.capabilities, 'notification.read'] },
      });
      renderApp(b, '/notifications');

      const toggleBtn = await screen.findByRole('button', { name: 'Unread only' });
      await userEvent.click(toggleBtn);
      expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument();
    });
  });

  describe('ConsentsPage', () => {
    it('renders active consents and allows withdrawal', async () => {
      const b = createFakeBackend({
        session: true,
        me: { ...STUDENT, capabilities: [...STUDENT.capabilities, 'consent.read'] },
      });
      renderApp(b, '/consents');

      expect(await screen.findByText('DATA PROCESSING')).toBeInTheDocument();
      expect(screen.getByText('GRANTED')).toBeInTheDocument();

      const withdrawBtn = screen.getByRole('button', { name: 'Withdraw consent' });
      await userEvent.click(withdrawBtn);

      expect(await screen.findByText('WITHDRAWN')).toBeInTheDocument();
      expect(screen.getByText('Consent has been withdrawn.')).toBeInTheDocument();
    });
  });

  describe('OrganisationPage', () => {
    it('renders campuses and allows switching to departments tab', async () => {
      const b = createFakeBackend({
        session: true,
        me: ADMIN,
      });
      renderApp(b, '/organisation');

      expect(await screen.findByText('Main Campus')).toBeInTheDocument();
      expect(screen.getByText('MAIN')).toBeInTheDocument();

      const deptTab = screen.getByRole('button', { name: /Departments/ });
      await userEvent.click(deptTab);

      expect(await screen.findByText('Computer Science')).toBeInTheDocument();
      expect(screen.getByText('CS')).toBeInTheDocument();
    });

    it('renders rooms tab and displays rooms list', async () => {
      const b = createFakeBackend({
        session: true,
        me: ADMIN,
      });
      renderApp(b, '/organisation');

      const roomsTab = await screen.findByRole('button', { name: /Rooms/ });
      await userEvent.click(roomsTab);

      expect(await screen.findByText('Lecture Hall 1')).toBeInTheDocument();
      expect(screen.getByText('LH-101')).toBeInTheDocument();
      expect(screen.getByText('Lecture hall')).toBeInTheDocument();
      // optional name/capacity may be absent: the card falls back to the code and shows no capacity row
      expect(screen.getAllByText('LAB-2')).toHaveLength(2); // title fallback + code row
      expect(screen.queryByText(/Building|Floor|ACTIVE|INACTIVE/)).not.toBeInTheDocument();
    });
  });

  describe('DocumentsPage', () => {
    it('renders empty documents state', async () => {
      const b = createFakeBackend({
        session: true,
        me: { ...STUDENT, capabilities: [...STUDENT.capabilities, 'document.read'] },
      });
      renderApp(b, '/documents');

      expect(await screen.findByText('My Documents')).toBeInTheDocument();
      expect(screen.getByText('No documents uploaded')).toBeInTheDocument();
    });
  });
});
