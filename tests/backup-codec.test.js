import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createCodec, isValidCollectionName, isValidDocId, SUB_PARENTS } from '../functions/backup.js';

// Stand-in for firebase-admin's Timestamp — same (seconds, nanoseconds)
// constructor shape, so the codec is exercised without initializing admin.
class FakeTimestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  toDate() {
    return new Date(this.seconds * 1000 + this.nanoseconds / 1e6);
  }
}

const codec = createCodec({ Timestamp: FakeTimestamp });

describe('backup codec', () => {
  it('round-trips Timestamps nested in maps and arrays', () => {
    const ts = new FakeTimestamp(1752800000, 123000000);
    const doc = {
      name: 'Acme',
      created_at: ts,
      history: [{ at: ts, note: 'x' }, { at: new FakeTimestamp(1700000000, 0) }],
      meta: { deep: { when: ts } },
    };
    const decoded = codec.decode(JSON.parse(JSON.stringify(codec.encode(doc))));
    expect(decoded.created_at).toBeInstanceOf(FakeTimestamp);
    expect(decoded.created_at.seconds).toBe(1752800000);
    expect(decoded.created_at.nanoseconds).toBe(123000000);
    expect(decoded.history[0].at).toBeInstanceOf(FakeTimestamp);
    expect(decoded.history[1].at.seconds).toBe(1700000000);
    expect(decoded.meta.deep.when).toBeInstanceOf(FakeTimestamp);
    expect(decoded.name).toBe('Acme');
  });

  it('the encoded form is what JSON survives — no raw Timestamp objects', () => {
    const enc = codec.encode({ at: new FakeTimestamp(5, 7) });
    expect(enc.at).toEqual({ __t: 'ts', s: 5, n: 7 });
  });

  it('leaves primitives, ISO strings, nulls and plain maps untouched', () => {
    const doc = {
      n: 42.5,
      b: true,
      s: 'hello',
      iso: '2026-07-18T10:00:00.000Z',
      nothing: null,
      plain: { seconds: 1, nanoseconds: 2 }, // looks ts-ish but has no toDate — must pass through
      arr: [1, 'two', null],
    };
    const decoded = codec.decode(JSON.parse(JSON.stringify(codec.encode(doc))));
    expect(decoded).toEqual(doc);
  });

  it('undefined encodes to null (Firestore never stores undefined)', () => {
    expect(codec.encode(undefined)).toBe(null);
    expect(codec.encode({ a: undefined }).a).toBe(null);
  });

  it('round-trips Date instances as Timestamps', () => {
    const d = new Date('2026-07-18T09:30:00.500Z');
    const decoded = codec.decode(JSON.parse(JSON.stringify(codec.encode({ at: d }))));
    expect(decoded.at).toBeInstanceOf(FakeTimestamp);
    expect(decoded.at.toDate().getTime()).toBe(d.getTime());
  });

  it('round-trips bytes via base64', () => {
    const buf = Buffer.from([1, 2, 3, 255]);
    const enc = JSON.parse(JSON.stringify(codec.encode({ blob: buf })));
    expect(enc.blob.__t).toBe('bytes');
    const decoded = codec.decode(enc);
    expect(Buffer.isBuffer(decoded.blob)).toBe(true);
    expect([...decoded.blob]).toEqual([1, 2, 3, 255]);
  });

  it('round-trips NaN and ±Infinity (JSON-hostile Firestore doubles)', () => {
    const doc = { bad: NaN, up: Infinity, down: -Infinity, nested: [{ x: NaN }] };
    const enc = codec.encode(doc);
    // Encoded form must be JSON-safe — this is what the callable transport requires.
    expect(enc.bad).toEqual({ __t: 'num', v: 'nan' });
    expect(enc.up).toEqual({ __t: 'num', v: 'inf' });
    expect(enc.down).toEqual({ __t: 'num', v: '-inf' });
    expect(JSON.stringify(enc)).not.toContain('null');
    const decoded = codec.decode(JSON.parse(JSON.stringify(enc)));
    expect(Number.isNaN(decoded.bad)).toBe(true);
    expect(decoded.up).toBe(Infinity);
    expect(decoded.down).toBe(-Infinity);
    expect(Number.isNaN(decoded.nested[0].x)).toBe(true);
  });

  it('decodes legacy untagged data unchanged (old backup files)', () => {
    const legacy = { date: { seconds: 123, nanoseconds: 0 }, amount: 100 };
    expect(codec.decode(legacy)).toEqual(legacy);
  });
});

describe('backup validation', () => {
  it('accepts the app collection names', () => {
    for (const name of ['projects', 'project_financials', 'chat_channels', 'timeLogs', 'userRoles']) {
      expect(isValidCollectionName(name)).toBe(true);
    }
  });

  it('rejects path-like or malformed collection names', () => {
    for (const name of ['', 'a/b', '..', 'x'.repeat(65), 'has space', null, undefined, 42]) {
      expect(isValidCollectionName(name)).toBe(false);
    }
  });

  it('validates doc ids', () => {
    expect(isValidDocId('abc-123_XYZ')).toBe(true);
    expect(isValidDocId('accounting_vouchers')).toBe(true);
    for (const id of ['', 'a/b', '.', '..', '__reserved__', null, 7]) {
      expect(isValidDocId(id)).toBe(false);
    }
  });

  it('knows the chat messages subcollection', () => {
    expect(SUB_PARENTS.chat_channels).toContain('messages');
  });
});
