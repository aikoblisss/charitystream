# Advertiser Campaign Flow — Complete Summary

This document covers the full advertiser campaign lifecycle: application and approval, activation, billing (recurring and non-recurring), campaign end, and how to test end-to-end in development.

---

## 1. Application and approval

### How an advertiser submits a campaign

There are two submission paths:

**Path A — Checkout flow (primary)**  
Used when the frontend collects payment via Stripe Checkout.

1. **File upload**  
   Creative is uploaded first (e.g. presigned URL to R2). The frontend receives a `fileUrl` (and optionally `fileName`).

2. **Create checkout session**  
   - **Route:** `POST /api/advertiser/create-checkout-session`  
   - **Body (JSON):** `campaignName`, `companyName`, `websiteUrl`, `firstName`, `lastName`, `email`, `jobTitle`, `adFormat`, `weeklyBudget`, `cpmRate`, `isRecurring`, `expeditedApproval`, `clickTracking`, `destinationUrl`, `fileUrl`, `fileName`.  
   - **Server:**  
     - INSERTs into `advertisers` with: `payment_completed = false`, `application_status = 'payment_pending'`, `approved = false`, `completed = false`, `media_r2_link` = `fileUrl`.  
     - Creates or finds `advertiser_accounts` by email and links `advertiser_id`.  
     - Creates or finds Stripe Customer (stored on `advertiser_accounts` and/or session metadata).  
     - Creates Stripe Checkout Session (mode `setup` to collect payment method), with `metadata.advertiserId` = new advertiser `id`.  
   - **Response:** Returns Stripe Checkout URL; frontend redirects the user to Stripe.

3. **After payment (Stripe webhook)**  
   - **Event:** `checkout.session.completed` (with `metadata.advertiserId`).  
   - **Handler (server.js ~703–746):**  
     - Sets `advertisers.payment_completed = TRUE`, `application_status = 'pending_approval'`, `stripe_customer_id` from session.  
     - Idempotency: skips if row already has `payment_completed = true` or `application_status = 'pending_approval'`.  
   - Confirmation email is sent from the webhook flow.

**Path B — Submit-only (no checkout in same step)**  
- **Route:** `POST /api/advertiser/submit` (multipart, `upload.single('creative')`).  
- **Server:**  
  - Creates/finds `advertiser_accounts` by email (and optionally password-setup token).  
  - INSERTs into `advertisers` with: `approved = false`, `completed = false`; uploads file to R2 `advertiser-media`, sets `media_r2_link`.  
  - Does **not** set `payment_completed` or `application_status` (those stay default/null).  
- Payment for this row would require a separate checkout that passes this advertiser’s `id` in metadata so the webhook can update the same row.

### Tables created/updated

- **advertiser_accounts**  
  - Created or found by email; `advertiser_id` linked to the new campaign row when applicable.

- **advertisers**  
  - One row per campaign.  
  - After checkout webhook: `payment_completed = TRUE`, `application_status = 'pending_approval'`, `stripe_customer_id` set.

### Who sets “approved” and what the approval script does

- **Who sets `approved = true`**  
  The codebase does **not** set `approved = true` via an API before the approval script runs. The script selects rows with either:
  - `(approved = true AND completed = false)`, or  
  - `(application_status = 'pending_approval' AND is_paused = true)` (e.g. replacement creative).  
  So for a **new** campaign, something external must set `approved = true` first (e.g. manual SQL or an admin tool):

  ```sql
  UPDATE advertisers SET approved = true WHERE id = <id> AND completed = false;
  ```

- **Approval script**  
  - **Script:** `backend/scripts/process-approved-advertisers.js`  
  - **Run:** From repo root: `cd backend && npm run process-advertisers`  
  - **Command:** `node scripts/process-approved-advertisers.js` (ensure `.env` with `DATABASE_URL` and R2/email config is loaded; script loads `.env` from project root).

