/**
 * Place-of-supply / GST-head resolution — pure and testable.
 *
 * WHY THIS EXISTS: sales and purchases use DIFFERENT vocabularies for the very
 * same concept, and mixing them silently mis-files tax.
 *
 *   tax_invoices      supply_type: 'IGST' | 'CGST_SGST'
 *                     split under  cgst_amount / sgst_amount / igst_amount
 *   purchase_invoices supply_type: 'intra' | 'inter' | 'unknown'
 *                     split under  gst_cgst / gst_sgst / gst_igst
 *
 * Comparing a PURCHASE supply_type against 'IGST' evaluates
 * `'inter' !== 'IGST'` → true → "intra", so every inter-state purchase gets
 * reported as CGST+SGST with IGST zero — wrong heads on GSTR-2/3B, i.e. a real
 * filing error. Both resolvers live here so neither surface has to remember
 * which vocabulary it is holding.
 *
 * Owner rule honoured throughout: GST is still computed and reported even when a
 * party has no GSTIN — a missing GSTIN changes the HEAD, never the amount.
 */
import { determineSupplyType, purchaseGstSplit } from './aiAccountant/knowledge';

const round2 = (v) => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** First two characters of a GSTIN = the state code. '' when absent. */
export const stateCodeOf = (gstin) => String(gstin || '').trim().substring(0, 2);

/**
 * The supply type actually applicable to a PURCHASE.
 * Trusts the value stored at entry; only re-derives when it is missing or
 * 'unknown', reusing determineSupplyType so the fallback matches how the
 * invoice would have been classified in the first place (org known + vendor
 * unregistered → 'intra', the app's B2C convention).
 */
export const resolvePurchaseSupplyType = (storedSupplyType, orgGstin, vendorGstin) => {
  const stored = String(storedSupplyType || '').toLowerCase();
  if (stored === 'intra' || stored === 'inter') return stored;
  const derived = determineSupplyType(orgGstin, vendorGstin);
  // determineSupplyType only says 'unknown' when the ORG GSTIN is missing. Default
  // to intra so the tax is still split and reported rather than silently dropped.
  return derived === 'unknown' ? 'intra' : derived;
};

/**
 * Resolve a purchase invoice's GST heads.
 * Prefers the split stored at entry, but only when it actually reconciles to the
 * invoice's gst_amount — purchaseGstSplit writes zeros for an 'unknown' supply
 * type, and a stored zero must never be mistaken for a genuine split.
 * @returns {{supplyType:'intra'|'inter', isIntra:boolean, taxable:number, gst:number, cgst:number, sgst:number, igst:number, splitSource:'stored'|'derived'}}
 */
export const resolvePurchaseGst = (pi, orgGstin, vendorGstin) => {
  const taxable = round2(num(pi?.amount));
  const gst = round2(num(pi?.gst_amount));
  const supplyType = resolvePurchaseSupplyType(pi?.supply_type, orgGstin, vendorGstin);
  const isIntra = supplyType === 'intra';

  const sc = num(pi?.gst_cgst);
  const ss = num(pi?.gst_sgst);
  const si = num(pi?.gst_igst);
  const storedTotal = round2(sc + ss + si);
  // A stored split is only usable when it sums to the GST AND sits on the heads
  // the resolved supply type calls for (a legacy row can hold the wrong heads).
  const headsMatch = isIntra ? si === 0 : (sc === 0 && ss === 0);
  const useStored = gst > 0 && Math.abs(storedTotal - gst) < 0.01 && headsMatch;

  if (useStored) {
    return { supplyType, isIntra, taxable, gst, cgst: round2(sc), sgst: round2(ss), igst: round2(si), splitSource: 'stored' };
  }
  const d = purchaseGstSplit(gst, supplyType);
  return { supplyType, isIntra, taxable, gst, cgst: d.cgst, sgst: d.sgst, igst: d.igst, splitSource: 'derived' };
};

/**
 * Resolve a tax invoice's GST heads (SALES vocabulary).
 * Uses the stored figures as booked; falls back to an exact halving so
 * cgst + sgst === gst to the paisa.
 * @returns {{isIGST:boolean, taxable:number, gst:number, cgst:number, sgst:number, igst:number}}
 */
export const resolveSalesGst = (inv) => {
  const taxable = round2(num(inv?.taxable));
  const gst = round2(num(inv?.gst_amount));
  const isIGST = String(inv?.supply_type || '') === 'IGST';
  if (isIGST) {
    const igst = inv?.igst_amount != null ? round2(num(inv.igst_amount)) : gst;
    return { isIGST, taxable, gst, cgst: 0, sgst: 0, igst };
  }
  const half = round2(gst / 2);
  const cgst = inv?.cgst_amount != null ? round2(num(inv.cgst_amount)) : half;
  const sgst = inv?.sgst_amount != null ? round2(num(inv.sgst_amount)) : round2(gst - half);
  return { isIGST, taxable, gst, cgst, sgst, igst: 0 };
};
