# Notifications API (N1 — reliability)

All routes are inside the central `/admin` (B2B admin session or staff token, as for every
`/api/admin/b2b/*` route). Contact details are shown as stored; masking arrives with N2.

## Queue statuses (what they really mean)

| Status | Shown as | Meaning |
| --- | --- | --- |
| `pending` | Queued | Waiting for the worker (also between retries) |
| `sending` | Sending | Handed to the provider now |
| `sent` | Accepted by provider | SMTP server / WhatsApp API / MSG91 took the message. Not proof of delivery |
| `failed` | Failed | Refused for good, or all 4 attempts failed (back-off 1, 5, 30, 120 min) |
| `skipped_no_provider` | Not sent: no provider | No provider configured — nothing left the server |
| `skipped_no_contact` | Not sent: no contact | No valid email / mobile |
| `skipped_opt_out` | Not sent: opted out | (used from N3) |

`delivery_status` (`unknown`, `sent`, `delivered`, `read`, `failed`) changes only from provider
reports: MSG91 delivery reports and Meta WhatsApp webhooks. WhatsApp rows stay "Accepted by
provider" until Meta's message id is stored (owner decision D2: needs a separately approved
change to the protected `src/services/notify.js`). Email has no delivery reports.

## Routes

| Method and path | Permission | Does |
| --- | --- | --- |
| `GET /api/admin/b2b/notifications/queue?status=failed\|not_sent\|pending\|sent&page=` | `b2b.settings.view` | Queue rows of that view; each row has `can_retry` |
| `GET /api/admin/b2b/notifications/queue/:id` | `b2b.settings.view` | One row with its full status `history` (oldest first) |
| `POST /api/admin/b2b/notifications/queue/:id/retry` | `b2b.settings.edit` | Re-queue ONE failed / not-sent row (attempts reset). Sent rows and one-time codes are refused (409 `not_retryable`). Audited `notification.retried` |
| `POST /api/admin/b2b/notifications/retry` | `b2b.settings.edit` | Re-queue ALL failed rows except one-time codes (kept during the transition, D10). Answers `{ requeued, skipped, processed }`. Audited `notification.retried_all` |
| `GET/POST /api/webhooks/whatsapp` | Meta signature (`WHATSAPP_APP_SECRET`) | Delivery statuses; replay refused; never backwards; each accepted report added to the history |
| `POST /api/webhooks/msg91?token=` | `MSG91_WEBHOOK_TOKEN` | SMS delivery reports; same rules |

## Status history (`b2b_notification_events`, migration 016)

