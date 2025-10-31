# Advertiser Sign-Up Flow and Email Code Summary

This document contains all code related to the advertiser sign-up flow, from form submission through Stripe payment and email notifications.

---

## **1. FRONTEND - Advertiser Form Submission**

**File:** `public/advertiser.html`  
**Lines:** 1552-1662

### **Main Checkout Function**

```javascript
function proceedToCheckout() {
  console.log('🚀 ===== PROCEEDING TO CHECKOUT =====');
  
  try {
    // Collect all form data
    const formData = collectFormData();
    console.log('📝 Form data collected:', formData);
    
    // Validate required fields
    if (!formData.email || !formData.companyName || !formData.firstName || !formData.lastName) {
      alert('Please fill in all required fields (Company Name, Email, First Name, Last Name)');
      return;
    }
    
    // Check if file is uploaded
    const fileInput = document.getElementById('fileUpload');
    if (!fileInput.files || fileInput.files.length === 0) {
      alert('Please upload your ad creative before proceeding to checkout');
      return;
    }
    
    // Show loading state
    const checkoutButton = document.querySelector('.modal-btn-primary');
    const originalText = checkoutButton.textContent;
    checkoutButton.textContent = 'Processing...';
    checkoutButton.disabled = true;
    
    // Create FormData for file upload
    const submitData = new FormData();
    
    // Add form fields
    Object.keys(formData).forEach(key => {
      submitData.append(key, formData[key]);
    });
    
    // Add file
    submitData.append('creative', fileInput.files[0]);
    
    console.log('📤 Submitting to checkout endpoint...');
    
    // Submit to backend
    fetch('/api/advertiser/create-checkout-session', {
      method: 'POST',
      body: submitData
    })
    .then(response => response.json())
    .then(data => {
      console.log('✅ Checkout session created:', data);
      
      if (data.checkoutUrl) {
        // Redirect to Stripe Checkout
        console.log('🛒 Redirecting to Stripe Checkout...');
        window.location.href = data.checkoutUrl;
      } else {
        throw new Error('No checkout URL received');
      }
    })
    .catch(error => {
      console.error('❌ Checkout error:', error);
      alert('Failed to create checkout session. Please try again.');
      
      // Restore button state
      checkoutButton.textContent = originalText;
      checkoutButton.disabled = false;
    });
    
  } catch (error) {
    console.error('❌ Error in proceedToCheckout:', error);
    alert('An error occurred. Please try again.');
  }
}
```

### **Form Data Collection Function**

```javascript
function collectFormData() {
  const form = document.getElementById('advertiserForm');
  const formData = new FormData(form);
  
  // Get basic form data
  const data = {
    companyName: document.getElementById('companyName').value,
    websiteUrl: document.getElementById('websiteUrl').value,
    firstName: document.getElementById('firstName').value,
    lastName: document.getElementById('lastName').value,
    email: document.getElementById('email').value,
    jobTitle: document.getElementById('jobTitle').value,
    adFormat: document.querySelector('input[name="adFormat"]:checked')?.value,
    weeklyBudget: document.getElementById('budget').value,
    cpmRate: document.querySelector('input[name="cpmRate"]:checked')?.value,
    isRecurring: document.getElementById('recurringSpend').checked
  };
  
  // Handle custom CPM rate
  if (data.cpmRate === 'custom') {
    const customSlider = document.getElementById('cpmSlider');
    if (customSlider) {
      data.cpmRate = customSlider.value;
    }
  }
  
  // Get enhancement selections
  data.expeditedApproval = document.getElementById('expeditedEnhancement').checked;
  data.clickTracking = document.getElementById('clickableLinkEnhancement').checked;
  
  // Get destination URL if clickable link is selected
  if (data.clickTracking) {
    data.destinationUrl = document.getElementById('destinationUrl').value;
  }
  
  console.log('📋 Collected form data:', data);
  return data;
}
```

**Key Details:**
- Collects all form fields including enhancements
- Validates required fields before submission
- Requires file upload before proceeding
- Creates FormData with multipart/form-data for file upload
- Redirects to Stripe Checkout URL on success

---

## **2. BACKEND - Advertiser Checkout Session Creation**

**File:** `backend/server.js`  
**Lines:** 3890-4152  
**Endpoint:** `POST /api/advertiser/create-checkout-session`

### **Complete Endpoint Code**

