/**
 * Institution type and the role names shown for it (doc 44).
 *
 * DISPLAY ONLY. A role's CODE (`roles.code`, the key of `ROLE_MATRIX`) is the only thing that carries permissions. Nothing in
 * this file is read by the authorization engine, the role matrix or any permission check, and a label can never add, remove
 * or widen a grant. Changing the institution type changes the words on screen and nothing else.
 *
 * The labels for SCHOOL are PROVISIONAL, pending the owner's confirmation of which role a school's Principal and Vice
 * Principal hold (doc 44 §5, decision OD-I2). "Class Teacher" and "Subject Teacher" are not roles: they are assignments
 * (`section_class_teachers`, a PRIMARY faculty assignment on an offering) and are not labelled here.
 */
export const INSTITUTION_TYPES = ['SCHOOL', 'COLLEGE', 'UNIVERSITY'] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];
export const INSTITUTION_TYPE_KEY = 'institution.type';

export function isInstitutionType(v: unknown): v is InstitutionType {
  return typeof v === 'string' && (INSTITUTION_TYPES as readonly string[]).includes(v);
}

/** What every institution sees until it chooses a type (the labels the product used before onboarding existed). */
export const BASE_ROLE_LABELS: Readonly<Record<string, string>> = {
  STUDENT: 'Student',
  FACULTY: 'Faculty',
  STAFF: 'Staff',
  HOD: 'Head of department',
  DEPARTMENT_ADMIN: 'Department administrator',
  CAMPUS_ADMIN: 'Campus administrator',
  COLLEGE_ADMIN: 'College administrator',
  REGISTRAR: 'Registrar',
};

const OVERRIDES: Readonly<Record<InstitutionType, Readonly<Record<string, string>>>> = {
  SCHOOL: {
    FACULTY: 'Teacher',
    COLLEGE_ADMIN: 'Principal',
    CAMPUS_ADMIN: 'Vice Principal',
    REGISTRAR: 'Admissions office',
  },
  COLLEGE: {},
  UNIVERSITY: { COLLEGE_ADMIN: 'University administrator' },
};

/** Role code -> display label for an institution type (`null` = not chosen yet = the base labels). */
export function roleLabelsFor(type: InstitutionType | null): Record<string, string> {
  return { ...BASE_ROLE_LABELS, ...(type ? OVERRIDES[type] : {}) };
}
