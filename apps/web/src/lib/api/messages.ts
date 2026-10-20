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