```javascript
// Create advertiser checkout session
app.post('/api/advertiser/create-checkout-session', upload.single('creative'), async (req, res) => {
  try {
    console.log('🚀 ===== ADVERTISER CHECKOUT SESSION CREATION STARTED =====');
    
    const {
      companyName,
      websiteUrl,
      firstName,
      lastName,
      email,
      jobTitle,
      adFormat,
      weeklyBudget,
      cpmRate,
      isRecurring,
      expeditedApproval,
      clickTracking,
      destinationUrl
    } = req.body;
    
    console.log('📝 Campaign data received:', {
      companyName,
      email,
      adFormat,
      weeklyBudget,
      cpmRate,
      expeditedApproval,
      clickTracking,
      destinationUrl
    });
    
    // Validate required fields
    if (!email || !companyName || !firstName || !lastName) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Company name, email, first name, and last name are required'
      });
    }
    
    // Check Stripe configuration
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ error: 'Stripe configuration missing' });
    }
    
    // Map frontend ad format to database format
    let databaseAdFormat;
    if (adFormat === 'static') {
      databaseAdFormat = 'static_image';
    } else if (adFormat === 'video') {
      databaseAdFormat = 'video';
    } else {
      databaseAdFormat = adFormat;
    }
    
    // Create payment_pending advertiser record in database
    console.log('💾 Creating payment_pending advertiser record...');
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Upload file to R2 immediately with final filename (no pending prefix)
    let mediaUrl = null;
    
    if (req.file) {
      console.log('📁 File received, uploading to R2 immediately:', req.file.originalname);
      console.log('📁 File size:', req.file.size, 'bytes');
      
      try {
        // Generate final filename (no pending prefix - file is uploaded directly)
        const timestamp = Date.now();
        const sanitizedFileName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const finalFileName = `${timestamp}-${sanitizedFileName}`;
        
        console.log(`📤 Uploading file to R2: ${finalFileName}`);
        
        // Upload to R2 immediately with final filename
        const uploadCommand = new PutObjectCommand({
          Bucket: 'advertiser-media',
          Key: finalFileName,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        });
        
        await r2Client.send(uploadCommand);
        
        // Generate public URL immediately
        mediaUrl = `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${finalFileName}`;
        
        console.log('✅ File uploaded to R2 successfully:', mediaUrl);
        console.log('💡 File is uploaded but payment_completed = false until payment succeeds');
        
      } catch (uploadError) {
        console.error('❌ Failed to upload file to R2:', uploadError);
        console.error('❌ Upload error details:', uploadError.message);
        return res.status(500).json({
          error: 'File upload failed',
          message: 'Failed to upload file to storage. Please try again.',
          details: uploadError.message
        });
      }
    }
    
    // Insert advertiser record with payment_completed = false
    const advertiserResult = await pool.query(
      `INSERT INTO advertisers (
        company_name, website_url, first_name, last_name, 
        email, title_role, ad_format, weekly_budget_cap, cpm_rate, 
        recurring_weekly, expedited, click_tracking, destination_url,
        media_r2_link, payment_completed, application_status, approved, completed, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false, 'payment_pending', false, false, CURRENT_TIMESTAMP)
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
        destinationUrl || null,
        mediaUrl // Store R2 URL immediately
      ]
    );
    
    const advertiser = advertiserResult.rows[0];
    console.log('✅ Payment pending advertiser created:', { 
      id: advertiser.id, 
      email: advertiser.email,
      media_r2_link: mediaUrl,
      payment_completed: false
    });
    
    // Calculate pricing and line items
    const lineItems = [];
    let totalAmount = 0;
    
    // ALL advertisers get CPM Impressions product (for usage-based billing)
    lineItems.push({
      price: 'price_1SLI8i0CutcpJ738GEgo3GtO' // CPM Impressions price ID (metered)
    });
    
    // Add Click Tracking if selected
    if (clickTracking === 'true' || clickTracking === true) {
      lineItems.push({
        price: 'price_1SLI9X0CutcpJ738vcuk6LPD' // Click Tracking price ID (metered, no quantity)
      });
    }
    
    // Add Expedited Approval if selected (this has upfront cost)
    if (expeditedApproval === 'true' || expeditedApproval === true) {
      lineItems.push({
        price: 'price_1SKv1E0CutcpJ738y51YDWa8', // Expedited Approval price ID
        quantity: 1
      });
      totalAmount += 500; // $5.00 in cents
    }
    
    console.log('💰 Pricing calculated:', {
      cpmImpressions: true, // Always included
      clickTracking: clickTracking === 'true' || clickTracking === true,
      expeditedApproval: expeditedApproval === 'true' || expeditedApproval === true,
      totalAmount: totalAmount,
      lineItems: lineItems.length
    });
    
    // Create Stripe customer for ALL advertisers
    console.log('👤 Creating Stripe customer for ALL advertisers...');
    const customerMetadata = {
      advertiserId: String(advertiser.id),
      companyName: companyName,
      campaignType: 'advertiser',
      hasFile: !!req.file ? 'true' : 'false'
    };
    
    // Add file metadata to customer (for reference)
    if (req.file) {
      customerMetadata.fileName = req.file.originalname;
      customerMetadata.fileMimeType = req.file.mimetype;
      customerMetadata.fileSize = String(req.file.size);
    }
    
    const customer = await stripe.customers.create({
      email: email,
      name: `${firstName} ${lastName}`,
      metadata: customerMetadata
    });
    
    console.log('✅ Stripe customer created:', customer.id);
    
    // Create Stripe Checkout Session
    console.log('🛒 Creating Stripe checkout session...');
    
    // Build subscription metadata (webhook will use advertiserId to update payment_completed)
    const subscriptionMetadata = {
      advertiserId: String(advertiser.id),
      campaignType: 'advertiser',
      companyName: companyName,
      hasFile: !!req.file ? 'true' : 'false'
    };
    
    console.log('📦 Subscription metadata prepared for webhook:', subscriptionMetadata);
    
    const sessionConfig = {
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription', // MUST be subscription for usage-based billing
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser.html`,
      metadata: {
        advertiserId: String(advertiser.id),
        companyName: companyName,
        campaignType: 'advertiser',
        hasFile: !!req.file ? 'true' : 'false',
        isRecurring: isRecurring === 'true' || isRecurring === true ? 'true' : 'false',
        weeklyBudget: weeklyBudget || '',
        cpmRate: cpmRate || ''
      },
      subscription_data: {
        metadata: subscriptionMetadata
      },
      line_items: lineItems
    };
    
    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    console.log('✅ Checkout session created:', session.id);
    console.log('🔗 Checkout URL:', session.url);
    
    // Update advertiser record with Stripe customer ID
    await pool.query(
      'UPDATE advertisers SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, advertiser.id]
    );
    
    console.log('🔍 ===== ADVERTISER CHECKOUT SESSION CREATION COMPLETED =====');
    
    res.json({
      sessionId: session.id,
      checkoutUrl: session.url,
      advertiserId: advertiser.id,
      totalAmount: totalAmount
    });
    
  } catch (error) {
    console.error('❌ ===== ADVERTISER CHECKOUT SESSION CREATION FAILED =====');
    console.error('❌ Error details:', error.message);
    res.status(500).json({ 
      error: 'Failed to create checkout session', 
      details: error.message 
    });
  }
});
```

**Key Details:**
- **File Upload:** Uploads file to R2 immediately with final filename (no pending prefix)
- **Database Record:** Creates advertiser record with `payment_completed = false` and `application_status = 'payment_pending'`
- **Stripe Customer:** Creates Stripe customer with advertiser email
- **Stripe Session:** Creates subscription checkout session (mode: 'subscription')
- **Metadata:** Stores `advertiserId` in both session metadata and subscription metadata
- **Line Items:** Includes CPM Impressions (always), Click Tracking (optional), Expedited Approval (optional)

---

## **3. BACKEND - Stripe Webhook Handler (Advertiser Subscription)**

**File:** `backend/server.js`  
**Lines:** 4794-4934  
**Event:** `customer.subscription.created`

```javascript
case 'customer.subscription.created':
  const subscription = event.data.object;
  console.log('✅ ===== SUBSCRIPTION CREATED =====');
  console.log('📋 Subscription ID:', subscription.id);
  console.log('👤 Customer ID:', subscription.customer);
  console.log('🏷️ Metadata:', subscription.metadata);
  
  // Handle advertiser subscription creation
  console.log('🔍 DEBUG: Checking if this is an advertiser subscription...');
  console.log('🔍 DEBUG: Full subscription object:', JSON.stringify(subscription, null, 2));
  console.log('🔍 DEBUG: Subscription metadata:', subscription.metadata);
  console.log('🔍 DEBUG: Has metadata property?', Object.prototype.hasOwnProperty.call(subscription, 'metadata'));
  console.log('🔍 DEBUG: Metadata keys:', Object.keys(subscription.metadata || {}));

  let campaignType = subscription.metadata?.campaignType;
  let advertiserId = subscription.metadata?.advertiserId;
  
  if (!campaignType) {
    console.log('⚠️ No campaignType in subscription.metadata, checking alternatives...');
    if (subscription.metadata && Object.keys(subscription.metadata).length === 0) {
      console.log('⚠️ Subscription metadata exists but is empty object');
    }
    if (!advertiserId) {
      console.log('🔍 Checking for advertiserId in description or other fields...');
    }
  }
  console.log('🔍 FINAL - campaignType:', campaignType, 'advertiserId:', advertiserId);
  
  if (campaignType === 'advertiser') {
    console.log('📝 Processing advertiser subscription creation...');
    
    try {
      console.log('📝 Advertiser ID:', advertiserId);
      
      // Get advertiser details from database
      const pool = getPool();
      if (!pool) {
        console.error('❌ Database pool not available in webhook');
        return;
      }
      
      const advertiserResult = await pool.query(
        'SELECT * FROM advertisers WHERE id = $1',
        [advertiserId]
      );
      
      if (advertiserResult.rows.length === 0) {
        console.error('❌ Advertiser not found:', advertiserId);
        return;
      }
      
      const advertiser = advertiserResult.rows[0];
      console.log('📝 Found advertiser:', { 
        id: advertiser.id, 
        email: advertiser.email,
        payment_completed: advertiser.payment_completed,
        media_r2_link: advertiser.media_r2_link
      });
      
      // Simple update: mark payment as completed and update status
      // File is already in R2 with final filename, no copying needed
      console.log('💳 Payment successful, updating payment_completed = true');
      
      const updateResult = await pool.query(
        `UPDATE advertisers 
         SET application_status = 'pending_approval',
             payment_completed = true,
             stripe_customer_id = $1,
             stripe_subscription_id = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING id, email, company_name, expedited, click_tracking, ad_format, cpm_rate, weekly_budget_cap, media_r2_link`,
        [subscription.customer, subscription.id, advertiserId]
      );
      
      if (updateResult.rows.length > 0) {
        const updatedAdvertiser = updateResult.rows[0];
        console.log('✅ Advertiser status updated:', {
          id: updatedAdvertiser.id,
          email: updatedAdvertiser.email,
          companyName: updatedAdvertiser.company_name,
          expedited: updatedAdvertiser.expedited,
          clickTracking: updatedAdvertiser.click_tracking,
          status: 'pending_approval',
          payment_completed: true,
          subscriptionId: subscription.id,
          media_r2_link: updatedAdvertiser.media_r2_link
        });
        
        // Send confirmation email with campaign summary
        console.log('🔍 DEBUG: About to check email service...');
        console.log('🔍 DEBUG: emailService exists:', !!emailService);
        console.log('🔍 DEBUG: emailService.isEmailConfigured:', emailService ? emailService.isEmailConfigured() : 'N/A');
        
        if (emailService && emailService.isEmailConfigured()) {
          console.log('🔍 DEBUG: Email service is configured, proceeding to send email');
          try {
            // Build campaign summary object
            const campaignSummary = {
              ad_format: updatedAdvertiser.ad_format,
              cpm_rate: updatedAdvertiser.cpm_rate,
              weekly_budget_cap: updatedAdvertiser.weekly_budget_cap,
              expedited: updatedAdvertiser.expedited,
              click_tracking: updatedAdvertiser.click_tracking
            };
            
            console.log('🔍 DEBUG: Reached email sending point in webhook');
            console.log('📧 Sending advertiser confirmation email to:', updatedAdvertiser.email);
            console.log('📧 Campaign summary data:', JSON.stringify(campaignSummary, null, 2));
            
            const emailResult = await emailService.sendAdvertiserConfirmationEmail(
              updatedAdvertiser.email,
              updatedAdvertiser.company_name,
              campaignSummary
            );
            
            if (emailResult.success) {
              console.log('✅ Advertiser confirmation email sent successfully');
              console.log('📧 Email message ID:', emailResult.messageId);
            } else {
              console.error('❌ Failed to send confirmation email:', emailResult);
            }
          } catch (emailError) {
            console.error('❌ Error sending confirmation email:', emailError);
            console.error('❌ Email error stack:', emailError.stack);
          }
        } else {
          console.warn('⚠️ Email service NOT configured - skipping email');
          console.warn('⚠️ Details:', {
            emailServiceExists: !!emailService,
            isConfigured: emailService ? emailService.isEmailConfigured() : false,
            hasTransporter: emailService ? !!emailService.transporter : false
          });
        }
      } else {
        console.error('❌ No advertiser found for update:', advertiserId);
      }
    } catch (advertiserError) {
      console.error('❌ Error processing advertiser subscription:', advertiserError);
    }
  } else {
    console.log('⚠️ Subscription metadata missing or not an advertiser campaign');
    console.log('⚠️ This is likely a test webhook without proper metadata');
  }
  break;
```

**Key Details:**
- **Event:** `customer.subscription.created` (fired when Stripe subscription is created after payment)
- **Metadata Check:** Looks for `subscription.metadata.campaignType === 'advertiser'`
- **Advertiser Lookup:** Uses `subscription.metadata.advertiserId` to find advertiser in database
- **Database Update:**
  - Sets `payment_completed = true`
  - Sets `application_status = 'pending_approval'`
  - Stores `stripe_customer_id` and `stripe_subscription_id`
- **Email Source:** Gets email from database record (`updatedAdvertiser.email`)
- **Email Trigger:** Calls `sendAdvertiserConfirmationEmail()` with campaign summary

---

## **4. EMAIL SERVICE - Advertiser Confirmation Email**

**File:** `backend/services/emailService.js`  
**Lines:** 520-707

### **Send Confirmation Email Function**

```javascript
// Send advertiser confirmation email with campaign summary
async sendAdvertiserConfirmationEmail(email, companyName, campaignSummary = {}) {
  try {
    console.log('📧 ===== SENDING ADVERTISER CONFIRMATION EMAIL =====');
    console.log('📧 To:', email);
    console.log('📧 Company:', companyName);
    console.log('📧 Campaign Summary:', campaignSummary);
    
    if (!this.isEmailConfigured()) {
      console.error('❌ Email service not configured');
      return { success: false, error: 'Email service not configured' };
    }
    
    const isExpedited = campaignSummary.expedited || false;
    const subject = `Thank You for Your Advertising Campaign Submission - ${companyName}`;
    
    const htmlContent = this.getAdvertiserConfirmationEmailTemplate(companyName, campaignSummary);
    const textContent = this.getAdvertiserConfirmationTextTemplate(companyName, campaignSummary);
    
    const mailOptions = {
      from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      text: textContent,
      html: htmlContent
    };
    
    console.log('📧 Sending email with options:', {
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject,
      hasHtml: !!mailOptions.html,
      hasText: !!mailOptions.text
    });
    
    const result = await this.transporter.sendMail(mailOptions);
    console.log('✅ Advertiser confirmation email sent successfully');
    console.log('📧 Message ID:', result.messageId);
    
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('❌ ===== ADVERTISER CONFIRMATION EMAIL FAILED =====');
    console.error('❌ Error details:', error.message);
    console.error('❌ Error code:', error.code);
    console.error('❌ Error response:', error.response);
    
    return { 
      success: false, 
      error: error.message,
      code: error.code,
      response: error.response
    };
  }
}
```

### **HTML Email Template**

```javascript
// Get advertiser confirmation email template with campaign summary
getAdvertiserConfirmationEmailTemplate(companyName, campaignSummary = {}) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
  const isExpedited = campaignSummary.expedited || false;
  
  // Format campaign details
  const adFormat = campaignSummary.ad_format === 'video' ? 'Video' : 'Static Image';
  const cpmRate = campaignSummary.cpm_rate ? `$${parseFloat(campaignSummary.cpm_rate).toFixed(2)}` : 'Not specified';
  const weeklyBudget = campaignSummary.weekly_budget_cap ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` : 'Not specified';
  const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
  const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
  
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
        <h1>🎉 Thank You for Your Advertising Campaign Submission!</h1>
      </div>
      <div style="padding: 20px; background-color: #f9fafb;">
        <h2>Hi ${companyName} team,</h2>
        <p>Thank you for choosing Charity Stream! Your advertising campaign has been successfully submitted and is now pending review.</p>
        
        <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
          <h3>📋 Campaign Summary</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Ad Format:</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${adFormat}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">CPM Rate:</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${cpmRate} per 1000 views</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Weekly Budget Cap:</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${weeklyBudget}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Expedited Approval:</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${expeditedApproval}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-weight: bold;">Click Tracking:</td>
              <td style="padding: 8px 0;">${clickTracking}</td>
            </tr>
          </table>
        </div>
        
        ${isExpedited ? `
        <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <strong>🚀 Expedited Processing:</strong> Your campaign will receive priority review and should be approved within 24-48 hours instead of the standard 3-5 business days.
        </div>
        ` : ''}
        
        <div style="background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3>💰 Important Payment Information</h3>
          <p><strong>You will NOT be charged until your campaign is approved.</strong></p>
          <p>Once approved, you'll only pay for actual views/clicks based on your CPM rate. This ensures you only pay for real engagement with your ads.</p>
        </div>
        
        <h3>📅 Approval Process</h3>
        <ul>
          <li><strong>Review Process:</strong> Our team will review your campaign and creative materials</li>
          <li><strong>Timeline:</strong> ${isExpedited ? '24-48 hours' : '3-5 business days'} for approval decision</li>
          <li><strong>Notification:</strong> You'll receive an email notification once approved</li>
          <li><strong>Campaign Launch:</strong> Your ads will start running and generating charitable impact</li>
          <li><strong>Performance Tracking:</strong> Monitor your campaign performance in real-time</li>
        </ul>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${frontendUrl}/advertiser.html" 
             style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
            View Campaign Status
          </a>
        </div>
        
        <p>Thank you for choosing Charity Stream to make your advertising dollars count twice!</p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="color: #666; font-size: 14px;">
          Questions? Reply to this email or visit our support center.
        </p>
      </div>
    </div>
  `;
}
```

### **Text Email Template**

```javascript
// Get advertiser confirmation text template with campaign summary
getAdvertiserConfirmationTextTemplate(companyName, campaignSummary = {}) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
  const isExpedited = campaignSummary.expedited || false;
  
  // Format campaign details
  const adFormat = campaignSummary.ad_format === 'video' ? 'Video' : 'Static Image';
  const cpmRate = campaignSummary.cpm_rate ? `$${parseFloat(campaignSummary.cpm_rate).toFixed(2)}` : 'Not specified';
  const weeklyBudget = campaignSummary.weekly_budget_cap ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` : 'Not specified';
  const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
  const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
  
  return `
Thank You for Your Advertising Campaign Submission - ${companyName}

Hi ${companyName} team,

Thank you for choosing Charity Stream! Your advertising campaign has been successfully submitted and is now pending review.

CAMPAIGN SUMMARY:
- Ad Format: ${adFormat}
- CPM Rate: ${cpmRate} per 1000 views
- Weekly Budget Cap: ${weeklyBudget}
- Expedited Approval: ${expeditedApproval}
- Click Tracking: ${clickTracking}

${isExpedited ? 'EXPEDITED PROCESSING: Your campaign will receive priority review and should be approved within 24-48 hours instead of the standard 3-5 business days.\n' : ''}

IMPORTANT PAYMENT INFORMATION:
You will NOT be charged until your campaign is approved. Once approved, you'll only pay for actual views/clicks based on your CPM rate. This ensures you only pay for real engagement with your ads.

APPROVAL PROCESS:
- Review Process: Our team will review your campaign and creative materials
- Timeline: ${isExpedited ? '24-48 hours' : '3-5 business days'} for approval decision
- Notification: You'll receive an email notification once approved
- Campaign Launch: Your ads will start running and generating charitable impact
- Performance Tracking: Monitor your campaign performance in real-time

View your campaign status: ${frontendUrl}/advertiser.html

Thank you for choosing Charity Stream to make your advertising dollars count twice!

Charity Stream - Making Every Dollar Count Twice
Questions? Reply to this email or visit our support center.
  `;
}
```

**Key Details:**
- **Function:** `sendAdvertiserConfirmationEmail(email, companyName, campaignSummary)`
- **Parameters:**
  - `email` - Advertiser's email from database
  - `companyName` - Company name from database
  - `campaignSummary` - Object with ad_format, cpm_rate, weekly_budget_cap, expedited, click_tracking
- **Templates:** Both HTML and plain text versions
- **Content:** Includes campaign summary, payment info, approval process, and timeline

---

## **5. EMAIL SERVICE - Advertiser Approval Email (After Approval)**

**File:** `backend/services/emailService.js`  
**Lines:** 709-799

```javascript
// New: Send advertiser approval email with distinct content
async sendAdvertiserApprovalEmail(email, companyName, campaignSummary = {}) {
  try {
    console.log('📧 ===== SENDING ADVERTISER APPROVAL EMAIL =====');
    console.log('📧 To:', email);
    console.log('📧 Company:', companyName);
    console.log('📧 Campaign Summary:', campaignSummary);
    
    if (!this.isEmailConfigured()) {
      console.error('❌ Email service not configured');
      return { success: false, error: 'Email service not configured' };
    }
    
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const subject = `Your Advertising Campaign Has Been Approved - ${companyName}`;
    
    // Format campaign details
    const adFormat = campaignSummary.ad_format === 'video' ? 'Video' : 'Static Image';
    const cpmRate = campaignSummary.cpm_rate ? `$${parseFloat(campaignSummary.cpm_rate).toFixed(2)}` : 'Not specified';
    const weeklyBudget = campaignSummary.weekly_budget_cap ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` : 'Not specified';
    const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
    const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
    
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>🎉 Your Campaign Has Been Approved!</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${companyName} team,</h2>
          <p>Your advertising campaign has been <strong>approved</strong> and is now playing on Charity Stream.</p>
          
          <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>📋 Campaign Summary</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Ad Format:</td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${adFormat}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">CPM Rate:</td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${cpmRate} per 1000 views</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Weekly Budget Cap:</td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${weeklyBudget}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Expedited Approval:</td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${expeditedApproval}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold;">Click Tracking:</td>
                <td style="padding: 8px 0;">${clickTracking}</td>
              </tr>
            </table>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${frontendUrl}/advertiser.html" 
               style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              View Campaign Status
            </a>
          </div>
          
          <p>If you have any questions, please contact us at <strong>charity.stream.support@gmail.com</strong>.</p>
        </div>
      </div>
    `;
    
    const textContent = `Your Advertising Campaign Has Been Approved - ${companyName}\n\nHi ${companyName} team,\n\nYour advertising campaign has been approved and is now playing on Charity Stream.\n\nCAMPAIGN SUMMARY:\n- Ad Format: ${adFormat}\n- CPM Rate: ${cpmRate} per 1000 views\n- Weekly Budget Cap: ${weeklyBudget}\n- Expedited Approval: ${expeditedApproval}\n- Click Tracking: ${clickTracking}\n\nView your campaign status: ${frontendUrl}/advertiser.html\n\nQuestions? Contact charity.stream.support@gmail.com`;
    
    const mailOptions = {
      from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      html: htmlContent,
      text: textContent
    };
    
    const result = await this.transporter.sendMail(mailOptions);
    console.log('✅ Advertiser approval email sent successfully');
    console.log('📧 Message ID:', result.messageId);
    
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('❌ ===== ADVERTISER APPROVAL EMAIL FAILED =====');
    console.error('❌ Error details:', error.message);
    return { success: false, error: error.message };
  }
}
```

**Key Details:**
- **Function:** `sendAdvertiserApprovalEmail(email, companyName, campaignSummary)`
- **When Sent:** After advertiser campaign is manually approved (via `process-approved-advertisers.js` script)
- **Difference:** Different subject and content from confirmation email
- **Purpose:** Notifies advertiser that their campaign is now live

---

## **COMPLETE FLOW DIAGRAM**

```
1. User fills advertiser form on advertiser.html
   ↓
