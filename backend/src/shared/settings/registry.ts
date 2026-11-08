import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Registry of organization settings (docs/architecture/v3/02 §4.2: "registry in code: type, schema, default,
 * sensitivity"; 11 §5.3: `shared/settings`). The table `app.organization_settings` stores only values a tenant
 * administrator has chosen; this registry decides which keys exist, what a valid value looks like, and what applies
 * while nothing is stored.
 *
 * WHAT IS REGISTERED, AND WHY ONLY THIS:
 *  Only keys whose TYPE the architecture states completely (02 §4.2): a number, a boolean, or a closed enumeration.
 *  A default is registered only where the document gives one (`identity.age_of_majority` = 18); a key without a
 *  default has no value until an administrator sets one, and consumers must handle that.
 *
 * `terminology` (02 §4.2 "{cohort:"Batch", section:"Section", ...} display labels only") is registered by Milestone 3
 * Batch 3 (doc 33 §6) with a CLOSED set of label slots and no registry default; the display fallbacks (11 R-9 "Batch /
 * Section / Semester") are applied by `GET /academics/terminology`, never stored.
 *
 * NOT REGISTERED (deliberately; the architecture does not yet give a complete schema or default, and this file must
 * not invent them): `academic.degree_levels`, `identity.admission_number`, `privacy.student_fields`,
 * `security.password_policy` / session lifetimes, `retention.*`, `attendance.default_policy_id`, and
 * `identity.unknown_dob_policy` (referenced in 02 §4.4 but absent from the §4.2 key list). Each is added by the
 * slice that owns its meaning, together with a schema, a default decision and tests.
 *
 * PER-KEY SENSITIVITY: the architecture says the registry carries a sensitivity but does not assign one to any key
 * ("CRITICAL keys A2" names no key). It is therefore not modelled here. Every write is already CRITICAL because it
 * requires `org.settings.manage` (a CRITICAL permission): a mandatory reason and a risk-tier-2 audit row.
 */
export interface SettingDefinition {
  readonly key: string;
  /** TypeBox schema every stored value must satisfy. */
  readonly schema: TSchema;
  /** Applies while no row exists. Absent = no value until one is set. */
  readonly default?: unknown;
  /**
   * Rules the schema cannot state (e.g. no two labels alike). Runs after the schema check; returns a message naming the
   * offending slots (never the submitted value), or null when the value is acceptable.
   */
  readonly validate?: (value: unknown) => string | null;
}

import { INSTITUTION_TYPES, INSTITUTION_TYPE_KEY } from './institution.js';

/** The label slots of the `terminology` setting (doc 33 §6). */
export const TERMINOLOGY_SLOTS = [
  'program',
  'cohort',
  'period',
  'section',
  'term',
  'course',
] as const;

/** Display fallbacks while a slot is unset: doc 11 R-9 ("Batch / Section / Semester"); the rest are the model's names. */
export const TERMINOLOGY_DEFAULTS: Record<(typeof TERMINOLOGY_SLOTS)[number], string> = {
  program: 'Programme',
  cohort: 'Batch',
  period: 'Semester',
  section: 'Section',
  term: 'Term',
  course: 'Course',
};

/**
 * A display label: 1..40 characters, no leading or trailing whitespace, no control characters and no angle brackets
 * (labels are rendered as text everywhere, the brackets are refused only to keep them plainly readable in exports).
 */
const LABEL = Type.String({
  minLength: 1,
  maxLength: 40,
  pattern: '^[^\\s<>\\x00-\\x1f\\x7f](?:[^<>\\x00-\\x1f\\x7f]*[^\\s<>\\x00-\\x1f\\x7f])?$',
});

/**
 * Task 8: no two slots may show the same label (two tabs called "Class" would be ambiguous), counting the fallbacks of
 * unset slots; and a per-period-type `periodTypes` label must not reuse a non-period slot's label (a "Year" period may
 * not read "Term"). Case and inner spacing are ignored when comparing.
 */
function validateTerminology(value: unknown): string | null {
  const v = value as Partial<Record<(typeof TERMINOLOGY_SLOTS)[number], string>> & {
    periodTypes?: Record<string, string>;
  };
  const norm = (x: string) => x.trim().replace(/\s+/g, ' ').toLowerCase();
  const effective = TERMINOLOGY_SLOTS.map(
    (k) => [k, norm(v[k] ?? TERMINOLOGY_DEFAULTS[k])] as const,
  );
  for (let i = 0; i < effective.length; i += 1) {
    for (let j = i + 1; j < effective.length; j += 1) {
      if (effective[i]![1] === effective[j]![1]) {
        return `The labels of "${effective[i]![0]}" and "${effective[j]![0]}" must differ.`;
      }
    }
  }
  const others = new Map(effective.filter(([k]) => k !== 'period').map(([k, l]) => [l, k]));
  for (const [code, label] of Object.entries(v.periodTypes ?? {})) {
    const clash = others.get(norm(label));
    if (clash)
      return `The label of period type "${code}" must differ from the label of "${clash}".`;
  }
  return null;
}

/** `module.name` style: lower-case segments of letters/digits/underscore separated by dots (02 §4.2 key names). */
export const SETTING_KEY_PATTERN = '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$';
export const SETTING_KEY_MAX_LENGTH = 100;
/** The database CHECK on `value` is 16 KiB; the service refuses larger values before they reach it. */
export const SETTING_VALUE_MAX_BYTES = 16_384;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    // 02 §4.2: "int (default 18; jurisdiction decision is the tenant's/legal's, not ours)". The 0..150 bound is a
    // technical sanity limit on the integer, NOT a legal rule; the document states none.
    key: 'identity.age_of_majority',
    schema: Type.Integer({ minimum: 0, maximum: 150 }),
    default: 18,
  },
  {
    // 02 §4.2: "bool"; no default stated.
    key: 'identity.dob_required',
    schema: Type.Boolean(),
  },
  {
    // 02 §4.2: NEVER | MINORS_ONLY | ALWAYS_WHEN_ENABLED; no default stated.
    key: 'guardian.notification_policy',
    schema: Type.Union([
      Type.Literal('NEVER'),
      Type.Literal('MINORS_ONLY'),
      Type.Literal('ALWAYS_WHEN_ENABLED'),
    ]),
  },
  {
    // 02 §4.2: MINORS_ONLY | ALWAYS_WHEN_LINKED | NEVER; no default stated.
    key: 'guardian.academic_visibility',
    schema: Type.Union([
      Type.Literal('MINORS_ONLY'),
      Type.Literal('ALWAYS_WHEN_LINKED'),
      Type.Literal('NEVER'),
    ]),
  },
  {
    // Doc 44: the institution chosen at onboarding. A closed enumeration, no default (unset = the pre-onboarding labels). It is
    // a display and workflow-presentation key: no permission, grant or access rule reads it. Changing a stored value is
    // restricted by SettingsService (only while no academic year exists).
    key: INSTITUTION_TYPE_KEY,
    schema: Type.Union(INSTITUTION_TYPES.map((t) => Type.Literal(t))),
  },
  {
    // 02 §4.2: display labels only. Closed label slots (doc 33 §6), each a LABEL; at least one key. Changing a label
    // never touches academic data: period_types.label still names each period type. Task 8 (doc 35 §4): optional
    // `periodTypes` = { <period type code>: label } overrides the period label for programmes of that period type, so
    // a college can show "Year" for its annual and "Semester" for its semester programmes.
    key: 'terminology',
    schema: Type.Object(
      {
        ...Object.fromEntries(TERMINOLOGY_SLOTS.map((k) => [k, Type.Optional(LABEL)])),
        periodTypes: Type.Optional(
          Type.Record(Type.String({ pattern: '^[^\\x00-\\x1f\\x7f]{1,30}$' }), LABEL, {
            additionalProperties: false,
            maxProperties: 50,
          }),
        ),
      },
      { additionalProperties: false, minProperties: 1 },
    ),
    validate: validateTerminology,
  },
];

const BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((d) => [d.key, d]),
);

/** Exact-match lookup. An unregistered key is not a setting, whatever its spelling. */
export function findSettingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

/** True when `value` satisfies the key's schema. Never throws and never echoes the value. */
export function isValidSettingValue(definition: SettingDefinition, value: unknown): boolean {
  return Value.Check(definition.schema, value);
}
