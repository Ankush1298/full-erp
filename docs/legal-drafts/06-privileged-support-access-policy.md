# 06 — Privileged Support Access Policy (draft)

> **DRAFT — NOT LEGALLY APPROVED.** Prepared for owner and qualified-counsel review. Not published, not offered to any school, not a promise. Every clause tagged _[Contract]_, _[Process]_ or _[Technical]_ (doc 46 §2); _[Technical]_ may be stated to a school only where the cited control exists and passes its test. Bracketed items are open decisions.

**Current reality (do not misstate).** Anesa operators with infrastructure or database credentials can technically reach all institutions' data; no platform realm, support-grant table or session recording exists (doc 46 §4). The `support:grant` CLI is not a control. This policy states the rules the organization commits to _[Process]_ and the target design.

Rules:

1. **No standing access.** No person holds permanent production data access. Credentials are person-bound, MFA-protected, and distinct per role (runtime, migrator, operator, backup).
2. **Request.** A ticket states the institution, purpose, data needed, duration (hours), and approver.
3. **Approval.** Written approval from an authorised institution administrator **and** a second Anesa approver; emergency access requires after-the-fact review within [24 h].
4. **Least privilege.** Read-only by default; access limited to the institution concerned and the minimum tables; no export of personal data off the platform.
5. **Time-box and revoke.** Access ends automatically; revoked on completion.
6. **Record.** Who, what, when, why, statements run or records viewed, stored where operators cannot edit; a copy is available to the institution on request.
7. **Review.** Monthly review of all access events by someone who did not use them.
8. **Prohibited.** Browsing, copying to local machines, use of real data in development or test, sharing credentials.
9. **Target technical design.** Separate platform identity realm with MFA, tenant-approved time-boxed grants stored and audited in the database, `SECURITY DEFINER` support functions, no BYPASSRLS except an alarmed break-glass role (doc 46 §4.2).
