import { isApiError, isModuleNotEntitled, isInstitutionSuspended } from './errors';

export interface ModuleCapability {
  title: string;
  description: string;
  badge?: string;
}

export interface ModulePreviewConfig {
  key: string;
  name: string;
  category: string;
  badge?: string;
  capabilities: ModuleCapability[];
}

export const MODULE_PREVIEWS: Record<string, ModulePreviewConfig> = {
  examinations: {
    key: 'examinations',
    name: 'Examinations & Results',
    category: 'Assessment & Evaluation',
    badge: 'Enterprise Add-On',
    capabilities: [
      {
        title: 'Examination Setup & Scheduling',
        description: 'Define assessment structures, evaluation schemes, exam dates, paper timetables, and room allocations.',
      },
      {
        title: 'Eligibility & Candidate Management',
        description: 'Automated attendance thresholds, fee clearances, hall ticket issuance, and Principal override tracking.',
      },
      {
        title: 'Marks Entry',
        description: 'Subject-wise teacher grade capture, rubrics assessment, draft saves, and offline moderation verification.',
      },
      {
        title: 'Review & Publish',
        description: 'Step-up MFA verified publication, multi-stage approval checks, and tamper-resistant grade locks.',
      },
      {
        title: 'Marks Register',
        description: 'Institutional grade books, course statistics, cohort performance rankings, and compliance transcripts.',
      },
      {
        title: 'Student Results',
        description: 'Accessible report cards, multi-tier letter grades, SGPA/CGPA calculations, and parent portal sync.',
      },
    ],
  },
  homework: {
    key: 'homework',
    name: 'Homework & Coursework',
    category: 'Learning Management',
    badge: 'Academic Add-On',
    capabilities: [
      {
        title: 'Homework Setup & Class Distribution',
        description: 'Assign coursework across sections, target specific syllabus topics, and set clear submission windows.',
      },
      {
        title: 'Document Attachments & Resources',
        description: 'Attach reference study materials, PDFs, worksheet rubrics, and educational media securely.',
      },
      {
        title: 'Student Submission Tracking',
        description: 'Track real-time student uploads, submission timelines, status history, and late flag auditing.',
      },
      {
        title: 'Teacher Review & Evaluation',
        description: 'Evaluate submitted work with custom feedback notes, numerical scores, and revision requests.',
      },
      {
        title: 'Class Progress & Completion Audits',
        description: 'Holistic class completion analytics, section-wise submissions rates, and learning progress monitoring.',
      },
      {
        title: 'Parent Portal Sync',
        description: 'Keep guardians informed of assigned tasks, upcoming deadlines, and evaluated coursework scores.',
      },
    ],
  },
  finance: {
    key: 'finance',
    name: 'Fees & Finance Ledger',
    category: 'Institutional Finance',
    badge: 'Core Ledger Add-On',
    capabilities: [
      {
        title: 'Multi-Tier Fee Structures',
        description: 'Configure tuition, laboratory, transport, sports, and recurring academic fee components.',
      },
      {
        title: 'Student Dues & Demand Generation',
        description: 'Automate invoice creation, cohort dues calculations, installment deadlines, and balance tracking.',
      },
      {
        title: 'Unified Offline & Online Payments',
        description: 'Multi-gateway collection (Razorpay, Cashfree, UPI, cards) alongside counter cash/cheque entries.',
      },
      {
        title: 'Automated Receipts & Reconciliation',
        description: 'Cryptographically signed receipts, gateway transaction reconciliation, and double-entry ledgers.',
      },
      {
        title: 'Reversals & Concession Governance',
        description: 'Strict step-up authorized reversals, fee concession quotas, and immutable financial audit logs.',
      },
      {
        title: 'Executive Financial Summaries',
        description: 'Real-time collection KPIs, revenue aging schedules, overdue analyses, and accounting exports.',
      },
    ],
  },
  reports: {
    key: 'reports',
    name: 'Institutional Analytics & Reports',
    category: 'Executive Intelligence',
    badge: 'Analytics Add-On',
    capabilities: [
      {
        title: 'Student Enrolment & Cohort Rosters',
        description: 'Comprehensive demographic breakdowns, admission cohorts, category ratios, and active rolls.',
      },
      {
        title: 'Attendance & Absenteeism Analytics',
        description: 'Campus-wide attendance patterns, chronic absenteeism identification, and section trends.',
      },
      {
        title: 'Examination Performance Reports',
        description: 'Subject pass rates, marks distributions, academic rank lists, and year-over-year analytics.',
      },
      {
        title: 'Financial Collection & Dues Overviews',
        description: 'Head-wise fee realization, outstanding dues aging, gateway settlement reports, and audit trails.',
      },
      {
        title: 'Accreditation & Compliance Exports',
        description: 'Pre-formatted institutional reports and Excel/PDF data exports ready for regulatory filings.',
      },
    ],
  },
  documents: {
    key: 'documents',
    name: 'Document Center & Storage',
    category: 'Records & Compliance',
    badge: 'Storage Add-On',
    capabilities: [
      {
        title: 'Central Institutional Repository',
        description: 'Cloud archive for academic policies, administrative circulars, certificates, and compliance manuals.',
      },
      {
        title: 'Student & Employee Digital Records',
        description: 'Secure digital dossiers for identity cards, previous transcripts, diplomas, and medical records.',
      },
      {
        title: 'Cryptographic Signed URLs',
        description: 'Short-lived time-bounded download signatures preventing hotlinking and unauthorized access.',
      },
      {
        title: 'Capability-Based Authorization',
        description: 'Strict least-privilege document visibility bound to campus scopes and student privacy rules.',
      },
      {
        title: 'Retention Schedules & Access Logs',
        description: 'Automated document retention lifecycles and non-repudiable audit logs of every document view.',
      },
    ],
  },
};

export type SemanticModuleState =
  | { kind: 'ready' }
  | { kind: 'not_entitled'; moduleKey: string; moduleName: string }
  | { kind: 'suspended'; reason?: string }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden'; message: string }
  | { kind: 'error'; message: string };

/**
 * Normalizes any error thrown during an ERP module's initial data load into a semantic UI state.
 */
export function resolveModuleError(
  err: unknown,
  moduleKey: string,
  fallbackMessage = 'Failed to load module data.',
): SemanticModuleState {
  if (isModuleNotEntitled(err)) {
    const preview = MODULE_PREVIEWS[moduleKey];
    return {
      kind: 'not_entitled',
      moduleKey,
      moduleName: preview?.name ?? moduleKey,
    };
  }

  if (isInstitutionSuspended(err)) {
    return {
      kind: 'suspended',
      reason: 'Institution access has been suspended by the platform administrator.',
    };
  }

  if (isApiError(err)) {
    if (err.kind === 'unauthenticated' || err.status === 401) {
      return { kind: 'unauthenticated' };
    }
    if (err.kind === 'forbidden' || err.status === 403) {
      return {
        kind: 'forbidden',
        message: 'You do not have permission to view or manage this module.',
      };
    }
    return {
      kind: 'error',
      message: err.message || fallbackMessage,
    };
  }

  return {
    kind: 'error',
    message: err instanceof Error ? err.message : fallbackMessage,
  };
}
