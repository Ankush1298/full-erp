import { resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { parseDate, parseReason } from '../people/validation.js';
import { cohortPeriodScope } from './calendar.service.js';
import {
  assertScoped,
  checkVersion,
  conflict,
  ensureTrusted,
  invalid,
  iso,
  mapDbError,
} from './common.js';
import {
  CLASS_TEACHER_ROLES,
  type ClassTeacherDto,
  type CreateClassTeacherBody,
  type EndClassTeacherBody,
} from './class-teacher.schemas.js';

/**
 * Class (homeroom) teachers of a section (migration 0038, doc 32). Scope is the section's cohort period's programme
 * department and campus, read from the database. Held at all but out of scope, missing or another tenant's ⇒ the same
 * 404; not held ⇒ 403. Writes reuse `academic.faculty.assign` (A2: reason, risk tier 2). Every rule (ACTIVE employee
 * posted on the section's campus, one PRIMARY per section, one PRIMARY section per employee, dates in the term) is in
 * the database guard, so it binds every writer; its plain-English refusals are returned as 409.
 */

const READ = 'academic.program.read';
const ASSIGN = 'academic.faculty.assign';
const lower = (s: string): string => s.toLowerCase();
const uuidOrThrow = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !isUuidV7(v)) throw invalid(`Invalid ${what} ID.`);
  return lower(v);
};

interface Row {
  id: string;
  section_id: string;
  employee_id: string;
  class_teacher_role: ClassTeacherDto['classTeacherRole'];
  valid_from: string;
  valid_to: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const COLS = `id, section_id, employee_id, role AS class_teacher_role, valid_from::text AS valid_from, valid_to::text AS valid_to,
  version, created_at, updated_at`;
const toDto = (r: Row): ClassTeacherDto => ({
  id: r.id,
  sectionId: r.section_id,
  employeeId: r.employee_id,
  classTeacherRole: r.class_teacher_role,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** The section's campus and department (via its cohort period's programme). Missing ⇒ 404. */
async function sectionScope(tx: TenantTx, ctx: TrustedContext, sectionId: string) {
  const r = await tx.query<{ cohort_period_id: string }>(
    `SELECT cohort_period_id FROM app.sections WHERE organization_id = $1 AND id = $2`,
    [ctx.tenantId, sectionId],
  );
  if (!r.rows[0]) throw resourceNotFound();
  const s = await cohortPeriodScope(tx, ctx, r.rows[0].cohort_period_id);
  return { campus_id: s.campusId, department_id: s.departmentId };
}

export class ClassTeacherService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    sectionId: string,
    input: CreateClassTeacherBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    const sid = uuidOrThrow(sectionId, 'section');
    if (!input || typeof input !== 'object') throw invalid('Class teacher payload is required.');
    const employeeId = uuidOrThrow(input.employeeId, 'employee');
    if (!(CLASS_TEACHER_ROLES as readonly string[]).includes(input.classTeacherRole))
      throw invalid('Invalid role.');
    const validFrom = parseDate(input.validFrom, 'validFrom');
    const validTo = input.validTo === undefined ? null : parseDate(input.validTo, 'validTo');
    if (validTo !== null && validTo < validFrom)
      throw invalid('validTo must not be before validFrom.');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, ASSIGN);
    const scope = await sectionScope(tx, ctx, sid);
    await assertScoped(tx, ctx, ASSIGN, scope);

    const emp = await tx.query(
      `SELECT 1 FROM app.employees WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, employeeId],
    );
    if (!emp.rows[0]) throw resourceNotFound();

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.section_class_teachers (id, organization_id, section_id, employee_id, role, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.tenantId, sid, employeeId, input.classTeacherRole, validFrom, validTo],
      );
    } catch (err) {
      mapDbError(err, 'The section already has an open primary class teacher.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.class_teacher.create',
        resourceType: 'section_class_teacher',
        resourceId: id,
        campusId: scope.campus_id,
        departmentId: scope.department_id,
        riskTier: 2,
        reasonText: reason,
        changes: {
          sectionId: { old: null, new: sid },
          employeeId: { old: null, new: employeeId },
          classTeacherRole: { old: null, new: input.classTeacherRole },
          validFrom: { old: null, new: validFrom },
          validTo: { old: null, new: validTo },
        },
      },
      meta,
    );
    return id;
  }

  /** Every class-teacher row of the section, history included (ended rows keep their dates). Staff-only rows (RLS). */
  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    sectionId: string,
  ): Promise<ClassTeacherDto[]> {
    ensureTrusted(ctx);
    const sid = uuidOrThrow(sectionId, 'section');
    await AuthorizationEngine.assert(tx, ctx, READ);
    await assertScoped(tx, ctx, READ, await sectionScope(tx, ctx, sid));
    const r = await tx.query<Row>(
      `SELECT ${COLS} FROM app.section_class_teachers
        WHERE organization_id = $1 AND section_id = $2 ORDER BY valid_from, class_teacher_role, id`,
      [ctx.tenantId, sid],
    );
    return r.rows.map(toDto);
  }

  /** Ends an open assignment on `validTo`. Reassignment = end this one, then create the successor. */
  static async end(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: EndClassTeacherBody,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<ClassTeacherDto> {
    ensureTrusted(ctx);
    const cid = uuidOrThrow(id, 'class teacher');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const validTo = parseDate(input.validTo, 'validTo');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, ASSIGN);
    const probe = await tx.query<{ section_id: string }>(
      `SELECT section_id FROM app.section_class_teachers WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, cid],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    const scope = await sectionScope(tx, ctx, probe.rows[0].section_id);
    await assertScoped(tx, ctx, ASSIGN, scope);

    const r = await tx.query<Row>(
      `SELECT ${COLS} FROM app.section_class_teachers WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, cid],
    );
    const cur = r.rows[0];
    if (!cur) throw resourceNotFound();
    checkVersion(options.expected, cur.version, 'Class teacher');
    if (cur.valid_to !== null) throw conflict('The class teacher assignment has already ended.');
    if (validTo < cur.valid_from) throw invalid('validTo must not be before validFrom.');

    let updated: Row | undefined;
    try {
      const u = await tx.query<Row>(
        `UPDATE app.section_class_teachers SET valid_to = $3 WHERE organization_id = $1 AND id = $2
         RETURNING ${COLS}`,
        [ctx.tenantId, cid, validTo],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'Class teacher conflict.');
    }
    if (!updated) throw resourceNotFound();
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.class_teacher.end',
        resourceType: 'section_class_teacher',
        resourceId: cid,
        campusId: scope.campus_id,
        departmentId: scope.department_id,
        riskTier: 2,
        reasonText: reason,
        changes: { validTo: { old: null, new: validTo } },
      },
      options.meta,
    );
    return toDto(updated);
  }
}
