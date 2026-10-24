import { describe, expect, it } from 'vitest';
import {
  buildErrorReport,
  csvCell,
  ERROR_REPORT_HEADER,
} from '../../src/modules/imports/import.csv.js';
import { FileDuplicates, issue, sortIssues } from '../../src/modules/imports/import.common.js';
import { employeeImportAdapter } from '../../src/modules/people/employee-import.adapter.js';
import { studentImportAdapter } from '../../src/modules/students/student-import.adapter.js';

// Pure parts of the import framework: the CSV error report and the shape rules of the two record kinds.

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks and doubles inner quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rlf')).toBe('"cr\rlf"');
    expect(csvCell(12)).toBe('12');
  });

  it('neutralises every leading character a spreadsheet reads as a formula', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const cell = csvCell(`${lead}SUM(A1)`);
      expect(cell.replace(/^"/, '')[0], JSON.stringify(lead)).toBe("'");
    }
    expect(csvCell('safe=1')).toBe('safe=1');
  });
});

describe('buildErrorReport', () => {
  it('has a fixed header, one line per issue, errors before warnings, rows in order, CRLF line ends', () => {
    const text = buildErrorReport([
      { rowNo: 2, errors: [issue('A', 'first', 'f', 1)], warnings: [issue('W', 'warn', 'g')] },
      { rowNo: 5, errors: [], warnings: [issue('W2', 'x,y')] },
    ]);
    expect(text).toBe(
      [
        ERROR_REPORT_HEADER,
        '2,ERROR,A,f,first,1',
        '2,WARNING,W,g,warn,',
        '5,WARNING,W2,,"x,y",',
        '',
      ].join('\r\n'),
    );
  });

  it('is just the header when nothing is wrong', () => {
    expect(buildErrorReport([])).toBe(`${ERROR_REPORT_HEADER}\r\n`);
  });
});

describe('issue helpers', () => {
  it('sortIssues is deterministic and independent of input order', () => {
    const a = issue('B', 'm', 'z');
    const b = issue('A', 'm', 'z');
    const c = issue('A', 'm', 'a');
    expect(sortIssues([a, b, c])).toEqual(sortIssues([c, a, b]));
    expect(sortIssues([a, b, c]).map((i) => `${i.field}${i.code}`)).toEqual(['aA', 'zA', 'zB']);
  });

  it('FileDuplicates reports the FIRST row of a repeated value, per field', () => {
    const d = new FileDuplicates();
    expect(d.seen('email', 'a', 1)).toBeUndefined();
    expect(d.seen('email', 'a', 2)).toBe(1);
    expect(d.seen('email', 'a', 3)).toBe(1);
    expect(d.seen('code', 'a', 4)).toBeUndefined(); // another field is another namespace
  });
});

const codes = (r: { errors: { code: string; field?: string }[] }): string[] =>
  r.errors.map((e) => `${e.code}@${e.field ?? ''}`);

describe('student row shape', () => {
  const ok = {
    email: 'Student@Example.TEST ',
    admissionNumber: ' A-1 ',
    admissionDate: '2024-07-01',
  };
  it('normalises e-mail and admission number and names the exact change', () => {
    const r = studentImportAdapter.parse(ok);
    expect(r.errors).toEqual([]);
    expect(r.proposal).toEqual({
      action: 'CREATE_STUDENT_RECORD',
      email: 'student@example.test',
      admissionNumber: 'A-1',
      admissionDate: '2024-07-01',
      initialStatus: 'ADMITTED',
    });
  });

  it('reports every shape problem at once, ordered by field, and offers no proposal', () => {
    const r = studentImportAdapter.parse({
      email: 'nope',
      admissionNumber: 'bad number',
      admissionDate: '2024-13-01',
      extra: 'x',
    });
    expect(r.proposal).toBeNull();
    expect(codes(r)).toEqual([
      'INVALID_DATE@admissionDate',
      'INVALID_ADMISSION_NUMBER@admissionNumber',
      'INVALID_EMAIL@email',
      'UNKNOWN_COLUMN@extra',
    ]);
    expect(codes(studentImportAdapter.parse({}))).toEqual([
      'REQUIRED@admissionDate',
      'REQUIRED@admissionNumber',
      'REQUIRED@email',
    ]);
    expect(codes(studentImportAdapter.parse({ ...ok, admissionNumber: 'x'.repeat(51) }))).toEqual([
      'INVALID_ADMISSION_NUMBER@admissionNumber',
    ]);
    expect(codes(studentImportAdapter.parse({ ...ok, admissionDate: '1899-12-31' }))).toEqual([
      'INVALID_DATE@admissionDate',
    ]);
    expect(codes(studentImportAdapter.parse({ ...ok, email: 'a b@c.test' }))).toEqual([
      'INVALID_EMAIL@email',
    ]);
  });

  it('never echoes a submitted value in a message', () => {
    const submitted = 'zz-submitted-cell-text';
    const r = studentImportAdapter.parse({
      email: submitted,
      admissionNumber: submitted + ' !',
      admissionDate: submitted,
    });
    expect(JSON.stringify(r.errors)).not.toContain(submitted);
  });
});

describe('employee row shape', () => {
  const ok = {
    email: 'T@Example.test',
    employeeCode: 'E-1',
    employeeType: 'FACULTY',
    joiningDate: '2024-06-01',
  };
  it('accepts the four documented employee types only, exactly spelled', () => {
    expect(employeeImportAdapter.parse(ok).errors).toEqual([]);
    for (const type of ['STAFF', 'ADMIN', 'VISITING']) {
      expect(employeeImportAdapter.parse({ ...ok, employeeType: type }).errors).toEqual([]);
    }
    for (const type of ['faculty', 'Faculty', 'TEACHER', 'ROOT', ' ']) {
      expect(codes(employeeImportAdapter.parse({ ...ok, employeeType: type })).length, type).toBe(
        1,
      );
    }
    expect(employeeImportAdapter.parse(ok).proposal).toMatchObject({
      email: 't@example.test',
      initialStatus: 'ACTIVE',
    });
  });

  it('reports every shape problem at once', () => {
    const r = employeeImportAdapter.parse({
      email: '',
      employeeCode: '-bad',
      employeeType: '',
      joiningDate: 'soon',
      x: '1',
    });
    expect(r.proposal).toBeNull();
    expect(codes(r)).toEqual([
      'REQUIRED@email',
      'INVALID_EMPLOYEE_CODE@employeeCode',
      'REQUIRED@employeeType',
      'INVALID_DATE@joiningDate',
      'UNKNOWN_COLUMN@x',
    ]);
  });
});
