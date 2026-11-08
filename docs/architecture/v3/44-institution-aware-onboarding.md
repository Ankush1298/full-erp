# 44 — Institution-aware onboarding (School, College, University)

Status: **foundation implemented, uncommitted (2026-11-07); design and decision sheet for the rest.** No earlier institution-aware onboarding document existed (checked docs 01 to 43; doc 30 is a readiness assessment and doc 35 covers terminology only), so this is the first. M3 is not accepted and M4 is not accepted; nothing here changes either status. Synthetic data only.

## 1. What the repository already had (trace)

| Question                      | Finding                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Institution-type field        | **None.** `app.organizations` has `id, name, slug, status, version`. No column, enum or setting named institution/organization type existed. Doc 30 uses "School (S) / College or University (U)" only as an assessment column.                                                                                                                              |
| Tenant and campus hierarchy   | organization (tenant) → campuses → departments → programmes → cohorts → terms/offerings (docs 02, 08, 24). The same model serves all three types ("labels, not models", unified-platform rule).                                                                                                                                                              |
| Role definitions              | Eight tenant roles, keyed by **code**: STUDENT, FACULTY, STAFF, HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (`role-matrix.ts`, doc 10). `roles.name` is a stored text label; **permissions come only from `role_permissions` rows keyed by role id (seeded from the matrix by code)**.                                                     |
| Grant rules                   | `GRANT_RULES`: only COLLEGE_ADMIN grants COLLEGE_ADMIN; CAMPUS_ADMIN grants DEPARTMENT_ADMIN, HOD, FACULTY, STAFF; DEPARTMENT_ADMIN grants FACULTY, STAFF (doc 06 §5). Every grant is audited (`assignments.ts`).                                                                                                                                            |
| School vs college differences | Schools add the class teacher (`section_class_teachers`, doc 32) and subject teacher (a PRIMARY faculty assignment on an offering, doc 31 §4); both are **assignments, not roles**. Wording differs (Class/Grade/Section vs Programme/Semester/Batch): the `terminology` setting (doc 33 §6, doc 35 §4) with school and college presets in the setup wizard. |
| First administrator           | One-time bootstrap enrollment ticket for the initial COLLEGE_ADMIN (`mfa-bootstrap.ts`); development accounts come from `seed-roles.ts` (local only). No self-service tenant creation or onboarding API exists.                                                                                                                                              |
| Invitations and MFA           | `user.account.invite` (COLLEGE_ADMIN, REGISTRAR) and invitation acceptance (doc 28). MFA (TOTP) is mandatory for HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (`mfa-policy.ts`, ADR-004); CRITICAL actions need a step-up.                                                                                                                  |
| Existing onboarding flow      | The academic setup wizard (doc 35), step 1 "Institution and terminology". It is tenant-internal; it does not create tenants or accounts.                                                                                                                                                                                                                     |

## 2. Display labels versus permission grants

A **role code** is the only thing the server evaluates. Everything in this document that is a name ("Principal", "Teacher") is a display string looked up from the code. The authorization layer does not import it (a unit test reads every file of `shared/authorization` and fails on any reference), and integration tests show that switching the institution type leaves `roles`, `role_permissions`, `role_assignments` and every user's `/auth/me` capabilities byte-identical. `roles.name` is not rewritten either.

## 3. Implemented foundation

| Piece                                                                                                                | Where                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed setting `institution.type` ∈ `SCHOOL`, `COLLEGE`, `UNIVERSITY`, no default (unset = the pre-onboarding names) | `shared/settings/registry.ts`, `institution.ts`. **No migration, no table, no permission**: it is one more key of the existing `organization_settings` store.                                                                                                                                 |
| Who may set it                                                                                                       | `PUT /organization/settings/institution.type`: `org.settings.manage` (CRITICAL, organization scope, COLLEGE_ADMIN only), step-up, `If-Match`, mandatory reason, atomic tier-2 audit `organization.setting.update` (existing behaviour of the settings service).                               |
| Controlled change                                                                                                    | First choice always allowed. Changing a stored value is **409** once any academic year exists (`SettingsService.assertTypeChangeAllowed`). Re-sending the same value is a no-op.                                                                                                              |
| Role display names                                                                                                   | `roleLabelsFor(type)`; returned for the caller's **own** roles by `GET /auth/me` (`institution_type`, `role_labels`) and for all roles by `GET /academics/terminology` (`institutionType`, `roleLabels`). The web shell, home pages and account page show them (`roleLabel(code, identity)`). |
| Selection UI                                                                                                         | "Institution type" form at the top of wizard step 1 (select, reason, step-up, 409 explained). Role names update at the next load.                                                                                                                                                             |

