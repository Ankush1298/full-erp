/**
 * Public-site content. Every claim here was checked against the repository (docs/architecture/v3, the migrations and the
 * routes) on 2026-11-07. Statuses are deliberately conservative: nothing has been piloted with a real institution, and
 * nothing is in production.
 */

export type FeatureStatus = 'available' | 'partial' | 'building' | 'planned';

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  available: 'Available in the current build',
  partial: 'Partly available',
  building: 'In development',
  planned: 'Planned',
};

export const NAV_LINKS = [
  { label: 'Platform', href: '#platform' },
  { label: 'Features', href: '#features' },
  { label: 'Solutions', href: '#solutions' },
  { label: 'Security', href: '#security' },
  { label: 'About', href: '/about' },
  { label: 'FAQ', href: '#faq' },
  { label: 'Contact', href: '#contact' },
] as const;

export const CHALLENGES = [
  {
    problem: 'Student records live in separate places',
    answer:
      'One student record carries programme, term enrolment, guardians, identifiers and documents, with a dated academic timeline that shows what changed and when.',
  },
  {
    problem: 'Administrative work is repeated by hand',
    answer:
      'Guided academic setup, CSV imports with a preview before anything is saved, and a cohort promotion tool replace re-keying the same details each term.',
  },
  {
    problem: 'Academic coordination is complicated',
    answer:
      'Terms, sections, course offerings, electives, timetable slots, teacher assignments and registrations are modelled together, so clashes and capacity limits are caught as they are entered.',
  },
  {
    problem: 'Permissions are inconsistent',
    answer:
      'Access comes from roles with a defined scope: your own records, the classes you teach, or your department, campus or institution. The server decides, not the screen.',
  },
  {
    problem: 'It is hard to see who changed what',
    answer:
      'Sensitive changes are written to an append-only audit trail, and attendance history is designed so a recorded value can only be changed by adding a new revision.',
  },
] as const;

export interface FeatureItem {
  title: string;
  text: string;
  status: FeatureStatus;
}

export const FEATURES: readonly FeatureItem[] = [
  {
    title: 'Student records',
    text: 'Profiles, programme enrolment, guardians, identifiers, status history and an academic timeline.',
    status: 'available',
  },
  {
    title: 'Academic years and terms',
    text: 'Years, terms and cohort periods, with a guided setup checklist before a term goes live.',
    status: 'available',
  },
  {
    title: 'Courses, sections and offerings',
    text: 'Curriculum, sections, offerings, timetable slots, teacher assignments and class teachers.',
    status: 'available',
  },
  {
    title: 'Enrolment and electives',
    text: 'Term enrolment, section placement, elective groups, course registrations and cohort promotion.',
    status: 'available',
  },
  {
    title: 'Organisation management',
    text: 'Campuses, departments, designations, rooms, staff postings, holidays and configurable terminology.',
    status: 'available',
  },
  {
    title: 'Users, invitations and roles',
    text: 'Invite people, accept invitations, and assign scoped roles with a recorded reason.',
    status: 'available',
  },
  {
    title: 'Data imports',
    text: 'Student and faculty CSV imports with validation, duplicate matching and a preview step.',
    status: 'available',
  },
  {
    title: 'Privacy and security controls',
    text: 'Consent records, tenant isolation, role scopes, audit logging and authenticator-app MFA.',
    status: 'available',
  },
  {
    title: 'Documents',
    text: 'Upload and read documents with a restricted class for sensitive files. Needs file storage to be configured for a deployment.',
    status: 'partial',
  },
  {
    title: 'Notifications',
    text: 'In-app notifications and preferences are built. Email delivery depends on a production mail setup that is not in place yet.',
    status: 'partial',
  },
  {
    title: 'Attendance',
    text: 'The database and server foundations exist (class sessions, first marking, revision history), tested on synthetic data only. Staff and student screens, correction, policies and summaries are not built yet.',
    status: 'building',
  },
  {
    title: 'Exams and results',
    text: 'Marks, results and transcripts are on the roadmap, after attendance.',
    status: 'planned',
  },
  {
    title: 'Service requests and helpdesk',
    text: 'Requests such as bonafide certificates, and support tickets, are on the roadmap.',
    status: 'planned',
  },
  {
    title: 'Reports and exports',
    text: 'Institution-wide reporting is on the roadmap.',
    status: 'planned',
  },
];

export const SOLUTIONS = [
  {
    id: 'schools',
    name: 'Schools',
    lead: 'Classes, sections and the people around a child.',
    points: [
      'Grades, sections and streams with class teachers',
      'Guardian contacts kept with data-minimisation rules for minors',
      'Labels such as “Class” and “Term” set to your own wording',
    ],
  },
  {
    id: 'colleges',
    name: 'Colleges',
    lead: 'Programmes, semesters and departments that need to line up.',
    points: [
      'Programmes, cohorts and semester-wise enrolment',
      'Elective baskets with selection limits and capacity',
      'Department-scoped roles for heads of department',
    ],
  },
  {
    id: 'universities',
    name: 'Universities',
    lead: 'Several campuses, one institution, clear boundaries.',
    points: [
      'Campuses and departments under one organisation',
      'Roles limited to a campus or an institution',
      'Academic years and terms managed per campus',
    ],
  },
] as const;

