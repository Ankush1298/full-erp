import { z } from 'zod';
import type { ApiClient } from './client';

export const CampusItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  timezone: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  version: z.number().optional(),
  created_at: z.string().optional(),
});

export type CampusItem = z.infer<typeof CampusItemSchema>;

export const ListCampusesResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(CampusItemSchema),
});

export const DepartmentItemSchema = z.object({
  id: z.string(),
  campus_id: z.string(),
  name: z.string(),
  code: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  version: z.number().optional(),
  created_at: z.string().optional(),
});

export type DepartmentItem = z.infer<typeof DepartmentItemSchema>;

export const ListDepartmentsResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(DepartmentItemSchema),
});

export function fetchCampuses(client: ApiClient): Promise<CampusItem[]> {
  return client
    .get('/organization/campuses', {
      schema: ListCampusesResponseSchema,
    })
    .then((res) => res.data);
}

export function fetchDepartments(client: ApiClient): Promise<DepartmentItem[]> {
  return client
    .get('/organization/departments', {
      schema: ListDepartmentsResponseSchema,
    })
    .then((res) => res.data);
}

// Canonical room (docs 01 Room, 02 §4.2): code and kind required; name and capacity optional. No status, building or
// floor. `kind` is free text: the specification defines no values.
export const RoomItemSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  campusId: z.string().optional(),
  code: z.string(),
  kind: z.string(),
  name: z.string().nullable(),
  capacity: z.number().nullable(),
  version: z.number().optional(),
});

export type RoomItem = z.infer<typeof RoomItemSchema>;

export const ListRoomsResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(RoomItemSchema),
});

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
    .get(`/organization/campuses/${campusId}/rooms`, {
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
    .post(`/organization/campuses/${encodeURIComponent(campusId)}/rooms`, {
      schema: CreateRoomResponseSchema,
      body: input,
    })
    .then((res) => res.data.id);
}
