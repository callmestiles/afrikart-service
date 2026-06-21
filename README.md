# AfriKart Service

Backend service for AfriKart, a fictional African commerce platform, built as a take-home assessment.

---

## What This Is

AfriKart needs to collect payments from customers, settle vendors, and give operations teams a clear picture of what happened when something goes wrong. This service is the backend that makes that possible.

It integrates with a Fincra-style sandbox API to handle the full payment lifecycle:

```
Customer places order
      ↓
AfriKart initiates checkout → Fincra creates virtual account
      ↓
Customer transfers money → Fincra fires collection webhook
      ↓
AfriKart verifies vendor account → initiates payout
      ↓
Fincra fires payout webhook → order settled
```

Every step is recorded in an append-only event log so a support agent can reconstruct the full story of any transaction from a single API call.

---

## Quick Start

### Prerequisites

- Node.js 18+
- The Fincra sandbox running locally (`participant-repo`)

### 1. Start the sandbox

```bash
cd participant-repo
cp .env.example .env
bun install && bun run start
# Sandbox runs at http://localhost:4000
```

### 2. Start AfriKart service

```bash
cd afrikart-service
cp .env.example .env
npm install
npm run dev
# Service runs at http://localhost:3000
```

### 3. Verify everything is connected

```bash
curl http://localhost:3000/health
```

### 4. Run the demo CLI (optional but recommended)

```bash
npm run demo
```

The CLI walks through the full flow interactively — no Postman needed.

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `FINCRA_BASE_URL` | Sandbox base URL | `http://localhost:4000` |
| `FINCRA_SECRET_KEY` | API secret key | `sk_test_afrikart_secret` |
| `FINCRA_PUBLIC_KEY` | API public key | `pk_test_afrikart_public` |
| `FINCRA_WEBHOOK_SECRET` | Webhook HMAC secret | `whsec_afrikart_secret` |
| `PORT` | Service port | `3000` |
| `DB_PATH` | SQLite database file path | `./afrikart.db` |
| `NODE_ENV` | Environment | `development` |

All variables are validated on startup. The service exits immediately with a clear error message if any required variable is missing.

**To use the hosted sandbox:** change `FINCRA_BASE_URL`, `FINCRA_SECRET_KEY`, `FINCRA_PUBLIC_KEY`, and `FINCRA_WEBHOOK_SECRET` to the values provided by the hiring team. No other changes needed.

---

## Running Tests

Unit tests (no external dependencies — run instantly):

```bash
npm test
```

Integration tests (sandbox + service must be running):

```bash
npm run test:integration
```

All tests:

```bash
npm run test:all
```

---

## API Reference

### Orders

| Method | Path | Description |
|---|---|---|
| `POST` | `/orders` | Initiate a checkout for a customer order |
| `GET` | `/orders/:orderId` | Get all payment attempts for an order |

### Payouts

| Method | Path | Description |
|---|---|---|
| `POST` | `/payouts/vendor` | Verify account and initiate vendor payout |

### Webhooks

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/fincra` | Fincra webhook receiver |

### Timeline

| Method | Path | Description |
|---|---|---|
| `GET` | `/timeline/:reference` | Full event history for a checkout reference |
| `GET` | `/timeline/order/:orderId` | All attempts and events for an order |

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health check |

---

## Architecture

### Data Model

Four tables. Everything connects through `orders`.

```
orders
  id                  — internal primary key
  reference           — checkout reference sent to Fincra (pay_<orderId>_<ts>)
  order_id            — human-readable AfriKart order ID
  payment_id          — Fincra's payment ID (txn_...)
  status              — current state (see state machine below)
  payout_reference    — Fincra's payout reference (payout_...)
  payout_id           — Fincra's payout ID (po_...)

order_events          — append-only timeline log, never updated or deleted
  order_id            — foreign key to orders
  event               — machine-readable event name
  detail              — human-readable description
  created_at          — timestamp of the state transition

