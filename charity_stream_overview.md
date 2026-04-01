Charity Stream — Project Context
What This Project Is
Charity Stream is a full-stack donation platform where advertisers and sponsors run campaigns, their payments are collected weekly, and all proceeds go to a selected charity each week. Users watch ads to drive impressions, which determines how much advertisers are billed.

Tech Stack

Backend: Node.js (≥18), Express 4, hosted on Vercel (backend/server.js is the single entrypoint)
Database: PostgreSQL via Neon (@neondatabase/serverless + WebSocket) — all production queries go through Neon; pg is used in standalone scripts only
Payments: Stripe — customers, Checkout Sessions (setup + payment mode), Setup Intents, Invoices, Subscriptions, Webhooks
Object Storage: Cloudflare R2 via AWS S3 SDK — advertiser videos, sponsor logos/videos
Auth: JWT for viewers/advertisers/sponsors; Google OAuth via Passport for viewers
Email: Nodemailer (backend/services/emailService.js)
Frontend: Static HTML + inline CSS/JS (public/) for main site; React 19 + Vite + TypeScript (portal/) for advertiser dashboard
Scheduling: Vercel cron jobs hit GET /api/system/* endpoints on Saturday afternoon (fallback winner selection) and Monday mornings (billing, reset, finalization)


Project Structure
charitystream/
├── backend/
│   ├── server.js              # Everything: API routes, webhooks, billing logic, static serving
│   ├── database-postgres.js   # Neon pool, bootstrap CREATE TABLE for core tables
│   ├── services/              # emailService.js, tokenService.js, googleAuthService.js
│   ├── config/                # google-oauth.js
│   ├── migrations/            # SQL patches (ALTER/CREATE for extended schema)
│   └── scripts/               # Operational jobs: billing, approvals, winner selection, video gen
├── public/                    # Static pages: index, about, advertise, impact, auth, admin, etc.
├── portal/                    # React advertiser dashboard (Vite build)
├── vercel.json                # Vercel build config + cron schedule
└── env-template.txt           # Example env vars

Key Environment Variables
DATABASE_URL, PORT, NODE_ENV, JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY, STRIPE_PRICE_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL, FRONTEND_URL, SITE_BASE_URL, EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, SKIP_WEBHOOK_VERIFICATION, ADMIN_USERNAME, ADMIN_PASSWORD_HASH

Active Core Tables
Table	Purpose
users	Viewer accounts — JWT auth, watch stats, Google OAuth, optional Stripe premium subscription
watch_sessions	One row per ad viewing session per user
ad_tracking	Individual ad start/complete events per session
daily_stats	Per-user daily ad watch aggregates (unique on user_id, date)
advertisers	One row per advertiser campaign — all campaign state lives here: billing flags, impression counts, Stripe IDs, archive status, pause state, real-time weekly_contributed_amount that accrues as impressions and clicks occur
advertiser_accounts	One row per advertiser account (login credentials, canonical Stripe customer ID) — one account can have multiple advertisers rows
advertiser_account_tokens	Password reset / signup tokens for advertiser portal auth
sponsor_accounts	One row per sponsor organization (login, Stripe customer ID)
sponsor_campaigns	One row per sponsor campaign — tier, status, impression/click counters, video/logo R2 keys
sponsor_billing	Billing records for sponsor payments (Checkout or invoice)
sponsor_account_tokens	Auth tokens for sponsor portal
sponsor_unique_viewers	Dedup junction table — one row per (sponsor_campaign_id, viewer_id, rollup_date) to prevent double-counting unique viewers
sponsor_donations	Records individual sponsor payments (one-time and recurring) that flow into the weekly donation pool
charity_applications	Active charity intake pipeline — paid entry, approval/rejection, winner selection
charity_week_pool	Eligible charities per week (populated by approvals script, read by winner selection)
charity_week_winner	One winning charity per week_start — selected manually or by fallback cron
donation_ledger	Immutable internal accounting — one row per payment from any source (advertiser billing, sponsor payment, or direct viewer donation), feeds weekly pool. source_type is one of 'advertiser', 'sponsor', or 'direct_donation'. Unique on (source_id, week_start) for idempotency
weekly_donation_pool	Running weekly totals split by source — sponsor_total, advertiser_total, and viewer_total (direct donations). Upserted by all three billing paths, stamped with finalized_at by finalize job
weekly_charity_allocation	Finalized payout snapshot per week tying pooled money to winning charity — stores sponsor_amount, advertiser_amount, viewer_amount, and total_amount. Written by finalize job only
transfer_intents	Ledger rows for pending fiscal sponsor payouts — written by finalize job, not yet wired to Stripe Transfers
weekly_impact_goals	UI config for weekly fundraising goal amount + partner name — no longer actively used, goal is now hardcoded to $500
non_recurring_billing_records	One row per billed non-recurring advertiser campaign — idempotency guard for billing job
recurring_billing_records	One row per recurring advertiser per billing week
donations	Viewer one-time direct donations via Stripe Checkout — records the Stripe session, payment intent, amount in dollars, and status. Separate from advertiser/sponsor billing. Source of truth for direct donation amounts before they are written to donation_ledger and weekly_donation_pool via the checkout.session.completed webhook
desktop_active_sessions	Heartbeat table for active desktop viewer sessions (fingerprint + last heartbeat)
Legacy / Unused Tables
Table	Status
charities	Legacy — superseded by charity_applications, no writes in codebase
sponsors	Legacy — superseded by sponsor_accounts/sponsor_campaigns, no writes in codebase
videos	Legacy admin video catalog — not used by live playlist (playlist reads R2 + advertisers directly)
video_advertiser_mappings	Partially legacy — no inserts in codebase, only updated by delete-video.js

Billing Architecture
Non-recurring advertisers:

Pay once at end of campaign based on total impressions × CPM rate
runNonRecurringBilling() triggered by Vercel cron → GET /api/system/non-recurring-billing
Eligibility: recurring_weekly = FALSE, approved = TRUE, completed = TRUE, payment_completed = TRUE, archived = FALSE, campaign_start_date <= NOW() - 7 days, no existing row in non_recurring_billing_records
Creates Stripe Invoice → finalizes → inserts non_recurring_billing_records + donation_ledger + upserts weekly_donation_pool → archives campaign
Default payment method retrieved via customer.invoice_settings.default_payment_method with fallback to stripe.paymentMethods.list() (fallback also promotes PM to default)

Recurring advertisers:

Billed weekly via runWeeklyRecurringBilling() → GET /api/system/weekly-recurring-billing
Inserts recurring_billing_records + donation_ledger + upserts weekly_donation_pool

Non-recurring sponsors:

Card saved at signup via Stripe Checkout in setup mode (no immediate charge)
Charged when the admin runs the video generation script (generate-sponsor-videos-ffmpeg.js) at approval time
start_week and end_at (= start_week + 7 days) are set by the same script
Activated Monday by sponsor-monday-activation cron; ended the following Monday by sponsor-end-campaigns cron
Inserts sponsor_billing + donation_ledger + upserts weekly_donation_pool

Recurring sponsors:

Billed via Stripe subscription (weekly); trial held until campaign is approved and video generated
sponsor-monday-activation activates ready campaigns (status → active) and extends Stripe trial one week for campaigns not yet ready
Inserts sponsor_billing + donation_ledger + upserts weekly_donation_pool when invoice.paid fires


Stripe Webhook Flow

Endpoint: POST /api/webhook — signature verified via STRIPE_WEBHOOK_SECRET
ENV-GUARD: events are ignored if event.livemode doesn't match the API key mode (test vs live)
Key events handled: checkout.session.completed (advertiser setup, sponsor, direct donation), customer.subscription.created (recurring advertiser), setup_intent.succeeded (payment method attachment + payment_completed backup path), invoice events
payment_completed = TRUE on advertisers is set by checkout.session.completed (setup mode, primary path) and setup_intent.succeeded (backup path)


Cron Schedule (Vercel)
Time (UTC)Time (PST)DayEndpointPurpose20:0012:00 PM SatSaturday/api/system/fallback-winner-selectionAuto-selects a charity winner for the upcoming week if none has been chosen manually; emails the charity06:0010:00 PM SunSunday/api/system/sponsor-monday-activationActivates approved recurring + non-recurring sponsor campaigns; extends Stripe trials one week for campaigns not yet ready08:0012:00 AM MonMonday/api/system/weekly-recurring-billingBills active recurring advertiser campaigns (impressions × CPM + optional click cost); writes recurring_billing_records; donation_ledger + weekly_donation_pool written when invoice.paid webhook fires08:0012:00 AM MonMonday/api/system/non-recurring-billingBills one-time advertiser campaigns that are ≥7 days old; writes non_recurring_billing_records; archives campaign after billing08:0512:05 AM MonMonday/api/system/sponsor-end-campaignsEnds non-recurring sponsor campaigns whose end_at date has passed (end_at set at video generation time = start_week + 7 days)08:1012:10 AM MonMonday/api/system/weekly-resetResets current_week_impressions, weekly_clicks, weekly_contributed_amount, and capped flag on all paid advertiser campaigns10:002:00 AM MonMonday/api/system/finalize-weekly-donationsFinalizes weekly_donation_pool, writes weekly_charity_allocation and transfer_intents, emails winning charity. Skips if no winner selected.

Note: All PST times shift +1 hour during PDT (summer). Vercel crons run in UTC and do not adjust for DST.

Frontend Pages (public/)
All pages share a standardized header with consistent CSS. Key pages: index.html (homepage + ad player), about.html, advertise.html, impact.html, auth.html, advertiser.html (advertiser signup flow), charity.html, admin.html. The portal/ React app serves the advertiser dashboard post-signup.

Admin Dashboard:
under URL: admin-cs. Used to approve and reject advertiser, sponsor, and charity applications and to select the charity winner for each week. Leverages the scripts in charitystream/backend/scripts.

Known Legacy / Watch-Out Areas

Some admin routes still reference dbHelpers.db (SQLite-style) rather than Neon — unreliable in production
video_advertiser_mappings has no insert path in the codebase — populated manually
weekly_impact_goals has no insert path in the codebase — populated manually via SQL
transfer_intents records pending payouts but no Stripe Transfer API calls are wired up yet
Stripe CLI must be logged into the same account as STRIPE_SECRET_KEY for local webhook forwarding (stripe login before stripe listen)