- **What the script does**  
  1. Selects from `advertisers` where  
     `((approved = true AND completed = false) OR (application_status = 'pending_approval' AND is_paused = true))`  
     and `ad_format IN ('video','image','static_image')` and `media_r2_link IS NOT NULL`, and not archived.  
  2. For each row:  
     - Copies media from R2 bucket `advertiser-media` to `charity-stream-videos` with a standardized filename (`video_<id>_<ext>` or similar).  
     - Deletes original from `advertiser-media`.  
     - Updates `advertisers`:  
       - `completed = true`, `application_status = 'approved'`, `approved = true`  
       - `video_filename`, `media_r2_link` (pointing to charity bucket)  
       - `is_paused = false`, `pause_start_at = NULL`  
       - `current_week_start`, `campaign_start_date`  
         - **Non-recurring:** `campaign_start_date` = next Monday 00:00 America/Los_Angeles.  
         - **Recurring:** `campaign_start_date` = now.  
       - `approved_at = COALESCE(approved_at, NOW())`  
  3. Sends approval email.

- **Status progression (summary)**  
  - After submit/checkout: `payment_completed` (true if paid), `application_status` = `'payment_pending'` or `'pending_approval'`.  
  - After admin sets `approved = true`: still `completed = false`.  
  - After approval script: `approved = true`, `completed = true`, `application_status = 'approved'`, `campaign_start_date` set, media in charity bucket.

There is **no** Vercel cron or HTTP endpoint that runs this script; it is intended to be run manually or by an external scheduler after campaigns are marked approved.

---

## 2. Campaign activation

- **When a campaign is “active”**  
  A campaign is treated as active for ad serving when it is approved, completed, payment completed, has a video filename, and is not archived. The playlist/rotation logic (e.g. in `server.js`) uses conditions such as:

  - `video_filename IS NOT NULL`  
  - `approved = true`  
  - `completed = true`  
  - `payment_completed = TRUE`  
  - (and in many places) not archived, and for non-recurring: current time within the run window relative to `campaign_start_date`).

- **No separate “activation” step**  
  Activation is the result of the approval script setting `completed = true` (and `approved` / `application_status = 'approved'`). No other cron or script is required for “activation” of advertiser campaigns.  

- **Weekly reset (does not approve or run the approval script)**  
  - **Route:** `GET /api/system/weekly-reset`  
  - **Vercel cron:** `0 8 * * 1` (Monday 08:00 UTC).  
  - Resets weekly counters (e.g. `current_week_impressions`, `current_week_start`) for advertisers that are already `approved = TRUE`, `completed = TRUE`, `payment_completed = TRUE`.  
  - It does **not** change approval status or run the approval script.

---

## 3. Billing

### Recurring advertisers

- **When:** Every week, for the **current** billing week (Monday–Sunday, America/Los_Angeles).  
- **Trigger:**  
  - **Cron:** `GET /api/system/weekly-recurring-billing` — Vercel cron `0 8 * * 1` (Monday 08:00 UTC).  
  - **On campaign end:** `POST /api/advertiser/end` calls `billCampaignUsage(..., trigger: 'campaign_end')` for the current week before archiving.

- **Eligibility (runWeeklyRecurringBilling):**  
  - `approved = TRUE`, `completed = TRUE`, `payment_completed = TRUE`  
  - `(archived IS NULL OR archived = FALSE)`  
  - `recurring_weekly = TRUE`  
  - `stripe_customer_id IS NOT NULL`  
  - `current_week_impressions > 0`

- **Logic:**  
  - `billCampaignUsage()` computes amount from `current_week_impressions` (and optional `weekly_clicks` if click tracking), applies `weekly_budget_cap`, creates Stripe Invoice + InvoiceItems, finalizes invoice (charge_automatically).  
  - Inserts into `recurring_billing_records`.  
  - Then inserts/updates **donation_ledger** and **weekly_donation_pool** (see below).

### Non-recurring advertisers

- **When:**  
  - **Cron:** After the campaign’s single run week has ended. Eligibility: `campaign_start_date <= NOW() - INTERVAL '7 days'` and no row in `non_recurring_billing_records`.  
  - **Trigger:** `GET /api/system/non-recurring-billing` — Vercel cron `0 8 * * 1`.  
  - **On campaign end:** `POST /api/advertiser/end` calls `billNonRecurringCampaign()` for the campaign’s lifetime impressions before archiving (if not already billed).

