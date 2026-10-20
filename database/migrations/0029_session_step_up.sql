-- 0029_session_step_up
-- Owner: app_migrator
-- Milestone 1 / Phase 1C: session step-up assurance (D10, ADR-004, doc 08 line 99, doc 10 rule 3, doc 12 line 13).
--
-- Contents:
--  * platform.auth_sessions additions:
--    - step_up_at timestamptz (nullable: timestamp of most recent step-up verification)
--    - auth_strength varchar(32) NOT NULL DEFAULT 'PASSWORD'
--      CHECK (auth_strength IN ('PASSWORD', 'PASSWORD_REAUTH', 'PASSWORD_MFA'))
--
-- PRIVILEGES & RUNTIME SAFETY:
--  * platform.auth_sessions was granted table-level SELECT, INSERT, UPDATE, DELETE to app_runtime in 0004.
--  * ALTER TABLE ... ADD COLUMN preserves existing grants, ensuring logout and revokeMembershipSessions continue
--    updating revoked_at without disruption.
--
-- ROLLOUT: forward-only, non-contract migration. Deferred behind 0019 in persistent environments until contract rollout.

SET LOCAL lock_timeout = '5s';

ALTER TABLE platform.auth_sessions
  ADD COLUMN step_up_at timestamptz,
  ADD COLUMN auth_strength varchar(32) NOT NULL DEFAULT 'PASSWORD'
    CONSTRAINT auth_sessions_auth_strength_ck
    CHECK (auth_strength IN ('PASSWORD', 'PASSWORD_REAUTH', 'PASSWORD_MFA'));

COMMENT ON COLUMN platform.auth_sessions.step_up_at IS
  'Timestamp of the most recent step-up authentication. Null if session was never stepped up.';
COMMENT ON COLUMN platform.auth_sessions.auth_strength IS
  'Authentication assurance level: PASSWORD (initial login), PASSWORD_REAUTH (password re-prompt), or PASSWORD_MFA (second factor).';
