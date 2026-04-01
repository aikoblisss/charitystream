# Advertiser Account → Campaign → Billing Records Ownership Chain

## Executive Summary

**Key Finding**: The system uses **email** as the linking mechanism between advertiser accounts and campaigns, NOT `advertiser_id` foreign keys. Multiple campaigns can share the same email address, representing one advertiser account with multiple campaigns.

---

## 1. Authoritative Advertiser Account Table

### Table: `advertiser_accounts`

**Primary Key**: `id` (SERIAL)

**Key Columns**:
- `id` - Primary key (account identifier)
- `email` - **UNIQUE** (case-insensitive, enforced via unique index on `LOWER(TRIM(email))`)
- `advertiser_id` - **Nullable**, NOT unique (can link to one campaign, but can be NULL)
- `password_hash` - For portal authentication
- Token columns: `signup_token`, `password_reset_token`, `initial_setup_token`

**Purpose**: Stores login credentials and account-level data for the advertiser portal.

**Constraints** (from migrations):
- Email is unique (case-insensitive)
- `advertiser_id` is nullable and NOT unique (multiple accounts can theoretically link to same campaign, but more importantly, one account can only link to ONE campaign via this field)

---

## 2. Campaign/Advertiser Records Table

### Table: `advertisers`

**Primary Key**: `id` (SERIAL) - This is the **campaign ID**

**Key Columns**:
- `id` - Primary key (campaign identifier)
- `email` - **NOT unique** (multiple campaigns can share same email)
- `company_name` - Can vary per campaign
- `campaign_name` - Campaign-specific name
- `stripe_customer_id` - Can be shared across campaigns with same email
- `payment_completed` - Boolean flag
- Campaign data: `cpm_rate`, `weekly_budget_cap`, `total_impressions`, etc.

**Purpose**: Each row represents one campaign. Multiple rows can share the same `email`, representing multiple campaigns owned by the same advertiser account.

---

## 3. How Campaigns Link to Advertiser Accounts

### Primary Linking Mechanism: **Email Matching**

**Relationship**: `advertiser_accounts.email` = `advertisers.email`

**Evidence from code** (dashboard endpoint, line 7408):
```sql
SELECT ... FROM advertisers
WHERE email = $1  -- advertiserEmail from advertiser_accounts
  AND payment_completed = TRUE
```

**Key Points**:
1. **Email is the account identifier** - One `advertiser_accounts.email` can own multiple `advertisers` rows
2. **`advertiser_accounts.advertiser_id` is NOT the primary link** - It's only used for:
   - Linking one specific campaign to the account for portal access
   - Can be NULL (account exists but no campaign linked yet)
   - Can be updated when a new campaign is submitted
3. **Multiple campaigns per account** - The dashboard query (line 7392-7411) fetches ALL campaigns for an email:
   ```sql
   SELECT ... FROM advertisers
   WHERE email = $1
     AND payment_completed = TRUE
   ORDER BY campaign_start_date DESC NULLS LAST, created_at DESC
   ```

### Secondary Link: `advertiser_accounts.advertiser_id`

**Relationship**: `advertiser_accounts.advertiser_id` → `advertisers.id` (nullable, one-to-one)

**Purpose**: Links one specific campaign to the account for portal authentication/access. This is NOT how you find all campaigns for an account.

**Evidence** (submission flow, line 3256-3270):
```sql
UPDATE advertiser_accounts
SET advertiser_id = $1  -- new campaign.id
WHERE id = $2
  AND advertiser_id IS NULL  -- Only update if NULL
```

**Note**: This field can be NULL and is NOT unique, meaning:
- An account can exist without a linked campaign
- Multiple accounts could theoretically link to the same campaign (though unlikely in practice)

---

## 4. How Billing Records Relate to Campaigns

### Table: `recurring_billing_records`

**Columns** (from INSERT statement, line 5525-5527):
- `advertiser_id` → **References `advertisers.id`** (campaign ID)
- `amount_billed` - Stripe invoice amount
- `stripe_invoice_id` - Stripe invoice identifier
- `billing_week_start`, `billing_week_end`
- `impressions_billed`

**Relationship**: `recurring_billing_records.advertiser_id` = `advertisers.id`

**Evidence** (line 5529):
```sql
INSERT INTO recurring_billing_records 
(advertiser_id, ...)
VALUES ($1, ...)  -- ad.id (campaign ID)
```

### Table: `non_recurring_billing_records`

**Columns** (from INSERT statement, line 6115-6117):
- `campaign_id` → **References `advertisers.id`** (campaign ID, unique constraint)
- `advertiser_id` → **Also references `advertisers.id`** (same as campaign_id for non-recurring)
- `amount_billed` - Stripe invoice amount
- `stripe_invoice_id` - Stripe invoice identifier
- `billing_week_start`, `billing_week_end`
- `impressions_billed`

**Relationship**: 
- `non_recurring_billing_records.campaign_id` = `advertisers.id`
- `non_recurring_billing_records.advertiser_id` = `advertisers.id` (same value as campaign_id)

**Evidence** (line 6119-6120):
```sql
INSERT INTO non_recurring_billing_records 
(campaign_id, advertiser_id, ...)
VALUES ($1, $2, ...)  -- ad.id, ad.id (both are the campaign ID)
```

**Note**: For non-recurring campaigns, `campaign_id` and `advertiser_id` in the billing record are the same value (the campaign ID).

