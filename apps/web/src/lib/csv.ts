/**
 * A small CSV reader for the import wizard (RFC 4180: quoted cells, doubled quotes, CRLF or LF, a leading BOM). It runs in
 * the browser so the server only ever receives rows (docs/architecture/v3/04: the CSV importer is an admin-client concern).
 * The limits mirror the server's (the server enforces them again): they only make a bad file fail early and readably.
 */
export const MAX_IMPORT_ROWS = 1000;
export const MAX_COLUMNS = 12;
export const MAX_COLUMN_NAME = 40;
export const MAX_CELL = 200;

export type CsvProblem =
  | 'empty'
  | 'unterminated_quote'
  | 'too_many_rows'
  | 'too_many_columns'
  | 'column_name'
  | 'duplicate_column'
  | 'cell_too_long'
  | 'control_character'
  | 'ragged_row';

export interface ParsedCsv {
  rows: Record<string, string>[];
  /** Empty when the file can be submitted. Never carries file content. */
  problems: CsvProblem[];
}

/** Splits text into records of cells. Blank lines are skipped. */
function records(text: string): { cells: string[][]; unterminated: boolean } {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const flush = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    flush();
    if (!(row.length === 1 && row[0] === '')) out.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      flush();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
    }
    i++;
  }
  if (cell !== '' || row.length > 0) endRow();
  return { cells: out, unterminated: quoted };
}

/** True when the text holds a control character (C0 or DEL); the server refuses those in every cell and column name. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const { cells, unterminated } = records(text);
  const problems = new Set<CsvProblem>();
  if (unterminated) problems.add('unterminated_quote');
  const [header, ...body] = cells;
  if (!header || body.length === 0) problems.add('empty');
  if (problems.size > 0 || !header) return { rows: [], problems: [...problems] };

  const names = header.map((h) => h.trim());
  if (names.length > MAX_COLUMNS) problems.add('too_many_columns');
  if (names.some((n) => n.length < 1 || n.length > MAX_COLUMN_NAME)) problems.add('column_name');
  if (new Set(names).size !== names.length) problems.add('duplicate_column');
  if (names.some((n) => hasControl(n))) problems.add('control_character');
  if (body.length > MAX_IMPORT_ROWS) problems.add('too_many_rows');
  if (problems.size > 0) return { rows: [], problems: [...problems] };

  const rows: Record<string, string>[] = [];
  for (const line of body) {
    if (line.length > names.length) {
      problems.add('ragged_row');
      continue;
    }
    const row: Record<string, string> = {};
    names.forEach((name, idx) => {
      const value = line[idx] ?? '';
      if (value.length > MAX_CELL) problems.add('cell_too_long');
      if (hasControl(value)) problems.add('control_character');
      row[name] = value;
    });
    rows.push(row);
  }
  return problems.size > 0 ? { rows: [], problems: [...problems] } : { rows, problems: [] };
}

/** Fixed wording for a problem; nothing from the file is quoted back. */
export const CSV_PROBLEM_TEXT: Readonly<Record<CsvProblem, string>> = {
  empty: 'The file needs a header row and at least one data row.',
  unterminated_quote: 'A quoted value is not closed.',
  too_many_rows: `The file has more than ${MAX_IMPORT_ROWS} rows. Split it and import the parts one by one.`,
  too_many_columns: `The file has more than ${MAX_COLUMNS} columns.`,
  column_name: `Every column needs a name of 1 to ${MAX_COLUMN_NAME} characters.`,
  duplicate_column: 'Two columns have the same name.',
  cell_too_long: `A value is longer than ${MAX_CELL} characters.`,
  control_character: 'The file contains control characters.',
  ragged_row: 'A row has more values than the header has columns.',
};