2. User clicks "Proceed to Checkout" button
   ↓
3. Frontend: proceedToCheckout() function
   - Collects form data: companyName, email, firstName, lastName, adFormat, etc.
   - Validates required fields
   - Checks file upload exists
   - Creates FormData with form fields + file
   ↓
4. Frontend: POST /api/advertiser/create-checkout-session
   - Sends FormData (multipart/form-data) with file
   ↓
5. Backend: Checkout Session Creation
   - Receives form data and file
   - Uploads file to R2 immediately (final filename, no pending prefix)
   - Creates database record:
     * payment_completed = false
     * application_status = 'payment_pending'
     * media_r2_link = R2 URL
   - Creates Stripe customer with advertiser email
   - Creates Stripe checkout session:
     * mode: 'subscription'
     * customer: customer.id (links to Stripe customer)
     * metadata: { advertiserId, companyName, campaignType: 'advertiser' }
     * subscription_data.metadata: { advertiserId, campaignType: 'advertiser' }
   - Returns: { checkoutUrl, sessionId, advertiserId }
   ↓
6. Frontend redirects to Stripe Checkout URL
   ↓
7. User completes payment in Stripe
   ↓
8. Stripe creates subscription and fires webhook: customer.subscription.created
   ↓
9. Backend Webhook Handler:
   - Checks subscription.metadata.campaignType === 'advertiser'
   - Gets advertiserId from subscription.metadata.advertiserId
   - Looks up advertiser from database
   - Updates database:
     * payment_completed = true
     * application_status = 'pending_approval'
     * stripe_customer_id = subscription.customer
     * stripe_subscription_id = subscription.id
   - Gets email from database record: updatedAdvertiser.email
   - Builds campaign summary from database
   - Calls sendAdvertiserConfirmationEmail()
   ↓