One row per status change: `queued`, `sending`, `accepted`, `retry_scheduled`, `failed`,
`skipped_no_provider`, `skipped_no_contact`, `requeued` (with the administrator's name), and
provider reports (`sent`, `delivered`, `read`, `failed`) with the provider reference. Rows are
only ever inserted. A retry re-delivers the same message; it never repeats any business action.

---

# Notification center API (N2): `/api/erp/notifications`

This is the Notifications screen inside the central `/admin` (`/admin/administration/notifications`). It needs an ERP
staff session (D9: ERP staff only; `staff.json` is not read). It uses the same outbox, worker, providers
and webhooks as N1. There is no second sending service. Shop customers are not recipients (D1).

## Permissions

| Permission | Lets you | Two-factor |
| --- | --- | --- |
| `notifications.view` | See the overview, history, detail, analytics and templates. Contacts are masked (`r•••@x.in`, `98•••••011`) | no |
| `notifications.contacts.view` | See full email and mobile | no |
| `notifications.send.trade` / `.salesmen` / `.vendors` / `.staff` | Send and resend to retailers and distributors, salesmen, suppliers and manufacturers, staff | no |
| `notifications.send.promotional` | Write promotional messages (N3: consented business accounts only) | no |
| `notifications.promotional.approve` | Approve promotional sends above the approval threshold (N3) | **yes** |
| `notifications.templates.manage` | Record templates and their provider approval | no |
| `notifications.optout.manage` | Record consent and opt-outs (N3) | no |

Roles:

| Role | Notification permissions |
| --- | --- |
| super_admin, business_admin | All |
| sales_manager | view, trade, salesmen |
| procurement_manager | view, vendors |
| finance_manager | view, trade |
| customer_support | view, contacts, trade, opt-out |
| auditor | view only |

Other roles have none.

## Limits (D5; setting `notifications.limits`, changed in Settings by a recorded decision)

| Limit | Default | When exceeded |
| --- | --- | --- |
| `max_recipients` | 500 per send | 400 `too_many_recipients` |
| `max_sends_per_hour` | 20 per administrator (sends and resends count) | 429 `send_limit` |
| `promo_approval_over` | 100 recipients (N3) | — |

## Routes

| Method and path | Permission | Does |
| --- | --- | --- |
| `GET /meta` | view | What the composer may offer: limits, allowed recipient types, providers configured, usable templates, the caller's abilities |
| `GET /recipients?type=&q=&all=1` | view + the send permission for that type | Search one recipient type (`retailer`, `distributor`, `salesman`, `supplier`, `manufacturer`, `staff`); `all=1` lists every active one, up to the limit plus one (`truncated`) |
| `POST /messages` | any send permission | Send a new message (body below). 201 `{ messageId, messageNo, sendNo, queued, skippedCount, resendCount }`, plus `duplicate: true` on a repeat |
| `GET /messages?q=&recipient=&channel=&category=&origin=&sender=&status=&from=&to=&page=` | view | History with filters and status counts |
| `GET /messages/:id` | view | Detail: the original text, recipients, every send and every delivery attempt with its full status history, provider reference and error |
| `POST /messages/:id/resend` | send permission for every chosen recipient's type | Resend (body below). 201: the same fields, plus `skipped: [{ name, reason }]` (recipients no longer reachable) |
| `GET /analytics?days=30` | view | Counts by channel and status, and by day |
| `GET /templates` | view | Templates (`?usable=1`: only active and approved at the provider) |
| `POST /templates`, `PUT /templates/:id` | templates.manage | Record a template: channel, name, category, provider template name or DLT id, language, parameter names, sample, `approved_at_provider`, `active`. Audited |

### Send

```json
{ "requestKey": "<new UUID per press of Send>", "category": "transactional|operational|account",
  "channels": ["email","whatsapp","sms"], "subject": "...", "body": "...",
  "whatsappTemplateId": 3, "smsTemplateId": 4,
  "params": { "whatsapp": ["value 1", "value 2"], "sms": { "name": "value" } },
  "recipients": [{ "type": "retailer", "ref": 12 }] }
```

- **One outbox row per recipient and channel.** Email is sent from the subject and body. WhatsApp and SMS can only use a template that is active and approved at the provider (`template_not_approved`).
- **A recipient with no usable address** gets a `skipped_no_contact` row. That row is visible and is not counted as sent.
- **Promotional sends** are refused here (`promotional_not_here`). The consented promotional flow is N3.
- **Pressing Send twice** with the same `requestKey` returns the result of the send that key made, with `duplicate: true`. This also holds when two presses arrive at once: the unique key admits one, and the other answers with its result. Nothing is sent twice. A key already used for a different message is refused (409 `request_key_reused`).
- Audited as `message.sent`.

### Resend (always available, D10)

```json
{ "requestKey": "<new UUID per press of Resend>", "recipientIds": [5, 6],
  "edit": { "subject": "...", "body": "..." }, "confirmChanged": false, "reason": "..." }
```

- **Each resend is a new send** (`send_no` 2, 3, …) with its own new outbox rows. The original message and every earlier result are kept unchanged.
- **`recipientIds` is optional** and limits the resend to some of the message's own recipients. Anyone else is refused with `not_original_recipient`.
- **The current contact details are used.** If an email or mobile changed since the last send, the answer is 409 `contact_changed` with `changes: [{ recipientId, name, old: { email, mobile }, new: { email, mobile } }]`. Full details for people with `contacts.view`. For everyone else they are masked, and a change the mask would hide (such as middle digits of a mobile) is marked `(changed)`. Details are compared with those at the message's first send, so every resend asks again until the message is rewritten. Repeat the request with `confirmChanged: true` and the same `requestKey` (D3).
- **Inactive recipients are skipped** and the resend reports them.
- **`edit` is optional.** It stores the edited text on that send only. The original stays as written.
- Audited as `message.resent`, and the message's `resend_count` goes up.

Error codes: `request_key`, `audience_forbidden`, `too_many_recipients`, `send_limit`, `template_required`,
`template_not_approved`, `promotional_not_here`, `not_original_recipient`, `contact_changed`, `no_active_recipients`, `request_key_reused`.

## Tables (migration 016)

- `b2b_messages`: the original message.
- `b2b_message_recipients`: who it was for, with the contact details at the first send.
- `b2b_message_sends`: one row per send or resend, unique `request_key`.
- `b2b_message_templates`: templates.
- Outbox rows carry `message_id`, `send_id` and `message_recipient_id`.
- `b2b_contact_preferences` and `b2b_recipient_groups` (with members) are created now and used from N3.

The notification module only reads accounts, staff and vendors. It never writes orders, payments, invoices or stock.

---

# Consent, opt-out, promotions, groups, throughput (N3)

## The rule, in one place

Every outbox row passes `consent.blockReason(row)` just before it is sent. That covers new
sends, resends, approved promotions and automatic (workflow) messages. A blocked row becomes
`skipped_opt_out` ("Not sent: opted out"), with the reason in its history. The provider never
sees it, and it is not offered for retry. If the consent lookup itself fails, the row is retried
later and is never sent unchecked.

| Message | Allowed when |
| --- | --- |
| Promotional | The address has a recorded **opt-in** for offers on that channel, and no opt-out |
| Transactional or service | No "stop all" opt-out on that channel |
| One-time sign-in code | Always (the person asked for it) |

How preferences are stored:

- **Per channel and per address.** The table `b2b_contact_preferences` keeps only a SHA-256 hash of the normalised email or Indian mobile (last 10 digits), and links to the account when known.
- **Scopes.** `promotional` holds opted_in or opted_out. `all` set to opted_out stops every message on that channel except codes; set to opted_in it means "resumed".
- **Audit.** Every change is written to the tamper-evident audit log with the address masked. A business changing its own preference is recorded as actor `business`.

## Where consent comes from

| Source | How |
| --- | --- |
| Business portal (Profile → Offers and promotions) | `GET/PUT /api/b2b/me/communication { email: bool, whatsapp: bool }`: the account itself |
| Staff (Notifications → Consent & groups) | `POST /api/erp/notifications/consent`. An opt-in needs `source` (written, call, email, meeting) and a note of how and when. Promotional opt-ins only for retailers and distributors. Permission `notifications.optout.manage` |
| Unsubscribe link in every promotional email | `GET /api/erp/public/unsubscribe?t=` shows a confirmation; `POST` records the opt-out. The token is signed (HMAC, `ERP_JWT_SECRET`) and carries a hash, never an address |
| WhatsApp reply | `STOP` / `UNSUBSCRIBE` → stop all WhatsApp messages; `START` → resume. Each reply is processed once (`b2b_webhook_events`, `in:<message id>`) |

## Promotional sends (D4, D5, D8)

`POST /messages` with `category: "promotional"` needs `notifications.send.promotional` and these conditions:

| Condition | Otherwise |
| --- | --- |
| Recipients are retailers or distributors only | `promotional_business_only` |
| No SMS (D8: SMS is for codes) | `promotional_no_sms` |
| Email needs `PUBLIC_SITE_URL` for the unsubscribe link | `unsubscribe_unavailable` |
| WhatsApp needs a template recorded as `promotional` (Meta: marketing), and other messages cannot use one | `template_category` |

**More than `promo_approval_over` recipients (100 by default)** requires a `reason`. The message is
stored with status `awaiting_approval` and nothing is queued (`queued: 0`, `awaitingApproval: true`, `approvalId`).
A second person holding `notifications.promotional.approve` decides under Administration →
Approvals (`POST /api/erp/core/approvals/:id/decide`). That needs two-factor sign-in, and the writer
cannot approve.

- **On approval**, the send is queued to the recipients' current details, and consent is checked again per row.
- **On rejection or withdrawal**, the message becomes `rejected`. It cannot be resent (`message_rejected`).
- **While waiting**, a resend is refused (`awaiting_approval`). Large promotional resends follow the same approval path.

`POST /preview` (same body as a send) returns, without writing anything:
`{ chosen, active, tooMany, needsApproval, approvalOver, channels: { email: { withAddress, willSend, optedOut, noConsent } }, problem }`.

## Recipient groups

| Route | Does |
| --- | --- |
| `GET /groups` | Groups with `size` now, `types`, `usable` (on, and you may send to every type) and `mayEdit` |
| `POST /groups` | `{ name, kind: "list", members: [{type, ref}] }` or `{ name, kind: "rule", rule: { type, stateId?, districtId? } }`. Geography applies to retailers and distributors only |
| `PUT /groups/:id` | `{ name?, active?, members?, rule? }` |

A send accepts `groups: [ids]` next to `recipients`. Rules are evaluated at send time, then
de-duplicated, limited (D5) and permission-checked per type. Changes are audited (`group.created`, `group.updated`).

## Provider throughput

The worker hands at most N messages per channel per minute to the provider. N comes from the setting
`erp.notifications.provider_rates`, default `{ email: 30, whatsapp: 60, sms: 60 }`. It is counted from
the `sending` history of the last 60 seconds. Rows over the limit stay `pending` and keep all their attempts.

---

# Automatic notifications in the history (N5)

Every automatic message is now also a message in the notification center, with `origin: "workflow"`.
That covers account decisions, orders, order status, payments, returns and refunds, recalls,
password and security events, stock alerts and field-sales codes. Each one shows its recipients,
every attempt and the provider results, and can be resent one recipient at a time.

**One sending service, one trigger per event.** The record is written by the same call that queues
the rows (`notifyAccount`, `notifyAdmins`, `queueCode` in the outbox). Only the outbox inserts into
`b2b_notification_queue`, and a test enforces that.

| Event | Trigger (existing unless marked new) | Channels |
| --- | --- | --- |
| Registration received, account approved, rejected or suspended | accounts service | email, WhatsApp; admins by email |
| New order; first order needs approval; retailer order to a distributor | orders service | as before |
| Order approved, accepted, processing, packed, **dispatched**, out for delivery, **delivered**, partially delivered, cancelled, not approved, refunded | orders status change. The invoice number is in the dispatched and delivered messages, so there is no second invoice message | email, WhatsApp |
| Return requested, decided, completed (refund or credit) | returns service | as before |
| Product recall | recalls | as before |
| **Payment received** (manual or online), with the amount still to pay | new: the one place a payment is applied. A repeated gateway confirmation returns before it | email, WhatsApp |
| **Password changed** (portal) and **password reset by an administrator** | new | email only; never the password; does not block the change |
| **Stock below reorder level** | new: daily job `notifications.stock_alerts` (deduplicated per day, read-only) | admins' alert emails |
| Field-sales order code | sales; now through the outbox (it gains the "queued" history row) | SMS or WhatsApp; the code is not stored in the record |

Resending an automatic message:

- **What it sends.** The original email (with its portal link) unless edited, and the original WhatsApp text. The business event is never repeated: a resend of "password reset" does not reset anything.
- **Who may resend.** Account recipients need the matching send permission. Alert addresses (`recipient_type: "address"`, migration 018) count as staff (`notifications.send.staff`).
- **One-time codes are never resent** (409 `otp_never_resent`). The screen says so instead of offering Resend.

History filter: `GET /messages?origin=workflow` (automatic) or `origin=manual` (written).

Before migration 016, and for alert emails before 018, rows are queued exactly as before, with no
record. A one-time probe of `information_schema` decides this, so production today behaves as now.

Migration **018_notification_workflow** (draft, test databases only) has one operation: it extends
`b2b_message_recipients.recipient_type` with `'address'`. Planned event sales therefore move to 019.