- **Eligibility (runNonRecurringBilling):**  
  - `recurring_weekly = FALSE`, `approved = TRUE`, `completed = TRUE`, `payment_completed = TRUE`  
  - Not archived, `stripe_customer_id` and `campaign_start_date` set  
  - `campaign_start_date <= NOW() - INTERVAL '7 days'`  
  - No existing `non_recurring_billing_records` for this campaign.

- **Logic:**  
  - `billNonRecurringCampaign()` bills **total_impressions** (and optional clicks) for the go-live week, creates Stripe Invoice, inserts into `non_recurring_billing_records`, then **archives** the campaign, then updates **donation_ledger** and **weekly_donation_pool**.

### What gets updated when billing runs

- **recurring_billing_records** (recurring): one row per advertiser per billing week.  
- **non_recurring_billing_records** (non-recurring): one row per campaign; after that, campaign is archived.  
- **donation_ledger:**  
  - `source_type = 'advertiser'`, `source_id` = campaign/advertiser id (string), `billing_record_id` = new recurring or non-recurring billing record id, `amount` = billed amount, `week_start` = billing week start (date).  
  - Insert uses `ON CONFLICT (source_id, week_start) DO NOTHING` (idempotent).  
- **weekly_donation_pool:**  
  - Upsert by `week_start`; adds `billedAmount` to `advertiser_total`, leaves `sponsor_total` unchanged (or sets 0 if new row).

### Manual trigger in development

Cron routes require either the Vercel cron header or local dev:

- **Security check (all three routes):**  
  `if (!(req.headers['x-vercel-cron'] === '1') && process.env.NODE_ENV === 'production') return 401`

So in development, call without the header (or with `NODE_ENV` not `production`). Example (replace base URL with your backend):

```bash
# Weekly reset (Monday 08:00 UTC equivalent)
curl -s "http://localhost:3000/api/system/weekly-reset"

# Recurring billing
curl -s "http://localhost:3000/api/system/weekly-recurring-billing"

# Non-recurring billing
curl -s "http://localhost:3000/api/system/non-recurring-billing"
```

For production-like local testing with the cron header:

```bash
curl -s -H "x-vercel-cron: 1" "http://localhost:3000/api/system/weekly-recurring-billing"
```

---

## 4. Campaign end

- **Endpoint:** `POST /api/advertiser/end` (authenticated; `requireAdvertiserAuth`).  
- **Query/body:** `campaignId` (required).

**Behavior:**

1. Validates campaign exists and belongs to the authenticated advertiser; ensures not already archived.  
2. **Billing before archive:**  
   - **Recurring:** Calls `billCampaignUsage(..., trigger: 'campaign_end')` for the **current** billing week. If billing fails (not skipped), responds 500 and does **not** archive.  
   - **Non-recurring:** Calls `billNonRecurringCampaign()`. That function bills lifetime impressions, inserts billing record, updates donation_ledger and weekly_donation_pool, then **archives** the campaign. So for non-recurring, the endpoint may return success immediately after billing with “campaign already archived.”  
3. **Recurring only (after billing):** Moves creative in R2 to `archived/<video_filename>`, then updates `advertisers` to `archived = true` and sets `media_r2_link` to the archived URL.

**Status after end:**  
- `archived = true`; campaign is excluded from playlist and from future billing.

**Billing at end:**  
- Yes: both recurring and non-recurring are billed at end (recurring for current week, non-recurring for total lifetime). Donation ledger and weekly pool are updated in both cases when billing runs.

---

## 5. How to test end-to-end in development

### Prerequisites

- Backend running (e.g. `cd backend && npm run dev`) with `.env` (e.g. `DATABASE_URL`, Stripe keys, R2, email).  
- Stripe webhook forwarding for `checkout.session.completed` (e.g. Stripe CLI: `stripe listen --forward-to localhost:3000/api/webhook`).  
- Optional: use Stripe test cards and test clock for predictable billing weeks.

