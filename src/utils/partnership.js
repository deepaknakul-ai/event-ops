/**
 * PARTNERSHIP — shared client helpers.
 *
 * A tenant declares its constitution once (settings/organization.firm_type,
 * chosen in the first-run wizard). Partnership behaviour — spend approvals,
 * dual sign-off, consent register, appropriation — activates only when the
 * firm is a partnership AND the partner registry has at least TWO active
 * partners, so an owner mid-setup is never locked out of their own books.
 *
 * The registry (settings/partnership.partners) is a MAP keyed by empId, not an
 * array, because firestore.rules must be able to ask `userEmpId() in partners`.
 *
 * Mirrored in firestore.rules (partnershipDoc()/isNamedPartner()/
 * partnershipActive()) — change both together.
 */

export const FIRM_TYPES = [
  { id: 'proprietorship', label: 'Proprietorship', hint: 'Single owner. The app behaves exactly as before.' },
  { id: 'partnership', label: 'Partnership', hint: 'Two or more partners share profit. Approvals, consent register and profit appropriation apply.' },
];

/** Active partner entries as [empId, partner] pairs. */
export const activePartners = (partnership) =>
  Object.entries(partnership?.partners || {}).filter(([, p]) => p && p.active !== false);

/**
 * Is the partnership machinery live? firm_type declared + registry enabled +
 * >= 2 active partners (Partnership Act needs two persons; below that the
 * firm keeps proprietor behaviour so setup can't strand the owner).
 */
export const partnershipActive = (orgSettings, partnership) =>
  (orgSettings?.firm_type === 'partnership')
  && partnership?.enabled !== false
  && activePartners(partnership).length >= 2;

/** Is this empId a named (active) partner? Approval power comes from HERE, not from role. */
export const isNamedPartner = (partnership, empId) =>
  !!empId && activePartners(partnership).some(([id]) => id === empId);

/** Does this amount need a partner's counter-approval before it is live? */
export const needsPartnerApproval = (amount, orgSettings, partnership) => {
  if (!partnershipActive(orgSettings, partnership)) return false;
  const threshold = Number(partnership?.approval_threshold);
  return Number.isFinite(threshold) && threshold > 0 && Number(amount) > threshold;
};

/**
 * Consent outcome — s.12(c) Partnership Act:
 *   ordinary matters    → majority of ACTIVE partners
 *   fundamental changes → consent of ALL active partners
 * Votes live as vote_{empId} fields on the consent doc (rules let each partner
 * write only their own). Returns the computed state; the doc's stored `status`
 * is stamped by whoever's client observes the outcome (and frozen by rules).
 */
export const computeConsentOutcome = (consent, partnership) => {
  const partnerIds = activePartners(partnership).map(([id]) => id);
  const total = partnerIds.length;
  let yes = 0; let no = 0;
  partnerIds.forEach((id) => {
    const v = consent?.[`vote_${id}`]?.vote;
    if (v === 'yes') yes += 1;
    else if (v === 'no') no += 1;
  });
  const pending = total - yes - no;
  const fundamental = consent?.category === 'fundamental';
  let outcome = 'open';
  if (fundamental) {
    if (no > 0) outcome = 'rejected';           // one dissent kills a fundamental change
    else if (yes === total) outcome = 'passed'; // ALL must consent (s.12(c), s.31)
  } else {
    const majority = Math.floor(total / 2) + 1;
    if (yes >= majority) outcome = 'passed';
    else if (no >= total - majority + 1) outcome = 'rejected'; // majority no longer reachable
  }
  return { outcome, yes, no, pending, total, needed: fundamental ? total : Math.floor(total / 2) + 1 };
};

/** Deterministic doc id for a dual-sign pending action (rules get() by this id). */
export const pendingActionId = (type, key) => `${type}_${String(key).replace(/[^\w-]/g, '_')}`;

/** Is a pending action fully signed by two DIFFERENT named partners? */
export const isDualSigned = (action) =>
  !!(action?.sig1?.emp && action?.sig2?.emp && action.sig1.emp !== action.sig2.emp);
