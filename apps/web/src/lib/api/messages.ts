import { isApiError } from './errors';

function wait(seconds: number | undefined): string {
  if (!seconds) return 'a few minutes';
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * Fixed, user-safe wording for every failure. The server never supplies text that is shown, and the
 * wording for bad credentials is identical whether or not the account exists (no enumeration).
 */
export function loginErrorMessage(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Please try again.';
  switch (err.kind) {
    case 'unauthenticated':
      return 'The email or password is incorrect.';
    case 'rate_limited':
      return `Too many sign-in attempts. Please wait ${wait(err.retryAfterSeconds)} and try again.`;
    case 'validation':
      return 'Check the details you entered and try again.';
    case 'forbidden':
    case 'csrf':
    case 'mfa_required':
      return 'The request was rejected. Reload the page and try again.';
    case 'network':
      return 'Cannot reach the server. Check your connection and try again.';
    case 'server':
    case 'protocol':
    case 'not_found':
      return 'Sign-in is temporarily unavailable. Please try again shortly.';
  }
}

export function genericErrorMessage(err: unknown): string {
  if (isApiError(err) && err.kind === 'network') {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  return 'Something went wrong on our side. Please try again.';
}

export function mfaErrorMessage(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Please try again.';
  if (err.kind === 'rate_limited') {
    return `Too many attempts. Please wait ${wait(err.retryAfterSeconds)} and try again.`;
  }
  if (err.code === 'INVALID_CREDENTIALS') {
    return 'Invalid authentication code or recovery code.';
  }
  if (err.code === 'MFA_TICKET_REQUIRED') {
    return 'An administrator-issued enrollment ticket is required for your account.';
  }
  if (err.code === 'INVALID_TICKET') {
    return 'Invalid or expired enrollment ticket.';
  }
  if (err.code === 'STEP_UP_REQUIRED') {
    return 'Re-verification is required before continuing. Nothing was changed.';
  }
  if (err.code === 'MFA_UNAVAILABLE') {
    return 'MFA service is temporarily unavailable. Please try again later.';
  }
  if (err.kind === 'network') {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  return 'Authentication failed. Please verify your code and try again.';
}

/** Fixed wording for the academics pages; the server's own text is never shown. */
export function academicsErrorMessage(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Please try again.';
  switch (err.kind) {
    case 'forbidden':
      return 'You do not have permission to do that.';
    case 'not_found':
      return 'That record could not be found, or it is outside your access.';
    case 'network':
      return 'Cannot reach the server. Check your connection and try again.';
    case 'validation':
      return err.code === 'CONFLICT'
        ? 'That conflicts with an existing record or its current state. Reload and try again.'
        : err.code === 'IDEMPOTENCY_KEY_REUSED' || err.status === 422
          ? 'That request was already submitted with different details. Reload and try again.'
          : 'Check the details you entered and try again.';
    case 'csrf':
    case 'mfa_required':
    case 'unauthenticated':
      return 'The request was rejected. Reload the page and try again.';
    case 'rate_limited':
    case 'server':
    case 'protocol':
      return 'Something went wrong on our side. Please try again.';
  }
}

/** Fixed wording for the import wizard; the server's own text is never shown. */
export function importErrorMessage(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Please try again.';
  switch (err.code) {
    case 'IMPORT_PREVIEW_CHANGED':
      return 'The proposed changes differ from the preview you reviewed. Nothing was imported. Review the refreshed preview and commit again.';
    case 'IMPORT_COMMIT_CONFLICT':
      return 'Some rows no longer pass validation, or conflict with a recent change. Nothing was imported. Download the error report and import again.';
    case 'IMPORT_MATCHING_MISMATCH':
      return 'The date of birth and guardian phone values do not match this import. Upload the same file again, then validate before committing.';
    case 'IMPORT_WARNINGS_UNACKNOWLEDGED':
      return 'The preview has warnings. Review them and tick the confirmation box.';
    case 'IMPORT_MATCHING_UNAVAILABLE':
      return 'Imports with date of birth or guardian phone data cannot be committed right now. Nothing was imported. Contact your administrator.';
    case 'IMPORT_JOB_COMMITTED':
      return 'This import was already committed.';
    case 'IMPORT_JOB_STATE':
      return 'That step is not available for this import in its current state.';
    default:
      break;
  }
  switch (err.kind) {
    case 'forbidden':
      return 'You do not have permission to import these records.';
    case 'not_found':
      return 'That import could not be found, or it belongs to someone else.';
    case 'network':
      return 'Cannot reach the server. Check your connection and try again.';
    case 'validation':
      return err.code === 'IDEMPOTENCY_KEY_REUSED' || err.status === 422
        ? 'That request was already submitted with different details. Start the import again.'
        : err.status === 409
          ? 'That conflicts with the current state of the import. Reload and try again.'
          : 'The file was not accepted. Check it and try again.';
    case 'csrf':
    case 'mfa_required':
    case 'unauthenticated':
      return 'The request was rejected. Reload the page and try again.';
    case 'rate_limited':
    case 'server':
    case 'protocol':
      return 'Something went wrong on our side. Please try again.';
  }
}

/** True for the backend's "re-verify this session first" refusal (403 STEP_UP_REQUIRED). Nothing else qualifies. */
export function isStepUpRequired(err: unknown): boolean {
  return isApiError(err) && err.kind === 'forbidden' && err.code === 'STEP_UP_REQUIRED';
}

/** Fixed wording for the step-up dialog; the server's text and the entered secret are never shown. */
export function stepUpErrorMessage(
  err: unknown,
  level: 'PASSWORD_REAUTH' | 'PASSWORD_MFA',
): string {
  if (!isApiError(err)) return 'Re-verification failed. Nothing was changed. Please try again.';
  if (err.kind === 'rate_limited') {
    return `Too many attempts. Please wait ${wait(err.retryAfterSeconds)} and try again.`;
  }
  if (err.code === 'INVALID_CREDENTIALS') {
    return level === 'PASSWORD_MFA'
      ? 'Invalid authentication code or recovery code.'
      : 'The password is incorrect.';
  }
  if (err.kind === 'validation') {
    return level === 'PASSWORD_MFA'
      ? 'Check the code you entered and try again.'
      : 'Enter your current password.';
  }
  if (err.kind === 'network') {
    return 'Cannot reach the server. Check your connection and try again. Nothing was changed.';
  }
  if (err.code === 'MFA_UNAVAILABLE') {
    return 'Two-factor authentication is temporarily unavailable. Please try again later.';
  }
  return 'Re-verification is unavailable right now. Nothing was changed. Please try again shortly.';
}

/** Fixed wording for the role-administration page; the server's text is never shown. */
export function accessErrorMessage(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Please try again.';
  if (isStepUpRequired(err))
    return 'Re-verification is required before continuing. Nothing was changed.';
  switch (err.code) {
    case 'LAST_ADMINISTRATOR':
      return 'The last effective administrator of the organization cannot be removed.';
    case 'ASSIGNMENT_NOT_EFFECTIVE':
      return 'This assignment has already expired. Grant the role again instead.';
    case 'CONFLICT':
      return 'This conflicts with the current state: the user may already have this role, the account may not accept it, or someone else changed the assignment. Reload and try again.';
  }
  switch (err.kind) {
    case 'forbidden':
      return 'You are not allowed to make this change. You cannot change your own access, and you can only manage roles and scopes your own role allows.';
    case 'not_found':
      return 'That user, role or assignment is no longer available. Reload and try again.';
    case 'validation':
      return 'Check the details you entered (the reason needs at least 5 characters, and an expiry must be a future date and time) and try again.';
    case 'rate_limited':
      return `Too many requests. Please wait ${wait(err.retryAfterSeconds)} and try again.`;
    case 'network':
      return 'Cannot reach the server. Check your connection and try again. Nothing was changed.';
    case 'unauthenticated':
    case 'csrf':
    case 'mfa_required':
    case 'server':
    case 'protocol':
      return 'Something went wrong on our side. Nothing was changed. Please try again.';
  }
}

/** Why the user list could not be shown (read-only call; the server decides who may see it). */
export function accessLoadMessage(err: unknown): string {
  if (isApiError(err) && err.kind === 'forbidden') {
    return 'Your role cannot manage access for the whole organization. Organization-level administrators can use this page.';
  }
  if (isApiError(err) && err.kind === 'network') {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  return 'Users and roles could not be loaded. Please try again.';
}

/** Fixed wording for user management (directory, invitation, suspension, reactivation). */
export function userErrorMessage(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Please try again.';
  if (isStepUpRequired(err))
    return 'Re-verification is required before continuing. Nothing was changed.';
  switch (err.code) {
    case 'LAST_ADMINISTRATOR':
      return 'The organization must keep at least one active administrator. This user cannot be suspended.';
    case 'USER_STATUS_TRANSITION_INVALID':
      return 'The user status has changed or does not permit this action. Please reload.';
    case 'CONFLICT':
      return 'This conflicts with the current state: the user may already exist, or another administrator modified this record. Reload and try again.';
  }
  switch (err.kind) {
    case 'forbidden':
      return 'You do not have permission to perform this action, or you cannot perform it on your own account.';
    case 'not_found':
      return 'That user could not be found. Please reload the list.';
    case 'validation':
      return 'Check the details you entered (such as email format and a reason of at least 5 characters) and try again.';
    case 'rate_limited':
      return `Too many requests. Please wait ${wait(err.retryAfterSeconds)} and try again.`;
    case 'network':
      return 'Cannot reach the server. Check your connection and try again. Nothing was changed.';
    case 'unauthenticated':
    case 'csrf':
    case 'mfa_required':
    case 'server':
    case 'protocol':
      return 'Something went wrong on our side. Nothing was changed. Please try again.';
  }
}

/** Why the user directory could not be loaded. */
export function userLoadMessage(err: unknown): string {
  if (isApiError(err) && err.kind === 'forbidden') {
    return 'You do not have permission to view the user directory. Contact your organization administrator.';
  }
  if (isApiError(err) && err.kind === 'network') {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  return 'Users could not be loaded. Please try again.';
}

/** Fixed wording for invitation acceptance failures; the server's own text is never shown. */
export function acceptInviteErrorMessage(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Please try again.';
  if (err.kind === 'rate_limited') {
    return `Too many attempts. Please wait ${wait(err.retryAfterSeconds)} and try again.`;
  }
  if (err.kind === 'network') {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  if (err.code === 'INVALID_INVITATION') {
    return 'This invitation link is invalid, expired, or has already been used. Please ask your administrator to send a new invitation.';
  }
  if (err.kind === 'validation') {
    return 'Check the details you entered and try again.';
  }
  if (err.kind === 'csrf') {
    return 'The request was rejected. Reload the page and try again.';
  }
  return 'Invitation acceptance is temporarily unavailable. Please try again shortly.';
}

/**
 * Fixed wording for student record reads (directory, lookup, profile sections). A 404 never says whether a record exists:
 * a missing record, another organisation's record and one outside the caller's scope are the same answer.
 */
export function studentReadMessage(err: unknown, subject: string): string {
  if (!isApiError(err)) return `${subject} could not be loaded. Please try again.`;
  switch (err.kind) {
    case 'forbidden':
      return `You do not have permission to view ${subject.toLowerCase()}.`;
    case 'not_found':
      return 'No student was found, or the record is outside your access.';
    case 'rate_limited':
      return `Too many requests. Please wait ${wait(err.retryAfterSeconds)} and try again.`;
    case 'network':
      return 'Cannot reach the server. Check your connection and try again.';
    default:
      return `${subject} could not be loaded. Please try again.`;
  }
}

/**
 * Directory failures the UI can tell apart. The backend (docs 21 §0c, tests/unit/student-directory-activation.test.ts)
 * gives NO stable signal for "directory not enabled": an unregistered route is read as GET /students/:id with a malformed
 * id and answers 400 BAD_REQUEST, the same status and code as a malformed directory query (bad status or limit) on an
 * enabled server. Only INVALID_CURSOR is distinct. So any other 400 is reported as "request not accepted" (which may mean
 * the directory is not enabled), never asserted to be the feature flag. Every case fails closed; no fallback listing.
 */
export type DirectoryFailure = 'cursor' | 'rejected' | 'other';
export function directoryFailure(err: unknown): DirectoryFailure {
  if (!isApiError(err) || err.kind !== 'validation') return 'other';
  return err.code === 'INVALID_CURSOR' ? 'cursor' : 'rejected';
}

/** Fixed wording for a rejected (non-cursor 400) directory request. */
export const DIRECTORY_REJECTED_MESSAGE =
  'The student directory is not available: the server did not accept the request. It may not be enabled on this server. If this continues, contact your administrator.';
