# Anesa Campus OS — Disaster Recovery & Operational Incident Runbooks

**Document Version:** 1.0.0
**Target Environment:** PostgreSQL 16 Enterprise ERP Cluster
**Applies to:** Platform Operations, Site Reliability Engineers, Lead DevOps
**Proposed Operational Targets:**
- **Recovery Point Objective (RPO):** $\le 15$ minutes (with continuous WAL archiving and hourly encrypted snapshots)
- **Recovery Time Objective (RTO):** $\le 4$ hours (actual rehearsal demonstration: 2 seconds for cold restore drill)

---

## 1. Core Principles & Cryptographic Safety Architecture

### 1.1 Strict Fail-Closed Safeguards (`test-guard.ts`)
Under no circumstances may automated drills or manual scripts run destructive restore procedures against active persistent environments (`campusos_demo`, `campusos_dev`, `campusos_prod`).
- Every restore operation enforces `assertDisposableTestDatabase` at the engine boundary.
- Non-disposable databases throw immediate `PERSISTENT_DB_MUTATION_BLOCKED` errors.
- Any manual production disaster recovery requires an explicitly stamped destination and dual-operator confirmation.

### 1.2 Zero-Access Encryption Truth & Data Boundaries
Anesa enforces two distinct data protection tiers:
1. **School Vault Zero-Access Cryptographic Tier:**
   - Applied to student child protection records, medical evaluations, and safeguarding notes.
   - Encrypted client-side using WebAuthn / Passkey / hardware-derived envelope keys.
   - The PostgreSQL database and backup artifacts store **only opaque ciphertext blobs and encrypted key envelopes**.
   - Server administrators, platform operators, and database backups **never** have access to raw plaintext or vault root keys.
2. **Enterprise Multi-Tenant ERP Tables:**
   - Standard administrative data (classes, courses, attendance, grades, finance ledger).
   - Stored in PostgreSQL with strict Row-Level Security (`FORCE ROW LEVEL SECURITY`) and tenant context isolation (`app.tenant_id`).
   - Backup artifacts are encrypted in transit and at rest using **AES-256-GCM** with random 96-bit IVs and 128-bit authentication tags.

---

## 2. Operator CLI & Tooling Reference

The enterprise backup and disaster recovery toolchain is located at `backend/tools/backup/`:

| Command | Purpose | Parameters |
| :--- | :--- | :--- |
| `backup:create` | Creates an AES-256-GCM encrypted snapshot with SHA-256 checksums | `[--db <url>] [--retention-days <days>] [--key <secret>]` |
| `backup:verify` | Verifies cryptographic integrity & catalog of backup file | `--file <meta-path> [--key <secret>]` |
| `backup:restore` | Restores encrypted backup into an isolated target database | `--file <path> --target <target-url> [--key <secret>]` |
| `backup:prune` | Safely prunes expired backups while retaining latest copy | `[--retention-days <days>]` |
| `backup:rehearse` | Runs full automated DR rehearsal into ephemeral disposable DB | `--server-admin <admin-url> --source-db <source-url>` |
| `backup:list` | Displays catalog of all discovered backup artifacts | `[--storage-dir <dir>]` |

---

## 3. Incident Playbooks by Scenario

### Scenario 1: Primary Database Corruption
**Triggers:** PostgreSQL checksum failure, corrupted data pages, missing WAL segments, or OS filesystem faults.
**Symptoms:** PostgreSQL logs report `PANIC: could not locate a valid checkpoint record` or `ERROR: invalid page in block`.

1. **Triage & Quarantine:**
   - Stop backend API instances to freeze transaction state:
     ```bash
     kill -TERM <backend-pid>
     ```
   - Do NOT run `pg_resetwal` on the primary instance, as this causes silent data loss.
2. **Integrity Assessment:**
   - Check the backup catalog for the most recent valid encrypted snapshot:
     ```bash
     tsx tools/backup/cli.ts backup:list
     ```
   - Verify cryptographic integrity and table of contents:
     ```bash
     tsx tools/backup/cli.ts backup:verify --file .data/backups/backup-campusos_demo-latest.meta.json
     ```
3. **Restoration into New Target Instance:**
   - Provision a fresh database instance (or new PostgreSQL 16 cluster):
     ```bash
     createdb -h localhost -p 54329 -U postgres campusos_recovered
     ```
   - Execute restore with AES-256-GCM decryption:
     ```bash
     tsx tools/backup/cli.ts backup:restore --file .data/backups/backup-campusos_demo-latest.dump.enc --target "postgresql://campusos_admin:<secret>@localhost:54329/campusos_recovered"
     ```
4. **Post-Restore Integrity Validation:**
   - Confirm migration ledger is contiguous (55 migrations):
     ```sql
     SELECT count(*), max(version) FROM platform.schema_migrations;
     ```
   - Confirm RLS remains forced on 100% of tenant tables:
     ```sql
     SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind = 'r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
     -- Expect 0
     ```
5. **Switch Traffic:**
   - Update `DATABASE_URL` in environment secrets and restart backend services.

---

### Scenario 2: Accidental Bulk Deletion or Operator Error
**Triggers:** Accidental `TRUNCATE`, bulk deletion script executed in wrong tenant, or administrative misconfiguration.
**Symptoms:** Sudden disappearance of student records, faculty data, or enrollment history.

1. **Immediate Containment:**
   - Suspend the affected organization via Platform API to prevent compounding writes:
     ```bash
     curl -X PATCH http://127.0.0.1:4001/api/v1/platform/institutions/<org-id>/suspend \
       -H "x-platform-token: $PLATFORM_ADMIN_TOKEN"
     ```
