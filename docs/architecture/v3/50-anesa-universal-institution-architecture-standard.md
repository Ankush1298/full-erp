# 50 — Anesa Universal Institution Architecture Standard

**Status:** Canonical Architecture Standard & Mandatory Engineering Requirement (2026-11-13)
**Applicability:** Universal — Every Module, UI Component, API, Permission, Data Schema, and Workflow across Anesa Campus OS.
**Multi-Tenant Model:** Single codebase, shared relational schema, tenant-isolated data, institution-configured business logic.

---

## 1. Executive Mandate

> **ANESA UNIVERSAL INSTITUTION REQUIREMENT**
>
> Every new feature, UI improvement, permission, dashboard, workflow, or security capability must be designed for **School**, **College**, and **University** institutions within the same multi-tenant Anesa architecture.
>
> 1. **Reuse Shared Functionality:** Build unified, high-integrity platform primitives; adapt terminology, academic structures, authorization, and business rules using institution configuration.
> 2. **Beyond Surface Labels:** Never assume that changing a display label alone makes a school workflow suitable for higher education. Structural, legal, and operational rules (e.g., student privacy, credit weighting, GPA vs. marks, prerequisite chains, elective groups) must be genuinely implemented and verified.
> 3. **Universal Compatibility Matrix:** Every implementation report and technical specification must contain a complete **School / College / University Compatibility Matrix**, backed by automated tests verifying the applicable differences.
> 4. **No ERP Duplication:** Do not duplicate entire ERP modules for separate institution tiers.
> 5. **Uncompromised Security:** Never weaken student privacy, tenant isolation, Row-Level Security (RLS), or academic integrity rules to accommodate different institutional workflows.

---

## 2. Institutional Dimensions & Configuration Model

Anesa institutions operate in one of three standardized modes configured in tenant metadata (`app.organizations.institution_type` and `app.organization_settings['institution.type']`):

```typescript
export type InstitutionType = 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';
```

### 2.1 Institutional Hierarchy Matrix

| Structural Level | School (`SCHOOL`) | College (`COLLEGE`) | University (`UNIVERSITY`) |
| :--- | :--- | :--- | :--- |
| **Top Executive Authority** | School Owner / Principal | Principal / Academic Dean | Chancellor / Vice-Chancellor |
| **Administrative Directorate** | Vice Principal / Headmistress | Campus Administrator / Vice Dean | Pro-Vice-Chancellor / Registrar |
| **Admissions & Records** | Admissions Office / Clerk | Registrar's Office | University Registrar / Academic Secretariat |
| **Faculty Division** | Academic Department / Wing | Academic Department / School | Faculty / Collegiate Department |
| **Instructional Staff** | Teacher / Subject Faculty | Lecturer / Assistant Professor | Professor / Chair / Reader |
| **Academic Program** | Standard / Grade / Class Stream | Degree Programme (UG/PG) | Degree / Honours / Doctoral Programme |
| **Cohort Grouping** | Academic Year / Batch | Degree Batch / Semester Group | Matriculation Year / Collegiate Cohort |
| **Enrolment Unit** | Class & Section (e.g., Grade 10-A) | Course Offering / Division | Module Section / Lecture Group |
| **Instructional Unit** | Subject | Course | Module |
| **Student Assignment** | Homework / Daily Assignment | Coursework / Term Paper | Project / Dissertation / Practicum |
| **Evaluation Model** | Continuous Marks & Grades | Credit Weights & Percentages | 10-point Weighted SGPA / CGPA |
| **Student Governance** | Minor Dependent | Young Adult / Independent | Adult Sovereign Scholar |

---

## 3. Structural & Business Rule Differences

### 3.1 Adult Student Privacy Guard (FERPA / GDPR / DPDP Compliance)
- **School (`SCHOOL`):** Students are presumed to be minors under parental/guardian custody. Authorized primary and secondary guardians have full visibility into attendance, homework, report cards, fees, and teacher notes.
- **College (`COLLEGE`) & University (`UNIVERSITY`):** By default, adult students (age $\ge 18$ or enrolled in Higher Education) own their academic, disciplinary, and financial records. Parents and guardians have **zero unauthorized access** (`assertGuardianAccessAuthorized` throws HTTP 403 `ADULT_STUDENT_PRIVACY_RESTRICTED`).
- **Sovereign Consent Delegation:** Adult students may choose to grant explicit, scoped access consent (`ALL`, `ACADEMICS_ONLY`, `FINANCE_ONLY`) via `app.adult_guardian_consents`. Revocation is immediate and permanent until re-consented.

### 3.2 Academic Structure & Enrolment Logic
- **School:** Enrolment is cohort-based and timetable-locked. A student admitted to Grade 10-A takes the mandatory curriculum for Grade 10-A. Subject teachers are assigned to class offerings. Class teachers (`section_class_teachers`) manage pastoral care and daily attendance.
- **College & University:** Enrolment is offering- and credit-based (`course_registrations`). Students register for core modules, departmental electives, and open electives, subject to credit maximums, minimum attendance requirements, and prerequisite completion.

### 3.3 Attendance Systems
- **School:** Daily homeroom/session attendance marked once or twice per day by the Class Teacher, tracking full-day/half-day presence.
- **College & University:** Period-by-period and lecture/lab-specific attendance marked by faculty assignments. Minimum attendance thresholds (e.g., 75%) gate examination eligibility via `app.exam_eligibility_policies`.

