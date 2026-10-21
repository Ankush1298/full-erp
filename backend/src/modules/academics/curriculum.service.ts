import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { departmentScopeFilter } from './academic.service.js';
import {
  assertOrgWide,
  assertScoped,
  checkVersion,
  conflict,
  ensureTrusted,
  invalid,
  iso,
  mapDbError,
  text,
} from './common.js';
import {
  COURSE_TYPES,
  CURRICULUM_CATEGORIES,
  type CourseDto,
  type CreateCourseBody,
  type CreateCurriculumCourseBody,
  type CurriculumCourseDto,
  type ListCoursesQuery,
  type ListCurriculumQuery,
  type UpdateCourseBody,
  type UpdateCurriculumCourseBody,
} from './calendar.schemas.js';

type Meta = AuditRequestMeta | undefined;
interface UpdateOptions {
  expected: ExpectedVersion;
  meta?: Meta;
}

const COURSE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/;
const READ_PERMISSION = 'academic.program.read';
const lower = (s: string): string => s.toLowerCase();

/** credits is numeric(4,1): reject anything that is not a multiple of 0.1 instead of silently rounding it. */
function parseCredits(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 99.9) {
    throw invalid('credits must be a number between 0 and 99.9.');
  }
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
    throw invalid('credits must have at most one decimal place.');
  }
  return Math.round(value * 10) / 10;
}

