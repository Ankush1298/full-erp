import { describe, expect, it } from 'vitest';
import { assertLocalTokenOutput } from '../../tools/platform/first-admin.js';

// A one-time secret may be printed only by an explicitly authorised, local, non-production process (doc 45 §7).
const LOCAL = 'postgres://u:p@localhost:5432/anesa_test'; // secret-scan:allow synthetic
const ON = { PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT: 'true' };

describe('assertLocalTokenOutput', () => {
  it('allows only the explicit opt-in on a local database outside production', () => {
    for (const url of [
      LOCAL,
      'postgres://u:p@127.0.0.1/db',
      'postgres://u:p@[::1]:5432/db',
      'postgres:///db',
    ]) {
      expect(() => assertLocalTokenOutput(url, ON), url).not.toThrow();
    }
  });
  it('refuses without the opt-in, with any other value, and in production', () => {
    expect(() => assertLocalTokenOutput(LOCAL, {})).toThrow(/PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT/);
    expect(() =>
      assertLocalTokenOutput(LOCAL, { PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT: '1' }),
    ).toThrow();
    expect(() => assertLocalTokenOutput(LOCAL, { ...ON, NODE_ENV: 'production' })).toThrow(
      /production/,
    );
  });
  it('refuses a remote or unparseable database', () => {
    for (const url of [
      'postgres://u:p@db.example.com/db',
      'postgres://u:p@10.0.0.5/db',
      'not a url',
      'postgres://u:p@localhost.evil.test/db',
    ]) {
      expect(() => assertLocalTokenOutput(url, ON), url).toThrow(/this machine/);
    }
  });
});
