Smart Campus OS

A modular School ERP platform designed to simplify academic and administrative operations for educational institutions.

Smart Campus OS is a multi-tenant campus management platform being developed to bring essential school operations into one centralized system.

The project is currently being prepared for an initial school pilot. The goal is to deliver a reliable core ERP experience first and expand the platform with additional modules over time.

Project Status

Current stage: Pilot development

The platform has an established backend, web application, authentication system and multiple school-management modules.

Some workflows are implemented but still require complete end-to-end verification with a participating school's real operational requirements and sample data.

This is an evolving product. Not every planned feature is currently available for production use.

Core Modules

The current codebase includes the following areas:

Module| Purpose
Student Management| Student records and lifecycle management
Academic Management| Academic structure, classes, sections and offerings
Attendance| Attendance recording and management
Examinations| Examination and result-related workflows
Fees & Finance| Fee management, dues and offline payment records
Staff & Users| User accounts, roles and access management
Reports| Academic and administrative reporting
Imports| Data import workflows
Notifications| In-app notification foundation
Organisation| Institution and campus management

Note: Module presence does not necessarily mean every workflow is fully verified or production-ready. Features will be enabled for pilot use after the relevant testing and acceptance checks.

Development Approach

The project follows a phased development approach:

1. Establish a secure and reliable platform foundation.
2. Complete the essential school-management workflows.
3. Conduct a pilot with a participating school.
4. Collect feedback from administrators and staff.
5. Improve existing modules and gradually introduce additional capabilities.

The initial pilot focuses on essential school operations rather than attempting to deliver every possible ERP feature at once.

Planned Expansion

Additional capabilities may be introduced in future phases, based on school requirements and pilot feedback.

Potential expansion areas include:

- Transport management
- Library management
- Hostel management
- Homework and assignments
- Parent and student portals
- Online payment integration
- Advanced communication and notification channels

These are future expansion areas, not claims of currently available functionality.

Technology & Architecture

The project uses a modern web application architecture with:

- TypeScript
- Node.js
- React-based web frontend
- PostgreSQL
- Multi-tenant application architecture
- Role-based access control
- Docker-based development infrastructure

The architecture and implementation decisions are documented in:

- "docs/architecture/v3/"
- "docs/decisions/"

Running Locally

Requirements

- Node.js >= 22.12
- pnpm 10
- PostgreSQL 16 or the supported development database setup

Setup

corepack pnpm install

infrastructure/scripts/setup-dev.sh

corepack pnpm dev:db

corepack pnpm dev

To start the web application separately:

corepack pnpm dev:web

Default development addresses:

- API: "http://127.0.0.1:4000"
- Web application: "http://127.0.0.1:5173"

Refer to the project documentation for environment configuration and deployment instructions.

Quality & Security

Security and tenant isolation are important design priorities.

The project includes automated checks for:

- Authentication and authorization
- Tenant isolation
- Application security
- Type checking
- Code formatting and linting
- Unit and integration tests
- Production build validation

Automated test success does not replace a production deployment rehearsal, operational testing or a school pilot acceptance process.

Project Vision

The long-term vision of Smart Campus OS is to provide educational institutions with a centralized, modular and scalable platform for managing their daily operations.

The platform is being developed incrementally, with reliability, practical usability and school feedback guiding its evolution.
