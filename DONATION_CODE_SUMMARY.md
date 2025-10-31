# Donation Tracking and Email Code Summary

This document contains all code related to donation checkout, tracking, and thank you email sending.

---

## **1. BACKEND - Donation Checkout Session Creation**

**File:** `backend/server.js`  
**Lines:** 5285-5317

```javascript
// Donation checkout session endpoint
app.post('/api/donate/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    console.log('💰 Donation checkout session requested');
    const { amount = 300 } = req.body || {};
    // Basic validation
    if (typeof amount !== 'number' || isNaN(amount) || amount < 100) {
      return res.status(400).json({ error: 'Minimum donation amount is $1.00' });
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: 'price_1SNmrt0CutcpJ738Sh6lSLeZ',
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/donation/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/`,
      metadata: {
        donationType: 'direct_donation',
        amount: String(amount),
        userId: String(req.user?.userId || ''),
      }
    });
    console.log('✅ Donation checkout session created:', session.id);
    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Donation session creation failed:', error);
    res.status(500).json({ error: 'Failed to create donation session' });
  }
});
```

**Key Details:**
- **Endpoint:** `POST /api/donate/create-checkout-session`
- **Authentication:** Required (`authenticateToken` middleware)
- **Default Amount:** $3.00 (300 cents)
- **Minimum Amount:** $1.00 (100 cents)
- **Stripe Price ID:** `price_1SNmrt0CutcpJ738Sh6lSLeZ` (custom amount price)
- **Metadata Stored:**
  - `donationType: 'direct_donation'` - Identifies donation payments
  - `amount: String(amount)` - Donation amount in cents
  - `userId: String(req.user?.userId || '')` - User ID for email lookup

---

## **2. BACKEND - Donation Payment Webhook Handler**

**File:** `backend/server.js`  
**Lines:** 5012-5060  
**Event:** `checkout.session.completed`

```javascript
case 'checkout.session.completed':
  const sessionCompleted = event.data.object;
  console.log('💰 ===== DONATION PAYMENT COMPLETED =====');
  console.log('💰 Session ID:', sessionCompleted.id);
  console.log('💰 Customer email:', sessionCompleted.customer_details?.email);
  console.log('💰 Amount total:', sessionCompleted.amount_total);
  console.log('💰 Metadata:', sessionCompleted.metadata);
  
  try {
    if (sessionCompleted.metadata?.donationType === 'direct_donation') {
      const userIdMeta = sessionCompleted.metadata?.userId;
      const donationAmount = sessionCompleted.amount_total;
      const customerEmail = sessionCompleted.customer_details?.email;
      
      if (customerEmail && userIdMeta) {
        const pool = getPool();
        if (pool) {
          try {
            const userResult = await pool.query('SELECT username FROM users WHERE id = $1', [userIdMeta]);
            const username = userResult.rows?.[0]?.username || 'Charity Stream Supporter';
            console.log('📧 Sending donation thank you email to:', customerEmail, 'username:', username);
            
            if (emailService && emailService.isEmailConfigured()) {
              const emailResult = await emailService.sendDonationThankYouEmail(
                customerEmail,
                username,
                donationAmount,
                sessionCompleted.customer
              );
              if (!emailResult.success) {
                console.error('❌ Failed to send donation thank you email:', emailResult.error);
              }
            } else {
              console.log('⚠️ Email service not configured - skipping donation thank you email');
            }
          } catch (userLookupErr) {
            console.error('❌ Error looking up user for donation thank you email:', userLookupErr);
          }
        } else {
          console.error('❌ No database pool available for donation email user lookup');
        }
      } else {
        console.log('⚠️ Missing customer email or userId for donation email');
      }
    }
  } catch (donationErr) {
    console.error('❌ Error processing donation completion:', donationErr);
  }
  break;