processed_webhooks    — idempotency table
  event_id            — PRIMARY KEY (Fincra's event ID)
  event_type          — e.g. collection.successful
  processed_at        — when we processed it

payouts
  order_id            — foreign key to orders
  customer_reference  — our internal payout reference
  fincra_reference    — Fincra's payout reference
  idempotency_key     — x-idempotency-key sent to Fincra
  status              — pending, processing, successful, failed
```

### Identifier Chain

Every identifier involved in a transaction lifecycle is stored in one `orders` row:

```
checkout.reference  →  orders.reference
payment.id          →  orders.payment_id
payout.reference    →  orders.payout_reference  +  payouts.fincra_reference
payout.id           →  orders.payout_id         +  payouts.fincra_payout_id
customerReference   →  payouts.customer_reference
balance-log ref     →  same as payout.reference (Fincra uses it as the log key)
```

`GET /timeline/:reference` surfaces all of these in an `identifierChain` field so a support agent can cross-reference any ID against Fincra's dashboard without touching the database.

### Order State Machine

```
draft
  ↓ (Fincra checkout confirmed)
pending
  ↓ (collection.successful webhook)
collected
  ↓ (payout claimed atomically)
payout_initiated
  ↓ (Fincra payout confirmed processing)
payout_processing
  ↓ (payout.successful webhook)          ↓ (payout.failed webhook)
payout_successful                      payout_failed

collected → chargebacked  (chargeback.created webhook)
pending   → collection_failed  (collection.failed webhook)
```

Orders in `payout_initiated` or `payout_processing` with no incoming webhook are recovered by the startup reconciliation job.

---

## Key Design Decisions

### SQLite over PostgreSQL

The main driver was keeping the setup frictionless — reviewers can `npm run dev` and have a running service without spinning up a database server. That said, there were real technical reasons for it beyond convenience. WAL journal mode gives non-blocking concurrent reads, which actually matters here since the webhook handler and the timeline endpoint can be hitting the database at the same time.

The obvious downside is write concurrency at scale. A production AfriKart with thousands of simultaneous transactions would need PostgreSQL or CockroachDB. The migration path is clean though — all database access is in `src/db/*.repo.ts` with no raw SQL leaking into route handlers.

### Idempotency at the Database Level

Webhook deduplication is enforced by a UNIQUE constraint on `processed_webhooks.event_id`, not by an application-level check. Two simultaneous deliveries of the same event can race to insert — SQLite serializes the writes, the first one succeeds, and the second hits the constraint and exits early. No race condition is possible regardless of concurrency.

Payout double-submit works the same way. The order status is re-read inside a database transaction and atomically updated to `payout_initiated`. Two concurrent requests can pass the initial status check, but only one can win the transaction. The idempotency key on the Fincra call is a second layer on top — if the same key reaches Fincra twice, Fincra returns the existing payout rather than creating a new one.

### Webhook Response Before Processing

The webhook handler returns 200 immediately after signature verification, then hands off to `setImmediate` for the actual work. Fincra considers a webhook delivered when it gets a 2xx response — if processing were synchronous and took long enough to time out, Fincra would retry and those retries would pile into the deduplication layer unnecessarily. Responding early keeps that from becoming a problem.

### Draft-First Order Creation

Orders are written to the database in `draft` state before the Fincra checkout call goes out. If the server crashes between Fincra confirming and our database write completing, the draft row is at least detectable. Full resume logic for abandoned drafts is intentionally out of scope — clients retry the request, generating a new attempt with a new reference, so orphaned drafts are benign. The real crash-recovery concern is mid-payout, which is what startup reconciliation covers.

### Verified Name for Payout Recipient

After account verification, the payout request to Fincra uses the verified account name rather than the name the user submitted. The user-supplied name is only used to decide whether to proceed with the payout — once that check passes, the verified name is what goes on the wire. Sending the user-supplied name after already having the correct verified name could cause bank-level rejections.

### 60-Second Safety Buffer on FX Quotes

Quotes expire after 5 minutes, but we treat them as expired 60 seconds early. That buffer absorbs any processing delay between our check and Fincra's validation, avoiding a TOCTOU race at the expiry boundary. When the buffer kicks in, we re-fetch a fresh quote rather than returning an error. The buffer is a named constant in the payout route so it can be adjusted without hunting through logic.

---

## Failure Modes Handled

| Failure | How Triggered | How Handled |
|---|---|---|
| Duplicate webhook (same event ID) | `POST /simulate/webhooks/replay/:id` | UNIQUE constraint on `processed_webhooks.event_id` — second insert fails, event skipped |
| Duplicate webhook (new event ID, same content) | Sandbox replay | Status machine guard — handler checks current order status before transitioning |
| Async payout failure | Account ending in 9 | `payout.failed` webhook updates order, writes timeline event with reason |
| Slow payout | Account ending in 7 | Order stays in `payout_processing`, status guard blocks unsafe retries |
| Chargeback | `POST /simulate/chargeback` | `chargeback.created` webhook marks order, records balance impact in timeline |
| FX quote expiry | Quote older than 4 min | 60-second buffer triggers re-fetch before use |
| Provider 503 chaos | `CHAOS_RATE` env var | Exponential backoff with jitter, 3 attempts max, same idempotency key on retries |
| Name mismatch on verification | Wrong recipient name | Payout blocked with `NAME_MISMATCH` error, order released back to `collected` |
| Server crash mid-payout | Kill server during payout | Startup reconciliation polls Fincra on restart, resolves stuck orders |
| Webhook processing failure | Any unhandled exception | DB transaction rolls back — event not marked processed, Fincra will redeliver |

---

## Demo Script (Office Presentation)

Run `npm run demo` and follow this sequence:

### 1. Happy Path (5 minutes)

**Action:** Select "Initiate a new order"
- Order ID: `order_demo_001`
- Amount: `25000`
- Customer: `Maya Okafor / maya@example.com`

**Show:** Reference returned, virtual account details, status is `pending`

**Action:** Select "Simulate customer payment"
- Paste the reference from step above

**Show:** Settlement confirmed, webhook fired

**Action:** Select "View transaction timeline" → by reference
- Show status is now `collected`
- Walk through the identifier chain
- Point out `fincraPaymentId` linking our record to Fincra's system

**Action:** Select "Initiate vendor payout"
- Paste the reference
- Select "Kofi Mensah" (happy path account)

**Wait 2 seconds**, then select "View transaction timeline" again

**Show:** Status is `payout_successful`, full timeline from `checkout_draft` to `payout_succeeded`

---

### 2. Failure Path — Async Payout Failure (3 minutes)

**Action:** Create and collect a new order (repeat steps above with `order_demo_002`)

**Action:** Select "Initiate vendor payout"
- Select "Fatima Invalid — ends in 9 — will fail"

**Show:** Returns 202 immediately — payout accepted for processing

**Wait 2 seconds**, then view timeline

**Show:** Status is `payout_failed`, timeline shows exactly what happened and when, funds restored note in the detail field

**Key point to make:** "The order is back in `payout_failed` state. An operator can see the failure reason, knows funds were restored, and can take recovery action. No log file access needed."

---

### 3. Architectural Highlight — Duplicate Webhook (2 minutes)

**Action:** Select "Simulate duplicate webhook delivery"
- Pick the most recent `collection.successful` event

**Show:** Service logs — "Duplicate delivery detected — skipping" OR status guard fires

**Key point to make:** "Two independent deduplication layers. First: UNIQUE constraint on `processed_webhooks.event_id` — database-level, survives restarts, handles concurrency. Second: status machine guard — even if a duplicate arrives with a fresh event ID, we check the order's current status before transitioning. Both must fail for a duplicate to cause harm."

---

### Talking Points for Deep Dive

- **Why SQLite?** Zero infrastructure, survives restarts, WAL mode for concurrent reads. Migration path to PostgreSQL is clean — all SQL is in `src/db/*.repo.ts`.
- **Why return 200 immediately on webhooks?** Prevent Fincra timeout → retry storm. Processing is async via `setImmediate`.
- **What if the server crashes mid-payout?** Startup reconciliation polls Fincra for stuck orders.  `src/services/reconciliation.ts`.
- **What changes for mobile money?** New route handler, same idempotency key pattern, same state machine. Core logic untouched.

## What I Would Improve With More Time

**Periodic reconciliation job** — The startup reconciliation only runs once at boot. A production system needs a background job (every 5-10 minutes) that catches orders that get stuck between restarts. This would use the same `reconcileStuckOrders` logic on a timer.

**Velocity checking / fraud flagging** — The `attempt_count` column on orders is already populated per payment attempt. A velocity check that flags customers with more than N failed attempts in a time window is a natural next step. The data foundation is there.

**WebSocket or SSE for real-time status** — Currently the frontend must poll `GET /orders/:orderId` to get status updates. A WebSocket or Server-Sent Events layer would push status changes to connected clients immediately. The order status model supports this without schema changes.

**Structured logging** — Console logs are sufficient for a sandbox but a production system needs structured JSON logs (via `pino` or `winston`) with correlation IDs so every log line for a given request or webhook event can be traced together.

**Proper migration tooling** — `CREATE TABLE IF NOT EXISTS` works for this assessment but is not suitable for production where you need to alter existing tables, roll back migrations, and track schema versions. `db-migrate` or Drizzle Kit would be the right addition.

**Mobile money payout rail** — The payout flow uses a `PayoutDestination` concept that currently only supports bank accounts. Adding mobile money requires a new route handler and a new Fincra API call (`POST /disbursements/payouts/mobile-money`). The core idempotency, retry, and state machine logic is reusable without modification.

---

## Assumptions and Non-Goals

- **No authentication on AfriKart's own endpoints** — in production, `POST /orders` and `POST /payouts/vendor` would require API key or JWT authentication. Omitted to keep the scope focused on payment flow correctness.
- **Single currency wallet assumed for local payouts** — NGN wallet is the default source. Multi-wallet selection would require an additional parameter and wallet lookup.
- **No retry queue for failed payouts** — when a payout fails, the order is marked `payout_failed` and an operator must manually retry. A job queue (Bull, BullMQ) would automate retries with configurable backoff.
- **Webhook target URL must be publicly reachable** — for the hosted sandbox evaluation, the service must be deployed or tunnelled (e.g. via ngrok) so Fincra can deliver webhooks. Local-only setup only works with the local sandbox.