export const STEPS: ReadonlyArray<{ title: string; text: string; note: string }> = [
  {
    title: 'Consultation and setup',
    text: 'We talk through your institution, structure and terminology before anything is configured.',
    note: 'Proposed process',
  },
  {
    title: 'Accounts and access',
    text: 'Authorised administrators are invited, and roles are granted with the scope each person needs.',
    note: 'Supported today',
  },
  {
    title: 'Workflow setup',
    text: 'Organisation, academic years, terms, sections and offerings are set up with the guided checklist.',
    note: 'Supported today',
  },
  {
    title: 'Daily operations',
    text: 'Staff manage records, enrolment and registrations. Attendance marking is still in development.',
    note: 'Partly supported',
  },
  {
    title: 'Review and improvement',
    text: 'The audit trail and the student timeline make it possible to see what changed, and to refine the setup.',
    note: 'Supported today',
  },
];

export const SECURITY_FACTS = [
  {
    title: 'Tenant isolation',
    text: 'Every record belongs to one institution. The database itself enforces that one institution cannot read another’s rows.',
  },
  {
    title: 'Role-based permissions',
    text: 'Permissions are scoped to self, assigned classes, or a department, campus or institution, and checked on the server for every request.',
  },
  {
    title: 'Multi-factor authentication',
    text: 'Authenticator-app codes with recovery codes, required for administrative roles, plus a fresh check before critical actions.',
  },
  {
    title: 'Audit logging',
    text: 'Sensitive changes are recorded in an append-only log that the application cannot edit or delete.',
  },
  {
    title: 'Restricted sensitive operations',
    text: 'Actions such as suspending an account or reading restricted documents need a reason and are always recorded.',
  },
  {
    title: 'Data stewardship',
    text: 'Consent records, data minimisation for minors, and history that is closed out rather than deleted.',
  },
] as const;

export const FAQ = [
  {
    q: 'What is Anesa?',
    a: 'Anesa is a campus management platform for student records, academic structure, enrolment, people and access, with attendance in development. It is built as one system that can serve schools, colleges and universities.',
  },
  {
    q: 'Who is Anesa for?',
    a: 'Schools, colleges and universities that want their records, academics and permissions in one place. It is intended for administrators, teachers and students, and the experience differs by role.',
  },
  {
    q: 'Which features are available today?',
    a: 'Student records, academic setup, enrolment and electives, organisation management, users and roles, imports, and privacy and security controls are built. Documents and notifications are partly built. Attendance is in development, and exams, requests and reporting are planned. The Features section shows the status of each.',
  },
  {
    q: 'How does a demo work?',
    a: 'A demo is a conversation and a walkthrough of the current build using sample data. Requesting one is not open yet: the enquiry form below is ready, but it is not connected to a system that can receive it. Until it is, nothing you type is sent or stored.',
  },
  {
    q: 'Where would our data be hosted?',
    a: 'This has not been finalised. Anesa is built to run in containers and is planned as a cloud-hosted service first. The provider, region and arrangements will be confirmed with an institution before any pilot, and no real institutional data is held today.',
  },
  {
    q: 'How is our data separated from other institutions?',
    a: 'Every record is tagged with its institution and the database refuses to return another institution’s rows. This is tested automatically. It has not been through an independent security audit.',
  },
  {
    q: 'Can a school request a pilot?',
    a: 'A pilot is the intended next step, and the build has not yet been validated with a real school. Interest is welcome and pilot terms are not defined yet. Nothing is promised until they are agreed.',
  },
  {
    q: 'How do we contact the team?',
    a: 'The enquiry form is the intended route. Because it cannot receive messages yet, please use the contact route you already have with the Anesa team.',
  },
] as const;

export const INSTITUTION_TYPES = ['School', 'College', 'University', 'Other'] as const;
export const SIZE_BANDS = [
  'Under 500 students',
  '500 to 2,000 students',
  '2,000 to 10,000 students',
  'Over 10,000 students',
] as const;
export const INTERESTS = [
  'Student records',
  'Academic setup and timetables',
  'Enrolment and electives',
  'Users and roles',
  'Attendance (in development)',
  'Imports from existing data',
  'Security and privacy',
] as const;

/**
 * Live submission is OFF: no backend endpoint, storage, retention policy or notification route has been authorised.
 * See docs/architecture/v3/42-public-website-and-lead-intake.md for what is needed to turn it on.
 */
export const ENQUIRY_LIVE = false;
