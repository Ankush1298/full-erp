import { z } from 'zod';
import type { ApiClient } from './client';

export const CampusItemSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      return {
        id: raw.id,
        name: raw.name,
        code: raw.code,
        timezone: raw.timezone,
        status: raw.status,
        version: raw.version,
        created_at: raw.created_at ?? raw.createdAt,
      };
    }
    return val;
  },
  z.object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    timezone: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    version: z.number().optional(),
    created_at: z.string().optional(),
  }),
);

export type CampusItem = z.infer<typeof CampusItemSchema>;

export const ListCampusesResponseSchema = z.preprocess(
  (val: unknown) => {
    if (Array.isArray(val)) return { success: true, data: val };
    return val;
  },
  z.object({
    success: z.boolean().optional().default(true),
    data: z.array(CampusItemSchema),
  }),
);

export const DepartmentItemSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      const campusId = (raw.campus_id ?? raw.campusId) as string;
      return {
        id: raw.id,
        campus_id: campusId,
        campusId,
        name: raw.name,
        code: raw.code,
        status: raw.status,
        version: raw.version,
        created_at: raw.created_at ?? raw.createdAt,
      };
    }
    return val;
  },
  z.object({
    id: z.string(),
    campus_id: z.string(),
    campusId: z.string().optional(),
    name: z.string(),
    code: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    version: z.number().optional(),
    created_at: z.string().optional(),
  }),
);

export type DepartmentItem = z.infer<typeof DepartmentItemSchema>;

export const ListDepartmentsResponseSchema = z.preprocess(
  (val: unknown) => {
    if (Array.isArray(val)) return { success: true, data: val };
    return val;
  },
  z.object({
    success: z.boolean().optional().default(true),
    data: z.array(DepartmentItemSchema),
  }),
);

export function fetchCampuses(client: ApiClient): Promise<CampusItem[]> {
  return client
    .get('/v1/organization/campuses', {
      schema: ListCampusesResponseSchema,
    })
    .then((res) => res.data);
}

export function fetchDepartments(client: ApiClient): Promise<DepartmentItem[]> {
  return client
    .get('/v1/organization/departments', {
      schema: ListDepartmentsResponseSchema,
    })
    .then((res) => res.data);
}

// Canonical room (docs 01 Room, 02 §4.2): code and kind required; name and capacity optional. No status, building or
// floor. `kind` is free text: the specification defines no values.
export const RoomItemSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      return {
        id: raw.id,
        organizationId: raw.organizationId ?? raw.organization_id,
        campusId: raw.campusId ?? raw.campus_id,
        code: raw.code,
        kind: raw.kind,
        name: raw.name ?? null,
        capacity: raw.capacity ?? null,
        version: raw.version,
      };
    }
    return val;
  },
  z.object({
    id: z.string(),
    organizationId: z.string().optional(),
    campusId: z.string().optional(),
    code: z.string(),
    kind: z.string(),
    name: z.string().nullable().optional(),
    capacity: z.number().nullable().optional(),
    version: z.number().optional(),
  }),
);

export type RoomItem = z.infer<typeof RoomItemSchema>;

export const ListRoomsResponseSchema = z.preprocess(
  (val: unknown) => {
    if (Array.isArray(val)) return { success: true, data: val };
    return val;
  },
  z.object({
    success: z.boolean().optional().default(true),
    data: z.array(RoomItemSchema),
  }),
);

export const CreateRoomResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ id: z.string() }),
});

export interface CreateRoomInput {
  code: string;
  kind: string;
  name?: string;
  capacity?: number;
}

export function fetchRooms(client: ApiClient, campusId: string): Promise<RoomItem[]> {
  return client
    .get(`/v1/organization/campuses/${campusId}/rooms`, {
      schema: ListRoomsResponseSchema,
    })
    .then((res) => res.data);
}

export function createRoom(
  client: ApiClient,
  campusId: string,
  input: CreateRoomInput,
): Promise<string> {
  return client
    .post(`/v1/organization/campuses/${encodeURIComponent(campusId)}/rooms`, {
      schema: CreateRoomResponseSchema,
      body: input,
    })
    .then((res) => res.data.id);
}

// ---- organization settings (GET /organization/settings, PUT /organization/settings/:key) ------------------------
const SettingSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  isDefault: z.boolean(),
  version: z.number().nullable(),
  updatedAt: z.string().nullable(),
});
export type SettingRecord = z.infer<typeof SettingSchema>;
export const fetchSettings = (c: ApiClient) =>
  c
    .get('/v1/organization/settings', {
      schema: z.object({ success: z.boolean(), data: z.array(SettingSchema) }),
    })
    .then((r) => r.data);
/** CRITICAL (org.settings.manage): reason required, If-Match = the stored version, "0" while none is stored. */
export const putSetting = (
  c: ApiClient,
  key: string,
  value: unknown,
  reason: string,
  version: number | null,
) =>
  c.put(`/v1/organization/settings/${encodeURIComponent(key)}`, {
    schema: z.object({ success: z.boolean(), data: SettingSchema }),
    body: { value, reason },
    headers: { 'If-Match': `"${version ?? 0}"` },
  });

// ---- setup wizard (Task 8): existing create endpoints ------------------------------------------------------------
const CreatedId = z.object({ success: z.boolean(), data: z.object({ id: z.string() }) });
export const createCampus = (
  c: ApiClient,
  body: { name: string; code: string; timezone: string },
) => c.post('/v1/organization/campuses', { schema: CreatedId, body });
export const createDepartment = (
  c: ApiClient,
  body: { campusId: string; name: string; code: string },
) => c.post('/v1/organization/departments', { schema: CreatedId, body });
export const EmployeeSchema = z.object({
  id: z.string(),
  userId: z.string(),
  employeeCode: z.string(),
  employeeType: z.string(),
  status: z.string(),
});
export type Employee = z.infer<typeof EmployeeSchema>;
export const fetchEmployees = (c: ApiClient) =>
  c
    .get('/v1/faculty/employees', {
      schema: z.object({ success: z.boolean(), data: z.array(EmployeeSchema) }),
    })
    .then((r) => r.data);
export const createEmployee = (
  c: ApiClient,
  body: {
    userId: string;
    employeeCode: string;
    employeeType: string;
    joiningDate: string;
    reason: string;
  },
) => c.post('/v1/faculty/employees', { schema: CreatedId, body });
export const createPosting = (
  c: ApiClient,
  employeeId: string,
  body: { departmentId: string; validFrom: string; isPrimary: boolean; reason: string },
) =>
  c.post(`/v1/faculty/employees/${encodeURIComponent(employeeId)}/postings`, {
    schema: CreatedId,
    body,
  });