```

**Key Details:**
- **Webhook Event:** `checkout.session.completed`
- **Metadata Check:** `sessionCompleted.metadata?.donationType === 'direct_donation'`
- **Email Source:** `sessionCompleted.customer_details?.email` (from Stripe checkout form)
- **Amount Source:** `sessionCompleted.amount_total` (from Stripe session, in cents)
- **User Lookup:** Queries database for username using `userId` from metadata
- **Fallback Username:** `'Charity Stream Supporter'` if user not found

---

## **3. EMAIL SERVICE - Donation Thank You Email Function**

**File:** `backend/services/emailService.js`  
**Lines:** 306-407

```javascript
// Send donation thank you email
async sendDonationThankYouEmail(customerEmail, username, donationAmount, stripeCustomerId = null) {
  try {
    console.log('📧 ===== SENDING DONATION THANK YOU EMAIL =====');
    console.log('📧 To (Stripe customer email):', customerEmail);
    console.log('📧 Username:', username);
    console.log('📧 Donation Amount (cents):', donationAmount);
    
    if (!this.isEmailConfigured()) {
      console.error('❌ Email service not configured');
      return { success: false, error: 'Email service not configured' };
    }
    
    const formattedAmount = (Number(donationAmount || 0) / 100).toFixed(2);
    const subject = `Thank You for Your Donation!`;
    
    const htmlContent = this.getDonationThankYouEmailTemplate(username, formattedAmount);
    const textContent = this.getDonationThankYouTextTemplate(username, formattedAmount);
    
    const mailOptions = {
      from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: subject,
      text: textContent,
      html: htmlContent
    };
    
    console.log('📧 Sending donation thank you email');
    const result = await this.transporter.sendMail(mailOptions);
    console.log('✅ Donation thank you email sent successfully');
    console.log('📧 Message ID:', result.messageId);
    
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('❌ ===== DONATION THANK YOU EMAIL FAILED =====');
    console.error('❌ Error details:', error.message);
    return { success: false, error: error.message };
  }
}

// Get donation thank you email template (HTML)
getDonationThankYouEmailTemplate(username, donationAmount) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
        <h1>💝 Thank You for Your Donation!</h1>
      </div>
      <div style="padding: 20px; background-color: #f9fafb;">
        <h2>Hi ${username},</h2>
        <p>Thank you so much for your generous donation of <strong>$${donationAmount}</strong> to Charity Stream!</p>
        
        <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center;">
          <h3 style="color: #2F7D31; margin: 0;">Your donation of $${donationAmount} will make a real difference!</h3>
        </div>
        
        <p>Your contribution helps us continue our mission of supporting charitable causes through advertising revenue. Every dollar goes directly to making a positive impact.</p>
        
        <div style="background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3>📊 Your Impact</h3>
          <p><strong>Charity Stream Username:</strong> ${username}</p>
          <p><strong>Donation Amount:</strong> $${donationAmount}</p>
          <p><strong>Thank you for being part of our community!</strong></p>
        </div>
        
        <p>If you have any questions about your donation, please reply to this email.</p>
        
        <p>With gratitude,<br>The Charity Stream Team</p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="color: #666; font-size: 14px;">
          Charity Stream - Making Every View Count for Charity
        </p>
      </div>
    </div>
  `;
}

// Get donation thank you email template (Text)
getDonationThankYouTextTemplate(username, donationAmount) {
  return `Thank You for Your Donation!

Hi ${username},

Thank you so much for your generous donation of $${donationAmount} to Charity Stream!

Your donation of $${donationAmount} will make a real difference!

Your contribution helps us continue our mission of supporting charitable causes through advertising revenue. Every dollar goes directly to making a positive impact.

YOUR IMPACT:
- Charity Stream Username: ${username}
- Donation Amount: $${donationAmount}
- Thank you for being part of our community!

If you have any questions about your donation, please reply to this email.

With gratitude,
The Charity Stream Team

Charity Stream - Making Every View Count for Charity`;
}
```

**Key Details:**
- **Function:** `sendDonationThankYouEmail(customerEmail, username, donationAmount, stripeCustomerId = null)`
- **Parameters:**
  - `customerEmail` - Email address from Stripe checkout form
  - `username` - User's Charity Stream username (from database lookup)
  - `donationAmount` - Amount in cents (converted to dollars for display)
  - `stripeCustomerId` - Optional Stripe customer ID
- **Amount Conversion:** `(Number(donationAmount || 0) / 100).toFixed(2)` - Converts cents to dollars
- **Email Templates:** Both HTML and plain text versions included

---

## **4. FRONTEND - Donate Button Handler**

**File:** `public/index.html`  
**Lines:** 3119-3145

