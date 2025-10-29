# Advertisers Table Manipulation Code

## Overview
This document contains all code that manipulates the `advertisers` table in your Neon PostgreSQL database.

## Table Schema
The `advertisers` table has the following columns:
- `id` (INTEGER, PRIMARY KEY, AUTO-INCREMENT)
- `company_name` (TEXT)
- `website_url` (TEXT)
- `first_name` (TEXT)
- `last_name` (TEXT)
- `email` (TEXT, NOT NULL)
- `title_role` (TEXT)
- `ad_format` (TEXT)
- `weekly_budget_cap` (NUMERIC/DECIMAL)
- `cpm_rate` (NUMERIC/DECIMAL)
- `media_r2_link` (TEXT)
- `recurring_weekly` (BOOLEAN, DEFAULT FALSE)
- `approved` (BOOLEAN, DEFAULT FALSE)
- `completed` (BOOLEAN, DEFAULT FALSE)
- `submission_type` (TEXT, DEFAULT 'campaign')
- `application_status` (VARCHAR, DEFAULT 'pending')
- `stripe_customer_id` (VARCHAR)
- `stripe_subscription_id` (VARCHAR)
- `stripe_price_id` (VARCHAR)
- `expedited` (BOOLEAN, DEFAULT FALSE)
- `click_tracking` (BOOLEAN, DEFAULT FALSE)
- `destination_url` (TEXT)
- `file_data` (BYTEA)
- `file_original_name` (TEXT)
- `file_mime_type` (TEXT)
- `updated_at` (TIMESTAMP)
- ... (many other tracking columns)

## Code Locations

### 1. Create Advertiser Record (Payment Pending)
**Location:** `server.js` lines 3939-3965  
**Endpoint:** `/api/advertiser/create-checkout-session`  
**Purpose:** Creates initial advertiser record before Stripe checkout

```javascript
const advertiserResult = await pool.query(
  `INSERT INTO advertisers (
    company_name, website_url, first_name, last_name, 
    email, title_role, ad_format, weekly_budget_cap, cpm_rate, 
    recurring_weekly, expedited, click_tracking, destination_url,
    application_status, approved, completed, created_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'payment_pending', false, false, CURRENT_TIMESTAMP)
  RETURNING id, email, company_name`,
  [
    companyName || null,
    websiteUrl || null,
    firstName || null,
    lastName || null,
    email,
    jobTitle || null,
    databaseAdFormat || null,
    weeklyBudget ? parseFloat(weeklyBudget) : null,
    cpmRate ? parseFloat(cpmRate) : null,
    isRecurring === 'true' || isRecurring === true,
    expeditedApproval === 'true' || expeditedApproval === true,
    clickTracking === 'true' || clickTracking === true,
    destinationUrl || null
  ]
);
```

### 2. Store File Data (After Creation)
**Location:** `server.js` lines 3971-3983  
**Purpose:** Stores uploaded file buffer, filename, and MIME type

```javascript
await pool.query(
  `UPDATE advertisers 
   SET file_data = $1, 
       file_original_name = $2, 
       file_mime_type = $3 
   WHERE id = $4`,
  [
    fileData.buffer, 
    fileData.originalname, 
    fileData.mimetype, 
    advertiser.id
  ]
);
```

### 3. Update Stripe Customer ID
**Location:** `server.js` lines 4072-4075  
**Purpose:** Links Stripe customer to advertiser record

```javascript
await pool.query(
  'UPDATE advertisers SET stripe_customer_id = $1 WHERE id = $2',
  [customer.id, advertiser.id]
);
```

### 4. Retrieve Session Details
**Location:** `server.js` lines 4120-4142  
**Endpoint:** `/api/advertiser/session-details`  
**Purpose:** Fetches advertiser details for success page

```javascript
const advertiserResult = await pool.query(
  'SELECT id, company_name, email, expedited, application_status, created_at FROM advertisers WHERE id = $1',
  [session.metadata.advertiserId]
);

const advertiser = advertiserResult.rows[0];
```

### 5. Webhook: Retrieve Full Advertiser Record
**Location:** `server.js` lines 4507-4574  
**Endpoint:** `/api/webhook` (customer.subscription.created)  
**Purpose:** Gets advertiser data for webhook processing

```javascript
const advertiserResult = await pool.query(
  'SELECT * FROM advertisers WHERE id = $1',
  [advertiserId]
);

const advertiser = advertiserResult.rows[0];
```

### 6. Webhook: Clear File Data
**Location:** `server.js` lines 4547-4555  
**Purpose:** Removes temporary file data after R2 upload

```javascript
await pool.query(
  `UPDATE advertisers 
   SET file_data = NULL, 
       file_original_name = NULL, 
       file_mime_type = NULL 
   WHERE id = $1`,
  [advertiserId]
);
```

### 7. Webhook: Update Application Status
**Location:** `server.js` lines 4564-4574  
**Purpose:** Updates advertiser status to 'pending_approval' after payment

```javascript
const updateResult = await pool.query(
  `UPDATE advertisers 
   SET application_status = 'pending_approval',
       stripe_customer_id = $1,
       stripe_subscription_id = $2,
       media_r2_link = $3,
       updated_at = CURRENT_TIMESTAMP
   WHERE id = $4
   RETURNING id, email, company_name, expedited, click_tracking, ad_format, cpm_rate, weekly_budget_cap`,
  [subscription.customer, subscription.id, mediaUrl, advertiserId]
);
```

## Database Flow

1. **User submits form** → Creates `payment_pending` record
2. **File uploaded** → Stores file buffer in `file_data` column
3. **Stripe checkout** → Links `stripe_customer_id`
4. **Payment succeeds** → Webhook triggers:
   - File uploaded to R2
   - File data cleared from database
   - Status updated to `pending_approval`
   - Stripe IDs saved

## Key Columns

- **`application_status`**: `payment_pending` → `pending_approval` → (future: `approved`, `rejected`)
- **`file_data`**: Temporary BYTEA storage before R2 upload
- **`stripe_customer_id`**: Links to Stripe customer
- **`stripe_subscription_id`**: Links to Stripe subscription
- **`media_r2_link`**: Final R2 URL after upload

## Endpoints

- **POST** `/api/advertiser/create-checkout-session` - Create advertiser + checkout
- **GET** `/api/advertiser/session-details` - Get session info
- **POST** `/api/webhook` - Process Stripe webhooks

