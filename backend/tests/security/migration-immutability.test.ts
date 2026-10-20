import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Migrations 0016-0026 are immutable once accepted (the runner's checksum drift check would refuse a database that
// already applied them). This pins their exact bytes: any edit, including whitespace, fails here and has to be a new
// migration instead. Each hash was computed from the file when it was pinned (0021-0026 were pinned before their commit).
const dir = resolve(import.meta.dirname, '../../../database/migrations');

const PINNED: Record<string, string> = {
  '0016_person_record_exclusivity.sql':
    'b01dcfda665b21d33329ac51bce3f8ea88a03a66554e094f5e4f99624cfb4b15',
  '0017_students_record_fields.sql':
    '1c7ed43919dd68ab3adba91efb753bcc6b7b751a6b10d875c44704bc6df6a585',
  '0018_idempotency_keys.sql': 'b58a1c1f58aa18301dd4e42ee8ecfbb7fe6997aff897f26e3dbb8af824716f3d',
  '0019_students_required_dates_contract.sql':
    '1076131800da137926df1087f86c50a6869e754252ccfd5d9ae2a07963b19b76',
  '0020_student_staff_role_exclusivity.sql':
    '570e932067a8bcf1a2e75ded4521eebd457589ba43e3c4d073b7eb15a58f7435',
  '0021_student_programs.sql': 'a494d6c1b9d928783a0af04a054ac171d3c86c10599b10720113dae4c295758d',
  '0022_student_program_assign_permission.sql':
    'f3fcb55cb77dc02152554fe21175b7f594177cf08e04ac9210f294c4be79be44',
  '0023_student_directory_search_permission.sql':
    'f79068eb5b82b3508b54dcfa4434050fd50d83c554f98a3f8f5746b9be46956e',
  '0024_student_directory_list_permission.sql':
    '056cc499b8c8ba10b6fab77df12fc19fb014863ee2335788a78bf94d8af1f669',
  '0025_student_status_change_permission.sql':
    'b892e3b58d55cf92c7d3d5a9bbed93ff79186593e211ceae8e80f2e70ef7f82b',
  '0026_student_status_transition_guard.sql':
    '1dca9e2eedc7d43cc442594d045c4d6a0c39e29e9dbcc9b16011119c0904dfb3',
};

describe('pushed migrations are immutable', () => {
  it.each(Object.entries(PINNED))('%s is byte-identical to the committed file', (file, sha256) => {
    const actual = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex');
    expect(actual).toBe(sha256);
  });
});