// =============================================================================================
// Courses (catalogue; soft-deletable)
// =============================================================================================
interface CourseRow {
  id: string;
  owning_department_id: string | null;
  code: string;
  title: string;
  credits: string;
  course_type: CourseDto['courseType'];
  tracks_attendance: boolean;
  status: CourseDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
const COURSE_COLS = `id, owning_department_id, code, title, credits, course_type, tracks_attendance, status, version,
                     created_at, updated_at`;
const toCourse = (r: CourseRow): CourseDto => ({
  id: r.id,
  owningDepartmentId: r.owning_department_id,
  code: r.code,
  title: r.title,
  credits: Number(r.credits),
  courseType: r.course_type,
  tracksAttendance: r.tracks_attendance,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/**
 * A course's authorization scope: its owning department (and that department's campus), or ORGANIZATION-wide when it has
 * no owner. Returns null for the org-wide case.
 */
async function courseScope(
  tx: TenantTx,
  ctx: TrustedContext,
  owningDepartmentId: string | null,
): Promise<{ campus_id: string; department_id: string } | null> {
  if (owningDepartmentId === null) return null;
  const r = await tx.query<{ campus_id: string }>(
    `SELECT campus_id FROM app.departments WHERE organization_id = $1 AND id = $2`,
    [ctx.tenantId, owningDepartmentId],
  );
  if (!r.rows[0]) throw resourceNotFound();
  return { campus_id: r.rows[0].campus_id, department_id: owningDepartmentId };
}

async function assertCourseManage(
  tx: TenantTx,
  ctx: TrustedContext,
  owningDepartmentId: string | null,
): Promise<void> {
  const scope = await courseScope(tx, ctx, owningDepartmentId);
  if (scope === null) await assertOrgWide(tx, ctx, 'academic.course.manage');
  else await assertScoped(tx, ctx, 'academic.course.manage', scope);
}

export class CourseService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateCourseBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Course payload is required.');
    const code = text(input.code, 'code', 1, 30, COURSE_CODE_RE);
    const title = text(input.title, 'title', 1, 255);
    const credits = parseCredits(input.credits);
    if (!(COURSE_TYPES as readonly string[]).includes(input.courseType)) {
      throw invalid('courseType is not a valid course type.');
    }
    const tracks = input.tracksAttendance ?? true;
    let departmentId: string | null = null;
    if (input.owningDepartmentId !== undefined) {
      if (!isUuidV7(input.owningDepartmentId)) throw invalid('Invalid owning department ID.');
      departmentId = lower(input.owningDepartmentId);
    }

    await AuthorizationEngine.assert(tx, ctx, 'academic.course.manage');
    await assertCourseManage(tx, ctx, departmentId);
    if (departmentId !== null) {
      const d = await tx.query(
        `SELECT 1 FROM app.departments
          WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE' AND deleted_at IS NULL FOR SHARE`,
        [ctx.tenantId, departmentId],
      );
      if (!d.rows[0]) throw resourceNotFound();
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.courses
           (id, organization_id, owning_department_id, code, title, credits, course_type, tracks_attendance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.tenantId, departmentId, code, title, credits, input.courseType, tracks],
      );
    } catch (err) {
      mapDbError(err, 'A course with this code already exists.');
    }
    const campus =
      departmentId === null ? undefined : (await courseScope(tx, ctx, departmentId))?.campus_id;
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.course.create',
        resourceType: 'course',
        resourceId: id,
        ...(campus !== undefined ? { campusId: campus } : {}),
        ...(departmentId !== null ? { departmentId } : {}),
        riskTier: 1,
        changes: {
          code: { old: null, new: code },
          title: { old: null, new: title },
          credits: { old: null, new: credits },
          courseType: { old: null, new: input.courseType },
          tracksAttendance: { old: null, new: tracks },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListCoursesQuery = {},
  ): Promise<CourseDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const scope = await departmentScopeFilter(tx, ctx, [READ_PERMISSION, 'academic.course.manage']);
    const params: unknown[] = [ctx.tenantId];
    const where = ['organization_id = $1', 'deleted_at IS NULL'];
    if (!scope.orgWide) {
      // Org-wide catalogue entries (no owner) are visible to every reader; owned ones only inside the reader's scope.
      params.push(scope.departmentIds);
      where.push(
        `(owning_department_id IS NULL OR owning_department_id = ANY($${params.length}::uuid[]))`,
      );
    }
    if (filter.departmentId) {
      params.push(filter.departmentId);
      where.push(`owning_department_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    const r = await tx.query<CourseRow>(
      `SELECT ${COURSE_COLS} FROM app.courses WHERE ${where.join(' AND ')} ORDER BY code`,
      params,
    );
    return r.rows.map(toCourse);
  }

  static async getById(tx: TenantTx, ctx: TrustedContext, id: string): Promise<CourseDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid course ID.');
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const r = await tx.query<CourseRow>(
      `SELECT ${COURSE_COLS} FROM app.courses WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.tenantId, lower(id)],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    const scope = await courseScope(tx, ctx, row.owning_department_id);
    if (scope !== null) await assertScoped(tx, ctx, READ_PERMISSION, scope);
    return toCourse(row);
  }

  private static async lockForChange(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
  ): Promise<{ row: CourseRow; scope: { campus_id: string; department_id: string } | null }> {
    await AuthorizationEngine.assert(tx, ctx, 'academic.course.manage');
    const probe = await tx.query<{ owning_department_id: string | null }>(
      `SELECT owning_department_id FROM app.courses WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.tenantId, lower(id)],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    await assertCourseManage(tx, ctx, probe.rows[0].owning_department_id);
    const r = await tx.query<CourseRow>(
      `SELECT ${COURSE_COLS} FROM app.courses
        WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`,
      [ctx.tenantId, lower(id)],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    return { row, scope: await courseScope(tx, ctx, row.owning_department_id) };
  }

  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateCourseBody,
    options: UpdateOptions,
  ): Promise<CourseDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid course ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const { row, scope } = await CourseService.lockForChange(tx, ctx, id);
    checkVersion(options.expected, row.version, 'Course');

    const title = input.title === undefined ? row.title : text(input.title, 'title', 1, 255);
    const credits = input.credits === undefined ? Number(row.credits) : parseCredits(input.credits);
    const courseType = input.courseType ?? row.course_type;
    if (!(COURSE_TYPES as readonly string[]).includes(courseType))
      throw invalid('Invalid courseType.');
    const tracks = input.tracksAttendance ?? row.tracks_attendance;
    const status = input.status ?? row.status;
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (title !== row.title) changes.title = { old: row.title, new: title };
    if (credits !== Number(row.credits))
      changes.credits = { old: Number(row.credits), new: credits };
    if (courseType !== row.course_type)
      changes.courseType = { old: row.course_type, new: courseType };
    if (tracks !== row.tracks_attendance)
      changes.tracksAttendance = { old: row.tracks_attendance, new: tracks };
    if (status !== row.status) changes.status = { old: row.status, new: status };
    if (Object.keys(changes).length === 0) return toCourse(row);

    const u = await tx.query<CourseRow>(
      `UPDATE app.courses SET title = $3, credits = $4, course_type = $5, tracks_attendance = $6, status = $7
        WHERE organization_id = $1 AND id = $2 AND version = $8 RETURNING ${COURSE_COLS}`,
      [ctx.tenantId, row.id, title, credits, courseType, tracks, status, row.version],
    );
    if (!u.rows[0]) throw conflict('Course version mismatch.');
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.course.update',
        resourceType: 'course',
        resourceId: row.id,
        ...(scope ? { campusId: scope.campus_id, departmentId: scope.department_id } : {}),
        riskTier: 1,
        changes,
      },
      options.meta ?? {},
    );
    return toCourse(u.rows[0]);
  }

  /** Soft delete. Refused (409) while any curriculum entry prescribes the course. */
  static async remove(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    options: UpdateOptions,
  ): Promise<void> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid course ID.');
    const { row, scope } = await CourseService.lockForChange(tx, ctx, id);
    checkVersion(options.expected, row.version, 'Course');
    const used = await tx.query(
      `SELECT 1 FROM app.curriculum_courses WHERE organization_id = $1 AND course_id = $2 LIMIT 1`,
      [ctx.tenantId, row.id],
    );
    if (used.rows[0])
      throw conflict('The course is prescribed by a curriculum and cannot be deleted.');
    try {
      const u = await tx.query(
        `UPDATE app.courses SET deleted_at = now()
          WHERE organization_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL`,
        [ctx.tenantId, row.id, row.version],
      );
      if (u.rowCount !== 1) throw conflict('Course version mismatch.');
    } catch (err) {
      if (err instanceof AppError) throw err;
      mapDbError(err, 'The course cannot be deleted.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.course.delete',
        resourceType: 'course',
        resourceId: row.id,
        ...(scope ? { campusId: scope.campus_id, departmentId: scope.department_id } : {}),
        riskTier: 2,
        changes: { code: { old: row.code, new: null } },
      },
      options.meta ?? {},
    );
  }
}

// =============================================================================================
// Curriculum (what a programme prescribes per study period)
// =============================================================================================
interface CurriculumRow {
  id: string;
  program_id: string;
  course_id: string;
  regulation: string;
  period_no: number;
  category: CurriculumCourseDto['category'];
  elective_group_code: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const CC_COLS = `id, program_id, course_id, regulation, period_no, category, elective_group_code, version, created_at, updated_at`;
const toCc = (r: CurriculumRow): CurriculumCourseDto => ({
  id: r.id,
  programId: r.program_id,
  courseId: r.course_id,
  regulation: r.regulation,
  periodNo: r.period_no,
  category: r.category,
  electiveGroupCode: r.elective_group_code,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

async function programScope(tx: TenantTx, ctx: TrustedContext, programId: string) {
  const r = await tx.query<{ department_id: string; campus_id: string }>(
    `SELECT p.department_id, d.campus_id FROM app.programs p
       JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
      WHERE p.organization_id = $1 AND p.id = $2`,
    [ctx.tenantId, programId],
  );
  const row = r.rows[0];
  if (!row) throw resourceNotFound();
  return { campus_id: row.campus_id, department_id: row.department_id };
}

function parseGroupCode(value: unknown, category: string): string | null {
  if (value === undefined || value === null) return null;
  const code = text(value, 'electiveGroupCode', 1, 30);
  if (category !== 'ELECTIVE')
    throw invalid('electiveGroupCode is only allowed for ELECTIVE entries.');
  return code;
}

export class CurriculumService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateCurriculumCourseBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Curriculum payload is required.');
    if (!isUuidV7(input.programId)) throw invalid('Invalid program ID.');
    if (!isUuidV7(input.courseId)) throw invalid('Invalid course ID.');
    const regulation = text(input.regulation, 'regulation', 1, 30);
    if (!Number.isInteger(input.periodNo) || input.periodNo < 1 || input.periodNo > 200) {
      throw invalid('periodNo must be an integer between 1 and 200.');
    }
    if (!(CURRICULUM_CATEGORIES as readonly string[]).includes(input.category)) {
      throw invalid('category is not a valid curriculum category.');
    }
    const group = parseGroupCode(input.electiveGroupCode, input.category);
    const programId = lower(input.programId);
    const courseId = lower(input.courseId);

    await AuthorizationEngine.assert(tx, ctx, 'academic.course.manage');
    const scope = await programScope(tx, ctx, programId);
    await assertScoped(tx, ctx, 'academic.course.manage', scope);

    const program = await tx.query<{ status: string; duration_periods: number }>(
      `SELECT status, duration_periods FROM app.programs WHERE organization_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, programId],
    );
    const p = program.rows[0];
    if (!p) throw resourceNotFound();
    if (p.status !== 'ACTIVE') throw conflict('The program is not ACTIVE.');
    if (input.periodNo > p.duration_periods) {
      throw invalid(`periodNo exceeds the programme duration (${p.duration_periods}).`);
    }
    const course = await tx.query<{ status: string }>(
      `SELECT status FROM app.courses WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE`,
      [ctx.tenantId, courseId],
    );
    if (!course.rows[0]) throw resourceNotFound();
    if (course.rows[0].status !== 'ACTIVE') throw conflict('The course is not ACTIVE.');

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.curriculum_courses
           (id, organization_id, program_id, course_id, regulation, period_no, category, elective_group_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.tenantId, programId, courseId, regulation, input.periodNo, input.category, group],
      );
    } catch (err) {
      mapDbError(err, 'This course is already prescribed for the program, regulation and period.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.curriculum.create',
        resourceType: 'curriculum_course',
        resourceId: id,
        campusId: scope.campus_id,
        departmentId: scope.department_id,
        riskTier: 1,
        changes: {
          programId: { old: null, new: programId },
          courseId: { old: null, new: courseId },
          regulation: { old: null, new: regulation },
          periodNo: { old: null, new: input.periodNo },
          category: { old: null, new: input.category },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListCurriculumQuery,
  ): Promise<CurriculumCourseDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    if (!isUuidV7(filter.programId)) throw invalid('Invalid program ID.');
    await assertScoped(
      tx,
      ctx,
      READ_PERMISSION,
      await programScope(tx, ctx, lower(filter.programId)),
    );
    const params: unknown[] = [ctx.tenantId, lower(filter.programId)];
    const where = ['organization_id = $1', 'program_id = $2'];
    if (filter.regulation !== undefined) {
      params.push(filter.regulation);
      where.push(`regulation = $${params.length}`);
    }
    if (filter.periodNo !== undefined) {
      params.push(filter.periodNo);
      where.push(`period_no = $${params.length}`);
    }
    const r = await tx.query<CurriculumRow>(
      `SELECT ${CC_COLS} FROM app.curriculum_courses WHERE ${where.join(' AND ')}
        ORDER BY regulation, period_no, category, course_id`,
      params,
    );
    return r.rows.map(toCc);
  }

  private static async lockForChange(tx: TenantTx, ctx: TrustedContext, id: string) {
    await AuthorizationEngine.assert(tx, ctx, 'academic.course.manage');
    const probe = await tx.query<{ program_id: string }>(
      `SELECT program_id FROM app.curriculum_courses WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(id)],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    const scope = await programScope(tx, ctx, probe.rows[0].program_id);
    await assertScoped(tx, ctx, 'academic.course.manage', scope);
    const r = await tx.query<CurriculumRow>(
      `SELECT ${CC_COLS} FROM app.curriculum_courses WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, lower(id)],
    );
    if (!r.rows[0]) throw resourceNotFound();
    return { row: r.rows[0], scope };
  }

  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateCurriculumCourseBody,
    options: UpdateOptions,
  ): Promise<CurriculumCourseDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid curriculum entry ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const { row, scope } = await CurriculumService.lockForChange(tx, ctx, id);
    checkVersion(options.expected, row.version, 'Curriculum entry');

    const category = input.category ?? row.category;
    if (!(CURRICULUM_CATEGORIES as readonly string[]).includes(category))
      throw invalid('Invalid category.');
    const group =
      input.electiveGroupCode === undefined
        ? category === 'ELECTIVE'
          ? row.elective_group_code
          : null
        : parseGroupCode(input.electiveGroupCode, category);
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (category !== row.category) changes.category = { old: row.category, new: category };
    if (group !== row.elective_group_code) {
      changes.electiveGroupCode = { old: row.elective_group_code, new: group };
    }
    if (Object.keys(changes).length === 0) return toCc(row);

    let updated: CurriculumRow | undefined;
    try {
      const u = await tx.query<CurriculumRow>(
        `UPDATE app.curriculum_courses SET category = $3, elective_group_code = $4
          WHERE organization_id = $1 AND id = $2 AND version = $5 RETURNING ${CC_COLS}`,
        [ctx.tenantId, row.id, category, group, row.version],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'The curriculum entry conflicts with an existing record.');
    }
    if (!updated) throw conflict('Curriculum entry version mismatch.');
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.curriculum.update',
        resourceType: 'curriculum_course',
        resourceId: row.id,
        campusId: scope.campus_id,
        departmentId: scope.department_id,
        riskTier: 1,
        changes,
      },
      options.meta ?? {},
    );
    return toCc(updated);
  }

  static async remove(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    options: UpdateOptions,
  ): Promise<void> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid curriculum entry ID.');
    const { row, scope } = await CurriculumService.lockForChange(tx, ctx, id);
    checkVersion(options.expected, row.version, 'Curriculum entry');
    const d = await tx.query(
      `DELETE FROM app.curriculum_courses WHERE organization_id = $1 AND id = $2 AND version = $3`,
      [ctx.tenantId, row.id, row.version],
    );
    if (d.rowCount !== 1) throw conflict('Curriculum entry version mismatch.');
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.curriculum.delete',
        resourceType: 'curriculum_course',
        resourceId: row.id,
        campusId: scope.campus_id,
        departmentId: scope.department_id,
        riskTier: 2,
        changes: {
          courseId: { old: row.course_id, new: null },
          regulation: { old: row.regulation, new: null },
          periodNo: { old: row.period_no, new: null },
        },
      },
      options.meta ?? {},
    );
  }
}
