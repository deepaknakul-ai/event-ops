import { describe, it, expect } from 'vitest';
import { extractParty, resolveParty } from '../src/utils/aiAccountant/party.js';

const CTX = { partyNames: ['Acme Corp Pvt Ltd', 'ABC Events', 'SuppliCo', 'Rahul Sharma'] };

describe('resolveParty', () => {
  it('returns raw when no context', () => {
    expect(resolveParty('Acme', {})).toBe('Acme');
  });
  it('matches exact case-insensitive', () => {
    expect(resolveParty('acme corp pvt ltd', CTX)).toBe('Acme Corp Pvt Ltd');
  });
  it('matches starts-with', () => {
    expect(resolveParty('acme', CTX)).toBe('Acme Corp Pvt Ltd');
  });
  it('matches via token overlap', () => {
    expect(resolveParty('rahul', CTX)).toBe('Rahul Sharma');
  });
});

describe('extractParty', () => {
  it('finds known name in free text', () => {
    expect(extractParty('received 50000 from Acme Corp Pvt Ltd today', CTX)).toBe('Acme Corp Pvt Ltd');
  });
  it('finds known name via partial token', () => {
    expect(extractParty('paid 10k to Suppli', CTX)).toBe('SuppliCo');
  });
  it('extracts after "from"', () => {
    expect(extractParty('50000 from Unknown Party', { partyNames: [] })).toMatch(/Unknown Party/i);
  });
  it('returns empty for pure action text', () => {
    expect(extractParty('paid 5000', CTX)).toBe('');
  });
});
