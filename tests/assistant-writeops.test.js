import { describe, it, expect, vi } from 'vitest';
import { parseAssistantMessage } from '../src/utils/assistant/nlu.js';
import { executeAssistantIntent } from '../src/utils/assistant/executor.js';
import { applyPendingAction } from '../src/utils/assistant/writeOps.js';

const ctx = {
  clientNames: ['ACME Pvt Ltd'],
  vendorNames: ['Truss World'],
  employeeNames: ['Ramesh Kumar'],
  projectNames: ['Wedding Spectacular', 'Concert Aug'],
  inventoryNames: [],
};

const data = {
  projects: [
    { id: 'p1', project_name: 'Wedding Spectacular', client_id: 'c1', client_name: 'ACME Pvt Ltd', status: 'Quoted', total: 50000 },
    { id: 'p2', project_name: 'Concert Aug', client_id: 'c1', client_name: 'ACME Pvt Ltd', status: 'Confirmed', total: 100000 },
    { id: 'p3', project_name: 'Done Show', client_id: 'c1', client_name: 'ACME Pvt Ltd', status: 'Completed', total: 30000 },
  ],
  clients: [{ id: 'c1', name: 'ACME Pvt Ltd', type: 'Client' }],
  employees: [{ id: 'e1', name: 'Ramesh Kumar', role: 'tech', status: 'Active' }],
  expenses: [
    { id: 'x1', employee_id: 'e1', amount: 500, status: 'Pending', date: '2026-04-20', narration: 'Taxi', category: 'Travel' },
  ],
  payments: [],
  taxInvoices: [{ id: 'inv1', client_id: 'c1', client_name: 'ACME Pvt Ltd', invoice_no: 'INV/1', invoice_date: '2026-04-01', final_amount: 25000 }],
  purchaseInvoices: [],
  inventory: [],
  payouts: [],
  vendorPayments: [],
  journalEntries: [],
  hrLeaves: [
    { id: 'l1', employeeId: 'e1', type: 'Casual', startDate: '2026-05-01', endDate: '2026-05-02', reason: 'family', status: 'Pending' },
  ],
};

describe('Phase 2 NLU — write intents', () => {
  it('parses confirm project', () => {
    const r = parseAssistantMessage('confirm project Wedding Spectacular', ctx);
    expect(r.intent).toBe('project.confirm');
    expect(r.entities.projectName).toBe('Wedding Spectacular');
    expect(r.isWriteAction).toBe(true);
  });
  it('parses complete project', () => {
    const r = parseAssistantMessage('complete project Concert Aug', ctx);
    expect(r.intent).toBe('project.markCompleted');
  });
  it('parses close project', () => {
    const r = parseAssistantMessage('close project Done Show', { ...ctx, projectNames: ['Done Show'] });
    expect(r.intent).toBe('project.markClosed');
  });
  it('parses record payment', () => {
    const r = parseAssistantMessage('record payment from ACME Pvt Ltd', ctx);
    expect(r.intent).toBe('payment.record');
    expect(r.entities.clientName).toBe('ACME Pvt Ltd');
  });
  it('parses reject expense', () => {
    const r = parseAssistantMessage('reject expense of Ramesh Kumar', ctx);
    expect(r.intent).toBe('expense.disapprove');
  });
  it('parses approve leave', () => {
    const r = parseAssistantMessage('approve leave of Ramesh Kumar', ctx);
    expect(r.intent).toBe('leave.approve');
  });
});

