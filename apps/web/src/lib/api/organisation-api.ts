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
