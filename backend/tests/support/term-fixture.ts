import { adminQuery } from './db-harness.js';

/**
 * FIXTURE ONLY: marks a PLANNED term ACTIVE as the harness superuser, for tests whose subject is NOT term activation
 * (enrolment, timelines, structure) and which need a running term without building a fully staffed one. Since Task 9
 * every API/service activation must pass the readiness rules (TermService.update, doc 35 §3); those rules and both
 * activation routes are tested in tests/integration/term-activation.test.ts. The database guards (an ACTIVE academic
 * year) still apply to this write; the version trigger bumps the version exactly as the service's UPDATE does.
 */
export async function activateTermFixture(termId: string): Promise<void> {
  const r = await adminQuery<{ id: string }>(
    `UPDATE app.terms SET status = 'ACTIVE' WHERE id = $1 AND status = 'PLANNED' RETURNING id`,
    [termId],
  );
  if (r.length !== 1) throw new Error(`activateTermFixture: term ${termId} is not PLANNED`);
}
