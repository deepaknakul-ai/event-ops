# WhatsApp AI Copilot — Setup & Operations

Team members WhatsApp the business number and get answers from the live books
("Acme ka balance kya hai?", "receivables kitne hain?") or send a supplier
invoice photo/PDF that becomes an approval-required journal draft. Built on the
Meta WhatsApp Cloud API. Fully inert until configured.

## Prerequisites

- AI accountant enabled (Admin > AI settings — `settings/ai` with `enabled` +
  `api_key`). The copilot reuses its model, budget and rate limits.
- A Meta developer account and a WhatsApp Business phone number.

## One-time Meta setup (~15 min)

1. Create an app at https://developers.facebook.com → type *Business* → add the
   **WhatsApp** product. Meta gives you a test number immediately; attach your
   real business number when ready.
2. From **WhatsApp > API Setup**, note the **Phone number ID**.
3. Create a **System User** (Business Settings > Users) with access to the app
   and WhatsApp account; generate a **permanent access token** with
   `whatsapp_business_messaging` permission. (The API-Setup page token expires
   in 24h — fine for testing, not production.)
4. From **App Settings > Basic**, copy the **App Secret** (used to verify
   webhook signatures).
5. In the app: **Admin > System > WhatsApp Copilot** — paste Phone Number ID,
   access token, app secret, invent a **Verify Token** (any random string),
   tick Enabled, Save.
6. Back in Meta: **WhatsApp > Configuration > Webhook** — set the Callback URL
   shown on the same admin card
   (`https://us-central1-<project>.cloudfunctions.net/whatsappWebhook`), enter
   your Verify Token, click *Verify and save*, then **subscribe to the
   `messages`** webhook field.
7. Send "help" to the business number from a registered phone — you should get
   the help reply.

## Who can use it

- The sender's number must resolve to an **Active employee** — matched against
  `employees.mobile1` (last-10-digit comparison, so `+91` prefixes don't
  matter), or listed in the admin card's allowlist (`+91XXXXXXXXXX = EMP_ID`).
- **Books Q&A additionally requires role admin or accountant** (same gate as
  the in-app AI accountant). Other roles get a polite refusal.
- Unknown numbers get one "not registered" reply and are logged.

## What it does

| Message | Behavior |
|---|---|
| "help" / "hi" | Capability summary |
| Any question (English/Hinglish) | Answered from a server-built books digest — same numbers the app shows. Includes 3 turns of follow-up context. |
| Image (JPEG/PNG/WebP) or PDF ≤10 MB | Extracted as a supplier invoice → **parked, approval-required** draft in Accounting > Drafts with the file attached and a 2-leg entry (Dr Purchases / Cr Party). Nothing posts without human approval. |

## Guardrails

- Per-number rate limit (`per_user_rpm` from AI settings, default 6/min) and
  the shared monthly token budget — both metered in `ai_usage` like the in-app
  assistant.
- Webhook requests are HMAC-verified against the App Secret; Meta's retries are
  deduped by message id.
- Every inbound message + reply is stored in `wa_conversations`
  (admin-read-only; clients can never write it). Review from Firestore console
  or build a viewer later.
- The copilot is **read-only on the books** — the only write it ever performs
  is a parked draft that a human must approve.

## Troubleshooting

- **Webhook verify fails**: Verify Token in Meta must exactly match the admin
  card; the settings doc must exist (Save first, then verify).
- **No reply**: check `onWaMessageCreated` logs
  (`firebase functions:log --only onWaMessageCreated`), confirm `enabled` is
  ticked, AI settings are configured, and the sender's number matches an
  employee's `mobile1`.
- **"AI accountant is not enabled"** reply: `settings/ai` needs `enabled: true`
  and an `api_key`.
- Standby project: the same settings doc exists per project — configure the
  standby separately if you want the copilot live there after a failover
  (point the Meta webhook at the standby URL during failover).
