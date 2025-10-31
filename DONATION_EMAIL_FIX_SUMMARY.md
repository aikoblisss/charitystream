# Donation Email Pre-Fill Implementation Summary

This document explains the pre-filled email approach for donations, using the same pattern that successfully works for advertisers.

---

## **ADVERTISER FLOW (WORKING PATTERN)**

### 1. **Checkout Session Creation**
- Creates a Stripe customer with email from form
- Uses `customer: customer.id` to link checkout session to customer
- Stores metadata with advertiserId for webhook lookup

**Key Code (backend/server.js ~4079-4101):**
```javascript
const customer = await stripe.customers.create({
  email: email, // Email from advertiser form
  name: `${firstName} ${lastName}`,
  metadata: customerMetadata
});

const sessionConfig = {
  customer: customer.id, // Links session to customer
  // ... other config
};
```

### 2. **Webhook Handler**
- Gets advertiserId from metadata
- Looks up advertiser from database (source of truth for email)
- Uses email from database record: `updatedAdvertiser.email`
- Sends confirmation email to database email

**Key Code (backend/server.js ~4825-4891):**
```javascript
const advertiserResult = await pool.query(
  'SELECT * FROM advertisers WHERE id = $1',
  [advertiserId]
);

const updatedAdvertiser = updateResult.rows[0];
// Email comes from database record
await emailService.sendAdvertiserConfirmationEmail(
  updatedAdvertiser.email, // Database email
  updatedAdvertiser.company_name,
  campaignSummary
);
```

**Why This Works:**
- Database record is the source of truth for email
- Email is always available in the database
- Stripe customer email matches database email

---

## **DONATION FLOW (IMPLEMENTED - MATCHES PATTERN)**

