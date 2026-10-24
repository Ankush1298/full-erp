import { describe, expect, it } from 'vitest';
import { CSV_PROBLEM_TEXT, MAX_CELL, MAX_IMPORT_ROWS, parseCsv } from '../src/lib/csv';

describe('parseCsv', () => {
  it('reads a header and rows, with LF or CRLF, a BOM and blank lines', () => {
    const text = '﻿email,admissionNumber\r\na@x.test,A1\n\nb@x.test,A2\r\n';
    expect(parseCsv(text)).toEqual({
      rows: [
        { email: 'a@x.test', admissionNumber: 'A1' },
        { email: 'b@x.test', admissionNumber: 'A2' },
      ],
      problems: [],
    });
  });

  it('handles quoted cells: commas and doubled quotes; a line break inside a cell is refused like the server does', () => {
    const r = parseCsv('a,b\n"x,1","say ""hi"""\n"two,words",z');
    expect(r.problems).toEqual([]);
    expect(r.rows).toEqual([
      { a: 'x,1', b: 'say "hi"' },
      { a: 'two,words', b: 'z' },
    ]);
    // the quoted line break is parsed as part of the cell, then rejected: the server accepts no control characters
    expect(parseCsv('a,b\n"two\nlines",z').problems).toEqual(['control_character']);
  });

  it('pads short rows with empty values and keeps text exactly (no trimming of values)', () => {
    expect(parseCsv('a,b,c\n 1 ,2').rows).toEqual([{ a: ' 1 ', b: '2', c: '' }]);
  });

  it('refuses files the server would refuse, with fixed wording that never quotes the file', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['a,b\n', 'empty'],
      ['a,b\n"open', 'unterminated_quote'],
      ['a,a\n1,2', 'duplicate_column'],
      [',b\n1,2', 'column_name'],
      [`${'n'.repeat(41)}\n1`, 'column_name'],
      [`${Array.from({ length: 13 }, (_, i) => `c${i}`).join(',')}\n1`, 'too_many_columns'],
      [`a\n${'x'.repeat(MAX_CELL + 1)}`, 'cell_too_long'],
      ['a\nx\u0000y', 'control_character'],
      ['a,b\n1,2,3', 'ragged_row'],
      [`a\n${Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => 'x').join('\n')}`, 'too_many_rows'],
    ];
    for (const [text, problem] of cases) {
      const r = parseCsv(text);
      expect(r.problems, JSON.stringify(text.slice(0, 20))).toContain(problem);
      expect(r.rows).toEqual([]);
    }
    expect(Object.values(CSV_PROBLEM_TEXT).join(' ')).not.toMatch(/\{|\$/);
    expect(
      parseCsv(`a\n${Array.from({ length: MAX_IMPORT_ROWS }, () => 'x').join('\n')}`).problems,
    ).toEqual([]);
  });
});