10. Email Service:
    - Sends confirmation email to advertiser.email (from database)
    - Includes campaign summary (ad_format, cpm_rate, weekly_budget_cap, expedited, click_tracking)
    - Subject: "Thank You for Your Advertising Campaign Submission - {CompanyName}"
   ↓
11. Advertiser receives confirmation email
   ↓
12. Later: Admin approves campaign (via process-approved-advertisers.js script)
   ↓
13. Approval script:
    - Finds approved advertisers
    - Copies video to charity-stream-videos bucket
    - Updates database: completed = true, application_status = 'approved'
    - Calls sendAdvertiserApprovalEmail()
   ↓
14. Approval Email Service:
    - Sends approval email to advertiser.email
    - Subject: "Your Advertising Campaign Has Been Approved - {CompanyName}"
    - Different content from confirmation email
```

---

## **KEY DIFFERENCES FROM DONATIONS**

| Aspect | Advertiser Flow | Donation Flow |
|--------|----------------|---------------|
| **Stripe Event** | `customer.subscription.created` | `checkout.session.completed` |
| **Stripe Mode** | `subscription` (recurring) | `payment` (one-time) |
| **Stripe Customer** | Created before checkout | Not created (null) |
| **Email Source** | Database record (`advertiser.email`) | Stripe checkout (`customer_details.email`) |
| **File Handling** | Uploaded immediately to R2 | No file upload |
| **Database Record** | Created before payment | No database record |
| **Metadata Location** | `subscription.metadata` | `session.metadata` |

---

## **EMAIL TEMPLATES SUMMARY**

### **Confirmation Email** (Sent After Payment)
- **Subject:** "Thank You for Your Advertising Campaign Submission - {CompanyName}"
- **Content:** Campaign summary, payment info, approval process timeline
- **Trigger:** Webhook `customer.subscription.created`
- **Recipient:** Email from database record

### **Approval Email** (Sent After Manual Approval)
- **Subject:** "Your Advertising Campaign Has Been Approved - {CompanyName}"
- **Content:** Campaign approved, now live, campaign summary
- **Trigger:** Manual approval script (`process-approved-advertisers.js`)
- **Recipient:** Email from database record

---

## **DATABASE FIELDS UPDATED**

### **During Checkout Session Creation:**
- `payment_completed`: `false`
- `application_status`: `'payment_pending'`
- `media_r2_link`: R2 URL (if file uploaded)
- `stripe_customer_id`: Set after customer creation

### **During Webhook (After Payment):**
- `payment_completed`: `true`
- `application_status`: `'pending_approval'`
- `stripe_customer_id`: Subscription customer ID
- `stripe_subscription_id`: Subscription ID
- `updated_at`: Current timestamp

### **During Approval (Manual Script):**
- `completed`: `true`
- `application_status`: `'approved'`
- `current_week_start`: `NOW()` (if null)
- `campaign_start_date`: `NOW()` (if null)
- `approved_at`: `NOW()` (if null)
- `updated_at`: `NOW()`

---

## **STRIPE CONFIGURATION**

- **Mode:** `subscription` (required for usage-based billing)
- **Customer:** Created before checkout session
- **Line Items:**
  - `price_1SLI8i0CutcpJ738GEgo3GtO` - CPM Impressions (always included, metered)
  - `price_1SLI9X0CutcpJ738vcuk6LPD` - Click Tracking (optional, metered)
  - `price_1SKv1E0CutcpJ738y51YDWa8` - Expedited Approval (optional, $5.00 upfront)
- **Webhook Events Required:**
  - `customer.subscription.created` (triggers confirmation email)

---

## **ERROR HANDLING**

- **Missing Required Fields:** Returns 400 error before processing
- **File Upload Failure:** Returns 500 error, prevents checkout session creation
- **Database Errors:** Logs error, returns 500 response
- **Stripe Errors:** Catches and logs, returns 500 with error message
- **Email Failures:** Logs error but doesn't fail webhook (graceful degradation)

---

## **TESTING CHECKLIST**

1. ✅ Form submission with all fields
2. ✅ File upload validation
3. ✅ R2 file upload success
4. ✅ Database record creation with `payment_completed = false`
5. ✅ Stripe customer creation
6. ✅ Stripe checkout session creation
7. ✅ Redirect to Stripe Checkout URL
8. ✅ Payment completion triggers webhook
9. ✅ Webhook updates `payment_completed = true`
10. ✅ Webhook sends confirmation email
11. ✅ Email contains correct campaign summary
12. ✅ Email sent to correct email address (from database)

---

This complete flow ensures advertisers receive proper confirmation emails after successful payment, with all campaign details included.

