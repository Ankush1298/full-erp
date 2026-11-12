# Anesa ERP — Smart Campus OS

A multi-tenant school and campus management platform under active development. The project is being prepared for a controlled first-school pilot, with a focus on secure institutional data handling and practical day-to-day academic and administrative workflows.

> **Pilot status:** This repository is not a declaration of production readiness. The first-school pilot still has operational, privacy, deployment, recovery, and acceptance gates to complete. Use synthetic/test data only until the required reviews and school approvals are complete.

## What the platform is intended to do

Anesa ERP brings core institutional workflows into one application:

- Manage student records, admissions, lifecycle history, and guardian relationships.
- Manage faculty, employees, role assignments, and institutional access.
- Configure academic years, terms, classes/cohorts, courses, sections, and teaching offerings.
- Record and review student attendance, including controlled correction and approval workflows.
- Schedule examinations, enter marks, manage candidate eligibility, and publish results.
- Manage fee structures, student dues, offline payment records, receipts, and reconciliation.
- Provide institution-scoped administrative reports and in-app notifications.

The application is designed as a configurable platform. The first pilot is intentionally narrower than a complete commercial ERP; additional modules can be introduced in later milestones.

## Current implementation snapshot

The following describes the repository's implementation status, not a guarantee that every workflow is ready for a live school.

| Area | Current status |
| --- | --- |
| Student and guardian records | Student lifecycle and guardian relationships are implemented; full pilot-data import and account-model decisions still require validation. |
| Faculty and staff | Employee records, postings, role assignments, and access-management foundations are implemented; some school-specific profile and role workflows remain to be completed. |
| Academics | Academic structure, terms, cohorts, courses, offerings, faculty assignments, and timetable-slot foundations are implemented; the complete school setup journey still needs rehearsal. |
| Attendance | Teacher marking, registers, correction/approval flows, and campus-time-zone handling are implemented and browser-tested. Student self-service attendance remains deferred. |
| Examinations and results | Examination scheduling, marks, eligibility controls, and result workflows have implementation and automated-test coverage. |
| Fees and finance | Fee/dues and offline receipt workflows are implemented. Do not assume an integrated online payment gateway is available. |
| Reporting | Administrative reporting foundations exist; complete school-scoped data export and exit tooling remain pilot-readiness work. |
| Notifications | In-app notification foundations exist. Production email delivery needs configuration and verification; SMS, WhatsApp, and web-push delivery should not be treated as available features. |
| Student/guardian portals | Student login and guardian self-service are not prerequisites for the initial record-focused pilot and are not represented as complete portals. |

For the detailed, evolving status and acceptance criteria, see the [Pilot V1 roadmap](docs/architecture/v3/47-pilot-v1-master-roadmap.md) and [school onboarding/browser rehearsal](docs/architecture/v3/49-school-onboarding-browser-rehearsal-and-pr1.md).

## Architecture and security

The repository uses a modular monolith architecture with a multi-tenant data model. The organization is the tenant boundary, with campus-aware workflows and database-enforced tenant isolation.

Security foundations include:

- Role- and scope-based authorization.
- Database row-level security and tenant-context enforcement.
- Password hashing and multi-factor authentication foundations.
- Audit-oriented workflows for sensitive operations.
- Controlled document and notification service boundaries.
- Automated unit, integration, and security tests.

These are engineering controls, not a certification or a claim of legal compliance. Independent security review, legal review, production hardening, and operational recovery exercises are still required before real school data is used.

Relevant design material is maintained in [docs/architecture/v3](docs/architecture/v3/) and [docs/decisions](docs/decisions/).

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/web` | Web application and user-facing workflows |
| `backend` | API, domain modules, services, and tests |
| `database` | Database migrations and schema-related assets |
| `infrastructure` | Local development and container infrastructure |
| `docs/architecture/v3` | Architecture, decisions, readiness, and pilot roadmap |
| `docs/runbooks` | Operational and development procedures |

## Development requirements

- Node.js **22.12 or newer** (see `.nvmrc` and `package.json`)
- pnpm **10** (the repository pins pnpm 10 through Corepack)
- PostgreSQL 16 for local development, either through the development database helper or Docker

## Local development

From a local clone of the repository:

```bash
corepack enable
corepack pnpm install

# Create a local, git-ignored .env file
infrastructure/scripts/setup-dev.sh

# Start the development database
corepack pnpm dev:db

# In separate terminals, start the API and web application
corepack pnpm dev
corepack pnpm dev:web
```

The API is configured for `http://127.0.0.1:4000` and the web development server for `http://127.0.0.1:5173`. Check the current environment and runbooks if your local setup differs.

For the Docker-based development database option:

```bash
docker compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d
```

## Quality checks

The root workspace exposes these checks:

| Command | Purpose |
| --- | --- |
| `pnpm lint` | ESLint and architecture rules |
| `pnpm format:check` | Prettier formatting check |
| `pnpm typecheck` | TypeScript checks across workspaces |
| `pnpm test:unit` | Backend unit tests |
| `pnpm test:integration` | Backend integration tests |
| `pnpm test:security` | Backend security tests |
| `pnpm check:secrets` | Repository secret scan |
| `pnpm build` | Workspace production builds |
| `pnpm check:bundle` | Web bundle secret/configuration scan |
| `pnpm verify` | Combined verification pipeline |

Run checks after making changes. A passing automated suite does not replace end-to-end school workflow rehearsals or independent security testing.

## Pilot-readiness gates

Before a school uses real personal or student data, the project must complete and document the applicable gates, including:

1. Finalize the pilot's student account model and school onboarding process.
2. Complete production hosting, TLS, secret management, and deployment rehearsal.
3. Automate encrypted backups and demonstrate a successful restore.
4. Complete school-scoped data export and the data handover/exit process.
5. Approve retention, deletion, privacy, and data-processing arrangements with qualified counsel and the participating school.
6. Complete incident-response procedures and independent security review.
7. Rehearse the end-to-end workflows with the school's principal, administrator, and teachers.
8. Obtain the required product-owner and school acceptance sign-offs.

The [Pilot V1 roadmap](docs/architecture/v3/47-pilot-v1-master-roadmap.md) is the source of truth for current task status and dependencies. Do not interpret a feature's presence in the codebase as proof that its full school workflow has been accepted.

## Deferred or future modules

The first pilot does not claim to include every possible ERP module. Areas such as transport, library, hostel, inventory, homework/assignments, advanced HR/payroll, full guardian self-service, and biometric attendance may be considered in later milestones.

Face/biometric attendance is explicitly deferred; see [ADR-016](docs/decisions/ADR-016-face-attendance-deferred.md) if that decision record is present in your checkout.

## Secrets and responsible use

- Never commit passwords, API keys, private certificates, production database URLs, or other secrets.
- Use local environment files that are excluded from Git.
- Follow [the secrets runbook](docs/runbooks/secrets.md).
- Do not upload real student, guardian, employee, or financial data to development or demonstration environments.
- Report security concerns privately to the repository maintainer rather than publishing exploitable details in an issue.

---

**Project:** Anesa ERP / Smart Campus OS  
**Repository:** [Ankush1298/full-erp](https://github.com/Ankush1298/full-erp)
