import type { RowIssue } from './import.common.js';

/**
 * CSV for the error report. One cell is quoted when it holds a comma, quote or line break, and a cell that a spreadsheet
 * would read as a formula (leading `=`, `+`, `-`, `@`, tab or carriage return) is prefixed with an apostrophe, so opening
 * the report can never execute anything. Messages are fixed server text; the only client-chosen text is a column name.
 */
export function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ReportRow {
  rowNo: number;
  errors: readonly RowIssue[];
  warnings: readonly RowIssue[];
}

export const ERROR_REPORT_HEADER = 'row,severity,code,field,message,related_row';

/** Rows without errors or warnings are omitted; order is row number, then errors before warnings, each already sorted. */
export function buildErrorReport(rows: readonly ReportRow[]): string {
  const lines = [ERROR_REPORT_HEADER];
  for (const row of rows) {
    const emit = (severity: 'ERROR' | 'WARNING', issues: readonly RowIssue[]): void => {
      for (const i of issues) {
        lines.push(
          [
            csvCell(row.rowNo),
            severity,
            csvCell(i.code),
            csvCell(i.field ?? ''),
            csvCell(i.message),
            csvCell(i.relatedRow ?? ''),
          ].join(','),
        );
      }
    };
    emit('ERROR', row.errors);
    emit('WARNING', row.warnings);
  }
  return `${lines.join('\r\n')}\r\n`;
}
