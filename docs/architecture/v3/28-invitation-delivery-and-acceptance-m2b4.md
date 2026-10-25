# 28 — Invitation Delivery and Acceptance (Milestone 2, Batch B4)

Roadmap note: `docs/architecture/v3/04-api-frontend-phasing-adrs.md` Part 14.2 & Part 16 specifies the invitation flow and acceptance page (`/accept-invite`) as part of **Milestone 2**. Following Batch B3 (`2f639d9`, User Management UI), Batch B4 implements the web acceptance page, client API integration, mailer boundary enforcement, and owner decision framework for production delivery.

---

## 1. What Already Existed and Contract Preservation

1. **Database Schema & Stored Functions** (Migration `0028_user_invitations.sql`):
   - `app.invite_tokens`: Stores only SHA-256 hash (`token_hash char(64) UNIQUE`), expiration timestamp (`expires_at`), consumption timestamp (`used_at`), and revocation timestamp (`revoked_at`). Forced row-level security (RLS).
   - `platform.lock_invitation(p_token_hash)`: `SECURITY DEFINER` function that locks usable invitation and invited user rows (`FOR UPDATE OF it, u`) matching the SHA-256 hash. Returns organization ID, user ID, email, and display name.
   - `platform.complete_invitation(p_token_hash, p_identity_id)`: Atomically marks `used_at = now()` on the token and transitions user status from `INVITED` to `ACTIVE` with bound `identity_id`.
   - `app.users_invited_status_guard`: Trigger preventing direct transition into or out of `INVITED` status except through `complete_invitation`.

2. **Backend Authentication & Acceptance Service** (`AuthService.acceptInvitation`):
   - Public endpoint `POST /api/v1/auth/accept-invite` with rate limiting via `FixedWindowLimiter` on client IP and token hash.
   - Closed request body (`additionalProperties: false`): `{ token: string (43 chars base64url), password: string (12..128 chars) }`. No tenant, role, scope, or identity parameters accepted.
   - Race-safe and single-use under concurrency: exactly one concurrent request wins; losers evaluate against consumed/withdrawn row and receive uniform `400 INVALID_INVITATION`.
   - Enumeration resistance: All failures (unknown token, expired token, revoked token, account locked, account disabled) return the exact same `400 INVALID_INVITATION`.
   - Audit event `user.invitation_accept` written atomically in the same transaction at Tier 1.
   - No session is issued upon acceptance; users must sign in through the standard login flow.

3. **User Management Delivery Status** (`POST /api/v1/users/invite`):
   - `delivery: 'SENT' | 'FAILED' | 'NOT_ATTEMPTED'`.
   - `SENT`: Configured provider accepted message.
   - `FAILED`: Mailer rejected sending (including unconfigured mailer `DisabledInvitationMailer`).
   - `NOT_ATTEMPTED`: Idempotent replay of an existing invitation request.

---

## 2. Web Acceptance Experience (`apps/web`)

1. **Route Wiring**:
   - `/accept-invite`: Public unauthenticated route alongside `/login` in `AppRoutes`.

2. **UI & Accessibility** (`AcceptInvitePage.tsx`):
   - Token extraction: Extracts `token` query parameter from URL.
   - Client-side validation: Validates 43-character base64url format (`^[A-Za-z0-9_-]{43}$`).
   - Invalid / missing link state: When token is missing or malformed, displays clear warning with link to `/login` without exposing password fields.
   - Accessible email context: Safely displays email address from optional `email` query param if valid, without transmitting it in mutation body.
   - Password fields: "New password" and "Confirm password" with policy enforcement (12–128 characters, matching check). Accessible programmatic association (`aria-describedby`, `aria-invalid`).
   - Loading state: Submit button reflects pending request (`Accepting invitation…`) and disables duplicate submissions.
   - Error states: Safe, actionable messaging via `acceptInviteErrorMessage`:
     - Invalid / expired / revoked / consumed: *"This invitation link is invalid, expired, or has already been used. Please ask your administrator to send a new invitation."*
     - Rate limited: *"Too many attempts. Please wait ... and try again."*
     - Network failure: *"Cannot reach the server. Check your connection and try again."*
     - Server failure: *"Invitation acceptance is temporarily unavailable. Please try again shortly."*
   - Success state: Shows confirmation that account is active, with primary link to `/login`.
   - History & storage sanitation: Cleans URL with `window.history.replaceState` upon successful submission; never persists tokens or passwords in `localStorage` or `sessionStorage`.

---

## 3. Mailer Integration Boundary

1. **Separation of Concerns**:
   - Token generation occurs inside the database transaction (`user.service.ts`).
   - Raw token is encapsulated in `InvitationMail` via a private field `#token`.
   - Serializations (`toJSON()` and `inspect.custom`) redact the raw token as `[redacted]`.
   - Message dispatch occurs strictly **after** transaction commit.

2. **Delivery Status Integrity**:
   - `DisabledInvitationMailer` fails closed, rejecting with `MailerNotConfiguredError`.
   - Delivery is truthfully marked `FAILED` (never false `SENT`).
   - Log output records `errorName: err.name` only; provider error messages and request bodies containing tokens are never logged.
   - Failures do not roll back created `INVITED` user accounts or tokens; administrators can re-invite (which rotates token and withdraws old token).

3. **Testing Harness**:
   - `InMemoryInvitationMailer` is maintained strictly for integration and unit test assertions and is never wired in production configurations.

---

## 4. Owner Decision Framework for Production Delivery

Production email delivery requires owner infrastructure selection. Until configured, `DisabledInvitationMailer` remains active.

| Decision Item | Requirements & Options | Status |
| :--- | :--- | :--- |
| **1. Provider Choice** | Select SMTP/API provider (e.g., AWS SES, Postmark, SendGrid). AWS SES or Postmark recommended for high-deliverability transactional campus notifications. | **Blocked on Owner** |
| **2. Sender & Domain Identity** | Dedicated domain or subdomain (e.g., `invitations.campus.edu` or `mail.campus.edu`) configured with SPF (`v=spf1`), DKIM (2048-bit CNAME/TXT), and DMARC (`p=reject` or `p=quarantine`). | **Blocked on Owner** |
| **3. Secrets & Key Storage** | AWS IAM role / instance profile (SES) or environment secret (e.g., `EMAIL_PROVIDER_API_KEY`) injected via runtime secret manager. Secrets must not be committed to Git or repository configs. | **Blocked on Owner** |
| **4. Sandbox Verification** | Escape sandbox status, verify bounce and complaint webhook handling, and conduct staging end-to-end delivery test to an external inbox. | **Blocked on Owner** |
| **5. Completed Implementation** | Full transactional token generation, SHA-256 storage, single-use concurrency locks, acceptance endpoint, rate limiting, audit logging, React acceptance page (`/accept-invite`), and automated test suite. | **Complete** |