### 3.4 Evaluation, Grading & Academic Standing
- **School Formula:**
  $$\text{Percentage} = \frac{\sum \text{Marks Obtained}}{\sum \text{Maximum Marks}} \times 100$$
  Letter grades assigned on standardized school scale ($A+ \ge 90\%$, $A \ge 80\%$, $B \ge 70\%$, $C \ge 60\%$, $D \ge 50\%$, $F < 50\%$).
- **College Formula:**
  Course percentage combined with total credits earned against degree graduation requirements.
- **University Formula (10-Point Weighted SGPA/CGPA):**
  $$\text{SGPA} = \frac{\sum_{i=1}^{n} (\text{Credits}_i \times \text{GradePoints}_i)}{\sum_{i=1}^{n} \text{Credits}_i}$$
  $$\text{CGPA} = \frac{\sum_{j=1}^{m} (\text{SGPA}_j \times \text{SemesterCredits}_j)}{\sum_{j=1}^{m} \text{SemesterCredits}_j}$$

---

## 4. Universal Compatibility Matrix Across All ERP Modules

| Module / Subsystem | School (`SCHOOL`) Implementation | College (`COLLEGE`) Implementation | University (`UNIVERSITY`) Implementation | Automated Verification |
| :--- | :--- | :--- | :--- | :--- |
| **Authentication & Shell** | Displays "Principal", "Teacher", "Class". Shell renders K-12 dashboard. | Displays "Dean / Admin", "Faculty", "Course". Shell renders collegiate dashboard. | Displays "Chancellor / Admin", "Professor", "Module". Shell renders university dashboard. | `role-labels.test.ts`, `me-profile.test.ts` |
| **Admissions & Identity** | Class/Section placement, guardian mandatory, emergency contacts. | Departmental matriculation, optional guardian contact. | Faculty matriculation, adult identity verification, autonomous applicant portal. | `scoped-admissions.test.ts`, `institution-type.test.ts` |
| **Student Privacy** | Guardian access enabled by default for minor welfare. | Adult privacy guard active; guardian blocked without explicit consent. | Adult privacy guard active; student sovereign consent mandatory. | `vault-zero-access.test.ts`, `parent-portal-security.test.ts` |
| **Academics & Enrolment** | Class Teacher pastoral care, section memberships, fixed subject roster. | Programme cohorts, course offerings, elective registration groups. | Multi-faculty offerings, prerequisites, modular credit registrations. | `m3b3-electives-registrations.test.ts`, `class-teachers.test.ts` |
| **Attendance & Timetable** | Homeroom daily attendance, lock policies, class teacher authority. | Period & lab lecture attendance, slot timetables, 75% exam lock. | Lecture, tutorial, seminar attendance with biometric / cryptographic logging. | `m4-attendance-slice1.test.ts`, `m4-attendance-slice2.test.ts` |
| **Homework & Coursework** | Homework assignments, parent visibility, simple file attachment. | Coursework & term papers, individual submissions, grading rubrics. | Research projects, dissertations, capstone defense evaluations. | `homework-workflow.test.ts`, `homework-page.test.tsx` |
| **Examinations & Marks** | Terminal exams, marks-based marksheets, Principal final sign-off. | Mid-term/End-term exams, percentage + credits, Dean sign-off. | Semester modular exams, SGPA/CGPA 10-point transcripts, Senate approval. | `examinations-slice2.test.ts`, `institution-compatibility.test.ts` |
| **Finance & Fees** | Term tuition, transport/bus fees, uniform & meal dues. | Semester tuition, lab fees, hostel/dormitory fees, installment plans. | Modular credits tuition, research endowment fees, semester charges. | `finance-slice1.test.ts`, `payment-gateways.test.ts` |
| **Parent / Guardian Portal** | Complete academic, attendance, fee, and homework monitoring. | Adult consent required; restricted financial or academic views upon grant. | Adult consent required; no unsolicited parental notifications. | `parent-portal-security.test.ts`, `parent-portal-page.test.tsx` |
| **School Vault (Zero-Access)** | School Owner / Principal ISA; CWK scoped to classes and sections. | College Principal / Dean ISA; CWK scoped to course offerings and departments. | University Chancellor ISA; CWK scoped to faculties and modular departments. | `vault-zero-access.test.ts`, `security-center-page.test.tsx` |
| **Recovery Ceremony** | 2-of-3 Quorum (Trustee, Principal, Legal Escrow). | 2-of-3 Quorum (Trustee, Dean, Legal Escrow). | 2-of-3 Quorum (Trustee, Chancellor, Legal Escrow). | `vault-crypto.test.ts`, `vault-zero-access.test.ts` |

---

## 5. Architectural Invariants for Future Development

1. **Schema Unification:** Never create `app.school_students` vs `app.university_students`. Always use unified `app.students` with discriminator `institution_type` on `app.organizations`.
2. **Dynamic UI Rendering:** Client-side components must consume `identity.institutionType` and `terminology` to adapt copy, input constraints, and workflows dynamically.
3. **No Unchecked Assumptions:** Every business rule change must state whether it behaves identically across School, College, and University or adapts according to institutional policy.
4. **Mandatory Report Section:** Every implementation report, audit, and PR rehearsal must include the verified School / College / University compatibility matrix.
