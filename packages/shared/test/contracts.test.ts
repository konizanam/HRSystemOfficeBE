import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  LoginRequestSchema,
  NewPasswordSchema,
  OidcStartQuerySchema,
  passwordPolicyIssues,
  RESTRICTED_FEATURES,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  SettingsSchema,
  UpdateSettingsRequestSchema,
} from '../src';

describe('password policy', () => {
  it('requires 10 characters and 3 of 4 character classes', () => {
    expect(passwordPolicyIssues('Short1!')).toEqual(['Use at least 10 characters']);
    expect(passwordPolicyIssues('alllowercaseletters')).toEqual([
      'Use at least 3 of: lowercase, uppercase, digits, symbols',
    ]);
    expect(passwordPolicyIssues('lowerUPPER12')).toEqual([]);
    expect(passwordPolicyIssues('lower-case-99')).toEqual([]);
    expect(NewPasswordSchema.safeParse('abc').success).toBe(false);
    expect(NewPasswordSchema.safeParse('Valid-Password-1').success).toBe(true);
  });

  it('defaults the sign-in profile to LOCAL', () => {
    expect(LoginRequestSchema.parse({ username: ' a ', password: 'x' })).toEqual({
      username: 'a',
      password: 'x',
      profile: 'LOCAL',
    });
  });
});

describe('settings contract', () => {
  it('has a valid default for every key', () => {
    const defaults = defaultSettings();
    expect(Object.keys(defaults).sort()).toEqual([...SETTING_KEYS].sort());
    expect(SettingsSchema.parse(defaults)).toEqual(defaults);
    expect(defaults['session.idleMinutes']).toBe(20);
    expect(defaults['session.warnSeconds']).toBe(60);
    expect(defaults['workingAs.maxDepth']).toBe(1);
    expect(defaults['workingAs.restrictedFeatures']).toEqual([...RESTRICTED_FEATURES]);
    expect(defaults['ui.dateFormat']).toBe('dd-MMM-yyyy');
    expect(defaults['ui.accentColour']).toBe('#0F766E');
  });

  it('returns a fresh copy of array defaults', () => {
    const a = defaultSettings();
    a['workingAs.restrictedFeatures'].pop();
    expect(defaultSettings()['workingAs.restrictedFeatures']).toHaveLength(RESTRICTED_FEATURES.length);
    expect(SETTING_DEFINITIONS['workingAs.restrictedFeatures'].default).toHaveLength(
      RESTRICTED_FEATURES.length,
    );
  });

  it('validates updates per key and rejects unknown keys', () => {
    expect(
      UpdateSettingsRequestSchema.safeParse({ values: { 'session.idleMinutes': 30 }, revision: 'abc' })
        .success,
    ).toBe(true);
    // The optimistic concurrency revision is required.
    expect(UpdateSettingsRequestSchema.safeParse({ values: { 'session.idleMinutes': 30 } }).success).toBe(
      false,
    );
    expect(UpdateSettingsRequestSchema.safeParse({ values: { 'session.idleMinutes': 0 } }).success).toBe(
      false,
    );
    expect(UpdateSettingsRequestSchema.safeParse({ values: { 'ui.accentColour': 'red' } }).success).toBe(
      false,
    );
    expect(UpdateSettingsRequestSchema.safeParse({ values: { 'no.such.key': 1 } }).success).toBe(false);
    expect(
      UpdateSettingsRequestSchema.safeParse({
        values: { 'workingAs.restrictedFeatures': ['PAYSLIPS', 'PAYSLIPS'] },
      }).success,
    ).toBe(false);
  });
});

describe('OIDC start query', () => {
  it('only accepts paths inside the app', () => {
    expect(OidcStartQuerySchema.safeParse({ returnTo: '/leave/apply' }).success).toBe(true);
    expect(OidcStartQuerySchema.safeParse({ returnTo: '//evil.example' }).success).toBe(false);
    expect(OidcStartQuerySchema.safeParse({ returnTo: 'https://evil.example' }).success).toBe(false);
    expect(OidcStartQuerySchema.safeParse({ returnTo: '/\\evil' }).success).toBe(false);
  });
});