### Suggested sequence

1. **Create campaign and “pay”**  
   - Use the frontend to fill the form and create a checkout session (`POST /api/advertiser/create-checkout-session` with `fileUrl` from a prior upload), or simulate the same.  
   - Complete Stripe Checkout (test mode).  
   - Confirm webhook sets `payment_completed = TRUE`, `application_status = 'pending_approval'` on the new `advertisers` row.

2. **Mark approved and run approval script**  
   - Set approved in DB (script expects `approved = true` for new campaigns):  
     `UPDATE advertisers SET approved = true WHERE id = <id> AND completed = false;`  
   - Run: `cd backend && npm run process-advertisers`  
   - Confirm the row gets `completed = true`, `application_status = 'approved'`, `campaign_start_date`, `video_filename`, and media in `charity-stream-videos`.

3. **Simulate impressions (optional)**  
   - Trigger the impression-recording endpoint your app uses for ad views so `current_week_impressions` (and for non-recurring `total_impressions`) increase. This ensures billing has something to bill.

4. **Trigger billing manually**  
   - **Recurring:**  
     `curl -s "http://localhost:3000/api/system/weekly-recurring-billing"`  
   - **Non-recurring:**  
     Only after `campaign_start_date` is at least 7 days in the past (or temporarily set in DB for testing):  
     `curl -s "http://localhost:3000/api/system/non-recurring-billing"`

5. **Verify donation_ledger and weekly_donation_pool**  
   - After recurring or non-recurring billing:  
     - `donation_ledger`: one row with `source_type = 'advertiser'`, `source_id` = campaign id, `billing_record_id` = new id, `amount` = billed amount, `week_start` = billing week start.  
     - `weekly_donation_pool`: row for that `week_start` with `advertiser_total` increased by the same amount.  
   - Example checks (replace `<campaign_id>` and `<week_start>`):  
     ```sql
     SELECT * FROM donation_ledger WHERE source_type = 'advertiser' AND source_id = '<campaign_id>';
     SELECT * FROM weekly_donation_pool WHERE week_start = '<week_start>';
     ```

6. **Optional: campaign end**  
   - Call `POST /api/advertiser/end?campaignId=<id>` with a valid advertiser JWT.  
   - Recurring: current week is billed, then campaign archived.  
   - Non-recurring: `billNonRecurringCampaign` runs (if not already billed by cron), then campaign archived.  
   - Confirm `advertisers.archived = true` and that ledger/pool were updated if billing ran.

### Quick curl reference (local)

```bash
# Cron endpoints (no auth; in dev, no x-vercel-cron needed)
curl -s "http://localhost:3000/api/system/weekly-reset"
curl -s "http://localhost:3000/api/system/weekly-recurring-billing"
curl -s "http://localhost:3000/api/system/non-recurring-billing"
```

### npm scripts (backend)

- **Approval script:** `cd backend && npm run process-advertisers`  
- **Start server:** `cd backend && npm run dev` (or `npm start`)

---

## Route and script reference

| Purpose              | Type  | Path/script |
|----------------------|-------|----------------------|
| Advertiser submit    | POST  | `/api/advertiser/submit` |
| Create checkout      | POST  | `/api/advertiser/create-checkout-session` |
| Stripe webhook       | POST  | `/api/webhook` |
| Approve campaigns    | Script| `backend/scripts/process-approved-advertisers.js` (`npm run process-advertisers`) |
| Weekly reset         | GET   | `/api/system/weekly-reset` |
| Recurring billing    | GET   | `/api/system/weekly-recurring-billing` |
| Non-recurring billing| GET   | `/api/system/non-recurring-billing` |
| End campaign         | POST  | `/api/advertiser/end` |

**Vercel crons (vercel.json):**  
- `0 8 * * 1`: weekly-reset, weekly-recurring-billing, non-recurring-billing.  
- No cron runs the advertiser approval script; it must be run manually or by an external scheduler.

This gives you the full advertiser campaign flow from submission through activation, billing, and end, with exact routes, script names, and how `donation_ledger` and `weekly_donation_pool` are updated.