### 1. **Checkout Session Creation** ✅
- Pre-fills email using `customer_email: req.user.email` (user's Charity Stream email)
- Stores email in metadata as backup: `userEmail: req.user.email`
- Uses same metadata pattern as advertiser: `userId`, `donationType`

**Implementation (backend/server.js ~5304-5342):**
```javascript
app.post('/api/donate/create-checkout-session', authenticateToken, async (req, res) => {
  console.log('💰 Donation checkout session requested for user:', req.user.email);
  
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price: 'price_1SNmrt0CutcpJ738Sh6lSLeZ', quantity: 1 }],
    mode: 'payment',
    customer_email: req.user.email, // PRE-FILL WITH USER'S CHARITY STREAM EMAIL
    metadata: {
      donationType: 'direct_donation',
      amount: String(amount),
      userId: String(req.user.userId),
      userEmail: req.user.email // Store email in metadata as backup
    }
  });
});
```

**Benefits:**
- Email is pre-filled in Stripe checkout form
- Email stored in metadata (backup source)
- Uses user's Charity Stream account email (known, reliable source)

### 2. **Webhook Handler** ✅
- Gets userId and userEmail from metadata
- Uses metadata email first (user's Charity Stream email)
- Falls back to Stripe customer_email if metadata missing
- Matches advertiser pattern: use known, reliable email source

**Implementation (backend/server.js ~5013-5073):**
```javascript
case 'checkout.session.completed':
  const sessionCompleted = event.data.object;
  
  if (sessionCompleted.metadata?.donationType === 'direct_donation') {
    const userIdMeta = sessionCompleted.metadata?.userId;
    const userEmail = sessionCompleted.metadata?.userEmail; // Use email from metadata
    const donationAmount = sessionCompleted.amount_total;
    
    // Use the email from metadata (user's Charity Stream email) first
    const customerEmail = userEmail || sessionCompleted.customer_email;
    
    if (customerEmail && userIdMeta) {
      // Lookup username from database
      const userResult = await pool.query('SELECT username FROM users WHERE id = $1', [userIdMeta]);
      const username = userResult.rows?.[0]?.username || 'Charity Stream Supporter';
      
      // Send email to user's Charity Stream email
      await emailService.sendDonationThankYouEmail(
        customerEmail, // Uses metadata email (user's Charity Stream email)
        username,
        donationAmount
      );
    }
  }
  break;
```

**Why This Works:**
- Metadata email is the primary source (user's Charity Stream account email)
- Fallback to Stripe customer_email if metadata missing
- Uses same pattern as advertiser: reliable, known email source
- Email is pre-filled in Stripe, so customer_email will match

---

## **COMPARISON: ADVERTISER vs DONATION**

| Aspect | Advertiser (Working) | Donation (Implemented) |
|--------|---------------------|----------------------|
| **Email Source** | Database record | Metadata + pre-filled Stripe |
| **Pre-fill in Stripe** | Via Stripe customer | Via `customer_email` field |
| **Webhook Email** | Database record email | Metadata email (userEmail) |
| **Backup Email** | N/A (database always exists) | Stripe customer_email |
| **Email Reliability** | ✅ Always available | ✅ Always available |

---

## **KEY BENEFITS**

1. **Uses Known Working Email**
   - User's Charity Stream account email (same as login)
   - Pre-verified and reliable email source

2. **Pre-filled in Stripe**
   - Stripe checkout form automatically shows user's email
   - Stripe receipts also go to this email
   - Better user experience

3. **Stored in Metadata**
   - Backup email source if webhook email extraction fails
   - Always available in webhook handler
   - Same pattern as advertiser (uses metadata for lookup)

4. **Consistent with Advertiser Flow**
   - Uses same metadata pattern
   - Uses same email lookup approach
   - Uses same email service function structure

---

## **EMAIL FLOW DIAGRAM**

```
1. User clicks "💝 Donate to Charity" button
   ↓
2. Frontend: POST /api/donate/create-checkout-session
   - Sends: { amount: 300 }
   - Includes: Authorization Bearer token (req.user.email available)
   ↓
3. Backend creates Stripe Checkout Session:
   - customer_email: req.user.email (PRE-FILLED)
   - Metadata: { userEmail: req.user.email, userId: '67' }
   - Returns: { url: 'https://checkout.stripe.com/...' }
   ↓
4. Frontend redirects to Stripe Checkout URL
   ↓
5. Stripe Checkout form shows PRE-FILLED email
   - User's Charity Stream email is already filled in
   - User can change it if needed (becomes customer_email)
   ↓
6. User completes payment
   ↓
7. Stripe sends webhook: checkout.session.completed
   ↓
8. Backend webhook handler:
   - Gets userEmail from metadata.metadata.userEmail
   - Gets userId from metadata.metadata.userId
   - Uses metadata email FIRST (user's Charity Stream email)
   - Falls back to sessionCompleted.customer_email if metadata missing
   ↓
9. Email Service:
   - Calls sendDonationThankYouEmail()
   - Sends to user's Charity Stream email (from metadata)
   - Uses username from database lookup
   ↓
10. User receives thank you email at their Charity Stream account email
```

---

## **TESTING CHECKLIST**

After implementation, test:

1. ✅ **Checkout Session Creation**
   - Log: `💰 Donation checkout session requested for user: user@example.com`
   - Log: `📧 Pre-filled email in Stripe checkout: user@example.com`
   - Verify Stripe checkout form shows pre-filled email

2. ✅ **Webhook Handler**
   - Log: `💰 Metadata: { donationType: 'direct_donation', userEmail: 'user@example.com', userId: '67' }`
   - Log: `🔍 Donation email lookup: { metadataUserEmail: 'user@example.com', stripeCustomerEmail: 'user@example.com', userId: '67' }`
   - Log: `📧 Sending donation thank you email to: user@example.com, username: username`
   - Log: `✅ Donation thank you email sent successfully!`

3. ✅ **Email Delivery**
   - Verify email arrives at user's Charity Stream account email
   - Verify email contains correct username and amount
   - Verify email contains proper formatting

---

## **CHANGES MADE**

### **File: backend/server.js**

1. **Donation Checkout Session Creation (lines 5304-5342)**
   - Added: `customer_email: req.user.email` - Pre-fills email in Stripe checkout
   - Added: `userEmail: req.user.email` - Stores email in metadata as backup
   - Added: Logging for user email and pre-fill confirmation

2. **Donation Webhook Handler (lines 5013-5073)**
   - Changed: Uses `metadata.userEmail` as primary email source
   - Changed: Falls back to `sessionCompleted.customer_email` if metadata missing
   - Changed: Removed `sessionCompleted.customer` parameter (not needed)
   - Added: Enhanced logging for email lookup debugging

---

## **WHY THIS APPROACH IS BETTER**

### **Previous Approach (Issues)**
- Relied on `customer_details?.email` which can be undefined
- Email extraction from webhook was unreliable
- No pre-filled email in Stripe checkout form

### **New Approach (Benefits)**
- ✅ Pre-fills email in Stripe checkout (better UX)
- ✅ Uses metadata email (primary source - always available)
- ✅ Fallback to Stripe customer_email (backup)
- ✅ Uses user's Charity Stream email (known, reliable source)
- ✅ Matches working advertiser pattern
- ✅ Stripe receipts also go to correct email

---

## **CONCLUSION**

The donation email system now:
- **Pre-fills email** in Stripe checkout form
- **Stores email in metadata** for reliable webhook access
- **Uses known email source** (user's Charity Stream account)
- **Matches advertiser pattern** (proven to work)
- **Sends thank you emails** reliably to user's Charity Stream email

This implementation ensures both Stripe receipts and our thank you emails go to the user's Charity Stream account email, providing a consistent and reliable email experience that matches the working advertiser flow.

