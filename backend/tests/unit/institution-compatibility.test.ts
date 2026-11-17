import { describe, expect, it } from 'vitest';
import {
  calculateAcademicStanding,
  getInstitutionTerminology,
} from '../../src/shared/institution/institution-config.js';

describe('Universal Institution Compatibility (Unit)', () => {
  describe('Terminology Configuration', () => {
    it('returns school terminology for SCHOOL', () => {
      const config = getInstitutionTerminology('SCHOOL');
      expect(config.leaderTitle).toBe('Principal');
      expect(config.educatorTitle).toBe('Teacher');
      expect(config.cohortTerm).toBe('Class & Section');
      expect(config.courseTerm).toBe('Subject');
      expect(config.assessmentTerm).toBe('Examination');
      expect(config.assignmentTerm).toBe('Homework');
      expect(config.feeTerm).toBe('School Fees');
      expect(config.gradingScheme).toBe('MARKS_PERCENTAGE');
    });

    it('returns college terminology for COLLEGE', () => {
      const config = getInstitutionTerminology('COLLEGE');
      expect(config.leaderTitle).toBe('Dean / Principal');
      expect(config.educatorTitle).toBe('Lecturer / Assistant Professor');
      expect(config.cohortTerm).toBe('Program & Semester / Batch');
      expect(config.courseTerm).toBe('Course / Paper');
      expect(config.assessmentTerm).toBe('Semester Exam / Mid-term');
      expect(config.assignmentTerm).toBe('Assignment / Coursework');
      expect(config.feeTerm).toBe('Tuition & College Fees');
      expect(config.gradingScheme).toBe('PERCENTAGE_CREDITS');
    });

    it('returns university terminology for UNIVERSITY', () => {
      const config = getInstitutionTerminology('UNIVERSITY');
      expect(config.leaderTitle).toBe('Vice-Chancellor / Chancellor');
      expect(config.educatorTitle).toBe('Professor / Chair');
      expect(config.cohortTerm).toBe('Faculty / Program / Cohort');
      expect(config.courseTerm).toBe('Module / Course');
      expect(config.assessmentTerm).toBe('Comprehensive Assessment');
      expect(config.assignmentTerm).toBe('Coursework / Project');
      expect(config.feeTerm).toBe('University Tuition & Dues');
      expect(config.gradingScheme).toBe('GPA_CGPA');
    });
  });

  describe('Academic Performance & Standing Calculations', () => {
    const scores = [
      { courseId: 'c1', courseName: 'Mathematics', credits: 4, maxMarks: 100, obtainedMarks: 92 },
      {
        courseId: 'c2',
        courseName: 'Computer Science',
        credits: 4,
        maxMarks: 100,
        obtainedMarks: 85,
      },
      { courseId: 'c3', courseName: 'Physics', credits: 3, maxMarks: 100, obtainedMarks: 78 },
      {
        courseId: 'c4',
        courseName: 'English Literature',
        credits: 2,
        maxMarks: 100,
        obtainedMarks: 88,
      },
    ];

    it('computes standard percentage and letter grade for School', () => {
      const result = calculateAcademicStanding('SCHOOL', scores);
      expect(result.scheme).toBe('MARKS_PERCENTAGE');
      expect(result.totalMaxMarks).toBe(400);
      expect(result.totalObtainedMarks).toBe(343);
      expect(result.percentage).toBe(85.75);
      expect(result.letterGrade).toBe('A');
      expect(result.passed).toBe(true);
    });

    it('computes percentage and total credits for College', () => {
      const result = calculateAcademicStanding('COLLEGE', scores);
      expect(result.scheme).toBe('PERCENTAGE_CREDITS');
      expect(result.totalCredits).toBe(13);
      expect(result.percentage).toBe(85.75);
      expect(result.letterGrade).toBe('A');
      expect(result.passed).toBe(true);
    });

    it('computes weighted SGPA / CGPA on 10-point scale for University', () => {
      const result = calculateAcademicStanding('UNIVERSITY', scores);
      expect(result.scheme).toBe('GPA_CGPA');
      expect(result.totalCredits).toBe(13);
      // c1: 92% -> gp 10 * 4 = 40
      // c2: 85% -> gp 9 * 4 = 36
      // c3: 78% -> gp 8 * 3 = 24
      // c4: 88% -> gp 9 * 2 = 18
      // sum = 118 / 13 = 9.08
      expect(result.sgpa).toBe(9.08);
      expect(result.passed).toBe(true);
    });

    it('handles empty scores cleanly', () => {
      const result = calculateAcademicStanding('UNIVERSITY', []);
      expect(result.totalObtainedMarks).toBe(0);
      expect(result.percentage).toBe(0);
      expect(result.letterGrade).toBe('N/A');
    });
  });
});