describe('Phase 2 executor — pendingAction descriptors', () => {
  it('project.confirm produces transition descriptor', () => {
    const parsed = { intent: 'project.confirm', entities: { projectName: 'Wedding Spectacular' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('action');
    expect(r.pendingAction.kind).toBe('project.transition');
    expect(r.pendingAction.fromStatus).toBe('Quoted');
    expect(r.pendingAction.toStatus).toBe('Confirmed');
    expect(r.pendingAction.perm).toEqual(['projects', 'edit']);
  });
  it('project.markCompleted blocks invalid transition', () => {
    const parsed = { intent: 'project.markCompleted', entities: { projectName: 'Wedding Spectacular' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    // Wedding is Quoted → cannot complete; must error or block
    expect(r.type).toBe('error');
    expect(r.title).toMatch(/Cannot/);
  });
  it('project.markClosed requires close permission', () => {
    const parsed = { intent: 'project.markClosed', entities: { projectName: 'Done Show' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('action');
    expect(r.pendingAction.perm).toEqual(['projects', 'close']);
  });
  it('payment.record requires amount/mode/date slots', () => {
    const parsed = { intent: 'payment.record', entities: { clientName: 'ACME Pvt Ltd' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('action');
    expect(r.pendingAction.kind).toBe('payment.record');
    expect(r.pendingAction.requires).toEqual(['amount', 'mode', 'date']);
    expect(r.pendingAction.perm).toEqual(['finance', 'create']);
  });
  it('expense.disapprove requires reason slot', () => {
    const parsed = { intent: 'expense.disapprove', entities: { employeeName: 'Ramesh Kumar' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('action');
    expect(r.pendingAction.kind).toBe('expense.disapprove');
    expect(r.pendingAction.requires).toContain('reason');
  });
  it('leave.approve emits descriptor with pending leaves', () => {
    const parsed = { intent: 'leave.approve', entities: { employeeName: 'Ramesh Kumar' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('action');
    expect(r.pendingAction.items.length).toBe(1);
    expect(r.pendingAction.items[0].id).toBe('l1');
  });
});

// ── writeOps unit tests with stubbed Firestore ─────────────────────────────
function makeFb() {
  const writes = [];
  const adds = [];
  return {
    fb: { db: 'DB', appId: 'APP' },
    writes,
    adds,
    // patch firebase/firestore mocks below
  };
}

vi.mock('firebase/firestore', () => {
  const writes = [];
  const adds = [];
  return {
    doc: (...a) => ({ __doc: a.slice(-1)[0] }),
    collection: (...a) => ({ __col: a.slice(-1)[0] }),
    updateDoc: vi.fn(async (ref, data) => { writes.push({ ref, data }); }),
    addDoc: vi.fn(async (ref, data) => { adds.push({ ref, data }); return { id: `new_${adds.length}` }; }),
    serverTimestamp: () => 'TS',
    __getCalls: () => ({ writes, adds, reset: () => { writes.length = 0; adds.length = 0; } }),
  };
});

import * as fsMock from 'firebase/firestore';

describe('Phase 2 writeOps — RBAC + happy paths', () => {
  const fb = { db: {}, appId: 'APP' };
  beforeEachReset();

  it('approves expenses (admin)', async () => {
    const { writes } = fsMock.__getCalls();
    const action = {
      kind: 'approve_expenses',
      employeeId: 'e1', employeeName: 'Ramesh',
      items: [{ id: 'x1' }, { id: 'x2' }],
    };
    const log = vi.fn();
    const res = await applyPendingAction(fb, action, { logAction: log, role: 'admin' });
    expect(res.count).toBe(2);
    expect(writes.length).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][3]).toMatchObject({ via: 'assistant' });
  });

  it('blocks tech from approving expenses', async () => {
    const action = { kind: 'approve_expenses', items: [{ id: 'x1' }] };
    await expect(applyPendingAction(fb, action, { role: 'tech' })).rejects.toThrow(/denied/i);
  });

  it('disapprove requires reason', async () => {
    const action = { kind: 'expense.disapprove', items: [{ id: 'x1' }], perm: ['expenses', 'approve'] };
    await expect(applyPendingAction(fb, action, { role: 'admin', slots: {} })).rejects.toThrow(/reason/i);
  });

  it('disapprove writes status=Rejected with reason', async () => {
    beforeEachReset();
    const { writes } = fsMock.__getCalls();
    const action = { kind: 'expense.disapprove', items: [{ id: 'x1' }], perm: ['expenses', 'approve'] };
    const log = vi.fn();
    await applyPendingAction(fb, action, { role: 'admin', slots: { reason: 'duplicate' }, logAction: log });
    expect(writes[0].data.status).toBe('Rejected');
    expect(writes[0].data.rejection_reason).toBe('duplicate');
  });

  it('project.transition writes new status', async () => {
    beforeEachReset();
    const { writes } = fsMock.__getCalls();
    const action = {
      kind: 'project.transition',
      projectId: 'p1', projectName: 'Wedding',
      fromStatus: 'Quoted', toStatus: 'Confirmed',
      perm: ['projects', 'edit'], verb: 'confirm',
    };
    const res = await applyPendingAction(fb, action, { role: 'admin', logAction: vi.fn() });
    expect(writes[0].data.status).toBe('Confirmed');
    expect(res.summary).toMatch(/Confirmed/);
  });

  it('project.markClosed requires admin (manager denied)', async () => {
    const action = {
      kind: 'project.transition',
      projectId: 'p1', toStatus: 'Closed',
      perm: ['projects', 'close'], verb: 'close',
    };
    await expect(applyPendingAction(fb, action, { role: 'manager' })).rejects.toThrow(/denied/i);
    await expect(applyPendingAction(fb, action, { role: 'admin', logAction: vi.fn() })).resolves.toBeTruthy();
  });

  it('payment.record requires amount > 0', async () => {
    const action = { kind: 'payment.record', clientId: 'c1', clientName: 'ACME', perm: ['finance', 'create'] };
    await expect(applyPendingAction(fb, action, { role: 'admin', slots: {} })).rejects.toThrow(/Amount/i);
  });

  it('payment.record adds doc with assistant audit', async () => {
    beforeEachReset();
    const { adds } = fsMock.__getCalls();
    const action = {
      kind: 'payment.record', clientId: 'c1', clientName: 'ACME',
      perm: ['finance', 'create'], defaults: { date: '2026-04-25', mode: 'UPI' },
    };
    const log = vi.fn();
    const res = await applyPendingAction(fb, action, { role: 'admin', logAction: log, slots: { amount: 5000 } });
    expect(adds[0].data.amount).toBe(5000);
    expect(adds[0].data.client_id).toBe('c1');
    expect(adds[0].data.mode).toBe('UPI');
    expect(res.summary).toMatch(/5,000/);
    expect(log.mock.calls[0][3]).toMatchObject({ via: 'assistant' });
  });

  it('leave.reject requires reason', async () => {
    const action = { kind: 'leave.reject', items: [{ id: 'l1' }], perm: ['hr_leaves', 'approve'] };
    await expect(applyPendingAction(fb, action, { role: 'admin', slots: {} })).rejects.toThrow(/reason/i);
  });

  it('leave.approve writes Approved status', async () => {
    beforeEachReset();
    const { writes } = fsMock.__getCalls();
    const action = { kind: 'leave.approve', employeeName: 'R', items: [{ id: 'l1' }], perm: ['hr_leaves', 'approve'] };
    await applyPendingAction(fb, action, { role: 'admin', currentUserId: 'u1', logAction: vi.fn() });
    expect(writes[0].data.status).toBe('Approved');
    expect(writes[0].data.approvedBy).toBe('u1');
  });

  it('leave.approve denied for tech', async () => {
    const action = { kind: 'leave.approve', items: [{ id: 'l1' }], perm: ['hr_leaves', 'approve'] };
    await expect(applyPendingAction(fb, action, { role: 'tech' })).rejects.toThrow(/denied/i);
  });
});

function beforeEachReset() {
  if (fsMock.__getCalls) fsMock.__getCalls().reset();
}