### 3.1 Role mapping (display only)

| Role code        | Not chosen               | SCHOOL (provisional)  | COLLEGE               | UNIVERSITY                   |
| ---------------- | ------------------------ | --------------------- | --------------------- | ---------------------------- |
| STUDENT          | Student                  | Student               | Student               | Student                      |
| FACULTY          | Faculty                  | **Teacher**           | Faculty               | Faculty                      |
| STAFF            | Staff                    | Staff                 | Staff                 | Staff                        |
| HOD              | Head of department       | Head of department    | Head of department    | Head of department           |
| DEPARTMENT_ADMIN | Department administrator | same                  | same                  | same                         |
| CAMPUS_ADMIN     | Campus administrator     | **Vice Principal**    | Campus administrator  | Campus administrator         |
| COLLEGE_ADMIN    | College administrator    | **Principal**         | College administrator | **University administrator** |
| REGISTRAR        | Registrar                | **Admissions office** | Registrar             | Registrar                    |

School labels are **provisional** (OD-I2). Principal is today exactly the organization-wide administrator role (all its grants, no more); no "school administrator" privilege was created. Class Teacher and Subject Teacher stay assignments and are not labelled as roles.

## 4. Dependency-ordered plan

1. **Institution-type selection**: done (§3).
2. **Safe persistence**: done (existing validated, audited settings store; no migration).
3. **Role labels**: done (§3.1).
4. **School role templates (Principal, Vice Principal, Class Teacher, Subject Teacher)**: labels done for the first two (provisional). Real templates (a Principal with narrower reach than COLLEGE_ADMIN, or a separate Vice Principal scope) need new roles or grants: **stopped here**, see OD-I2.
5. **College and university presentation**: done for the labels; a university with constituent colleges needs a scope-name decision (OD-I4).
6. **Terminology**: existing presets stay manual. Next step: pre-fill the school/college/university presets when the type is chosen (display only, no migration); not done.
7. **Secure first-administrator onboarding**: today a bootstrap ticket plus invitation and mandatory MFA. A self-service tenant-creation flow is **not authorised** and was not built (OD-I1).
8. **Audited role assignment**: exists (`role.assignment.grant`, doc 06 §5, tier-2 audit); unchanged. Any new school role must enter `GRANT_RULES` so nobody can grant above their own level.
9. **Controlled type change**: done in its safest form (§3). A migration path after academic data exists is OD-I3.

## 5. Owner decisions still missing

| ID    | Decision                                                                                                                                                                                   | Safe default in force                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| OD-I1 | How a new institution is created and its first administrator provisioned (operator-run bootstrap ticket vs self-service), and who verifies a real school                                   | Operator-run bootstrap only; nothing automatic; no real-school accounts or data accepted |
| OD-I2 | Which role a Principal and a Vice Principal hold; whether a school needs roles with narrower reach than COLLEGE_ADMIN / CAMPUS_ADMIN; whether HOD reads as "Head of department" in schools | Labels only (§3.1), no new grants                                                        |
| OD-I3 | Whether and how the type may change after academic years exist                                                                                                                             | Refused (409)                                                                            |
| OD-I4 | University structure: do constituent colleges become campuses, departments or tenants                                                                                                      | Not modelled; labels only                                                                |
| OD-I5 | Whether choosing a type should pre-fill terminology and show/hide school-only setup steps (class teachers)                                                                                 | Not done; the wizard is unchanged                                                        |

## 6. Tests

`tests/unit/institution-labels.test.ts` (4): the eight codes in every table, base and COLLEGE equal, distinct labels, the authorization layer never references the module. `tests/integration/institution-type.test.ts` (5): unset then SCHOOL with reason and tier-2 audit; every role and no foreign tenant sees it; closed values, reason, authority (campus admin, HOD, faculty and student get 403) and stale version; **roles, grants, assignments and capabilities identical across SCHOOL, COLLEGE and UNIVERSITY**; the "Principal" has exactly the old administrator's reach and a "Teacher" none; 409 after an academic year exists. Web: `role-labels.test.ts` (2) and two wizard tests.
