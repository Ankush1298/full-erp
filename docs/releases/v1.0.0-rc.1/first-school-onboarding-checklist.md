# ANESA CAMPUS OS — FIRST-SCHOOL ONBOARDING CHECKLIST
**Release Candidate**: `v1.0.0-rc.1`
**Target Profile**: K-12 School / Senior Secondary High School (Institutional Type: `SCHOOL`)
**Deployment Model**: Dedicated Tenant Instance / Isolated Multi-Tenant Schema

See also [First Administrator Onboarding Runbook](../../runbooks/first-administrator-onboarding.md).

---

## 1. Pre-Onboarding Institutional Prerequisites

| Step | Action Item | Responsible Party | Verification Criteria | Status |
| :--: | :--- | :--- | :--- | :---: |
| **1.1** | Institutional Profile Collected | Deployment Lead | School legal name, affiliation code, primary address, timezone confirmed (`Asia/Kolkata`). | [ ] |
| **1.2** | Top Executive Appointed | School Management | Principal / Director full name, official institutional email, phone number. | [ ] |
| **1.3** | Domain & Email Verification | IT Admin / Network | Subdomain provisioned (e.g., `school.campusos.internal` or custom domain); SPF/DKIM configured for notifications. | [ ] |
| **1.4** | CSV Ingestion Data Sanitized | Registrar / Admissions | Pupil roster, faculty list, class/section designations pre-validated against template schemas. | [ ] |

---

## 2. Platform Tenant Provisioning & Admin Activation

1. **Create Institution Tenant (Platform Super Admin UI or CLI)**:
   - **Platform Control Center UI** (`/platform/institutions`):
     - Click **`+ Provision New Tenant`**, enter the institution name, slug, type (`SCHOOL`), plan bundle, and first administrator email/designation, then submit **`Provision Institution`**.
     - Follow the **`Manage Administrator Onboarding →`** next-step banner to open the institution detail page (`/platform/institutions/:id`).
   - **Platform CLI** (alternative for scripted/headless environments):
     ```bash
     cd /opt/campusos/backend
     pnpm exec tsx tools/platform/cli.ts tenant:create \
       --name "Greenwood Public School" \
       --slug "greenwood" \
       --institution-type SCHOOL \
       --admin-email "principal@greenwood.edu" \
       --admin-title "Principal"
     ```
   - **Verification**: Outputs Tenant ID, verifies 8 canonical system roles seeded, and displays the first administrator in **First Administrator Onboarding** (`Pending Activation`).

2. **Issue First Administrator Invitation & Copy Activation Link**:
   - **Platform Control Center UI** (`/platform/institutions/:id` -> **First Administrator Onboarding**):
     - Click **`Send Invitation`** (sends via configured `InvitationMailer` SMTP when `SMTP_HOST`/`SMTP_FROM` are configured, and displays the one-time activation link) or **`Generate Invitation`** (copy-link only).
     - Use **`Copy Activation Link`** if SMTP is not configured or out-of-band delivery is preferred.
     - Unused or expired invitations can be **`Revoke Invitation`** or **`Reissue Invitation`** directly from the same panel.
   - **Platform CLI** (alternative):
     ```bash
     pnpm exec tsx tools/platform/cli.ts admin:invite \
       --tenant greenwood
     ```
   - **Verification**: Generates single-use activation URL using configured `APP_ORIGINS` (`https://portal.institution.edu/accept-invite?token=...`).

3. **Principal Activation & MFA Bootstrap Enrollment**:
   - Principal accesses the activation link in browser and sets a strong passphrase (min 12 chars, mixed case, numbers, symbols). Account status transitions to **Activated** (`ACCEPTED`).
   - In **First Administrator Onboarding**, once the account is **Activated**, click **`Issue MFA Bootstrap Ticket`** and share the one-time ticket securely with the Principal.
   - Principal signs in, enters the MFA bootstrap ticket at `/mfa-enroll`, scans the TOTP QR Code using Google Authenticator / Microsoft Authenticator, confirms the initial 6-digit TOTP code, and stores emergency recovery codes.
   - **Verification**: Platform UI **First Administrator Onboarding** reports **Activated**, **`ACCEPTED`**, and **MFA Enrolled**.

---

## 3. Academic Structure & Setup Wizard

The Principal logs in and completes the **Academic Setup Wizard**:

1. **Institution Settings & Terminology**:
   - Selects `SCHOOL` institutional terminology preset:
     - Courses -> **Subjects**
     - Cohorts -> **Classes**
     - Cohort Periods -> **Sections**
     - Head of Department -> **Department Coordinator**
2. **Campus & Facilities**:
   - Confirms "Main Campus" timezone (`Asia/Kolkata`).
   - Defines academic buildings and classrooms/rooms (e.g. `Room 101`, `Physics Lab`, `Library`).
3. **Academic Year & Terms**:
   - Creates Academic Year: e.g. `2026-2027` (Starts: `2026-06-01`, Ends: `2027-05-31`).
   - Configures Terms:
     - `Term 1` (`2026-06-01` to `2026-10-31`, status: `ACTIVE`).
     - `Term 2` (`2026-11-01` to `2027-05-31`, status: `PLANNING`).
4. **Departments & Classes**:
   - Creates Academic Departments: `Science & Mathematics`, `Languages & Humanities`, `Physical Education`.
   - Creates Classes & Sections:
     - `Class IX` -> `Section A`, `Section B`
     - `Class X` -> `Section A`, `Section B`

---

## 4. Staff Onboarding & Role Assignments

1. **Invite Operational Staff**:
   - Academic / Admissions Coordinator -> Role: `REGISTRAR`
   - Department Heads -> Role: `HOD`
   - Teachers / Subject Faculty -> Role: `FACULTY`
   - Accounting & Fee Officer -> Role: `FINANCE_OFFICER` (or `STAFF` with fee permissions)
2. **Assign Class Teachers**:
   - Assign primary Class Teacher to each active Section for attendance ownership and report card generation.

---

## 5. Pupil Admissions & Guardian Linking

1. **Admit Students**:
   - Via UI modal or Bulk CSV Import tool (`/imports`).
   - Records: Legal Full Name, Admission Number, Date of Birth, Gender, Durably Owned Campus (`MAIN`).
   - Enrolls pupils into designated Class & Section for the active Academic Year.
2. **Link Primary Guardians**:
   - Registers Parent / Guardian Name, verified mobile phone, and email.
   - Connects parent record to pupil with specified relationship (`FATHER`, `MOTHER`, `LEGAL_GUARDIAN`).

---

## 6. Daily Operations Verification

| Operational Flow | Action Items | Verified |
| :--- | :--- | :---: |
| **Attendance** | Class teacher marks daily attendance on Section A roster; verifies Present, Absent, and Excused tallies. | [ ] |
| **Homework** | Teacher creates English assignment with PDF attachment; student submits response; teacher reviews. | [ ] |
| **Examinations** | Examination schedule created; 75% attendance threshold evaluated; candidate list frozen; marks entered. | [ ] |
| **School Fees** | Annual tuition fee structure created; student dues generated; offline cash receipt issued; balance decremented. | [ ] |
| **Parent Portal** | Parent signs in; verifies child attendance summary, homework status, and dues balance. | [ ] |
| **Document Center** | Upload pupil birth certificate and transfer certificate; verify antivirus scan Clean and available. | [ ] |

---

## 7. Institutional Sign-Off Gate

- **School Principal Signature**: _______________________  **Date**: ______________
- **Anesa Deployment Lead Signature**: _______________________  **Date**: ______________
- **Pilot Transition Status**: `PILOT_ACTIVE`
