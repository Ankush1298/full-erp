# 42 — Public website and demo-enquiry intake

Status: the public landing page is built (uncommitted). **Live enquiry submission is NOT active**: no backend endpoint, storage, retention rule, privacy notice or notification route has been authorised. Nothing a visitor types is sent or stored.

## 1. What exists

| Piece | Where |
|---|---|
| Landing page, sections, motion, SEO tags | `apps/web/src/features/landing/` (`LandingPage.tsx`, `landing.css`, `content.ts`, `ProductPreview.tsx`) |
| Enquiry form and client-side validation | `apps/web/src/features/landing/EnquiryForm.tsx` |
| Sign-in dialog over the page (`/` and `/login`) | `LandingPage.tsx`, `features/auth/LoginForm.tsx`, `LoginPage.tsx`, `guards.tsx` |
| Single switch for live submission | `ENQUIRY_LIVE = false` in `content.ts` |
| Tests | `apps/web/tests/landing-page.test.tsx` |

Audit result: the repository has **no** lead, enquiry or contact-request table, route or service. The existing `/contact` page is institutional-helpdesk text, not an intake. Student, user and tenant tables must not be reused for marketing leads.

## 2. Content accuracy

All claims live in `content.ts` and were checked on 2026-11-07 against docs 02–41, the migrations and the routes. Statuses: *available in the current build* (student records, academic setup, courses/sections/offerings, enrolment and electives, organisation, users and roles, imports, privacy and security controls), *partly available* (documents need file storage configured; notifications are in-app only, no production mailer), *in development* (attendance: backend foundation on synthetic data, no staff or student screens), *planned* (exams and results, service requests and helpdesk, reports). No customers, metrics, testimonials, certifications, pricing or deployment claims. The product images are drawn illustrations with sample data, not screenshots (capturing real screens needs a login to a real database).

## 3. Minimum safe architecture to turn the form on (proposal, not built)

1. **Endpoint**: a new public `POST /api/v1/public/enquiries`, separate from every tenant route (no tenant context, no student or user tables). Strict body schema (TypeBox, `additionalProperties: false`), the same field limits as the client, server-side phone and email checks. The client validation is a convenience only.
2. **Storage**: one new table, `platform.enquiries`, outside any tenant. Columns: id, created_at, status (`NEW`, `CONTACTED`, `CLOSED`, `SPAM`), contact name, institution, institution type, email, phone, region, size band, interests, message, privacy-notice version accepted, purpose text version, source IP hash (not the raw IP), expires_at. Runtime role: INSERT only; a separate staff role: SELECT and UPDATE of status. No access from `app_runtime` tenant sessions.
3. **Abuse control**: per-IP and per-email rate limit (reuse the login-abuse pattern), a hidden honeypot field, body size cap, `Idempotency-Key` so a retry never creates a duplicate, and a duplicate rule (same email and institution within 7 days updates `last_seen_at` instead of adding a row).
4. **Staff access**: a platform-operator permission such as `platform.enquiry.read`, audited like other platform reads; never visible in the tenant UI.
5. **Notification**: one outbound message to a fixed Anesa team mailbox through an approved mail provider, sent by the server after the row is committed. A failed notification leaves the row and is retried; it never fails the visitor's request.
6. **Retention and deletion**: proposed 12 months from last contact, then deleted by a scheduled job; a visitor deletion request handled by staff within a stated period. These numbers need the owner's decision.
7. **Honest states**: the page shows success only after the server returns 201 for a committed row; 429 and 5xx show a retry message and keep the form contents.

## 4. Approvals needed before activation

1. Owner approval of the architecture above (a new `platform` table and a public endpoint).
2. The Anesa contact destination (team mailbox) and the mail provider for the notification, including where that provider stores data (this is a new data transfer).
3. A written enquiry privacy notice and contact purpose, with the retention period and a deletion route. The form links to the existing `/privacy` page, which does not yet cover enquiries.
4. A named staff owner for reading and answering enquiries.
5. Then: a migration (separate authorisation), the endpoint, tests, and setting `ENQUIRY_LIVE = true`.

## 5. Other open decisions

- **Indexing**: `index.html` and `robots.txt` still say `noindex` and `Disallow: /`, because the app is private and not in production. Allowing search engines to index the landing page needs a separate decision and a way to keep the signed-in app out.
- **Hosting wording** ("not finalised; cloud-first") comes from ADR-015 and must be replaced once a provider and region are chosen.
- **Social preview image**: none exists. Open Graph title and description are set at runtime; an image needs an approved asset.
- **Real screenshots**: replace the illustrations only from a disposable synthetic tenant.
