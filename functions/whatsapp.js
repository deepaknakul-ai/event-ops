/**
 * WhatsApp AI copilot — Meta WhatsApp Cloud API webhook + processing.
 *
 * Flow: whatsappWebhook (onRequest) verifies the callback + signature,
 * dedupes by wamid and stores each inbound message as a wa_conversations doc;
 * the onWaMessageCreated Firestore trigger then processes it (books Q&A via
 * the same STATIC_QA_PROMPT/digest path as aiAnswerQuery, or invoice photo →
 * parked journal draft) and replies through the Cloud API. Split this way so
 * Meta's ~15s webhook timeout never races Claude.
 *
 * Config doc (admin-written, admin-read): settings/whatsapp
 *   { enabled, access_token, phone_number_id, app_secret, verify_token,
 *     allowed_numbers (text: one "+91XXXXXXXXXX = EMP_ID" per line, optional
 *     — employees are matched by mobile1 automatically), qa_roles }
 * Inert until that doc exists with enabled=true (same recipe as
 * settings/communication for email).
 *
 * Only phone numbers resolving to an employee (mobile1 match or allowlist)
 * get answers; books Q&A additionally requires a role in qa_roles
 * (default admin/accountant — mirrors aiAnswerQuery). AI usage meters into
 * the shared ai_usage monthly doc; per-number rate limit doc rl_wa_<last10>.
 */
const { createHmac, timingSafeEqual } = require('crypto');

const GRAPH = 'https://graph.facebook.com/v21.0';
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const MEDIA_TYPES = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'application/pdf': 'document' };
const HELP_TEXT = [
  'Namaste! I am your books copilot. You can:',
  '• Ask questions — "Acme ka balance kya hai", "is month ka GST kitna banta hai", "kal ke events?"',
  '• Send an invoice photo/PDF — I will draft the entry for approval in the app.',
  'Answers come from your live books. Replies may take a few seconds.',
].join('\n');

// Digits-only, last 10 — matches free-form Indian numbers stored in
// employees.mobile1 ("+91 98765-43210" and "9876543210" both → 9876543210).
function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.slice(-10);
}

// allowed_numbers text field: one mapping per line, "<phone> = <emp doc id>".
function parseAllowlist(text) {
  const map = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.split('=');
    if (m.length === 2) {
      const key = normalizePhone(m[0]);
      const val = m[1].trim();
      if (key.length === 10 && val) map[key] = val;
    }
  }
  return map;
}

function verifySignature(appSecret, rawBody, signatureHeader) {
  if (!appSecret) return true; // not configured — skip (webhook still gated by verify_token at subscribe time)
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = signatureHeader.slice(7);
  if (expected.length !== got.length) return false;
  try { return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex')); } catch { return false; }
}

// Pull the messages out of a webhook POST payload (statuses/read receipts are ignored).
function extractInbound(body) {
  const out = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const phoneNumberId = v.metadata && v.metadata.phone_number_id;
      for (const msg of v.messages || []) {
        out.push({ phoneNumberId, msg, contacts: v.contacts || [] });
      }
    }
  }
  return out;
}

