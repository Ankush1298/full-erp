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
    return 'Password verification is required before continuing.';
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
