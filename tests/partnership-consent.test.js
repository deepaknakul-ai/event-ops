import { describe, it, expect } from 'vitest';
import {
  partnershipActive, isNamedPartner, needsPartnerApproval,
  computeConsentOutcome, pendingActionId, isDualSigned, activePartners,
} from '../src/utils/partnership.js';

// s.12(c) Partnership Act: ordinary matters by MAJORITY of partners;
// fundamental changes (change in the nature of the business, admitting a
// partner s.31) only with the consent of ALL.

const org = { firm_type: 'partnership' };
const registry = {
  enabled: true,
  approval_threshold: 50000,
  partners: {
    A: { name: 'A', active: true },
    B: { name: 'B', active: true },
    C: { name: 'C', active: true },
  },
};

describe('partnershipActive — when the machinery is live', () => {
  it('on: partnership + enabled + >=2 active partners', () => {
    expect(partnershipActive(org, registry)).toBe(true);
  });
  it('off for a proprietorship regardless of registry', () => {
    expect(partnershipActive({ firm_type: 'proprietorship' }, registry)).toBe(false);
  });
  it('off with fewer than 2 active partners (mid-setup safety)', () => {
    const one = { ...registry, partners: { A: { active: true }, B: { active: false } } };
    expect(partnershipActive(org, one)).toBe(false);
  });
  it('off when firm_type not yet chosen', () => {
    expect(partnershipActive({}, registry)).toBe(false);
    expect(partnershipActive(undefined, registry)).toBe(false);
  });
});

describe('needsPartnerApproval — the spend threshold', () => {
  it('above threshold → yes; at/below → no', () => {
    expect(needsPartnerApproval(50001, org, registry)).toBe(true);
    expect(needsPartnerApproval(50000, org, registry)).toBe(false);
    expect(needsPartnerApproval(100, org, registry)).toBe(false);
  });
  it('never for a proprietorship or unset threshold', () => {
    expect(needsPartnerApproval(999999, { firm_type: 'proprietorship' }, registry)).toBe(false);
    expect(needsPartnerApproval(999999, org, { ...registry, approval_threshold: 0 })).toBe(false);
  });
});

describe('isNamedPartner', () => {
  it('active partner yes, retired partner no, stranger no', () => {
    const reg = { ...registry, partners: { ...registry.partners, D: { name: 'Retired', active: false } } };
    expect(isNamedPartner(reg, 'A')).toBe(true);
    expect(isNamedPartner(reg, 'D')).toBe(false);
    expect(isNamedPartner(reg, 'X')).toBe(false);
    expect(isNamedPartner(reg, null)).toBe(false);
  });
});

describe('computeConsentOutcome — ordinary (majority of 3 → 2 needed)', () => {
  it('2 yes → passed even with one silent', () => {
    const c = { category: 'ordinary', vote_A: { vote: 'yes' }, vote_B: { vote: 'yes' } };
    expect(computeConsentOutcome(c, registry)).toMatchObject({ outcome: 'passed', yes: 2, needed: 2 });
  });
  it('1 yes 1 no → still open (third vote decides)', () => {
    const c = { category: 'ordinary', vote_A: { vote: 'yes' }, vote_B: { vote: 'no' } };
    expect(computeConsentOutcome(c, registry).outcome).toBe('open');
  });
  it('2 no → rejected (majority unreachable)', () => {
    const c = { category: 'ordinary', vote_A: { vote: 'no' }, vote_B: { vote: 'no' } };
    expect(computeConsentOutcome(c, registry).outcome).toBe('rejected');
  });
});

describe('computeConsentOutcome — fundamental (ALL must consent, s.12(c)/s.31)', () => {
  it('all 3 yes → passed', () => {
    const c = { category: 'fundamental', vote_A: { vote: 'yes' }, vote_B: { vote: 'yes' }, vote_C: { vote: 'yes' } };
    expect(computeConsentOutcome(c, registry)).toMatchObject({ outcome: 'passed', needed: 3 });
  });
  it('2 yes + 1 silent → still open — majority is NOT enough', () => {
    const c = { category: 'fundamental', vote_A: { vote: 'yes' }, vote_B: { vote: 'yes' } };
    expect(computeConsentOutcome(c, registry).outcome).toBe('open');
  });
  it('a single dissent rejects immediately', () => {
    const c = { category: 'fundamental', vote_A: { vote: 'yes' }, vote_B: { vote: 'no' } };
    expect(computeConsentOutcome(c, registry).outcome).toBe('rejected');
  });
  it('a retired partner\'s stale vote does not count', () => {
    const reg = { ...registry, partners: { A: { active: true }, B: { active: true }, C: { active: false } } };
    const c = { category: 'fundamental', vote_A: { vote: 'yes' }, vote_B: { vote: 'yes' }, vote_C: { vote: 'no' } };
    expect(computeConsentOutcome(c, reg).outcome).toBe('passed'); // C no longer a voter
  });
});

describe('dual-sign helpers', () => {
  it('pendingActionId is deterministic and rule-safe', () => {
    expect(pendingActionId('fy_close', '2025-26')).toBe('fy_close_2025-26');
    expect(pendingActionId('invoice_cancel', 'gst 26-27/009')).toBe('invoice_cancel_gst_26-27_009');
  });
  it('isDualSigned needs two DIFFERENT signers', () => {
    expect(isDualSigned({ sig1: { emp: 'A' }, sig2: { emp: 'B' } })).toBe(true);
    expect(isDualSigned({ sig1: { emp: 'A' }, sig2: { emp: 'A' } })).toBe(false); // self-countersign
    expect(isDualSigned({ sig1: { emp: 'A' }, sig2: null })).toBe(false);
    expect(isDualSigned(null)).toBe(false);
  });
});

describe('activePartners ordering stability', () => {
  it('returns entries usable for consistent UI listing', () => {
    expect(activePartners(registry).map(([id]) => id)).toEqual(['A', 'B', 'C']);
  });
});
