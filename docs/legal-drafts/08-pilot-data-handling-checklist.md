# 08 — Pilot Data Handling Checklist (draft)

> **DRAFT — NOT LEGALLY APPROVED.** Prepared for owner and qualified-counsel review. Not published, not offered to any school, not a promise. Every clause tagged _[Contract]_, _[Process]_ or _[Technical]_ (doc 46 §2); _[Technical]_ may be stated to a school only where the cited control exists and passes its test. Bracketed items are open decisions.

Use per pilot school. Tick only with evidence attached. **No real student data until every line is ticked or has a signed owner exception.**

- [ ] Written agreement signed: DPA, no-sale policy, sub-processor list, offboarding policy (drafts 02 to 05) — reviewed by counsel.
- [ ] Counsel's written view on children's data, exemptions and notice/consent for this school.
- [ ] Hosting model, provider and region decided and disclosed.
- [ ] Production database: runtime role has no superuser/BYPASSRLS; no standing human superuser; privileged sessions logged to storage operators cannot edit.
- [ ] Backups encrypted; restore drill done within the stated recovery time; key backup verified by a second person.
- [ ] `support:grant` retired or replaced; support procedure (draft 06) in force.
- [ ] First administrator onboarded by the operator runbook, MFA enrolled, tokens never written to logs or tickets.
- [ ] Data minimisation register set: only needed student fields enabled; DOB policy decided.
- [ ] Retention periods decided and recorded; deletion procedure rehearsed on synthetic data.
- [ ] Export procedure rehearsed on synthetic data; receipt template ready.
- [ ] Incident process and contacts agreed; tabletop done.
- [ ] Staff briefed: no real data in development/test, no screenshots to chat tools, report suspected incidents.
- [ ] Penetration test or independent review completed or exception signed.
- [ ] Statement review: nothing told to the school exceeds what is implemented (doc 46 §1).
