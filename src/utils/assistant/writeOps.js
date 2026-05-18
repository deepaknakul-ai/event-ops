// Single place for all chat-driven Firestore mutations.
//
// Every function here is invoked with:
//   - { db, appId }      — Firestore handles
//   - action             — pendingAction descriptor produced by executor.js
//   - context            — { logAction, currentUserId, slots? }
//
// All writes:
//   - Set updated_at / approved_at / created_at as appropriate
//   - Always write an audit log entry with `via: 'assistant'`
//   - Throw on validation failure; the caller (AppAssistant) shows the toast
//
// NEW kinds supported:
//   - approve_expenses        (legacy, also handled here)
//   - expense.disapprove
//   - project.transition
//   - payment.record
//   - leave.approve
//   - leave.reject

import { doc, updateDoc, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { can } from '../permissions';

const colRef = (db, appId, name) => collection(db, 'artifacts', appId, 'public', 'data', name);
const docRef = (db, appId, name, id) => doc(db, 'artifacts', appId, 'public', 'data', name, id);

function ensurePerm(role, perm) {
  if (!perm || perm.length < 2) return true;
  if (!can(role, perm[0], perm[1])) {
    const err = new Error('Access denied for this action.');
    err.code = 'permission-denied';
    throw err;
  }
  return true;
}

async function safeLog(logAction, ...args) {
  if (!logAction) return;
  try { await logAction(...args); } catch { /* non-fatal */ }
}

// ── approve_expenses (legacy + bulk) ──────────────────────────────────────
async function approveExpenses({ db, appId }, action, { logAction, role }) {
  ensurePerm(role, ['expenses', 'approve']);
  const ids = (action.items || []).map((x) => x.id);
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await updateDoc(docRef(db, appId, 'expenses', id), {
      status: 'Approved',
      approved_at: new Date().toISOString(),
    });
    // eslint-disable-next-line no-await-in-loop
    await safeLog(logAction, 'expenses', 'approve', id, { via: 'assistant', employee_id: action.employeeId }, 'Expense');
  }
  return { count: ids.length, summary: `Approved ${ids.length} expense(s) for ${action.employeeName}.` };
}

async function disapproveExpenses({ db, appId }, action, { logAction, role, slots = {} }) {
  ensurePerm(role, action.perm || ['expenses', 'approve']);
  const reason = String(slots.reason || '').trim();
  if (!reason) {
    const err = new Error('Rejection reason is required.');
    err.code = 'missing-slot';
    throw err;
  }
  const ids = (action.items || []).map((x) => x.id);
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await updateDoc(docRef(db, appId, 'expenses', id), {
      status: 'Rejected',
      rejected_at: new Date().toISOString(),
      rejection_reason: reason,
    });
    // eslint-disable-next-line no-await-in-loop
    await safeLog(logAction, 'expenses', 'reject', id, { via: 'assistant', employee_id: action.employeeId, reason }, 'Expense');
  }
  return { count: ids.length, summary: `Rejected ${ids.length} expense(s) for ${action.employeeName}.` };
}

// ── project.transition ───────────────────────────────────────────────────
async function projectTransition({ db, appId }, action, { logAction, role }) {
  ensurePerm(role, action.perm || ['projects', 'edit']);
  const update = {
    status: action.toStatus,
    updated_at: new Date().toISOString(),
  };
  if (action.toStatus === 'Closed') update.closed_at = new Date().toISOString();
  if (action.toStatus === 'Completed') update.completed_at = new Date().toISOString();
  await updateDoc(docRef(db, appId, 'projects', action.projectId), update);
  await safeLog(logAction, 'projects', action.verb || 'transition', action.projectId, {
    via: 'assistant', from: action.fromStatus, to: action.toStatus,
  }, `Project ${action.projectName}: ${action.fromStatus} → ${action.toStatus}`);
  return { summary: `${action.projectName} marked ${action.toStatus}.` };
}

// ── payment.record ───────────────────────────────────────────────────────
async function paymentRecord({ db, appId }, action, { logAction, role, currentUserId, slots = {} }) {
  ensurePerm(role, action.perm || ['finance', 'create']);
  const amount = Number(slots.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('Amount must be a positive number.');
    err.code = 'missing-slot';
    throw err;
  }
  const date = slots.date || (action.defaults && action.defaults.date) || new Date().toISOString().slice(0, 10);
  const mode = slots.mode || (action.defaults && action.defaults.mode) || 'Bank Transfer';
  const data = {
    client_id: action.clientId,
    client_name: action.clientName,
    project_id: slots.projectId || 'general',
    amount,
    date,
    mode,
    reference: slots.reference || '',
    remarks: slots.remarks || 'Recorded via assistant',
    created_at: new Date().toISOString(),
    created_by: currentUserId || null,
    updated_at: new Date().toISOString(),
  };
  const ref = await addDoc(colRef(db, appId, 'payments'), data);
  await safeLog(logAction, 'payments', 'receive_payment', ref.id, { via: 'assistant', ...data }, `Payment from ${action.clientName}`);
  return { id: ref.id, summary: `Recorded ₹${amount.toLocaleString('en-IN')} payment from ${action.clientName}.` };
}

// ── leave.approve / leave.reject ─────────────────────────────────────────
async function leaveDecision({ db, appId }, action, { logAction, role, currentUserId, slots = {} }) {
  ensurePerm(role, action.perm || ['hr_leaves', 'approve']);
  const newStatus = action.kind === 'leave.approve' ? 'Approved' : 'Rejected';
  if (newStatus === 'Rejected' && !String(slots.reason || '').trim()) {
    const err = new Error('Rejection reason is required.');
    err.code = 'missing-slot';
    throw err;
  }
  const ids = (action.items || []).map((x) => x.id);
  for (const id of ids) {
    const update = {
      status: newStatus,
      approvedBy: currentUserId || null,
      approvedAt: new Date().toISOString(),
    };
    if (newStatus === 'Rejected') update.rejection_reason = slots.reason;
    // eslint-disable-next-line no-await-in-loop
    await updateDoc(docRef(db, appId, 'leaves', id), update);
    // eslint-disable-next-line no-await-in-loop
    await safeLog(logAction, 'leaves', newStatus.toLowerCase(), id, { via: 'assistant' }, `Leave ${newStatus}`);
  }
  return { count: ids.length, summary: `${newStatus} ${ids.length} leave(s) for ${action.employeeName}.` };
}

// Suppress lint warnings about serverTimestamp being unused — kept for future writes.
void serverTimestamp;

/**
 * Dispatch a pending action.
 * @param {{db, appId}} fb
 * @param {object} action
 * @param {{ logAction, role, currentUserId, slots }} ctx
 * @returns {Promise<{summary:string, count?:number, id?:string}>}
 */
export async function applyPendingAction(fb, action, ctx) {
  if (!action || !action.kind) throw new Error('Invalid action.');
  switch (action.kind) {
    case 'approve_expenses':   return approveExpenses(fb, action, ctx);
    case 'expense.disapprove': return disapproveExpenses(fb, action, ctx);
    case 'project.transition': return projectTransition(fb, action, ctx);
    case 'payment.record':     return paymentRecord(fb, action, ctx);
    case 'leave.approve':
    case 'leave.reject':       return leaveDecision(fb, action, ctx);
    default: throw new Error(`Unsupported action kind: ${action.kind}`);
  }
}

export default applyPendingAction;
