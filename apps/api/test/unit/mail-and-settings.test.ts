import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultSettings, RESTRICTED_FEATURES } from '@peoplehub/shared';
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  htmlToText,
  MAIL_SUBJECTS,
  renderMail,
  renderTemplate,
  TEMPLATE_DIR,
} from '../../src/modules/notifications/mail-templates';
import { resolveSetting } from '../../src/modules/settings/settings.service';

describe('mail templates', () => {
  it('has a file for every template', () => {
    for (const name of [...Object.keys(MAIL_SUBJECTS), 'layout']) {
      expect(existsSync(resolve(TEMPLATE_DIR, `${name}.html`)), name).toBe(true);
    }
  });

  it('escapes variables and refuses missing ones', () => {
    expect(renderTemplate('<p>{{name}}</p>', { name: '<b>&' })).toBe('<p>&lt;b&gt;&amp;</p>');
    expect(renderTemplate('<div>{{{content}}}</div>', { content: '<p>x</p>' })).toBe('<div><p>x</p></div>');
    expect(() => renderTemplate('{{missing}}', {})).toThrow(/missing/);
    expect(escapeHtml(`"'`)).toBe('&quot;&#39;');
  });

  it('renders the reset email with only the first name and a link', () => {
    const mail = renderMail(
      'password-reset',
      { firstName: 'Anna', link: 'https://ess.example/reset-password?token=abc&x=1', expiresMinutes: 30 },
      { accentColour: '#0F766E' },
    );
    expect(mail.subject).toBe('Reset your PeopleHub password');
    expect(mail.html).toContain('Hi Anna,');
    expect(mail.html).toContain('href="https://ess.example/reset-password?token=abc&amp;x=1"');
    expect(mail.html).toContain('<title>Reset your PeopleHub password</title>');
    expect(mail.html).toContain('#0F766E');
    expect(mail.text).toContain('Reset password: https://ess.example/reset-password?token=abc&x=1');
    expect(mail.text).toContain('30 minutes');
    expect(mail.text).not.toMatch(/<[a-z]/i);
  });

  it('turns HTML into readable text', () => {
    expect(htmlToText('<body><p>One</p><p>Two<br>Three</p></body>')).toBe('One\n\nTwo\nThree');
  });
});

describe('settings resolution', () => {
  it('accepts valid stored values, including null for nullable keys', () => {
    expect(resolveSetting('session.idleMinutes', 45)).toBe(45);
    expect(resolveSetting('ui.helpUrl', null)).toBeNull();
    expect(resolveSetting('workingAs.restrictedFeatures', ['PAYSLIPS'])).toEqual(['PAYSLIPS']);
  });

  it('rejects invalid stored values so the default applies', () => {
    expect(resolveSetting('session.idleMinutes', 'twenty')).toBeUndefined();
    expect(resolveSetting('workingAs.restrictedFeatures', ['NOPE'])).toBeUndefined();
    expect(defaultSettings()['workingAs.restrictedFeatures']).toEqual([...RESTRICTED_FEATURES]);
  });
});