```javascript
// Donate button handler
document.getElementById('donateButton')?.addEventListener('click', async function() {
  try {
    console.log('🎯 Donate button clicked');
    const token = (typeof authToken !== 'undefined' && authToken) ? authToken : getAuthToken();
    const response = await fetch('/api/donate/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ amount: 300 }) // $3.00 default
    });
    if (!response.ok) {
      console.error('❌ Donation create session failed:', response.status, response.statusText);
      const errText = await response.text();
      console.error('❌ Error body:', errText);
      throw new Error('Failed to create donation session');
    }
    const { url } = await response.json();
    console.log('✅ Donation session created, redirecting to:', url);
    window.location.href = url;
  } catch (error) {
    console.error('❌ Donation error:', error);
    alert('Failed to process donation. Please try again.');
  }
});
```

**Key Details:**
- **Button ID:** `donateButton`
- **Default Amount:** 300 cents ($3.00)
- **Authentication:** Uses `getAuthToken()` helper function to get auth token
- **Redirect:** Redirects to Stripe Checkout URL on success

---

## **5. FRONTEND - Donate Button HTML/CSS**

**File:** `public/index.html`  
**Lines:** 1611 (HTML), 17-28 (CSS)

**HTML:**
```html
<button id="donateButton" class="action-button donate-btn">💝 Donate to Charity</button>
```

**CSS:**
```css
.donate-btn {
  background: linear-gradient(135deg, #ff6b6b, #ee5a24);
  color: white;
  border: none;
  padding: 12px 20px;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  margin-right: 10px;
}
.donate-btn:hover {
  background: linear-gradient(135deg, #ff5252, #e84118);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(255, 107, 107, 0.4);
}
```

---

## **COMPLETE FLOW DIAGRAM**

```
1. User clicks "💝 Donate to Charity" button
   ↓
2. Frontend: POST /api/donate/create-checkout-session
   - Sends: { amount: 300 } (default $3.00)
   - Includes: Authorization Bearer token
   ↓
3. Backend creates Stripe Checkout Session:
   - Price ID: price_1SNmrt0CutcpJ738Sh6lSLeZ (custom amount)
   - Mode: 'payment' (one-time payment)
   - Metadata: { donationType: 'direct_donation', amount: '300', userId: '67' }
   - Returns: { url: 'https://checkout.stripe.com/...' }
   ↓
4. Frontend redirects to Stripe Checkout URL
   ↓
5. User enters email and payment details in Stripe form
   ↓
6. User completes payment
   ↓
7. Stripe sends webhook: checkout.session.completed
   ↓
8. Backend webhook handler:
   - Checks metadata.donationType === 'direct_donation'
   - Extracts: customerEmail, donationAmount, userId
   - Looks up username from database using userId
   ↓
9. Email Service:
   - Calls sendDonationThankYouEmail()
   - Formats amount: cents → dollars
   - Sends email to customerEmail with username and amount
   ↓
10. User receives thank you email
```

---

## **ENVIRONMENT VARIABLES REQUIRED**

- `STRIPE_SECRET_KEY` - Stripe secret key for API calls
- `STRIPE_WEBHOOK_SECRET` - Webhook signature verification secret
- `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS` - Email service configuration
- `FRONTEND_URL` - Frontend URL for success redirect
- `DATABASE_URL` - Database connection for user lookup

---

## **STRIPE CONFIGURATION**

- **Price ID:** `price_1SNmrt0CutcpJ738Sh6lSLeZ` (custom amount pricing)
- **Webhook Events Required:**
  - `checkout.session.completed` (for donation thank you emails)
  - `customer.subscription.created` (for advertiser subscriptions)
  - `invoice.payment_succeeded` (for subscription payments)

---

## **ERROR HANDLING**

- **Missing Email:** Falls back to username lookup error handling
- **Missing UserId:** Logs warning and skips email
- **Email Service Not Configured:** Logs warning and continues
- **Database Errors:** Logs error but doesn't crash webhook handler
- **Stripe Errors:** Returns 500 with error message

---

## **NOTES**

- Donations use **one-time payments** (`mode: 'payment'`) not subscriptions
- Email is sent to the address the user enters in **Stripe checkout form** (not their Charity Stream account email)
- Username is looked up from the database using the `userId` stored in checkout session metadata
- Amount is stored in cents but converted to dollars for email display
- Default donation amount is $3.00 but users can change it in Stripe Checkout (custom amount price)