2. **Point-In-Time Rehearsal (PITR):**
   - Execute an automated rehearsal to verify backup completeness without touching production:
     ```bash
     tsx tools/backup/cli.ts backup:rehearse --server-admin "$SERVER_ADMIN_URL" --source-db "$SOURCE_DB_URL"
     ```
3. **Surgical Data Extraction:**
   - Restore the encrypted backup into a sidecar disposable database (`campusos_dr_recovery`).
   - Extract only the affected tenant's data using tenant-scoped export:
     ```sql
     \copy (SELECT * FROM app.students WHERE organization_id = '<target-org>') TO '/tmp/students_recovered.csv' CSV HEADER;
     ```
   - Re-import records into production inside a controlled transaction.
4. **Reactivate Institution:**
   - Unsuspend the institution after verifying count consistency.

---

### Scenario 3: Complete Server / Infrastructure Failure
**Triggers:** Physical host failure, hardware disk controller fault, datacenter outage.
**Symptoms:** Complete loss of server responsiveness, unreachable port `54329`.

1. **Activate Secondary Standby / New Node:**
   - Deploy base PostgreSQL 16 container or virtual machine on failover infrastructure.
2. **Retrieve Offsite Encrypted Backups:**
   - Sync encrypted `.dump.enc` and `.meta.json` files from secure secondary replica or S3 cold storage.
   - Verify SHA-256 hashes against immutable metadata.
3. **Execute Bare-Metal Restore:**
   - Run `tsx tools/backup/cli.ts backup:restore` against the newly provisioned node.
4. **Verify Application Readiness:**
   - Call `/api/v1/monitoring/health` with institutional credentials.
   - Check round-trip DB latency and connection metrics.

---

### Scenario 4: Failed or Incomplete Schema Migrations
**Triggers:** Migration DDL timeout, network split during migration runner, lock conflict on large table.
**Symptoms:** Migration runner throws error; database locked in intermediate migration state.

1. **Lock Identification:**
   - Check `pg_stat_activity` for blocking advisory locks:
     ```sql
     SELECT pid, age(clock_timestamp(), query_start), query, state
       FROM pg_stat_activity
      WHERE query LIKE '%schema_migrations%' OR query LIKE '%advisory_lock%';
     ```
2. **Evaluate Transaction State:**
   - Anesa migrations execute inside atomic transactions (`BEGIN ... COMMIT`).
   - If a migration fails, PostgreSQL automatically rolls back the entire transaction.
   - Check `platform.schema_migrations` to identify the last cleanly committed version:
     ```sql
     SELECT version, name, applied_at FROM platform.schema_migrations ORDER BY version DESC LIMIT 5;
     ```
3. **Dry Run Fix:**
   - Test the failing migration in an ephemeral disposable database before re-running in production:
     ```bash
     pnpm --filter @campusos/backend test tests/security-db/
     ```

---

### Scenario 5: Document Object Storage Outage
**Triggers:** S3/MinIO bucket downtime, invalid bucket policy, network partition to storage gateway.
**Symptoms:** Document downloads fail with 503; virus scan worker cannot reach quarantine bucket.

1. **Operator Diagnostics:**
   - Check `/api/v1/monitoring/telemetry` for `storage.documentStoreReady`.
2. **Fail-Closed Guarantee:**
   - The storage subsystem fails closed: unverified or unscanned files are never served to clients.
   - Database metadata tracks file states (`QUARANTINED`, `CLEAN`, `REJECTED`).
3. **Recovery:**
   - Once object storage connectivity is restored, trigger reconciliation scan on unverified files.

---

### Scenario 6: Backup Storage Tampering or Compromise
**Triggers:** Malicious file modification, ransomware attempt, storage bit rot.
**Symptoms:** `backup:verify` reports authentication tag mismatch.

1. **Detection:**
   - Every backup file is protected by AES-256-GCM authenticated encryption. Any alteration of even a single bit in the ciphertext causes `verifyBackup` to throw:
     ```
     Catalog validation failed: Unsupported state or unable to authenticate data
     ```
2. **Immediate Incident Protocol:**
   - Isolate the corrupted backup file immediately.
   - Alert Security Operations.
   - Fall back to the previous verified snapshot in the chain.

---

### Scenario 7: Credential or Key Compromise
**Triggers:** Accidental exposure of database password or backup encryption key in logs or communications.
**Symptoms:** Security notification, secrets scanner alert.

1. **Database Password Rotation:**
   - Rotate `app_runtime` and `app_migrator` passwords in PostgreSQL:
     ```sql
     ALTER ROLE app_runtime WITH PASSWORD '<new-random-hex-64>';
     ALTER ROLE app_migrator WITH PASSWORD '<new-random-hex-64>';
     ```
   - Update production environment secrets and restart backend services.
2. **Backup Encryption Key Rotation:**
   - Generate a new 256-bit AES master key:
     ```bash
     openssl rand -hex 32
     ```
   - Run on-demand backup with the new key (`BACKUP_ENCRYPTION_KEY=<new-key> tsx tools/backup/cli.ts backup:create`).
   - Retire the compromised key after re-encrypting existing archive catalogs.

---

## 4. Disaster Recovery Drill Schedule & Cadence

| Drill Type | Frequency | Target | Success Criteria |
| :--- | :--- | :--- | :--- |
| **Automated Rehearsal Drill** | Daily (Automated CI & Cron) | Ephemeral disposable DB (`campusos_dr_*`) | 100% verification pass: ledger = 55, RLS forced on all tables, RTO $\le 30$s |
| **Backup Integrity Verification** | Hourly (Automated SRE probe) | Backup storage directory | SHA-256 and GCM auth tag pass |
| **Failover Simulation** | Quarterly | Staging environment | Full end-to-end failover with zero data loss |
| **Zero-Access Boundary Audit** | Bi-weekly | School Vault tables | Vault keys unrecoverable without client passkeys |