---

## 5. Complete Ownership Chain

```
┌─────────────────────────────────────┐
│ advertiser_accounts                 │
│ ─────────────────────────────────── │
│ id (PK)                              │
│ email (UNIQUE, case-insensitive)    │ ← Account Identifier
│ advertiser_id (nullable, FK)         │ ← Links to ONE campaign (optional)
│ password_hash                        │
└─────────────────────────────────────┘
         │
         │ Relationship: email matching
         │ (NOT advertiser_id FK)
         │
         ▼
┌─────────────────────────────────────┐
│ advertisers (Campaigns)              │
│ ─────────────────────────────────── │
│ id (PK) = Campaign ID                │
│ email (NOT unique)                   │ ← Links to account via email
│ company_name                         │
│ campaign_name                        │
│ stripe_customer_id                   │
│ payment_completed                    │
│ ... (campaign data)                  │
└─────────────────────────────────────┘
         │
         │ Relationship: advertiser_id / campaign_id
         │
         ├─────────────────────────────┐
         │                             │
         ▼                             ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│ recurring_billing_records │  │ non_recurring_billing_records│
│ ──────────────────────── │  │ ─────────────────────────── │
│ advertiser_id →          │  │ campaign_id →                 │
│   advertisers.id         │  │   advertisers.id             │
│ amount_billed            │  │ advertiser_id →              │
│ stripe_invoice_id       │  │   advertisers.id (same value) │
└──────────────────────────┘  │ amount_billed                │
                               │ stripe_invoice_id            │
                               └──────────────────────────────┘
```

---

## 6. Critical Insights for Aggregation

### For Top Advertisers Leaderboard:

**Current Implementation Issue**: The endpoint aggregates by `advertisers.id` (campaign-level), but should aggregate by **advertiser account** (email-level).

**Correct Aggregation Strategy**:

1. **Group by**: `advertisers.email` (not `advertisers.id`)
2. **Sum billing records**: All `amount_billed` from billing records where:
   - `recurring_billing_records.advertiser_id` = any `advertisers.id` with matching email
   - `non_recurring_billing_records.campaign_id` = any `advertisers.id` with matching email
3. **Display**: Use `company_name` from one of the campaigns (most recent or most common)

**Why Email, Not ID**:
- One advertiser account (email) can have multiple campaigns
- Each campaign has its own `advertisers.id`
- Billing records reference `advertisers.id` (campaign ID)
- To get total donations per account, must:
  1. Find all campaigns with same email
  2. Sum all billing records for those campaign IDs

---

## 7. Exact Column Relationships

### Account → Campaigns
```
advertiser_accounts.email (UNIQUE)
    =
advertisers.email (NOT unique, multiple rows per email)
```

### Campaigns → Billing Records (Recurring)
```
advertisers.id
    =
recurring_billing_records.advertiser_id
```

### Campaigns → Billing Records (Non-Recurring)
```
advertisers.id
    =
non_recurring_billing_records.campaign_id
    AND
non_recurring_billing_records.advertiser_id (same value as campaign_id)
```

---

## 8. Example Data Flow

**Scenario**: One advertiser account with 3 campaigns

```
advertiser_accounts:
  id: 1
  email: "marketing@company.com"
  advertiser_id: 5  (links to campaign #5, but account owns campaigns 5, 7, 9)

advertisers (campaigns):
  id: 5, email: "marketing@company.com", company_name: "Company A"
  id: 7, email: "marketing@company.com", company_name: "Company A"  
  id: 9, email: "marketing@company.com", company_name: "Company A"

recurring_billing_records:
  advertiser_id: 5, amount_billed: 100.00
  advertiser_id: 7, amount_billed: 150.00

non_recurring_billing_records:
  campaign_id: 9, advertiser_id: 9, amount_billed: 75.00

Total for account "marketing@company.com": $325.00
```

---

## 9. Implications for Leaderboard Query

**Current (INCORRECT) Query**:
```sql
-- Groups by advertisers.id (campaign-level)
GROUP BY a.id, a.company_name
```

**Correct Query Should Be**:
```sql
-- Groups by email (account-level)
GROUP BY a.email
-- Then sum all billing records for all campaigns with that email
```

**Correct Aggregation**:
1. Find all unique `advertisers.email` values
2. For each email, find all `advertisers.id` values with that email
3. Sum all `amount_billed` from billing records where:
   - `recurring_billing_records.advertiser_id` IN (campaign IDs for that email)
   - `non_recurring_billing_records.campaign_id` IN (campaign IDs for that email)
4. Use `company_name` from one campaign (most recent or most common)

---

## 10. Summary

| Relationship | Link Type | Columns | Notes |
|-------------|----------|---------|-------|
| Account → Campaigns | **Email matching** | `advertiser_accounts.email` = `advertisers.email` | Primary link, one-to-many |
| Account → One Campaign | Foreign key | `advertiser_accounts.advertiser_id` → `advertisers.id` | Secondary, nullable, for portal access |
| Campaign → Recurring Billing | Foreign key | `recurring_billing_records.advertiser_id` → `advertisers.id` | Direct reference to campaign |
| Campaign → Non-Recurring Billing | Foreign key | `non_recurring_billing_records.campaign_id` → `advertisers.id` | Direct reference to campaign |

**Key Takeaway**: To aggregate by advertiser account, group by `advertisers.email`, not `advertisers.id`.
