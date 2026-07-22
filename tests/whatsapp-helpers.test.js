import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  normalizePhone, parseAllowlist, verifySignature, extractInbound, splitForWhatsApp,
} from '../functions/whatsapp.js';

describe('normalizePhone', () => {
  it.each([
    ['+91 98765-43210', '9876543210'],
    ['919876543210', '9876543210'],
    ['9876543210', '9876543210'],
    ['0091 98765 43210', '9876543210'],
  ])('normalizes %j to %j', (input, want) => {
    expect(normalizePhone(input)).toBe(want);
  });

  it('handles empty/null', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
  });
});

describe('parseAllowlist', () => {
  it('parses phone = empId lines and normalizes phones', () => {
    const map = parseAllowlist('+91 9876543210 = emp_1\n918888877777=emp_2\n\nbadline\n');
    expect(map['9876543210']).toBe('emp_1');
    expect(map['8888877777']).toBe('emp_2');
    expect(Object.keys(map)).toHaveLength(2);
  });

  it('ignores short/invalid phone keys', () => {
    expect(parseAllowlist('12345 = emp_x')).toEqual({});
  });
});

describe('verifySignature', () => {
  const secret = 'shhh';
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySignature(secret, Buffer.from('{"a":2}'), sig)).toBe(false);
  });

  it('rejects missing/malformed headers', () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, 'md5=abc')).toBe(false);
  });

  it('skips verification when no app secret configured', () => {
    expect(verifySignature('', body, undefined)).toBe(true);
  });
});

describe('extractInbound', () => {
  it('pulls messages with their phone_number_id and ignores status-only changes', () => {
    const payload = {
      entry: [{
        changes: [
          { value: { metadata: { phone_number_id: 'PNI1' }, statuses: [{ id: 'x' }] } },
          {
            value: {
              metadata: { phone_number_id: 'PNI1' },
              contacts: [{ wa_id: '919876543210', profile: { name: 'Deepak' } }],
              messages: [{ id: 'wamid.1', from: '919876543210', type: 'text', text: { body: 'balance?' } }],
            },
          },
        ],
      }],
    };
    const got = extractInbound(payload);
    expect(got).toHaveLength(1);
    expect(got[0].phoneNumberId).toBe('PNI1');
    expect(got[0].msg.id).toBe('wamid.1');
    expect(got[0].contacts[0].profile.name).toBe('Deepak');
  });

  it('returns empty for malformed payloads', () => {
    expect(extractInbound({})).toEqual([]);
    expect(extractInbound({ entry: [{}] })).toEqual([]);
  });
});

describe('splitForWhatsApp', () => {
  it('keeps short messages whole', () => {
    expect(splitForWhatsApp('hello')).toEqual(['hello']);
  });

  it('splits long text on newlines under the limit', () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} — some ledger row content`).join('\n');
    const parts = splitForWhatsApp(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3800);
    expect(parts.join('\n').replace(/\n+/g, '\n')).toContain('line 299');
  });
});
