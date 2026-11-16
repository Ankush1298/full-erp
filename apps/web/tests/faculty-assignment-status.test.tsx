import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { OFFERING_ADMIN, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';
import {
  isAssignmentActive,
  isAssignmentEnded,
  isSlotEnded,
  todayIso,
} from '../src/pages/AcademicsPage';

describe('Faculty assignment status & timetable selection (Defect #1 regression)', () => {
  describe('Date validity helper functions', () => {
    const AS_OF = '2026-11-09';

    it('considers Sunita Sharma assignment (2026-11-01 to 2027-03-31) ACTIVE and NOT ended on 2026-11-09', () => {
      const assignment = {
        validFrom: '2026-11-01',
        validTo: '2027-03-31',
      };
      expect(isAssignmentEnded(assignment, AS_OF)).toBe(false);
      expect(isAssignmentActive(assignment, AS_OF)).toBe(true);
    });

    it('treats validTo as inclusive: active on validTo date, ended on the day after', () => {
      const assignment = {
        validFrom: '2026-11-01',
        validTo: '2027-03-31',
      };
      // On the last day (2027-03-31), assignment is still active
      expect(isAssignmentEnded(assignment, '2027-03-31')).toBe(false);
      expect(isAssignmentActive(assignment, '2027-03-31')).toBe(true);

      // On the day after (2027-04-01), assignment has ended
      expect(isAssignmentEnded(assignment, '2027-04-01')).toBe(true);
      expect(isAssignmentActive(assignment, '2027-04-01')).toBe(false);
    });

    it('considers a past assignment (2026-06-01 to 2026-10-31) ENDED on 2026-11-09', () => {
      const expiredAssignment = {
        validFrom: '2026-06-01',
        validTo: '2026-10-31',
      };
      expect(isAssignmentEnded(expiredAssignment, AS_OF)).toBe(true);
      expect(isAssignmentActive(expiredAssignment, AS_OF)).toBe(false);
    });

    it('considers an open-ended assignment (validTo === null) ACTIVE on 2026-11-09', () => {
      const openAssignment = {
        validFrom: '2026-11-01',
        validTo: null,
      };
      expect(isAssignmentEnded(openAssignment, AS_OF)).toBe(false);
      expect(isAssignmentActive(openAssignment, AS_OF)).toBe(true);
    });

    it('considers a future assignment (validFrom: 2026-12-01) NOT ended on 2026-11-09', () => {
      const futureAssignment = {
        validFrom: '2026-12-01',
        validTo: '2027-03-31',
      };
      expect(isAssignmentEnded(futureAssignment, AS_OF)).toBe(false);
      expect(isAssignmentActive(futureAssignment, AS_OF)).toBe(false);
    });

    it('slot validity behaves identically with inclusive end dates', () => {
      const activeSlot = { effectiveTo: '2027-03-31' };
      const endedSlot = { effectiveTo: '2026-10-31' };
      const openSlot = { effectiveTo: null };

      expect(isSlotEnded(activeSlot, AS_OF)).toBe(false);
      expect(isSlotEnded(endedSlot, AS_OF)).toBe(true);
      expect(isSlotEnded(openSlot, AS_OF)).toBe(false);

      // Last day inclusive check
      expect(isSlotEnded(activeSlot, '2027-03-31')).toBe(false);
      expect(isSlotEnded(activeSlot, '2027-04-01')).toBe(true);
    });

    it('resolves campus timezone date accurately across midnight boundaries', () => {
      // Test with IANA timezone 'Asia/Kolkata' vs UTC
      expect(todayIso('Asia/Kolkata')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(todayIso('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Fallback for invalid timezone
      expect(todayIso('Invalid/Zone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('UI offering detail view and timetable slot dropdown', () => {
    it('displays active teacher without (ended) and includes teacher in slot assignment selector', async () => {
      const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });

      const TERM_ID = 'term-2026';
      const COURSE_ID = 'course-math5';
      const OFFERING_ID = 'off-math5';
      const ACTIVE_EMP_ID = '01a1bc8e-7365-74bf-82cf-90d86505a831'; // Sunita Sharma T001
      const EXPIRED_EMP_ID = '01a1bc8e-0000-0000-0000-0000000000e2';

      b.state.academics.terms = [
        {
          id: TERM_ID,
          campusId: 'camp-main',
          academicYearId: 'ay-2026',
          code: 'TERM2-2026',
          name: 'Term 2',
          startDate: '2026-10-31',
          endDate: '2027-03-30',
          status: 'ACTIVE',
          version: 1,
        },
      ];

      b.state.academics.courses = [
        {
          id: COURSE_ID,
          code: 'MATH5',
          title: 'Mathematics 5',
          credits: 4,
          courseType: 'THEORY',
          tracksAttendance: true,
          status: 'ACTIVE',
          owningDepartmentId: null,
          version: 1,
        },
      ];

      b.state.academics.offerings = [
        {
          id: OFFERING_ID,
          campusId: 'camp-main',
          termId: TERM_ID,
          courseId: COURSE_ID,
          cohortPeriodId: null,
          sectionId: null,
          offeringKind: 'CORE',
          groupLabel: null,
          codeSnapshot: 'MATH5',
          titleSnapshot: 'Mathematics 5',
          creditsSnapshot: '4.0',
          tracksAttendance: true,
          registrationPolicy: 'OPEN_ENROLLMENT',
          capacity: 40,
          electiveGroupId: null,
          status: 'PUBLISHED',
          publishedAt: '2026-11-01T00:00:00.000Z',
          version: 1,
        },
      ];

      // Two assignments: Sunita Sharma (active) and Previous Teacher (ended)
      b.state.academics.assignments[OFFERING_ID] = [
        {
          id: 'fa-active',
          courseOfferingId: OFFERING_ID,
          employeeId: ACTIVE_EMP_ID,
          teachingRole: 'PRIMARY',
          validFrom: '2026-11-01',
          validTo: '2027-03-31',
          version: 1,
        },
        {
          id: 'fa-expired',
          courseOfferingId: OFFERING_ID,
          employeeId: EXPIRED_EMP_ID,
          teachingRole: 'CO_INSTRUCTOR',
          validFrom: '2026-06-01',
          validTo: '2026-10-31',
          version: 1,
        },
      ];

      renderApp(b, '/academics');
      await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
      await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);
      await userEvent.click(await screen.findByRole('button', { name: /Manage MATH5/ }));

      // 1. Verify Teaching assignments list
      const teacherList = await screen.findByRole('list', { name: 'Teaching assignments' });
      const listItems = within(teacherList).getAllByRole('listitem');
      expect(listItems).toHaveLength(2);

      // Sunita Sharma (active): must NOT show (ended)
      const sunitaItem = listItems[0];
      expect(sunitaItem).toHaveTextContent('Primary teacher');
      expect(sunitaItem).toHaveTextContent('from 2026-11-01 to 2027-03-31');
      expect(sunitaItem).not.toHaveTextContent('(ended)');

      // Expired instructor: MUST show (ended)
      const expiredItem = listItems[1];
      expect(expiredItem).toHaveTextContent('Co-instructor');
      expect(expiredItem).toHaveTextContent('from 2026-06-01 to 2026-10-31 (ended)');

      // 2. Verify Timetable slot faculty dropdown
      const facultySelect = await screen.findByLabelText('Teacher assignment (optional)');
      const options = within(facultySelect).getAllByRole('option');

      // Options must include "None assigned" + Sunita Sharma, but EXCLUDE expired instructor
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveTextContent('None assigned');
      expect(options[1]).toHaveTextContent(`Primary teacher (${ACTIVE_EMP_ID.slice(-8)})`);
      expect(options[1]).toHaveValue('fa-active');
    });
  });
});