function splitForWhatsApp(text, limit = 3800) {
  const s = String(text || '').trim();
  if (s.length <= limit) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function createWhatsApp({ admin, db, logger, Anthropic, listAppIds, sanitize, books }) {
  const {
    STATIC_QA_PROMPT, LLM_INVOICE_SCHEMA, STATIC_INVOICE_PROMPT,
    sanitizeLlmInvoice, supportsAdaptiveThinking,
  } = sanitize;

  const dataPath = (appId) => `artifacts/${appId}/public/data`;
  // phone_number_id → { appId, cfg, at } cache (5 min) for tenant routing.
  const tenantCache = new Map();

  async function readWaConfig(appId) {
    const snap = await db.doc(`${dataPath(appId)}/settings/whatsapp`).get();
    return snap.exists ? snap.data() : null;
  }

  async function resolveTenant(phoneNumberId) {
    const hit = tenantCache.get(phoneNumberId);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit;
    for (const appId of await listAppIds()) {
      const cfg = await readWaConfig(appId);
      if (cfg && cfg.phone_number_id === phoneNumberId) {
        const entry = { appId, cfg, at: Date.now() };
        tenantCache.set(phoneNumberId, entry);
        return entry;
      }
    }
    return null;
  }

  async function sendText(cfg, to, text) {
    for (const part of splitForWhatsApp(text)) {
      const res = await fetch(`${GRAPH}/${cfg.phone_number_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: part } }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`WhatsApp send failed HTTP ${res.status}: ${err.slice(0, 300)}`);
      }
    }
  }

  async function resolveSender(appId, cfg, fromPhone) {
    const key = normalizePhone(fromPhone);
    const allow = parseAllowlist(cfg.allowed_numbers);
    let empId = allow[key] || null;
    if (!empId) {
      const emps = await db.collection(`${dataPath(appId)}/employees`).get();
      const match = emps.docs.find((d) => normalizePhone(d.data().mobile1) === key && key.length === 10);
      if (match) empId = match.id;
    }
    if (!empId) return null;
    const empSnap = await db.doc(`${dataPath(appId)}/employees/${empId}`).get();
    if (!empSnap.exists) return null;
    const emp = empSnap.data();
    if ((emp.status || 'Active') !== 'Active') return null;
    return { empId, name: emp.name || '', role: emp.role || '' };
  }

  // ── AI config / metering (mirrors aiAnswerQuery conventions) ─────────────
  async function readAiConfig(appId) {
    const snap = await db.doc(`${dataPath(appId)}/settings/ai`).get();
    const cfg = snap.exists ? snap.data() : {};
    if (!cfg.enabled || !cfg.api_key) return null;
    return cfg;
  }

  async function checkRateAndBudget(appId, cfg, phoneKey) {
    const month = new Date().toISOString().slice(0, 7);
    const usageRef = db.doc(`${dataPath(appId)}/ai_usage/usage_${month}`);
    const usage = await usageRef.get();
    const budget = parseInt(cfg.monthly_token_budget, 10) || 2000000;
    if (usage.exists && (usage.data().tokens_total || 0) >= budget) return { ok: false, reason: 'budget' };
    const rpm = parseInt(cfg.per_user_rpm, 10) || 6;
    const minute = new Date().toISOString().slice(0, 16);
    const rlRef = db.doc(`${dataPath(appId)}/ai_usage/rl_wa_${phoneKey}`);
    const allowed = await db.runTransaction(async (tx) => {
      const rl = await tx.get(rlRef);
      const cur = rl.exists && rl.data().minute === minute ? (rl.data().count || 0) : 0;
      if (cur >= rpm) return false;
      tx.set(rlRef, { minute, count: cur + 1, updated_at: new Date().toISOString() });
      return true;
    });
    return allowed ? { ok: true } : { ok: false, reason: 'rate' };
  }

  async function meterUsage(appId, modelId, resp) {
    const u = (resp && resp.usage) || {};
    const month = new Date().toISOString().slice(0, 7);
    await db.doc(`${dataPath(appId)}/ai_usage/usage_${month}`).set({
      tokens_in: admin.firestore.FieldValue.increment(u.input_tokens || 0),
      tokens_out: admin.firestore.FieldValue.increment(u.output_tokens || 0),
      tokens_total: admin.firestore.FieldValue.increment(
        (u.input_tokens || 0) + (u.output_tokens || 0) +
        (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)),
      calls: admin.firestore.FieldValue.increment(1),
      last_call_at: new Date().toISOString(),
      last_model: modelId,
    }, { merge: true });
  }

  // ── Books digest (server-side twin of the client's snapshot → digest) ────
  const digestCache = new Map(); // appId → { digest, at }

  async function buildDigest(appId) {
    const hit = digestCache.get(appId);
    if (hit && Date.now() - hit.at < 3 * 60 * 1000) return hit.digest;
    const col = async (name) => (await db.collection(`${dataPath(appId)}/${name}`).get())
      .docs.map((d) => ({ id: d.id, ...d.data() }));
    const [clients, projects, taxInvoices, purchaseInvoices, payments, vendorPayments,
      payouts, expenses, advances, employees, chartOfAccounts, openingBalances,
      manualJournalEntries, fiscalYearClosings, partyAccounts] = await Promise.all([
      col('clients'), col('projects'), col('tax_invoices'), col('purchase_invoices'),
      col('payments'), col('vendor_payments'), col('payouts'), col('expenses'),
      col('advances'), col('employees'), col('chart_of_accounts'), col('opening_balances'),
      col('journal_entries'), col('fiscal_year_closings'), col('party_accounts'),
    ]);
    const snapshot = books.buildAccountingSnapshot({
      clients, projects, taxInvoices, purchaseInvoices, payments, vendorPayments,
      payouts, expenses, advances, employees, chartOfAccounts, openingBalances,
      manualJournalEntries, fiscalYearClosings, partyAccounts, fyFilter: 'all',
    });
    const digest = books.buildBooksDigest(snapshot, {});
    digestCache.set(appId, { digest, at: Date.now() });
    return digest;
  }

  async function answerQuestion(appId, aiCfg, question, history) {
    const digest = await buildDigest(appId);
    const modelId = (typeof aiCfg.model === 'string' && aiCfg.model.trim()) || 'claude-opus-4-8';
    const client = new Anthropic({ apiKey: aiCfg.api_key, timeout: 45000, maxRetries: 1 });
    const historyBlock = history.length
      ? `\n\n<recent_conversation>\n${history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join('\n')}\n</recent_conversation>`
      : '';
    const resp = await client.messages.create({
      model: modelId,
      max_tokens: 1000,
      ...(supportsAdaptiveThinking(modelId) ? { thinking: { type: 'adaptive' } } : {}),
      system: [{ type: 'text', text: STATIC_QA_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `<question>\n${question.slice(0, 500)}\n</question>${historyBlock}\n\n<books_digest>\n${JSON.stringify(digest).slice(0, 60000)}\n</books_digest>`,
      }],
    });
    await meterUsage(appId, modelId, resp);
    if (resp.stop_reason === 'refusal') return { text: 'I cannot answer that from the books.', modelId };
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, 4000);
    return { text: text || 'No answer produced — try rephrasing.', modelId };
  }

  // ── Invoice media → parked journal draft ─────────────────────────────────
  async function downloadMedia(cfg, mediaId) {
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${cfg.access_token}` } });
    if (!metaRes.ok) throw new Error(`media meta HTTP ${metaRes.status}`);
    const meta = await metaRes.json();
    if (!MEDIA_TYPES[meta.mime_type]) return { unsupported: meta.mime_type };
    if ((meta.file_size || 0) > MEDIA_MAX_BYTES) return { tooBig: true };
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.access_token}` } });
    if (!binRes.ok) throw new Error(`media download HTTP ${binRes.status}`);
    const buf = Buffer.from(await binRes.arrayBuffer());
    return { buf, mime: meta.mime_type };
  }

  async function extractInvoiceToDraft(appId, aiCfg, media, sender, caption) {
    const modelId = (typeof aiCfg.model === 'string' && aiCfg.model.trim()) || 'claude-opus-4-8';
    const client = new Anthropic({ apiKey: aiCfg.api_key, timeout: 90000, maxRetries: 0 });
    const kind = MEDIA_TYPES[media.mime];
    const fileBlock = kind === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: media.mime, data: media.buf.toString('base64') } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: media.buf.toString('base64') } };
    const resp = await client.messages.create({
      model: modelId,
      max_tokens: 4000,
      ...(supportsAdaptiveThinking(modelId) ? { thinking: { type: 'adaptive' } } : {}),
      system: [{ type: 'text', text: STATIC_INVOICE_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: LLM_INVOICE_SCHEMA } },
      messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: `<invoice>\nExtract this supplier invoice.${caption ? ` Sender note: ${caption.slice(0, 200)}` : ''}\n</invoice>` }] }],
    });
    await meterUsage(appId, modelId, resp);
    if (resp.stop_reason === 'refusal' || resp.stop_reason === 'max_tokens') {
      return { error: 'The document could not be read as an invoice.' };
    }
    const rawText = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let inv;
    try { inv = sanitizeLlmInvoice(JSON.parse(rawText)); } catch { return { error: 'Could not parse the invoice.' }; }

    // Store the original file next to app-made draft attachments.
    const ts = Date.now();
    const ext = media.mime === 'application/pdf' ? 'pdf' : media.mime.split('/')[1];
    const storagePath = `artifacts/${appId}/journal_drafts/wa_${ts}.${ext}`;
    await admin.storage().bucket().file(storagePath).save(media.buf, { contentType: media.mime });

    const vendor = inv.vendor_name || inv.party_name || 'Unknown Vendor';
    const total = Number(inv.grand_total || inv.total || 0);
    const draft = {
      date: inv.invoice_date || new Date().toISOString().slice(0, 10),
      narration: `Purchase invoice ${inv.invoice_no || ''} from ${vendor} (via WhatsApp, sent by ${sender.name})`.trim(),
      party_name: vendor,
      party_type: 'vendor',
      entries: total > 0 ? [
        { account: 'Purchases', debit: total, credit: 0 },
        { account: `Party: ${vendor}`, debit: 0, credit: total },
      ] : [],
      status: 'parked',
      origin: 'whatsapp',
      source: 'whatsapp_invoice',
      requires_approval: true,
      approval_status: 'pending',
      ai_model: modelId,
      ai_meta: JSON.parse(JSON.stringify(inv)),
      ai_issues: total > 0 ? [] : ['Total could not be extracted — entries left empty'],
      attachments: [{ path: storagePath, name: `wa_${ts}.${ext}`, type: media.mime }],
      currency: 'INR',
      fx_rate_to_inr: 1,
      created_by: `whatsapp:${sender.empId}`,
      created_at: new Date().toISOString(),
    };
    const ref = await db.collection(`${dataPath(appId)}/journal_drafts`).add(draft);
    return { draftId: ref.id, vendor, total, invoiceNo: inv.invoice_no || '—' };
  }

  // ── Webhook handlers ──────────────────────────────────────────────────────
  async function handleWebhook(req, res) {
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token) {
        for (const appId of await listAppIds()) {
          const cfg = await readWaConfig(appId);
          if (cfg && cfg.verify_token && cfg.verify_token === token) {
            logger.info(`whatsappWebhook: verified subscription for ${appId}`);
            res.status(200).send(challenge);
            return;
          }
        }
      }
      res.status(403).send('Verification failed');
      return;
    }
    if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

    const inbound = extractInbound(req.body || {});
    if (!inbound.length) { res.status(200).send('ok'); return; }

    for (const { phoneNumberId, msg, contacts } of inbound) {
      try {
        const tenant = await resolveTenant(phoneNumberId);
        if (!tenant) { logger.warn(`whatsappWebhook: no tenant for phone_number_id ${phoneNumberId}`); continue; }
        if (!verifySignature(tenant.cfg.app_secret, req.rawBody, req.get('X-Hub-Signature-256'))) {
          logger.warn('whatsappWebhook: bad signature — dropping'); continue;
        }
        if (!tenant.cfg.enabled) continue;
        const profileName = (contacts.find((c) => c.wa_id === msg.from) || {}).profile?.name || '';
        // Doc id = wamid → create() dedupes Meta's webhook retries for free.
        await db.doc(`${dataPath(tenant.appId)}/wa_conversations/${msg.id}`).create({
          wamid: msg.id,
          app_id: tenant.appId,
          from: msg.from,
          profile_name: profileName,
          phone_number_id: phoneNumberId,
          type: msg.type,
          text: msg.text?.body || msg.image?.caption || msg.document?.caption || '',
          media_id: msg.image?.id || msg.document?.id || null,
          status: 'received',
          created_at: new Date().toISOString(),
        }).catch((e) => { if (e.code !== 6 /* ALREADY_EXISTS */) throw e; });
      } catch (err) {
        logger.error(`whatsappWebhook: ${err.message}`);
      }
    }
    res.status(200).send('ok');
  }

  // Firestore trigger body — processes one stored inbound message end-to-end.
  async function processInbound(event) {
    const snap = event.data;
    if (!snap) return;
    const m = snap.data();
    if (m.status !== 'received') return;
    const { appId } = event.params;
    const cfg = await readWaConfig(appId);
    if (!cfg || !cfg.enabled) return;
    const mark = (fields) => snap.ref.set({ ...fields, answered_at: new Date().toISOString() }, { merge: true });

    try {
      const sender = await resolveSender(appId, cfg, m.from);
      if (!sender) {
        await sendText(cfg, m.from, 'This number is not registered for this workspace. Ask your admin to add your number in Admin > WhatsApp Copilot.');
        await mark({ status: 'rejected', reject_reason: 'unknown_number' });
        return;
      }
      const qaRoles = Array.isArray(cfg.qa_roles) && cfg.qa_roles.length ? cfg.qa_roles : ['admin', 'accountant'];
      const text = (m.text || '').trim();

      if (!m.media_id && (!text || /^(help|hi|hello|namaste|menu)$/i.test(text))) {
        await sendText(cfg, m.from, HELP_TEXT);
        await mark({ status: 'answered', reply: HELP_TEXT, emp_id: sender.empId });
        return;
      }
      if (!qaRoles.includes(sender.role)) {
        await sendText(cfg, m.from, `Sorry ${sender.name}, books access over WhatsApp is limited to: ${qaRoles.join(', ')}.`);
        await mark({ status: 'rejected', reject_reason: 'role', emp_id: sender.empId });
        return;
      }
      const aiCfg = await readAiConfig(appId);
      if (!aiCfg) {
        await sendText(cfg, m.from, 'The AI accountant is not enabled for this workspace (Admin > AI settings).');
        await mark({ status: 'rejected', reject_reason: 'ai_disabled', emp_id: sender.empId });
        return;
      }
      const gate = await checkRateAndBudget(appId, aiCfg, normalizePhone(m.from));
      if (!gate.ok) {
        await sendText(cfg, m.from, gate.reason === 'budget'
          ? 'Monthly AI budget is exhausted — ask your admin to raise it.'
          : 'Too many requests — wait a minute and try again.');
        await mark({ status: 'rejected', reject_reason: gate.reason, emp_id: sender.empId });
        return;
      }

      if (m.media_id) {
        const media = await downloadMedia(cfg, m.media_id);
        if (media.unsupported) {
          await sendText(cfg, m.from, `Unsupported file type (${media.unsupported}). Send a JPEG/PNG photo or a PDF.`);
          await mark({ status: 'rejected', reject_reason: 'media_type', emp_id: sender.empId });
          return;
        }
        if (media.tooBig) {
          await sendText(cfg, m.from, 'File too large (max 10 MB).');
          await mark({ status: 'rejected', reject_reason: 'media_size', emp_id: sender.empId });
          return;
        }
        const out = await extractInvoiceToDraft(appId, aiCfg, media, sender, text);
        const reply = out.error
          ? `Could not process the document: ${out.error}`
          : `📄 Draft created from ${out.vendor}'s invoice ${out.invoiceNo}${out.total ? ` for ₹${out.total.toLocaleString('en-IN')}` : ''}.\nReview & approve it in Accounting > Drafts.`;
        await sendText(cfg, m.from, reply);
        await mark({ status: out.error ? 'error' : 'answered', reply, emp_id: sender.empId, draft_id: out.draftId || null });
        return;
      }

      // Books Q&A with short follow-up context (last 3 answered exchanges).
      const histSnap = await db.collection(`${dataPath(appId)}/wa_conversations`)
        .where('from', '==', m.from).where('status', '==', 'answered')
        .orderBy('created_at', 'desc').limit(3).get();
      const history = histSnap.docs.map((d) => ({ q: (d.data().text || '').slice(0, 200), a: (d.data().reply || '').slice(0, 400) })).reverse();
      const { text: answer, modelId } = await answerQuestion(appId, aiCfg, text, history);
      await sendText(cfg, m.from, answer);
      await mark({ status: 'answered', reply: answer, emp_id: sender.empId, ai_model: modelId });
    } catch (err) {
      logger.error(`processInbound(${appId}/${m.wamid}): ${err.message}`);
      await mark({ status: 'error', error: String(err.message || err).slice(0, 500) });
      try { await sendText(cfg, m.from, 'Something went wrong handling that message — please try again.'); } catch { /* best effort */ }
    }
  }

  return { handleWebhook, processInbound };
}

module.exports = { createWhatsApp, normalizePhone, parseAllowlist, verifySignature, extractInbound, splitForWhatsApp };
