// Force IPv4 DNS resolution for Node 24 + Neon compatibility
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

// guh
// ADD global unhandled rejection handler (AT THE VERY TOP)
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Promise Rejection:', reason);
  // Don't exit the process, just log the error
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  // Don't exit the process for database errors
  if (error.message.includes('Connection terminated') || 
      error.message.includes('database') || 
      error.message.includes('pool')) {
    console.log('🔌 Database-related error caught, continuing server operation');
  } else {
    // Only exit for critical errors
    process.exit(1);
  }
});

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const multer = require('multer');
const { S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { exec } = require('child_process');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Pool } = require('pg');

// Load environment variables from parent directory
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const R2_VIDEOS_URL = process.env.R2_VIDEOS_URL || 'https://videos.stream.charity';
const R2_ADVERTISER_MEDIA_URL = process.env.R2_ADVERTISER_MEDIA_URL || 'https://uploads.stream.charity';
const R2_SPONSOR_GENERATED_URL = process.env.R2_SPONSOR_GENERATED_URL || 'https://sponsor-generated.stream.charity';
const R2_PUBLIC_ASSETS_URL = process.env.R2_PUBLIC_ASSETS_URL || 'https://public.stream.charity';

const { initializeDatabase, dbHelpers, getPool: getPoolFromDb } = require('./database-postgres');
const { normalizeBareMediaR2Link } = require('./lib/normalizeBareMediaR2Link');
// Google OAuth - Enabled for production
const passportConfig = require('./config/google-oauth');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
try {
  const stripePkg = require('stripe/package.json');
  console.log('[STRIPE API VERSION] stripe-node', stripePkg.version);
} catch (_) {
  console.log('[STRIPE API VERSION] unknown');
}

// Use the single pool from database-postgres.js
function getPool() {
  return getPoolFromDb();
}

// Email service - handle missing config gracefully
let emailService = null;
let tokenService = null;

try {
  // Clear cache to ensure fresh module load
  delete require.cache[require.resolve('./services/emailService')];
  emailService = require('./services/emailService');
  console.log('✅ Email service loaded (cache cleared)');
  
  // Test email service on startup
  console.log('🚀 Initializing email service...');
  if (emailService.isEmailConfigured()) {
    console.log('✅ Email service is properly configured and ready');
    console.log('🔍 DEBUG: emailService available:', !!emailService);
    console.log('🔍 DEBUG: emailService.isEmailConfigured:', emailService.isEmailConfigured());
    console.log('🔍 DEBUG: emailService.transporter:', !!emailService.transporter);
  } else {
    console.error('❌ Email service failed to initialize - check your .env configuration');
    console.error('🔍 DEBUG: emailService available:', !!emailService);
    console.error('🔍 DEBUG: emailService.isConfigured:', emailService.isConfigured);
    console.error('🔍 DEBUG: Missing env vars:', {
      EMAIL_HOST: !!process.env.EMAIL_HOST,
      EMAIL_PORT: !!process.env.EMAIL_PORT,
      EMAIL_USER: !!process.env.EMAIL_USER,
      EMAIL_PASS: !!process.env.EMAIL_PASS
    });
  }
} catch (error) {
  console.log('⚠️ Email service not available:', error.message);
  console.error('🔍 DEBUG: emailService import error:', error);
}

try {
  tokenService = require('./services/tokenService');
  console.log('✅ Token service loaded');
} catch (error) {
  console.log('❌ Token service failed to load:', error.message);
  console.log('❌ This will cause registration to fail!');
}

// Fallback token generation if tokenService fails to load
const crypto = require('crypto');
const generateFallbackToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const getTokenExpiry = () => {
  const now = new Date();
  return new Date(now.getTime() + (30 * 60 * 1000)); // 30 minutes
};

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// 🚨 CRITICAL: Robust JWT token generation function
// ===== TOKEN GENERATION UTILITY FOR ADVERTISER PORTAL =====
// Generate secure random token (32-48 bytes) and return raw token for email links
// Tokens will be hashed before storing in database
function generateSecureToken() {
  // Generate 32-byte (256-bit) random token
  return crypto.randomBytes(32).toString('hex');
}

// Hash a token for database storage (one-way hash using bcrypt)
async function hashToken(token) {
  const saltRounds = 10;
  return await bcrypt.hash(token, saltRounds);
}

// Compare a raw token (from URL) with a hashed token from database
async function compareToken(rawToken, hashedToken) {
  if (!rawToken || !hashedToken) return false;
  return await bcrypt.compare(rawToken, hashedToken);
}

// ===== UNIFIED TOKEN CREATION FOR PASSWORD SETUP/RESET =====
// Creates a token in advertiser_account_tokens table
// purpose: 'password_setup' or 'password_reset'
// Returns the raw token (to be sent in email) and the token record
async function createPasswordToken(advertiserAccountId, purpose, pool) {
  if (!advertiserAccountId || !purpose || !pool) {
    throw new Error('advertiserAccountId, purpose, and pool are required');
  }
  
  if (purpose !== 'password_setup' && purpose !== 'password_reset') {
    throw new Error('purpose must be "password_setup" or "password_reset"');
  }
  
  // Generate raw token
  const rawToken = generateSecureToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours from now
  
  // Insert into advertiser_account_tokens table
  const result = await pool.query(`
    INSERT INTO advertiser_account_tokens (
      advertiser_account_id,
      purpose,
      token_hash,
      expires_at
    ) VALUES ($1, $2, $3, $4)
    RETURNING id, created_at
  `, [advertiserAccountId, purpose, tokenHash, expiresAt]);
  
  console.log(`✅ [TOKEN] Created ${purpose} token for account_id: ${advertiserAccountId}, token_id: ${result.rows[0].id}`);
  
  return {
    rawToken,
    tokenRecord: result.rows[0]
  };
}

// ===== SPONSOR TOKEN CREATION FOR PASSWORD SETUP/RESET =====
// Creates a token in sponsor_account_tokens table
// purpose: 'password_setup' or 'password_reset'
// Returns the raw token (to be sent in email) and the token record
async function createSponsorPasswordToken(sponsorAccountId, purpose, pool) {
  if (!sponsorAccountId || !purpose || !pool) {
    throw new Error('sponsorAccountId, purpose, and pool are required');
  }
  
  if (purpose !== 'password_setup' && purpose !== 'password_reset') {
    throw new Error('purpose must be "password_setup" or "password_reset"');
  }
  
  // Generate raw token
  const rawToken = generateSecureToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours from now
  
  // Insert into sponsor_account_tokens table
  const result = await pool.query(`
    INSERT INTO sponsor_account_tokens (
      sponsor_account_id,
      purpose,
      token_hash,
      expires_at
    ) VALUES ($1, $2, $3, $4)
    RETURNING id, created_at
  `, [sponsorAccountId, purpose, tokenHash, expiresAt]);
  
  console.log(`✅ [SPONSOR-TOKEN] Created ${purpose} token for sponsor_account_id: ${sponsorAccountId}, token_id: ${result.rows[0].id}`);
  
  return {
    rawToken,
    tokenRecord: result.rows[0]
  };
}

const generateJWTToken = (payload, expiresIn = '7d') => {
  const now = new Date();
  const systemTime = now.toISOString();
  
  console.log(`🔑 GENERATING JWT TOKEN:`, {
    payload: { userId: payload.userId, username: payload.username, email: payload.email },
    expiresIn: expiresIn,
    currentTime: systemTime,
    currentTimestamp: now.getTime()
  });
  
  // Calculate expiration time manually to ensure it's in the future
  let expirationMs;
  if (expiresIn === '7d') {
    expirationMs = now.getTime() + (7 * 24 * 60 * 60 * 1000);
  } else if (expiresIn === '30d') {
    expirationMs = now.getTime() + (30 * 24 * 60 * 60 * 1000);
  } else {
    // Default to 7 days
    expirationMs = now.getTime() + (7 * 24 * 60 * 60 * 1000);
  }
  
  const expirationDate = new Date(expirationMs);
  
  console.log(`🕐 CALCULATED EXPIRATION:`, {
    expirationMs: expirationMs,
    expirationDate: expirationDate.toISOString(),
    timeDifference: expirationMs - now.getTime(),
    isValidExpiration: expirationMs > now.getTime()
  });
  
  // Generate token with explicit expiration
  // Note: exp should NOT be in options - only expiresIn is allowed
  const token = jwt.sign(
    payload,
    JWT_SECRET,
    { 
      expiresIn: expiresIn
    }
  );
  
  // Verify the generated token
  try {
    const decoded = jwt.decode(token);
    console.log(`🔍 TOKEN VERIFICATION:`, {
      generatedExpiry: decoded.exp,
      generatedExpiryDate: new Date(decoded.exp * 1000).toISOString(),
      currentTime: systemTime,
      timeDifference: (decoded.exp * 1000) - now.getTime(),
      isValidExpiration: (decoded.exp * 1000) > now.getTime(),
      tokenLength: token.length
    });
    
    // Check if token is valid
    if ((decoded.exp * 1000) <= now.getTime()) {
      console.error(`❌ CRITICAL ERROR: Generated token is already expired!`);
      console.error(`❌ Token expires at: ${new Date(decoded.exp * 1000).toISOString()}`);
      console.error(`❌ Current time: ${systemTime}`);
      throw new Error('Generated JWT token is already expired');
    }
    
  } catch (verifyErr) {
    console.error(`❌ Token verification failed:`, verifyErr);
    throw verifyErr;
  }
  
  return token;
};

// 🚨 CRITICAL: Webhook diagnostics endpoints MUST be registered before other middleware
app.get('/api/webhook/test', (req, res) => {
  console.log('✅ WEBHOOK TEST ENDPOINT HIT VIA GET');
  res.json({
    status: 'webhook_endpoint_accessible',
    timestamp: new Date().toISOString(),
    message: 'Webhook endpoint is reachable via GET'
  });
});

app.post('/api/webhook/test', express.raw({ type: 'application/json' }), (req, res) => {
  console.log('✅ WEBHOOK TEST ENDPOINT HIT VIA POST');
  const bodyLength = Buffer.isBuffer(req.body) ? req.body.length : (req.body ? req.body.length || 'unknown' : 'no body');
  console.log('📦 Request summary:', {
    method: req.method,
    url: req.originalUrl,
    contentType: req.headers['content-type'],
    bodyLength,
    bodyType: Buffer.isBuffer(req.body) ? 'Buffer' : typeof req.body,
    hasStripeSignature: !!req.headers['stripe-signature'],
  });

  res.json({
    received: true,
    bodyLength: Buffer.isBuffer(req.body) ? req.body.length : 0,
    timestamp: new Date().toISOString(),
    message: 'Webhook endpoint is reachable via POST'
  });
});

// 🔍 Global request logger for debugging routing issues
app.use('*', (req, res, next) => {
  console.log('🌐 Incoming request:', {
    method: req.method,
    url: req.originalUrl,
    path: req.path,
    contentType: req.headers['content-type'],
    bodyPresent: !!req.body,
    bodyType: req.body ? (req.body.constructor ? req.body.constructor.name : typeof req.body) : typeof req.body
  });
  next();
});

// Stripe webhook route - express.raw is required here for signature verification

class WebhookProcessingError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Check if a payment method is a duplicate (same card fingerprint already on customer).
 * If duplicate: detach the new PM and return true. Otherwise return false.
 * Only dedupes within the same customer.
 */
async function dedupePaymentMethodByFingerprint(customerId, newPaymentMethodId) {
  if (!customerId || !newPaymentMethodId) return false;
  const newPm = await stripe.paymentMethods.retrieve(newPaymentMethodId);
  const newFingerprint = newPm?.card?.fingerprint;
  if (!newFingerprint) return false;

  const existingList = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card'
  });

  for (const existing of existingList.data) {
    if (existing.id === newPaymentMethodId) continue;
    if (existing.card?.fingerprint === newFingerprint) {
      try {
        await stripe.paymentMethods.detach(newPaymentMethodId);
        console.log('[DUPLICATE CARD] Prevented duplicate card attach', {
          customerId,
          existingPaymentMethodId: existing.id,
          newPaymentMethodId
        });
        return true;
      } catch (detachErr) {
        if (detachErr.code === 'resource_missing' || /not attached|already detached/i.test(detachErr.message || '')) {
          console.log('[DUPLICATE CARD] Duplicate already detached (no-op):', newPaymentMethodId);
        } else {
          console.error('[DUPLICATE CARD] Failed to detach duplicate:', detachErr.message);
        }
        return true;
      }
    }
  }
  return false;
}

const processStripeEvent = async (event) => {
  console.log('ðŸ”” ===== STRIPE WEBHOOK PROCESSING =====');
  console.log('ðŸŒ Event type:', event.type);
  console.log('ðŸ”” Event ID:', event.id);
  
  // ===== COMPACT EVENT LOGGING (BEFORE ANY PROCESSING) =====
  console.log('📅 Event created:', event.created);
  console.log('🌐 Event livemode:', event.livemode);
  console.log('📦 Object type:', event.data?.object?.object);
  console.log('🆔 Object ID:', event.data?.object?.id);
  if (event.data?.object?.subscription) {
    console.log('📋 Subscription ID:', event.data.object.subscription);
  }
  if (event.data?.object?.mode) {
    console.log('🎯 Mode:', event.data.object.mode);
  }
  if (event.data?.object?.payment_status) {
    console.log('💳 Payment status:', event.data.object.payment_status);
  }
  if (event.data?.object?.customer) {
    console.log('👤 Customer ID:', event.data.object.customer);
  }
  if (event.data?.object?.metadata) {
    console.log('📝 Metadata keys:', Object.keys(event.data.object.metadata || {}));
  }
  if (event.data?.object?.subscription_data) {
    console.log('📋 Has subscription_data:', !!event.data.object.subscription_data);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('ðŸŽ¯ CHECKOUT.SESSION.COMPLETED DETECTED');
    console.log('ðŸŽ¯ Is donation?', session.metadata?.donationType === 'direct_donation');
    console.log('ðŸŽ¯ Session mode:', session.mode);
    console.log('ðŸŽ¯ Has donation metadata?', !!session.metadata?.donationType);
    console.log('🎉 Has advertiser metadata?', !!session.metadata?.advertiserId);
    console.log('🎉 Subscription ID (if created):', session.subscription);
  }

  switch (event.type) {
    case 'customer.subscription.created': {
      const subscription = event.data.object;
      console.log('âœ… ===== SUBSCRIPTION CREATED =====');
      console.log('ðŸ“‹ Subscription ID:', subscription.id);
      console.log('ðŸ‘¤ Customer ID:', subscription.customer);
      console.log('ðŸ·ï¸ Metadata keys:', Object.keys(subscription.metadata || {}));

      const campaignType = subscription.metadata?.campaignType;
      const advertiserId = subscription.metadata?.advertiserId;

      console.log('ðŸ” FINAL - campaignType:', campaignType, 'advertiserId:', advertiserId);

      if (campaignType === 'advertiser') {
        console.log('ðŸ“ Processing advertiser subscription creation...');

        try {
          console.log('ðŸ“ Advertiser ID:', advertiserId);

          const pool = getPool();
          if (!pool) {
            throw new WebhookProcessingError('Database connection not available', 500);
          }

          const advertiserResult = await pool.query(
            'SELECT id, email, company_name, payment_completed, status FROM advertisers WHERE id = $1',
            [advertiserId]
          );

          if (advertiserResult.rows.length === 0) {
            throw new WebhookProcessingError('Advertiser not found', 404);
          }

          const advertiser = advertiserResult.rows[0];

          // Extract campaign_name from metadata if present
          const campaignName = subscription.metadata?.campaignName || null;

          // Extract subscription item ID (for usage-based billing)
          // The subscription item ID is needed for creating usage records
          let subscriptionItemId = null;
          if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
            // Get the first subscription item (CPM Impressions product)
            subscriptionItemId = subscription.items.data[0].id;
            console.log('📦 [WEBHOOK] Extracted subscription item ID:', subscriptionItemId);
          } else {
            console.warn('⚠️ [WEBHOOK] No subscription items found in subscription:', subscription.id);
          }

          await pool.query(
            `UPDATE advertisers
             SET payment_completed = TRUE,
                 status = 'pending_review',
                 stripe_subscription_id = $1,
                 stripe_price_id = $4,
                 campaign_name = COALESCE($3, campaign_name),
                 updated_at = NOW()
             WHERE id = $2`,
            [subscription.id, advertiserId, campaignName, subscriptionItemId]
          );

          await pool.query(
            `UPDATE advertiser_accounts
             SET stripe_customer_id = $1
             WHERE advertiser_id = $2`,
            [subscription.customer, advertiserId]
          );
          
          console.log('✅ [WEBHOOK] Updated advertiser with Stripe IDs:', {
            advertiserId,
            stripe_customer_id: subscription.customer,
            stripe_subscription_id: subscription.id,
            stripe_price_id: subscriptionItemId
          });

          console.log('✅ Advertiser payment marked as complete for advertiser ID:', advertiserId);

          if (emailService && emailService.isEmailConfigured()) {
            console.log('📧 ===== WEBHOOK: PREPARING TO SEND EMAIL =====');
            console.log('📧 [WEBHOOK] Advertiser email:', advertiser.email);
            console.log('📧 [WEBHOOK] Company name:', advertiser.company_name);
            console.log('📧 [WEBHOOK] Email service configured:', emailService.isEmailConfigured());

            // Generate password_setup token for Email #1 (campaign submission confirmation)
            // Only create if password doesn't exist
            const pool = getPool();
            let rawInitialSetupToken = null;
            if (pool) {
              try {
                // Find advertiser_accounts row
                const accountResult = await pool.query(`
                  SELECT id, password_hash
                  FROM advertiser_accounts
                  WHERE advertiser_id = $1
                `, [advertiserId]);
                
                if (accountResult.rows.length === 0) {
                  console.error('❌ [INITIAL SETUP] No advertiser_accounts row found for advertiser_id:', advertiserId);
                } else {
                  const account = accountResult.rows[0];
                  // Only create token if password doesn't exist (Email #1 flow)
                  if (!account.password_hash) {
                    const tokenResult = await createPasswordToken(account.id, 'password_setup', pool);
                    rawInitialSetupToken = tokenResult.rawToken;
                    console.log('✅ [INITIAL SETUP] Created password_setup token for advertiser:', advertiserId);
                  } else {
                    console.log('ℹ️ [INITIAL SETUP] Password already exists - skipping token creation');
                  }
                }
              } catch (tokenError) {
                console.error('❌ [INITIAL SETUP] Failed to create token:', tokenError.message);
                console.error('❌ [INITIAL SETUP] Error details:', tokenError);
              }
            }

            const campaignSummary = {
              campaign_type: subscription.metadata?.campaignType || 'advertiser',
              weekly_budget: subscription.metadata?.weeklyBudget,
              weekly_budget_cap: subscription.metadata?.weeklyBudget, // Template expects this field name
              cpm_rate: subscription.metadata?.cpmRate,
              click_tracking: subscription.metadata?.clickTracking === 'true',
              expedited: subscription.metadata?.expedited === 'true',
              ad_format: subscription.metadata?.adFormat || 'video'
            };
            
          console.log('📧 [WEBHOOK] Campaign summary prepared (compact):', {
            campaign_type: campaignSummary.campaign_type,
            weekly_budget: campaignSummary.weekly_budget,
            cpm_rate: campaignSummary.cpm_rate,
            click_tracking: campaignSummary.click_tracking,
            expedited: campaignSummary.expedited,
            ad_format: campaignSummary.ad_format
          });
            console.log('📧 [WEBHOOK] About to call sendAdvertiserConfirmationEmail...');

          const emailResult = await emailService.sendAdvertiserConfirmationEmail(
              advertiser.email,
              advertiser.company_name,
              campaignSummary,
              rawInitialSetupToken
            );
            
          console.log('📧 [WEBHOOK] Email send result:', {
            success: emailResult?.success,
            messageId: emailResult?.messageId,
            code: emailResult?.code
          });

            if (emailResult.success) {
              console.log('âœ… Advertiser confirmation email sent successfully');
            } else {
              console.error('âŒ Failed to send advertiser confirmation email:', emailResult.error);
            }
          } else {
            console.warn('âš ï¸ Email service not configured, skipping advertiser confirmation email');
          }
        } catch (subscriptionError) {
          console.error('âŒ Error processing advertiser subscription:', subscriptionError);
          console.error('âŒ Stack:', subscriptionError.stack);
          if (subscriptionError instanceof WebhookProcessingError) {
            throw subscriptionError;
          }
          throw new WebhookProcessingError('Failed to process advertiser subscription', 500, subscriptionError.message);
        }
      }
      break;
    }

    case 'checkout.session.completed': {
      const sessionCompleted = event.data.object;

      console.log('ðŸŽ¯ WEBHOOK RECEIVED: checkout.session.completed');
      console.log('ðŸŽ¯ Session ID:', sessionCompleted.id);
      console.log('ðŸŽ¯ Mode:', sessionCompleted.mode);
      console.log('ðŸŽ¯ Metadata:', sessionCompleted.metadata);
      console.log('ðŸŽ¯ Customer:', sessionCompleted.customer);

      console.log('[SPONSOR DONATION DEBUG] checkout.session.completed received');
      console.log('[SPONSOR DONATION DEBUG] mode:', sessionCompleted.mode);
      console.log('[SPONSOR DONATION DEBUG] metadata:', sessionCompleted.metadata);
      console.log('[SPONSOR DONATION DEBUG] payment_intent:', sessionCompleted.payment_intent);

      const isDonation = sessionCompleted.metadata?.donationType === 'direct_donation';
      const isAdvertiserSetup = sessionCompleted.mode === 'setup' && 
                                 sessionCompleted.metadata?.campaignType === 'advertiser' &&
                                 sessionCompleted.metadata?.advertiserId;
      const isSponsor = sessionCompleted.metadata?.campaignType === 'sponsor';
      console.log('[SPONSOR DONATION DEBUG] isSponsor:', isSponsor);

      if (isDonation && sessionCompleted.mode === 'payment') {
        console.log('ðŸ’° PROCESSING DONATION PAYMENT WEBHOOK');

        try {
          const donationId = sessionCompleted.metadata?.donationId;
          const userIdMeta = sessionCompleted.metadata?.userId;
          const donationAmount = sessionCompleted.metadata?.amount;

          console.log('ðŸ” Donation metadata extracted:', { donationId, userIdMeta, donationAmount });

          const pool = getPool();
          if (!pool) {
            throw new WebhookProcessingError('Database connection not available', 500);
          }

          if (donationId) {
            const donationResult = await pool.query(
              `SELECT d.*, u.username
               FROM donations d
               LEFT JOIN users u ON d.user_id = u.id
               WHERE d.id = $1`,
              [donationId]
            );

            if (donationResult.rows.length > 0) {
              const donation = donationResult.rows[0];
              const username = donation.username || 'Charity Stream Supporter';

              const customerEmail =
                donation.customer_email ||
                sessionCompleted.metadata?.userEmail ||
                sessionCompleted.customer_details?.email ||
                sessionCompleted.customer_email;

              console.log('ðŸ“§ Donation email resolution:', {
                fromDatabase: donation.customer_email,
                fromMetadata: sessionCompleted.metadata?.userEmail,
                fromCustomerDetails: sessionCompleted.customer_details?.email,
                fromCustomerEmail: sessionCompleted.customer_email,
                resolved: customerEmail
              });

              const amountCents = sessionCompleted.amount_total;
              const amountDollars = amountCents / 100;

              await pool.query(
                `UPDATE donations
                 SET status = 'completed',
                     stripe_payment_intent_id = $1,
                     amount = $2,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [
                  sessionCompleted.payment_intent || sessionCompleted.id,
                  Math.round(amountCents / 100),
                  donationId
                ]
              );

              const donationWeekStart = getBillingWeekStart(new Date());
              const weekStartStr = donationWeekStart.toISOString().slice(0, 10);

              const ledgerResult = await pool.query(
                `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
                 VALUES ('direct_donation', $1, $2, $3, $4::date)
                 ON CONFLICT (source_id, week_start) DO NOTHING
                 RETURNING id`,
                [String(donationId), sessionCompleted.id, amountDollars, weekStartStr]
              );

              if (ledgerResult.rows.length > 0) {
                await pool.query(
                  `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total, viewer_total)
                   VALUES ($1::date, 0, 0, $2)
                   ON CONFLICT (week_start) DO UPDATE
                   SET viewer_total = weekly_donation_pool.viewer_total + $2,
                       updated_at = NOW()`,
                  [weekStartStr, amountDollars]
                );
              }

              console.log('âœ… Donation status updated to completed for donation ID:', donationId);

              if (emailService && emailService.isEmailConfigured()) {
                if (!customerEmail) {
                  console.warn('âš ï¸ No customer email available for donation thank you email');
                } else {
                  console.log('ðŸ“§ Sending donation thank you email to:', customerEmail);

                  const emailResult = await emailService.sendDonationThankYouEmail(
                    customerEmail,
                    username,
                    amountCents,
                    sessionCompleted.customer || null
                  );

                  if (emailResult.success) {
                    console.log('âœ… Donation thank you email sent successfully');
                  } else {
                    console.error('âŒ Failed to send donation thank you email:', emailResult.error);
                  }
                }
              } else {
                console.warn('âš ï¸ Email service not configured, skipping donation thank you email');
              }
            } else {
              console.warn('âš ï¸ Donation record not found for donationId:', donationId);
            }
          } else {
            console.warn('âš ï¸ Donation webhook received without donationId in metadata');
          }
        } catch (donationError) {
          console.error('âŒ Error processing donation webhook:', donationError);
          console.error('âŒ Stack:', donationError.stack);
          if (donationError instanceof WebhookProcessingError) {
            throw donationError;
          }
          throw new WebhookProcessingError('Failed to process donation', 500, donationError.message);
        }
      } else if (isAdvertiserSetup) {
        // Handle advertiser setup-mode checkout completion
        console.log('📝 Processing advertiser setup completion');
        
        try {
          const advertiserId = parseInt(sessionCompleted.metadata.advertiserId);
          
          if (!advertiserId || isNaN(advertiserId)) {
            console.error('❌ Invalid advertiserId in session metadata:', sessionCompleted.metadata.advertiserId);
            throw new WebhookProcessingError('Invalid advertiserId', 400);
          }

          console.log('📝 Advertiser ID from session:', advertiserId);

          const pool = getPool();
          if (!pool) {
            throw new WebhookProcessingError('Database connection not available', 500);
          }

          // Query advertiser details needed for email, plus idempotency fields
          const advertiserResult = await pool.query(
            `SELECT id, email, company_name, payment_completed, status, 
                    ad_format, cpm_rate, weekly_budget_cap, expedited, click_tracking
             FROM advertisers 
             WHERE id = $1`,
            [advertiserId]
          );

          if (advertiserResult.rows.length === 0) {
            throw new WebhookProcessingError('Advertiser not found', 404);
          }

          const advertiser = advertiserResult.rows[0];

          // Idempotency guard: skip DB/PM updates if already processed (expedited fee still runs below)
          const setupAlreadyDone =
            advertiser.payment_completed === true || advertiser.status === 'pending_review';

          if (setupAlreadyDone) {
            console.log('⏭️ Skipping duplicate advertiser setup completion - already processed');
            console.log('⏭️ Current state:', {
              payment_completed: advertiser.payment_completed,
              status: advertiser.status
            });
          } else {
            // Update advertiser to mark setup complete (idempotent-safe: only updates if not already complete)
            const updateResult = await pool.query(
              `UPDATE advertisers
               SET payment_completed = TRUE,
                   status = 'pending_review',
                   updated_at = NOW()
               WHERE id = $1
                 AND (payment_completed = FALSE OR status != 'pending_review')
               RETURNING id`,
              [advertiserId]
            );

            if (updateResult.rows.length > 0 && sessionCompleted.customer) {
              await pool.query(
                `UPDATE advertiser_accounts
                 SET stripe_customer_id = COALESCE(stripe_customer_id, $1)
                 WHERE advertiser_id = $2`,
                [sessionCompleted.customer, advertiserId]
              );
            }

            if (updateResult.rows.length === 0) {
              console.log('⏭️ Skipping duplicate advertiser setup completion - state changed during processing');
            } else {
              console.log('✅ Advertiser setup marked as complete for advertiser ID:', advertiserId);

              // Do NOT auto-set default when user adds new card at Checkout.
              // Only set default if customer has NO default (first-time users).
              // Dedupe by fingerprint to prevent duplicate cards in Billing tab.
              try {
                if (!sessionCompleted.setup_intent) {
                  console.error('❌ [SETUP-COMPLETION] No setup_intent found in checkout session:', sessionCompleted.id);
                  throw new WebhookProcessingError('SetupIntent not found in checkout session', 400);
                }

                const setupIntent = await stripe.setupIntents.retrieve(sessionCompleted.setup_intent);
                if (!setupIntent.payment_method) {
                  console.error('❌ [SETUP-COMPLETION] SetupIntent has no payment method:', setupIntent.id);
                  throw new WebhookProcessingError('SetupIntent has no payment method', 400);
                }

                // Normalize IDs (retrieve may return string IDs or expanded objects)
                const customerId = typeof setupIntent.customer === 'string'
                  ? setupIntent.customer
                  : setupIntent.customer?.id;
                const paymentMethodId = typeof setupIntent.payment_method === 'string'
                  ? setupIntent.payment_method
                  : setupIntent.payment_method?.id;

                if (!customerId || !paymentMethodId) {
                  console.error('❌ [SETUP-COMPLETION] Could not resolve customer or payment_method id');
                  throw new WebhookProcessingError('Could not resolve customer or payment_method id', 400);
                }

                console.log('[DEDUP CHECK]', {
                  customerId,
                  paymentMethodId,
                  typeofCustomer: typeof setupIntent.customer,
                  typeofPaymentMethod: typeof setupIntent.payment_method
                });
                console.log('💳 [SETUP-COMPLETION] Card attached to customer:', customerId);

                // Fingerprint dedup: if same card already on customer, detach new PM and skip default
                const isDuplicate = await dedupePaymentMethodByFingerprint(customerId, paymentMethodId);
                if (isDuplicate) {
                  console.log('⏭️ [SETUP-COMPLETION] Duplicate card - skipped default payment method update');
                } else {
                  const customer = await stripe.customers.retrieve(customerId);
                  const currentDefault = customer.invoice_settings?.default_payment_method;

                  if (currentDefault) {
                    console.log(`⏭️ [SETUP-COMPLETION] Customer already has default, NOT changing to ${paymentMethodId}`);
                  } else {
                    await stripe.customers.update(customerId, {
                      invoice_settings: { default_payment_method: paymentMethodId }
                    });
                    console.log(`✅ [SETUP-COMPLETION] Set default payment method ${paymentMethodId} (customer had none)`);
                  }
                }
              } catch (paymentMethodError) {
                console.error('❌ [SETUP-COMPLETION] Error processing payment method:', paymentMethodError.message);
                if (paymentMethodError instanceof WebhookProcessingError) {
                  throw paymentMethodError;
                }
                throw new WebhookProcessingError(`Failed to process payment method: ${paymentMethodError.message}`, 500);
              }

              // Confirmation email + password_setup token are sent from setup_intent.succeeded (avoids race with checkout idempotency)
            }
          }

        } catch (setupError) {
          console.error('❌ Error processing advertiser setup completion:', setupError);
          console.error('❌ Stack:', setupError.stack);
          if (setupError instanceof WebhookProcessingError) {
            throw setupError;
          }
          throw new WebhookProcessingError('Failed to process advertiser setup completion', 500, setupError.message);
        }

        // Recurring expedited fee ($5): runs after setup path; idempotent; PI failure does not fail the webhook
        try {
          await processAdvertiserExpeditedFeeAfterCheckoutSession(sessionCompleted);
        } catch (expeditedOuterErr) {
          console.error('❌ [EXPEDITED] Unexpected error (non-fatal):', expeditedOuterErr.message);
        }
      } else if (isSponsor) {
        // Handle sponsor checkout completion (one-time payment or subscription)
        console.log('🎯 PROCESSING SPONSOR CHECKOUT WEBHOOK');
        console.log('🎯 Session mode:', sessionCompleted.mode);
        console.log('🎯 Sponsor campaign ID:', sessionCompleted.metadata?.sponsorCampaignId);
        
        try {
          const sponsorCampaignId = sessionCompleted.metadata?.sponsorCampaignId;
          
          if (!sponsorCampaignId) {
            console.error('❌ [SPONSOR] Missing sponsorCampaignId in session metadata');
            throw new WebhookProcessingError('Missing sponsorCampaignId in session metadata', 400);
          }
          console.log('[SPONSOR DONATION DEBUG] sponsorCampaignId from metadata:', sessionCompleted.metadata?.sponsorCampaignId);

          const pool = getPool();
          if (!pool) {
            throw new WebhookProcessingError('Database connection not available', 500);
          }
          
          // Fetch sponsor campaign and account details for email
          const campaignResult = await pool.query(
            `SELECT sc.*, sa.organization_legal_name, sa.contact_email, sa.id as sponsor_account_id
             FROM sponsor_campaigns sc
             JOIN sponsor_accounts sa ON sc.sponsor_account_id = sa.id
             WHERE sc.id = $1`,
            [sponsorCampaignId]
          );
          
          if (campaignResult.rows.length === 0) {
            throw new WebhookProcessingError('Sponsor campaign not found', 404);
          }
          const campaignRow = campaignResult.rows[0];
          console.log('[SPONSOR DONATION DEBUG] campaign lookup result:', campaignRow);

          const sponsorCampaign = campaignResult.rows[0];
          const sponsorAccountId = sponsorCampaign.sponsor_account_id;
          const contactEmail = sponsorCampaign.contact_email;
          const organizationName = sponsorCampaign.organization_legal_name;
          
          let billingUpdated = false;
          
          if (sessionCompleted.mode === 'payment') {
            // One-time sponsor payment
            console.log('💰 [SPONSOR] Processing one-time payment');
            console.log('💰 [SPONSOR] Payment Intent:', sessionCompleted.payment_intent);
            
            const paymentIntentId = sessionCompleted.payment_intent;
            
            if (!paymentIntentId) {
              console.error('❌ [SPONSOR] Missing payment_intent in checkout session');
              throw new WebhookProcessingError('Missing payment_intent in checkout session', 400);
            }
            
            const updateResult = await pool.query(
              `UPDATE sponsor_billing
               SET status = 'paid',
                   stripe_payment_intent_id = $1
               WHERE stripe_checkout_session_id = $2`,
              [paymentIntentId, sessionCompleted.id]
            );
            
            if (updateResult.rowCount === 0) {
              console.warn('⚠️ [SPONSOR] No sponsor_billing row found or already updated for session:', sessionCompleted.id);
            } else {
              billingUpdated = true;
              console.log('✅ [SPONSOR] Updated sponsor_billing to paid for one-time payment');
              console.log('✅ [SPONSOR] Payment Intent ID:', paymentIntentId);
            }

            // Sponsor donations ledger: insert row for one-time sponsor payment
            try {
              const paymentIntent = await stripe.paymentIntents.retrieve(
                typeof paymentIntentId === 'string' ? paymentIntentId : paymentIntentId?.id
              );
              console.log('[SPONSOR DONATION DEBUG] PaymentIntent retrieved:', paymentIntent.id);
              console.log('[SPONSOR DONATION DEBUG] amount_received:', paymentIntent.amount_received);
              const amountCents = typeof paymentIntent.amount_received === 'number'
                ? paymentIntent.amount_received
                : parseInt(paymentIntent.amount_received, 10) || 0;
              console.log('[SPONSOR DONATION DEBUG] inserting sponsor donation with:', {
                sponsor_account_id: sponsorAccountId,
                sponsor_campaign_id: sponsorCampaignId,
                paymentIntentId: paymentIntent.id
              });
              await pool.query(
                `INSERT INTO sponsor_donations (
                  sponsor_account_id,
                  sponsor_campaign_id,
                  stripe_payment_intent_id,
                  amount_cents,
                  source
                )
                VALUES ($1, $2, $3, $4, 'one_time_payment')
                ON CONFLICT (stripe_payment_intent_id)
                WHERE stripe_payment_intent_id IS NOT NULL
                DO NOTHING`,
                [sponsorAccountId, sponsorCampaignId, paymentIntent.id, amountCents]
              );
              console.log('[SPONSOR DONATION DEBUG] sponsor_donations insert attempted');
              console.log('✅ [SPONSOR] sponsor_donations ledger updated (one_time_payment)');
            } catch (ledgerErr) {
              console.error('[SPONSOR DONATION DEBUG] donation insert failed:', ledgerErr);
              console.error('❌ [SPONSOR] sponsor_donations insert failed (non-fatal):', ledgerErr.message);
            }
            
          } else if (sessionCompleted.mode === 'subscription') {
            // Recurring sponsor subscription
            // CRITICAL: Do NOT mark as paid here - subscription is in trial until Monday
            // Payment will be marked as paid when invoice.paid webhook fires after first Monday charge
            console.log('🔄 [SPONSOR] Processing recurring subscription (trial period)');
            console.log('🔄 [SPONSOR] Subscription ID:', sessionCompleted.subscription);
            
            const subscriptionId = sessionCompleted.subscription;
            
            if (!subscriptionId) {
              console.error('❌ [SPONSOR] Missing subscription in checkout session');
              throw new WebhookProcessingError('Missing subscription in checkout session', 400);
            }
            
            // CRITICAL: Always persist stripe_subscription_id for recurring sponsors
            // Update subscription_id regardless of current status (as long as not already paid)
            // Also set status to 'trialing' if currently 'open'
            const updateResult = await pool.query(
              `UPDATE sponsor_billing
               SET stripe_subscription_id = $1,
                   status = CASE 
                     WHEN status = 'open' THEN 'trialing'
                     ELSE status
                   END
               WHERE stripe_checkout_session_id = $2
                 AND status != 'paid'`,
              [subscriptionId, sessionCompleted.id]
            );
            
            if (updateResult.rowCount === 0) {
              console.warn('⚠️ [SPONSOR] No sponsor_billing row found or already paid for session:', sessionCompleted.id);
            } else {
              console.log('✅ [SPONSOR] Stored subscription_id for recurring sponsor');
              console.log('✅ [SPONSOR] Subscription ID:', subscriptionId);
              console.log('ℹ️ [SPONSOR] First payment will occur on Monday after approval - invoice.paid webhook will mark as paid');
              // Set billingUpdated = true to send confirmation email, but status remains 'trialing' (not 'paid')
              billingUpdated = true;
            }
            // Billing authority: enforce after subscription creation (Billing tab default = authority; Checkout must not override)
            try {
              const customerId = typeof sessionCompleted.customer === 'string' ? sessionCompleted.customer : sessionCompleted.customer?.id;
              const originalDefault = sessionCompleted.metadata?.customer_default_pm || null;
              if (customerId && subscriptionId) {
                const customer = await stripe.customers.retrieve(customerId);
                const currentCustomerDefault = customer.invoice_settings?.default_payment_method || null;
                const authorityPm = originalDefault || currentCustomerDefault;
                const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                const subscriptionDefaultPm = typeof subscription.default_payment_method === 'string' ? subscription.default_payment_method : subscription.default_payment_method?.id || null;
                if (authorityPm && subscriptionDefaultPm !== authorityPm) {
                  await stripe.subscriptions.update(subscriptionId, { default_payment_method: authorityPm });
                  console.log('✅ [SPONSOR] Aligned subscription to Billing tab default PM:', authorityPm);
                }
                if (originalDefault && currentCustomerDefault !== originalDefault) {
                  await stripe.customers.update(customerId, {
                    invoice_settings: { default_payment_method: originalDefault }
                  });
                  console.log('✅ [SPONSOR] Restored customer default PM (Checkout had overridden):', originalDefault);
                }
              }
            } catch (safeguardErr) {
              console.error('❌ [SPONSOR] Billing authority safeguard failed:', safeguardErr.message);
            }
          } else if (sessionCompleted.mode === 'setup') {
            // Non-recurring sponsor: card saved via Checkout setup mode
            console.log('💳 [SPONSOR] Processing setup mode checkout (non-recurring card save)');
            const setupUpdateResult = await pool.query(
              `UPDATE sponsor_billing SET status = 'setup_complete'
               WHERE stripe_checkout_session_id = $1 AND status = 'open'`,
              [sessionCompleted.id]
            );
            if (setupUpdateResult.rowCount > 0) {
              billingUpdated = true;
              console.log('✅ [SPONSOR] Non-recurring billing updated to setup_complete');
            } else {
              console.warn('⚠️ [SPONSOR] No open billing row found for setup session:', sessionCompleted.id);
            }
          } else {
            console.warn('⚠️ [SPONSOR] Unsupported checkout mode for sponsor:', sessionCompleted.mode);
          }
          
          // Promote campaign to pending_approval now that payment/billing is confirmed
          if (billingUpdated) {
            try {
              const promoteResult = await pool.query(
                `UPDATE sponsor_campaigns SET status = 'pending_approval', updated_at = NOW()
                 WHERE id = $1 AND status = 'payment_pending'`,
                [sponsorCampaignId]
              );
              if (promoteResult.rowCount > 0) {
                console.log('✅ [SPONSOR] Campaign promoted to pending_approval');
              } else {
                console.log('ℹ️ [SPONSOR] Campaign already promoted or not in payment_pending state');
              }
            } catch (promoteErr) {
              console.error('❌ [SPONSOR] Failed to promote campaign status:', promoteErr.message);
            }
          }

          // Send Sponsor Email #1 only if billing was successfully updated
          if (billingUpdated && emailService && emailService.isEmailConfigured()) {
            console.log('📧 ===== WEBHOOK: PREPARING TO SEND SPONSOR CONFIRMATION EMAIL =====');
            console.log('📧 [WEBHOOK] Sponsor email:', contactEmail);
            console.log('📧 [WEBHOOK] Organization name:', organizationName);
            console.log('📧 [WEBHOOK] Email service configured:', emailService.isEmailConfigured());
            
            // Generate password_setup token for Email #1 (submission confirmation)
            // Only create if password doesn't exist
            let rawInitialSetupToken = null;
            try {
              // Find sponsor_accounts row to check for password
              const accountResult = await pool.query(`
                SELECT id, password_hash
                FROM sponsor_accounts
                WHERE id = $1
              `, [sponsorAccountId]);
              
              if (accountResult.rows.length === 0) {
                console.error('❌ [SPONSOR-SETUP] No sponsor_accounts row found for sponsor_account_id:', sponsorAccountId);
              } else {
                const account = accountResult.rows[0];
                // Only create token if password doesn't exist (Email #1 flow)
                if (!account.password_hash) {
                  const tokenResult = await createSponsorPasswordToken(account.id, 'password_setup', pool);
                  rawInitialSetupToken = tokenResult.rawToken;
                  console.log('✅ [SPONSOR-SETUP] Created password_setup token for sponsor_account:', sponsorAccountId);
                } else {
                  console.log('ℹ️ [SPONSOR-SETUP] Password already exists - skipping token creation');
                }
              }
            } catch (tokenError) {
              console.error('❌ [SPONSOR-SETUP] Failed to create token:', tokenError.message);
              console.error('❌ [SPONSOR-SETUP] Error details:', tokenError);
              // Continue with email even if token creation fails
            }
            
            // Build submission summary for email
            const submissionSummary = {
              organizationName: organizationName,
              tier: sponsorCampaign.tier,
              isRecurring: sponsorCampaign.is_recurring,
              tagline: sponsorCampaign.tagline || null
            };
            
            console.log('📧 [WEBHOOK] Submission summary prepared:', {
              organizationName: submissionSummary.organizationName,
              tier: submissionSummary.tier,
              isRecurring: submissionSummary.isRecurring
            });
            console.log('📧 [WEBHOOK] About to call sendSponsorConfirmationEmail...');
            
            const emailResult = await emailService.sendSponsorConfirmationEmail(
              contactEmail,
              organizationName,
              submissionSummary,
              rawInitialSetupToken
            );
            
            console.log('📧 [WEBHOOK] Email send result:', {
              success: emailResult?.success,
              messageId: emailResult?.messageId,
              code: emailResult?.code
            });
            
            if (emailResult.success) {
              console.log('✅ Sponsor confirmation email sent successfully');
            } else {
              console.error('❌ Failed to send sponsor confirmation email:', emailResult.error);
            }
          } else {
            if (!billingUpdated) {
              console.warn('⚠️ [SPONSOR] Billing not updated, skipping email');
            } else {
              console.warn('⚠️ Email service not configured, skipping sponsor confirmation email');
            }
          }
          
        } catch (sponsorError) {
          console.error('❌ [SPONSOR] Error processing sponsor checkout:', sponsorError);
          console.error('❌ [SPONSOR] Stack:', sponsorError.stack);
          if (sponsorError instanceof WebhookProcessingError) {
            throw sponsorError;
          }
          throw new WebhookProcessingError('Failed to process sponsor checkout', 500, sponsorError.message);
        }
      } else {
        console.log('⚠️ checkout.session.completed received but not a donation payment, advertiser setup, or sponsor checkout');
        console.log('⚠️ Session mode:', sessionCompleted.mode);
        console.log('⚠️ Has advertiser metadata?', !!sessionCompleted.metadata?.advertiserId);
        console.log('⚠️ Has sponsor metadata?', !!sessionCompleted.metadata?.sponsorCampaignId);
        console.log('⚠️ Subscription ID (if subscription mode):', sessionCompleted.subscription);
        console.log('⚠️ This checkout will trigger customer.subscription.created if mode=subscription');
      }
      break;
    }

    case 'setup_intent.succeeded': {
      // Handle SetupIntent confirmation (e.g., when user adds new card via Payment Element or Checkout)
      // Dedupe by fingerprint, then auto-set as default only if customer has no default
      const setupIntent = event.data.object;
      console.log('💳 [WEBHOOK] setup_intent.succeeded received');
      console.log('💳 SetupIntent ID:', setupIntent.id);
      console.log('💳 Customer ID:', setupIntent.customer);
      console.log('💳 Payment Method:', setupIntent.payment_method);

      try {
        if (!setupIntent.customer) {
          console.log('⏭️ [SETUP-INTENT] SetupIntent has no customer, skipping');
          break;
        }

        if (!setupIntent.payment_method) {
          console.log('⏭️ [SETUP-INTENT] SetupIntent has no payment_method, skipping');
          break;
        }

        // Normalize IDs (webhook may send string IDs or expanded objects)
        const customerId = typeof setupIntent.customer === 'string'
          ? setupIntent.customer
          : setupIntent.customer?.id;
        const paymentMethodId = typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : setupIntent.payment_method?.id;

        if (!customerId || !paymentMethodId) {
          console.log('⏭️ [SETUP-INTENT] Could not resolve customer or payment_method id, skipping');
          break;
        }

        console.log('[DEDUP CHECK]', {
          customerId,
          paymentMethodId,
          typeofCustomer: typeof setupIntent.customer,
          typeofPaymentMethod: typeof setupIntent.payment_method
        });

        // Backup path: mark advertiser checkout as complete when SetupIntent succeeds.
        // Some Payment Element / SetupIntent flows attach a PM but don't fire/handle the expected Checkout update path.
        try {
          const pool = getPool();
          if (!pool) {
            console.warn('⚠️ [SETUP-INTENT] Database pool not available, skipping advertiser payment_completed update');
          } else {
            const advertiserUpdate = await pool.query(
              `UPDATE advertisers a
               SET payment_completed = TRUE,
                   status = 'pending_review',
                   updated_at = NOW()
               FROM advertiser_accounts aa
               WHERE LOWER(TRIM(aa.email)) = LOWER(TRIM(a.email))
                 AND aa.stripe_customer_id = $1
                 AND a.payment_completed = FALSE
                 AND a.status = 'payment_pending'
               RETURNING a.id`,
              [customerId]
            );
            if (advertiserUpdate.rows.length > 0) {
              const advertiserIdFromUpdate = advertiserUpdate.rows[0].id;
              console.log('✅ [SETUP-INTENT] Marked advertiser payment_completed = TRUE via SetupIntent:', {
                advertiserId: advertiserIdFromUpdate,
                customerId
              });

              // Confirmation email + password_setup token (must run here — setup_intent.succeeded wins the race vs checkout.session.completed idempotency)
              let rawInitialSetupToken = null;
              try {
                const accountResult = await pool.query(
                  `
                  SELECT id, password_hash
                  FROM advertiser_accounts
                  WHERE advertiser_id = $1
                  `,
                  [advertiserIdFromUpdate]
                );

                if (accountResult.rows.length === 0) {
                  console.error('❌ [INITIAL SETUP] No advertiser_accounts row found for advertiser_id:', advertiserIdFromUpdate);
                } else {
                  const account = accountResult.rows[0];
                  if (!account.password_hash) {
                    const tokenResult = await createPasswordToken(account.id, 'password_setup', pool);
                    rawInitialSetupToken = tokenResult.rawToken;
                    console.log('✅ [INITIAL SETUP] Created password_setup token for advertiser:', advertiserIdFromUpdate);
                  } else {
                    rawInitialSetupToken = null;
                    console.log('ℹ️ [INITIAL SETUP] Password already exists - skipping token creation');
                  }
                }
              } catch (tokenError) {
                console.error('❌ [INITIAL SETUP] Failed to create token:', tokenError.message);
                console.error('❌ [INITIAL SETUP] Error details:', tokenError);
              }

              const advertiserRowResult = await pool.query(
                `
                SELECT email, company_name, ad_format, cpm_rate, weekly_budget_cap, expedited, click_tracking
                FROM advertisers
                WHERE id = $1
                `,
                [advertiserIdFromUpdate]
              );

              if (advertiserRowResult.rows.length === 0) {
                console.error('❌ [SETUP-INTENT] Advertiser row missing after update for id:', advertiserIdFromUpdate);
              } else {
                const adv = advertiserRowResult.rows[0];
                const campaignSummary = {
                  ad_format: adv.ad_format || 'video',
                  cpm_rate: adv.cpm_rate || null,
                  weekly_budget_cap: adv.weekly_budget_cap || null,
                  expedited: adv.expedited || false,
                  click_tracking: adv.click_tracking || false
                };

                console.log('📧 [WEBHOOK] Campaign summary prepared from database:', {
                  ad_format: campaignSummary.ad_format,
                  cpm_rate: campaignSummary.cpm_rate,
                  weekly_budget_cap: campaignSummary.weekly_budget_cap,
                  expedited: campaignSummary.expedited,
                  click_tracking: campaignSummary.click_tracking
                });

                if (emailService && emailService.isEmailConfigured()) {
                  console.log('📧 ===== WEBHOOK: PREPARING TO SEND ADVERTISER CONFIRMATION EMAIL =====');
                  console.log('📧 [WEBHOOK] Advertiser email:', adv.email);
                  console.log('📧 [WEBHOOK] Company name:', adv.company_name);
                  console.log('📧 [WEBHOOK] Email service configured:', emailService.isEmailConfigured());
                  console.log('📧 [WEBHOOK] About to call sendAdvertiserConfirmationEmail...');

                  const emailResult = await emailService.sendAdvertiserConfirmationEmail(
                    adv.email,
                    adv.company_name,
                    campaignSummary,
                    rawInitialSetupToken
                  );

                  console.log('📧 [WEBHOOK] Email send result:', {
                    success: emailResult?.success,
                    messageId: emailResult?.messageId,
                    code: emailResult?.code
                  });

                  if (emailResult.success) {
                    console.log('✅ Advertiser confirmation email sent successfully');
                  } else {
                    console.error('❌ Failed to send advertiser confirmation email:', emailResult.error);
                  }
                } else {
                  console.warn('⚠️ Email service not configured, skipping advertiser confirmation email');
                }
              }
            }
          }
        } catch (dbUpdateErr) {
          console.error('❌ [SETUP-INTENT] Failed to mark advertiser payment_completed via SetupIntent (non-fatal):', dbUpdateErr.message);
        }

        // Fingerprint dedup: if same card already on customer, detach new PM and skip default
        const isDuplicate = await dedupePaymentMethodByFingerprint(customerId, paymentMethodId);
        if (isDuplicate) {
          console.log('⏭️ [SETUP-INTENT] Duplicate card - skipped default payment method update');
          break;
        }

        // Retrieve customer to check current default payment method
        const customer = await stripe.customers.retrieve(customerId);
        const currentDefault = customer.invoice_settings?.default_payment_method;

        if (currentDefault) {
          console.log(`⏭️ [SETUP-INTENT] Customer ${customerId} already has default ${currentDefault}, skipping auto-set`);
          break;
        }

        // Customer has no default - auto-set the newly added one
        console.log(`💳 [SETUP-INTENT] Customer ${customerId} has no default, auto-setting ${paymentMethodId}`);
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId }
        });
        console.log(`✅ [SETUP-INTENT] Auto-set default payment method ${paymentMethodId} for customer ${customerId}`);
      } catch (setupIntentError) {
        console.error('❌ [SETUP-INTENT] Error processing setup_intent.succeeded:', setupIntentError.message);
        // Don't throw - best-effort
      }
      break;
    }

    case 'customer.subscription.deleted': {
      // Fired when a subscription fully ends (cancel_at_period_end reached, or immediate cancel)
      const deletedSub = event.data.object;
      console.log('🗑️ [WEBHOOK] customer.subscription.deleted — subscription:', deletedSub.id);
      try {
        const pool = getPool();
        if (pool) {
          // Only revoke premium if the deleted sub matches what we have on record
          const result = await pool.query(
            `UPDATE users
             SET is_premium = false,
                 stripe_subscription_id = NULL,
                 premium_since = NULL,
                 subscription_cancel_at = NULL
             WHERE stripe_subscription_id = $1
             RETURNING id, email`,
            [deletedSub.id]
          );
          if (result.rows.length > 0) {
            console.log(`✅ [SUBSCRIPTION.DELETED] Revoked premium for user ${result.rows[0].id} (${result.rows[0].email})`);
          } else {
            console.log('ℹ️ [SUBSCRIPTION.DELETED] No user matched subscription — may be sponsor/advertiser sub, skipping');
          }
        }
      } catch (err) {
        console.error('❌ [SUBSCRIPTION.DELETED] Error revoking premium:', err.message);
      }
      break;
    }

    case 'customer.updated':
      // Ignore customer.updated events
      console.log(`⏭️ [WEBHOOK] Ignoring event type: ${event.type} (no action required)`);
      break;

    case 'invoice.paid': {
      // Reactive webhook - marks billing as paid when Stripe invoice is paid
      // Campaign activation handled by Monday job
      // CRITICAL: Uses invoice.subscription directly - does NOT require subscription metadata
      const invoice = event.data.object;
      console.log('💳 [WEBHOOK] invoice.paid received');
      console.log('💳 Invoice ID:', invoice.id);
      console.log('💳 Customer ID:', invoice.customer);
      console.log('💳 Payment Intent ID:', invoice.payment_intent);
      console.log('[SPONSOR DONATION DEBUG] invoice.paid received');
      console.log('[SPONSOR DONATION DEBUG] subscription:', invoice.subscription);
      console.log('[SPONSOR DONATION DEBUG] amount_paid:', invoice.amount_paid);

      // Normalize: invoice.subscription can be a string ID or an expanded object { id: "sub_..." }
      // Fallback: when trial is ended manually, Stripe may omit invoice.subscription; use first line's subscription
      let rawSub = invoice.subscription;
      let subscriptionId = typeof rawSub === 'string' ? rawSub : rawSub?.id;
      if (!subscriptionId) {
        rawSub = invoice.lines?.data?.[0]?.subscription;
        subscriptionId = typeof rawSub === 'string' ? rawSub : rawSub?.id;
      }
      if (!subscriptionId && invoice.payment_intent) {
        try {
          const pi = await stripe.paymentIntents.retrieve(invoice.payment_intent, {
            expand: ['charges.data.invoice', 'charges.data.invoice.lines.data.subscription']
          });
          const inv = pi.charges?.data?.[0]?.invoice;
          if (inv) {
            rawSub = inv.subscription;
            subscriptionId = typeof rawSub === 'string' ? rawSub : rawSub?.id;
            if (!subscriptionId && inv.lines?.data) {
              for (const line of inv.lines.data) {
                rawSub = line.subscription;
                subscriptionId = typeof rawSub === 'string' ? rawSub : rawSub?.id;
                if (subscriptionId) break;
              }
            }
          }
        } catch (piErr) {
          console.error('❌ [INVOICE.PAID] PaymentIntent fallback failed:', piErr.message);
        }
      }
      if (!subscriptionId) {
        console.warn(invoice.payment_intent
          ? '⚠️ [INVOICE.PAID] Unable to resolve subscription ID after PaymentIntent fallback'
          : '⚠️ [INVOICE.PAID] Could not extract subscription ID (tried invoice.subscription and invoice.lines.data[0].subscription)');
        console.warn('⚠️ [INVOICE.PAID] (Invoice may be advertiser recurring — sponsor block skipped)');
      } else {
        console.log('💳 Subscription ID:', subscriptionId);
      }

      if (subscriptionId) {
        try {
          const pool = getPool();
          if (!pool) {
            console.warn('⚠️ [INVOICE.PAID] Database pool not available');
          } else {
        // CRITICAL FIX: Update sponsor_billing directly using subscription ID
        // No longer depends on subscription metadata - uses normalized subscriptionId
        // This ensures payment is recorded even if metadata is missing or invoice.subscription is expanded
        const updateResult = await pool.query(
          `UPDATE sponsor_billing
           SET status = 'paid',
               stripe_payment_intent_id = $1
           WHERE stripe_subscription_id = $2`,
          [invoice.payment_intent, subscriptionId]
        );
        
        if (updateResult.rowCount > 0) {
          console.log('✅ [INVOICE.PAID] Marked recurring sponsor billing as paid');
          console.log('✅ [INVOICE.PAID] Subscription ID:', subscriptionId);
          console.log('✅ [INVOICE.PAID] Payment Intent ID:', invoice.payment_intent);
          console.log('✅ [INVOICE.PAID] Invoice ID:', invoice.id);
          // Activate the sponsor campaign now that billing has started.
          // Also correct start_week if it is in the past (e.g. trial ended early).
          const todayStr = new Date().toISOString().slice(0, 10);
          const campaignActivateResult = await pool.query(
            `UPDATE sponsor_campaigns
             SET status = 'active',
                 start_week = CASE WHEN start_week < $2::date THEN $2::date ELSE start_week END,
                 updated_at = NOW()
             WHERE id = (
               SELECT sponsor_campaign_id FROM sponsor_billing WHERE stripe_subscription_id = $1 LIMIT 1
             )
             AND status IN ('approved', 'pending_approval')`,
            [subscriptionId, todayStr]
          );
          if (campaignActivateResult.rowCount > 0) {
            console.log('✅ [INVOICE.PAID] Activated sponsor campaign (first billing started)');
          }
        } else {
          // Improved failure visibility: Check why update failed
          const checkResult = await pool.query(
            `SELECT id, status, stripe_subscription_id, sponsor_campaign_id
             FROM sponsor_billing
             WHERE stripe_subscription_id = $1`,
            [subscriptionId]
          );
          
          if (checkResult.rows.length === 0) {
            console.warn('⚠️ [INVOICE.PAID] No sponsor_billing row found for subscription:', subscriptionId);
            console.warn('⚠️ [INVOICE.PAID] This invoice may be for a non-sponsor subscription (advertiser or other)');
          } else {
            const billing = checkResult.rows[0];
            if (billing.status === 'paid') {
              console.log('ℹ️ [INVOICE.PAID] Billing already marked as paid (idempotent - safe to ignore)');
              console.log('ℹ️ [INVOICE.PAID] Billing ID:', billing.id, 'Campaign ID:', billing.sponsor_campaign_id);
            } else {
              console.warn('⚠️ [INVOICE.PAID] Billing found but status not updated');
              console.warn('⚠️ [INVOICE.PAID] Current status:', billing.status);
              console.warn('⚠️ [INVOICE.PAID] Expected status: trialing or open');
              console.warn('⚠️ [INVOICE.PAID] Billing ID:', billing.id, 'Campaign ID:', billing.sponsor_campaign_id);
              console.warn('⚠️ [INVOICE.PAID] Update was skipped because status is not in (trialing, open)');
            }
          }
        }

        // Sponsor donations ledger: insert row for each successful recurring payment
        const campaignLookup = await pool.query(
          `SELECT sc.id AS sponsor_campaign_id, sc.sponsor_account_id
           FROM sponsor_billing sb
           JOIN sponsor_campaigns sc ON sc.id = sb.sponsor_campaign_id
           WHERE sb.stripe_subscription_id = $1`,
          [subscriptionId]
        );
        const campaignRow = campaignLookup.rows[0] || null;
        console.log('[SPONSOR DONATION DEBUG] recurring campaign lookup result:', campaignRow);
        if (campaignLookup.rows.length > 0) {
          const { sponsor_campaign_id, sponsor_account_id } = campaignLookup.rows[0];
          const amountCents = typeof invoice.amount_paid === 'number' ? invoice.amount_paid : parseInt(invoice.amount_paid, 10) || 0;
          console.log('[SPONSOR DONATION DEBUG] inserting recurring donation (invoice.paid fallback):', {
            sponsor_account_id,
            sponsor_campaign_id,
            invoiceId: invoice.id
          });
          try {
            await pool.query(
              `INSERT INTO sponsor_donations (
                sponsor_account_id,
                sponsor_campaign_id,
                stripe_invoice_id,
                amount_cents,
                source
              )
              VALUES ($1, $2, $3, $4, 'recurring_invoice')
              ON CONFLICT (stripe_invoice_id)
              WHERE stripe_invoice_id IS NOT NULL
              DO NOTHING`,
              [sponsor_account_id, sponsor_campaign_id, invoice.id, amountCents]
            );
            console.log('[SPONSOR DONATION DEBUG] recurring donation insert attempted (invoice.paid)');
            console.log('✅ [INVOICE.PAID] sponsor_donations ledger updated (recurring_invoice) — ledger/pool/start_week run in charge.succeeded when subscription context missing here');
          } catch (recurringDonationErr) {
            console.error('[SPONSOR DONATION DEBUG] recurring donation insert failed:', recurringDonationErr);
          }
        }
          }
        } catch (invoiceError) {
          console.error('❌ [INVOICE.PAID] Error processing invoice:', invoiceError.message);
          console.error('❌ [INVOICE.PAID] Error stack:', invoiceError.stack);
          // Don't throw - allow webhook to succeed (Stripe will retry if needed)
        }
      }

      // User premium subscription accounting
      // Primary lookup: stripe_subscription_id (when Stripe provides invoice.subscription)
      // Fallback lookup: stripe_customer_id (common with Stripe API 2025-08-27.basil where invoice.subscription is undefined)
      {
        try {
          const poolPremium = getPool();
          if (poolPremium) {
            let userPremiumResult;
            if (subscriptionId) {
              userPremiumResult = await poolPremium.query(
                `SELECT id FROM users WHERE stripe_subscription_id = $1 AND is_premium = true`,
                [subscriptionId]
              );
            } else if (invoice.customer) {
              console.log('ℹ️ [INVOICE.PAID] subscriptionId not found — falling back to stripe_customer_id lookup:', invoice.customer);
              userPremiumResult = await poolPremium.query(
                `SELECT id FROM users WHERE stripe_customer_id = $1 AND is_premium = true`,
                [invoice.customer]
              );
            }
            if (userPremiumResult && userPremiumResult.rows.length > 0) {
              const amountDollars = typeof invoice.amount_paid === 'number' ? invoice.amount_paid / 100 : 1.00;
              const weekStart = _adminThisMonday();
              // payment_intent may be undefined for subscription renewals via test clocks or some billing modes
              const paymentIntentId = (typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id) || invoice.id;
              const webhookLedgerResult = await poolPremium.query(
                `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
                 VALUES ('subscription', $1, $2, $3, $4)
                 ON CONFLICT (source_id, week_start) DO NOTHING
                 RETURNING id`,
                [invoice.id, paymentIntentId, amountDollars, weekStart]
              );
              if (webhookLedgerResult.rows.length > 0) {
                await poolPremium.query(
                  `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total, viewer_total)
                   VALUES ($1, 0, 0, $2)
                   ON CONFLICT (week_start) DO UPDATE
                   SET viewer_total = weekly_donation_pool.viewer_total + EXCLUDED.viewer_total,
                       updated_at = NOW()`,
                  [weekStart, amountDollars]
                );
                console.log('✅ [INVOICE.PAID] User premium subscription ledger recorded, week_start:', weekStart);
              } else {
                console.log('ℹ️ [INVOICE.PAID] Invoice already in ledger — pool not double-counted, week_start:', weekStart);
              }
            }
          }
        } catch (premiumLedgerErr) {
          console.error('❌ [INVOICE.PAID] User premium ledger error:', premiumLedgerErr.message);
        }
      }

      try {
        const poolAdv = getPool();
        if (poolAdv) {
          await applyAdvertiserRecurringLedgerFromInvoicePaid(invoice, poolAdv);
        }
      } catch (advLedgerErr) {
        console.error('❌ [INVOICE.PAID] Advertiser recurring ledger error:', advLedgerErr.message);
      }

      try {
        const poolNrAdv = getPool();
        if (poolNrAdv) {
          await applyAdvertiserNonRecurringLedgerFromInvoicePaid(invoice, poolNrAdv);
        }
      } catch (nrAdvLedgerErr) {
        console.error('❌ [INVOICE.PAID] Advertiser non-recurring ledger error:', nrAdvLedgerErr.message);
      }

      // Advertiser billing: log card used for verification (no billing behavior change)
      const isAdvertiserInvoice = invoice.metadata?.campaignType === 'recurring' || invoice.metadata?.campaignType === 'non-recurring';
      if (isAdvertiserInvoice && invoice.payment_intent) {
        try {
          const paymentIntentId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id;
          if (!paymentIntentId) break;
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          const rawPm = paymentIntent.payment_method;
          const paymentMethodId = typeof rawPm === 'string' ? rawPm : rawPm?.id;
          if (!paymentMethodId) break;
          const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
          const customerId = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer?.id;
          if (paymentMethod.type === 'card' && paymentMethod.card) {
            console.log('[ADVERTISER BILLING CARD USED]', {
              customerId,
              paymentMethodId,
              brand: paymentMethod.card.brand,
              last4: paymentMethod.card.last4,
              exp_month: paymentMethod.card.exp_month,
              exp_year: paymentMethod.card.exp_year
            });
          }
        } catch (cardLogErr) {
          console.error('❌ [INVOICE.PAID] Advertiser card logging failed:', cardLogErr.message);
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      // Handle Stripe subscription payment failures for recurring sponsors
      // Updates sponsor_billing.status to 'failed' so unpaid sponsors are not eligible to run
      const invoice = event.data.object;
      console.log('❌ [WEBHOOK] invoice.payment_failed received');
      console.log('❌ Invoice ID:', invoice.id);
      console.log('❌ Customer ID:', invoice.customer);
      
      // Robust subscription ID extraction with priority:
      // 1. invoice.subscription (string or expanded object)
      // 2. invoice.lines.data[].subscription_item.subscription (search all lines)
      let subscriptionId = null;
      let resolutionPath = null;
      
      // Priority 1: Try invoice.subscription directly
      const rawSub = invoice.subscription;
      if (rawSub) {
        subscriptionId = typeof rawSub === 'string' ? rawSub : rawSub?.id;
        if (subscriptionId) {
          resolutionPath = 'invoice.subscription';
          console.log('✅ [INVOICE.PAYMENT_FAILED] Resolved subscription ID from invoice.subscription');
        }
      }
      
      // Priority 2: Search invoice.lines.data for subscription_item.subscription
      if (!subscriptionId && invoice.lines?.data) {
        for (const line of invoice.lines.data) {
          if (line.subscription_item?.subscription) {
            const lineSub = line.subscription_item.subscription;
            subscriptionId = typeof lineSub === 'string' ? lineSub : lineSub?.id;
            if (subscriptionId) {
              resolutionPath = 'invoice.lines.data[].subscription_item.subscription';
              console.log('✅ [INVOICE.PAYMENT_FAILED] Resolved subscription ID from invoice.lines.data[].subscription_item.subscription');
              break;
            }
          }
          // Also check line.subscription as fallback (for backwards compatibility)
          if (!subscriptionId && line.subscription) {
            const lineSub = line.subscription;
            subscriptionId = typeof lineSub === 'string' ? lineSub : lineSub?.id;
            if (subscriptionId) {
              resolutionPath = 'invoice.lines.data[].subscription';
              console.log('✅ [INVOICE.PAYMENT_FAILED] Resolved subscription ID from invoice.lines.data[].subscription');
              break;
            }
          }
        }
      }
      
      // Fallback: If no subscription ID found, try to resolve via customer ID
      if (!subscriptionId) {
        console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Could not extract subscription ID from invoice');
        console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Tried: invoice.subscription, invoice.lines.data[].subscription_item.subscription, invoice.lines.data[].subscription');
        console.log('🔍 [INVOICE.PAYMENT_FAILED] Attempting fallback via customer ID...');
        
        const customerId = invoice.customer;
        if (!customerId) {
          console.warn('⚠️ [INVOICE.PAYMENT_FAILED] No customer ID available in invoice');
          console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Cannot resolve subscription - exiting gracefully');
          break;
        }
        
        console.log('🔍 [INVOICE.PAYMENT_FAILED] Customer ID:', customerId);
        
        try {
          const pool = getPool();
          if (!pool) {
            console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Database pool not available');
            break;
          }
          
          // Query sponsor_billing via sponsor_campaigns → sponsor_accounts join to get stripe_subscription_id
          // Schema path: sponsor_billing.sponsor_campaign_id → sponsor_campaigns.id
          //              sponsor_campaigns.sponsor_account_id → sponsor_accounts.id
          //              sponsor_accounts.stripe_customer_id = invoice.customer
          const customerQueryResult = await pool.query(
            `SELECT sb.stripe_subscription_id
             FROM sponsor_billing sb
             JOIN sponsor_campaigns sc
               ON sb.sponsor_campaign_id = sc.id
             JOIN sponsor_accounts sa
               ON sc.sponsor_account_id = sa.id
             WHERE sa.stripe_customer_id = $1
             LIMIT 1`,
            [customerId]
          );
          
          if (customerQueryResult.rows.length === 0 || !customerQueryResult.rows[0].stripe_subscription_id) {
            console.warn('⚠️ [INVOICE.PAYMENT_FAILED] No sponsor_billing row found for customer:', customerId);
            console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Join path: sponsor_billing → sponsor_campaigns → sponsor_accounts');
            console.warn('⚠️ [INVOICE.PAYMENT_FAILED] This invoice may be for a non-sponsor subscription (advertiser or other)');
            // Fall through to the advertiser handler below — do not break here
          } else {
            subscriptionId = customerQueryResult.rows[0].stripe_subscription_id;
            resolutionPath = 'customer_id_fallback (sponsor_billing → sponsor_campaigns → sponsor_accounts)';
            console.log('✅ [INVOICE.PAYMENT_FAILED] Resolved subscription ID via customer ID fallback');
            console.log('✅ [INVOICE.PAYMENT_FAILED] Join path used: sponsor_billing → sponsor_campaigns → sponsor_accounts');
            console.log('✅ [INVOICE.PAYMENT_FAILED] Subscription ID:', subscriptionId);
          }
        } catch (customerQueryError) {
          console.error('❌ [INVOICE.PAYMENT_FAILED] Error querying sponsor_billing by customer ID:', customerQueryError.message);
          console.error('❌ [INVOICE.PAYMENT_FAILED] Error stack:', customerQueryError.stack);
          // Don't throw - exit gracefully
          break;
        }
      }
      
      if (!subscriptionId) {
        console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Could not resolve subscription ID via any method');

        // Check if this is an advertiser invoice (standalone — no subscription attached)
        const campaignType = invoice.metadata?.campaignType;
        const advertiserIdStr = invoice.metadata?.advertiserId;

        if ((campaignType === 'recurring' || campaignType === 'non-recurring') && advertiserIdStr) {
          console.log(`❌ [INVOICE.PAYMENT_FAILED] Advertiser invoice payment failed — campaignType: ${campaignType}, advertiserId: ${advertiserIdStr}`);
          try {
            const pool = getPool();
            if (pool) {
              const parsedId = parseInt(advertiserIdStr, 10);
              // Recurring campaigns are paused immediately to stop serving ads
              // Non-recurring campaigns are already archived — just flag for admin visibility
              const pauseClause = campaignType === 'recurring' ? ', is_paused = TRUE' : '';
              const advResult = await pool.query(
                `UPDATE advertisers SET billing_failed = TRUE${pauseClause} WHERE id = $1 RETURNING email, company_name`,
                [parsedId]
              );
              console.log(`❌ [INVOICE.PAYMENT_FAILED] Marked advertiser ${advertiserIdStr} billing_failed = TRUE${campaignType === 'recurring' ? ' and is_paused = TRUE' : ''}`);
              if (advResult.rows.length > 0) {
                const { email: advEmail, company_name } = advResult.rows[0];
                try {
                  await emailService.sendAdvertiserPaymentFailedEmail(advEmail, company_name);
                } catch (emailErr) {
                  console.error('❌ [INVOICE.PAYMENT_FAILED] Error sending advertiser payment failed email:', emailErr.message);
                }
              }
            }
          } catch (advFailErr) {
            console.error('❌ [INVOICE.PAYMENT_FAILED] Error updating advertiser billing_failed:', advFailErr.message);
          }
        } else {
          console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Not an advertiser invoice — exiting gracefully');
        }
        break;
      }
      
      console.log('❌ [INVOICE.PAYMENT_FAILED] Subscription ID:', subscriptionId);
      console.log('📊 [INVOICE.PAYMENT_FAILED] Resolution path:', resolutionPath || 'unknown');
      
      try {
        const pool = getPool();
        if (!pool) {
          console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Database pool not available');
          break;
        }
        
        // Update sponsor_billing.status to 'failed'
        // Idempotent: safe to run multiple times regardless of current status
        // Status-agnostic: updates from any status (trialing, paid, etc.) to 'failed'
        const updateResult = await pool.query(
          `UPDATE sponsor_billing
           SET status = 'failed'
           WHERE stripe_subscription_id = $1`,
          [subscriptionId]
        );

        if (updateResult.rowCount > 0) {
          console.log('✅ [INVOICE.PAYMENT_FAILED] Marked sponsor billing as failed');
          console.log('✅ [INVOICE.PAYMENT_FAILED] Subscription ID:', subscriptionId);
          console.log('✅ [INVOICE.PAYMENT_FAILED] Invoice ID:', invoice.id);
          console.log('✅ [INVOICE.PAYMENT_FAILED] Resolution path:', resolutionPath);

          // Mark campaign as payment_failed and send notification email
          const campaignResult = await pool.query(
            `UPDATE sponsor_campaigns sc
             SET status = 'payment_failed', updated_at = NOW()
             FROM sponsor_billing sb
             WHERE sb.stripe_subscription_id = $1
               AND sc.id = sb.sponsor_campaign_id
               AND sc.status NOT IN ('payment_failed', 'rejected', 'cancelled')
             RETURNING sc.id, sc.sponsor_account_id`,
            [subscriptionId]
          );
          if (campaignResult.rowCount > 0) {
            console.log('❌ [INVOICE.PAYMENT_FAILED] Marked sponsor_campaigns.status = payment_failed for campaign(s):', campaignResult.rows.map(r => r.id));
            // Send failure notification email
            if (emailService && emailService.isEmailConfigured()) {
              try {
                const sponsorAccountId = campaignResult.rows[0].sponsor_account_id;
                const sponsorRow = await pool.query(
                  `SELECT contact_email, organization_legal_name FROM sponsor_accounts WHERE id = $1`,
                  [sponsorAccountId]
                );
                if (sponsorRow.rows.length > 0) {
                  const { contact_email, organization_legal_name } = sponsorRow.rows[0];
                  await emailService.sendSponsorPaymentFailedEmail(contact_email, organization_legal_name);
                }
              } catch (emailErr) {
                console.error('❌ [INVOICE.PAYMENT_FAILED] Error sending sponsor payment failed email:', emailErr.message);
              }
            }
          }
        } else {
          // Check if sponsor_billing row exists for this subscription
          const checkResult = await pool.query(
            `SELECT id, status, sponsor_campaign_id
             FROM sponsor_billing
             WHERE stripe_subscription_id = $1`,
            [subscriptionId]
          );

          if (checkResult.rows.length === 0) {
            console.warn('⚠️ [INVOICE.PAYMENT_FAILED] No sponsor_billing row found for subscription:', subscriptionId);
            console.warn('⚠️ [INVOICE.PAYMENT_FAILED] This invoice may be for a non-sponsor subscription (advertiser or other)');
          } else {
            const billing = checkResult.rows[0];
            if (billing.status === 'failed') {
              console.log('ℹ️ [INVOICE.PAYMENT_FAILED] Billing already marked as failed (idempotent - safe to ignore)');
              console.log('ℹ️ [INVOICE.PAYMENT_FAILED] Billing ID:', billing.id, 'Campaign ID:', billing.sponsor_campaign_id);
            } else {
              // This shouldn't happen if the UPDATE worked, but log it for visibility
              console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Billing found but status not updated');
              console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Current status:', billing.status);
              console.warn('⚠️ [INVOICE.PAYMENT_FAILED] Billing ID:', billing.id, 'Campaign ID:', billing.sponsor_campaign_id);
            }
          }
        }
      } catch (invoiceError) {
        console.error('❌ [INVOICE.PAYMENT_FAILED] Error processing invoice:', invoiceError.message);
        console.error('❌ [INVOICE.PAYMENT_FAILED] Error stack:', invoiceError.stack);
        // Don't throw - allow webhook to succeed (Stripe will retry if needed)
      }
      break;
    }

    case 'invoice.created': {
      // Reactive webhook - only logs invoice creation
      // Trial extension and campaign activation handled by Monday job
      const invoice = event.data.object;
      
      if (invoice.subscription && invoice.status === 'draft') {
        try {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const sponsorCampaignId = subscription.metadata?.sponsor_campaign_id;
          
          if (sponsorCampaignId) {
            console.log('📋 [INVOICE.CREATED] Draft invoice created for recurring sponsor');
            console.log('📋 [INVOICE.CREATED] Sponsor campaign ID:', sponsorCampaignId);
            console.log('📋 [INVOICE.CREATED] Invoice ID:', invoice.id);
            console.log('ℹ️ [INVOICE.CREATED] Trial extension handled by Monday activation job');
          }
        } catch (invoiceError) {
          console.error('❌ [INVOICE.CREATED] Error logging invoice:', invoiceError.message);
          // Don't throw - allow webhook to succeed
        }
      }
      break;
    }

    case 'invoice.updated':
    case 'invoice.finalized':
      // Ignore these events - we don't act on them, reduce log noise
      console.log(`⏭️ [WEBHOOK] Ignoring event type: ${event.type} (no action required)`);
      break;

    case 'invoice.payment_succeeded': {
      const invSucceeded = event.data.object;
      console.log('💳 [WEBHOOK] invoice.payment_succeeded received');
      console.log('💳 Invoice ID:', invSucceeded.id);
      try {
        const poolPs = getPool();
        if (poolPs) {
          await applyAdvertiserRecurringLedgerFromInvoicePaid(invSucceeded, poolPs, '[INVOICE.PAYMENT_SUCCEEDED]');
        }
      } catch (advLedgerErr) {
        console.error('❌ [INVOICE.PAYMENT_SUCCEEDED] Advertiser recurring ledger error:', advLedgerErr.message);
      }
      try {
        const poolNrPs = getPool();
        if (poolNrPs) {
          await applyAdvertiserNonRecurringLedgerFromInvoicePaid(invSucceeded, poolNrPs, '[INVOICE.PAYMENT_SUCCEEDED]');
        }
      } catch (nrAdvLedgerErr) {
        console.error('❌ [INVOICE.PAYMENT_SUCCEEDED] Advertiser non-recurring ledger error:', nrAdvLedgerErr.message);
      }
      break;
    }

    case 'charge.succeeded': {
      // Fallback: when invoice.paid has no subscription linkage, Charge always links to invoice/subscription
      const charge = event.data.object;
      if (charge.payment_method_details?.card) {
        const card = charge.payment_method_details.card;
        console.log('💳 [DEBUG] Charge used card:', {
          brand: card.brand,
          last4: card.last4,
          exp_month: card.exp_month,
          exp_year: card.exp_year
        });
      }
      try {
        const expandedCharge = await stripe.charges.retrieve(charge.id, {
          expand: ['invoice.subscription']
        });
        const rawSub = expandedCharge.invoice?.subscription;
        const subscriptionId = typeof rawSub === 'string' ? rawSub : rawSub?.id;
        if (!subscriptionId) {
          console.warn('⚠️ [CHARGE.SUCCEEDED] Could not extract subscription ID from charge.invoice (missing or not a subscription charge)');
          break;
        }
        const pool = getPool();
        if (!pool) {
          console.warn('⚠️ [CHARGE.SUCCEEDED] Database pool not available');
          break;
        }
        const updateResult = await pool.query(
          `UPDATE sponsor_billing
           SET status = 'paid'
           WHERE stripe_subscription_id = $1
             AND status IN ('trialing', 'open', 'failed')`,
          [subscriptionId]
        );
        if (updateResult.rowCount > 0) {
          console.log('✅ [CHARGE.SUCCEEDED] Marked recurring sponsor billing as paid');
          console.log('✅ [CHARGE.SUCCEEDED] Subscription ID:', subscriptionId);
          console.log('✅ [CHARGE.SUCCEEDED] Charge ID:', charge.id);

          // Restore campaign to active if it was paused due to payment failure
          const campaignRestore = await pool.query(
            `UPDATE sponsor_campaigns sc
             SET status = 'active', updated_at = NOW()
             FROM sponsor_billing sb
             WHERE sb.stripe_subscription_id = $1
               AND sc.id = sb.sponsor_campaign_id
               AND sc.status = 'payment_failed'
             RETURNING sc.id`,
            [subscriptionId]
          );
          if (campaignRestore.rowCount > 0) {
            console.log('✅ [CHARGE.SUCCEEDED] Restored sponsor_campaigns.status = active for campaign(s):', campaignRestore.rows.map(r => r.id));
          }
        } else {
          const checkResult = await pool.query(
            `SELECT id, status FROM sponsor_billing WHERE stripe_subscription_id = $1`,
            [subscriptionId]
          );
          if (checkResult.rows.length === 0) {
            console.log('ℹ️ [CHARGE.SUCCEEDED] No sponsor_billing row for subscription:', subscriptionId, '(non-sponsor charge)');
          } else if (checkResult.rows[0].status === 'paid') {
            console.log('ℹ️ [CHARGE.SUCCEEDED] Billing already marked as paid (idempotent)');
          } else {
            console.warn('⚠️ [CHARGE.SUCCEEDED] Billing status not in (trialing, open, failed), skipped. Current:', checkResult.rows[0].status);
          }
        }

        // Recurring sponsor donation insert (when invoice.paid lacks subscription ID, charge.succeeded has it)
        if (subscriptionId && expandedCharge.invoice) {
          try {
            const campaignLookup = await pool.query(
              `SELECT sc.id AS sponsor_campaign_id, sc.sponsor_account_id
               FROM sponsor_billing sb
               JOIN sponsor_campaigns sc ON sc.id = sb.sponsor_campaign_id
               WHERE sb.stripe_subscription_id = $1`,
              [subscriptionId]
            );
            if (campaignLookup.rows.length > 0) {
              const { sponsor_campaign_id, sponsor_account_id } = campaignLookup.rows[0];
              const invoiceId = typeof expandedCharge.invoice === 'string' ? expandedCharge.invoice : expandedCharge.invoice?.id;
              const amountCents = typeof expandedCharge.amount === 'number' ? expandedCharge.amount : parseInt(expandedCharge.amount, 10) || 0;
              if (invoiceId && amountCents >= 0) {
                await pool.query(
                  `INSERT INTO sponsor_donations (
                    sponsor_account_id,
                    sponsor_campaign_id,
                    stripe_invoice_id,
                    amount_cents,
                    source
                  )
                  VALUES ($1, $2, $3, $4, 'recurring_invoice')
                  ON CONFLICT (stripe_invoice_id)
                  WHERE stripe_invoice_id IS NOT NULL
                  DO NOTHING`,
                  [sponsor_account_id, sponsor_campaign_id, invoiceId, amountCents]
                );
                console.log('[SPONSOR DONATION DEBUG] recurring donation inserted via charge.succeeded');

                // donation_ledger + weekly_donation_pool + start_week (invoice.paid often lacks subscription; charge.succeeded has it)
                let periodStart = null;
                try {
                  const fullInvoice = await stripe.invoices.retrieve(invoiceId);
                  periodStart = fullInvoice.lines?.data?.[0]?.period?.start ?? null;
                } catch (invoiceErr) {
                  console.warn('[CHARGE.SUCCEEDED] Could not retrieve invoice for period_start:', invoiceErr.message);
                }

                if (periodStart) {
                  const periodStartSec = typeof periodStart === 'number' ? periodStart : parseInt(periodStart, 10);
                  const weekStart = getBillingWeekStart(new Date(periodStartSec * 1000));
                  const weekStartStr = weekStart.toISOString().slice(0, 10);
                  const amountDollars = amountCents / 100;

                  try {
                    const donRow = await pool.query(
                      `SELECT id FROM sponsor_donations WHERE stripe_invoice_id = $1`,
                      [invoiceId]
                    );
                    const donationId = donRow.rows[0]?.id;

                    if (donationId) {
                      const ledgerResult = await pool.query(
                        `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
                         VALUES ('sponsor', $1, $2, $3, $4::date)
                         ON CONFLICT (source_id, week_start) DO NOTHING
                         RETURNING id`,
                        [sponsor_campaign_id, String(donationId), amountDollars, weekStartStr]
                      );

                      if (ledgerResult.rows.length === 0) {
                        console.warn(`[CHARGE.SUCCEEDED] Donation ledger entry already exists for recurring sponsor campaign ${sponsor_campaign_id} week ${weekStartStr}, skipping.`);
                      } else {
                        await pool.query(
                          `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total)
                           VALUES ($1::date, $2, 0)
                           ON CONFLICT (week_start) DO UPDATE
                           SET sponsor_total = weekly_donation_pool.sponsor_total + $2,
                               updated_at = NOW()`,
                          [weekStartStr, amountDollars]
                        );
                        console.log(`[CHARGE.SUCCEEDED] Donation ledger and pool updated for recurring sponsor campaign ${sponsor_campaign_id} week ${weekStartStr}`);
                      }
                    }

                    await pool.query(
                      `UPDATE sponsor_campaigns
                       SET start_week = $1
                       WHERE id = $2
                       AND start_week IS NULL`,
                      [weekStartStr, sponsor_campaign_id]
                    );
                  } catch (ledgerErr) {
                    console.error('[CHARGE.SUCCEEDED] donation_ledger/weekly_donation_pool/start_week error:', ledgerErr.message);
                  }
                } else {
                  console.warn(`[CHARGE.SUCCEEDED] No period_start found for invoice ${invoiceId}, skipping donation ledger insert.`);
                }
              }
            }
          } catch (donationErr) {
            console.error('[SPONSOR DONATION DEBUG] recurring donation insert failed in charge.succeeded:', donationErr.message);
          }
        }
      } catch (chargeErr) {
        console.error('❌ [CHARGE.SUCCEEDED] Error:', chargeErr.message);
      }
      break;
    }

    default:
      console.log(`⚠️ ===== UNHANDLED EVENT TYPE =====`);
      console.log(`⚠️ Event type: ${event.type}`);
      console.log(`⚠️ Event ID: ${event.id}`);
      console.log(`⚠️ Event created: ${event.created}`);
      console.log(`⚠️ Event livemode: ${event.livemode}`);
      console.log(`⚠️ Event data object type: ${event.data?.object?.object}`);
      console.log(`⚠️ Event data object ID: ${event.data?.object?.id}`);
      break;
  }
};

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('ðŸŽ¯ ===== STRIPE WEBHOOK RECEIVED =====');
  console.log('ðŸŽ¯ Timestamp:', new Date().toISOString());
  console.log('🎉 Request URL:', req.url);
  console.log('🎉 Request path:', req.path);
  console.log('🎉 Request method:', req.method);
  console.log('ðŸŽ¯ Headers summary:', {
    hasStripeSignature: !!req.headers['stripe-signature'],
    userAgent: req.headers['user-agent'],
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
  });
  console.log('ðŸŽ¯ Raw body meta:', {
    isBuffer: Buffer.isBuffer(req.body),
    bodyType: typeof req.body,
    bodyLength: req.body ? req.body.length : 0,
  });

  try {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    console.log('ðŸŽ¯ Webhook verification:', {
      signaturePresent: !!sig,
      webhookSecretPresent: !!webhookSecret,
      webhookSecretLength: webhookSecret ? webhookSecret.length : 0,
      webhookSecretPrefix: webhookSecret ? webhookSecret.substring(0, 10) + '...' : 'MISSING',
      webhookSecretExpected: webhookSecret ? (webhookSecret.startsWith('whsec_') ? 'Stripe CLI format' : 'Dashboard format') : 'N/A'
    });

    if (!sig) {
      console.error('âŒ Missing Stripe signature header');
      return res.status(400).send('Missing Stripe signature');
    }

    if (!webhookSecret) {
      console.error('âŒ Missing STRIPE_WEBHOOK_SECRET environment variable');
      return res.status(500).send('Webhook secret not configured');
    }

    let event;
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const skipVerification = isDevelopment && process.env.SKIP_WEBHOOK_VERIFICATION === 'true';

    if (skipVerification) {
      console.warn('âš ï¸ DEVELOPMENT MODE: Skipping webhook signature verification');
      try {
        const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
        event = JSON.parse(bodyBuffer.toString('utf8'));
      } catch (parseError) {
        console.error('âŒ Failed to parse webhook body as JSON:', parseError.message);
        return res.status(400).send(`Webhook Error: ${parseError.message}`);
      }
    } else {
      let bodyBuffer;
      if (Buffer.isBuffer(req.body)) {
        bodyBuffer = req.body;
      } else if (typeof req.body === 'string') {
        bodyBuffer = Buffer.from(req.body, 'utf8');
      } else {
        console.error('âŒ Invalid body format for webhook signature verification');
        return res.status(400).send('Webhook Error: Invalid body format');
      }

      try {
        event = stripe.webhooks.constructEvent(bodyBuffer, sig, webhookSecret);
        console.log('âœ… Webhook signature verified successfully');
        console.log('âœ… Event type:', event.type);
        console.log('âœ… Event ID:', event.id);
        console.log('✅ Event created:', event.created);
        console.log('✅ Event livemode:', event.livemode);
        console.log('✅ Webhook secret used:', webhookSecret ? webhookSecret.substring(0, 10) + '...' : 'MISSING');
      } catch (err) {
        console.error('âŒ Webhook signature verification failed:', err.message);
        console.error('âŒ Verification error details:', {
          message: err.message,
          stack: err.stack
        });
        return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
      }
    }

    console.log('ðŸ”„ Processing event:', event.type);
    // ENVIRONMENT SAFETY GUARD: Ensure webhook event livemode matches Stripe API key environment
    // This prevents test events from being processed in production and vice versa
    const stripeApiKey = process.env.STRIPE_SECRET_KEY || '';
    const isTestApiKey = stripeApiKey.startsWith('sk_test_');
    const isLiveApiKey = stripeApiKey.startsWith('sk_live_');
    const eventIsLive = event.livemode === true;
    const eventIsTest = event.livemode === false;

    if (isLiveApiKey && eventIsTest) {
      console.warn('⚠️ [ENV-GUARD] Ignoring test mode webhook event in LIVE environment');
      console.warn('⚠️ [ENV-GUARD] Event type:', event.type);
      console.warn('⚠️ [ENV-GUARD] Event ID:', event.id);
      console.warn('⚠️ [ENV-GUARD] Event livemode:', event.livemode);
      console.warn('⚠️ [ENV-GUARD] API key mode: LIVE');
      return res.json({ 
        received: true, 
        ignored: true, 
        reason: 'Test mode event received in live environment' 
      });
    }

    if (isTestApiKey && eventIsLive) {
      console.warn('⚠️ [ENV-GUARD] Ignoring live mode webhook event in TEST environment');
      console.warn('⚠️ [ENV-GUARD] Event type:', event.type);
      console.warn('⚠️ [ENV-GUARD] Event ID:', event.id);
      console.warn('⚠️ [ENV-GUARD] Event livemode:', event.livemode);
      console.warn('⚠️ [ENV-GUARD] API key mode: TEST');
      return res.json({ 
        received: true, 
        ignored: true, 
        reason: 'Live mode event received in test environment' 
      });
    }

    if (!isTestApiKey && !isLiveApiKey) {
      console.warn('⚠️ [ENV-GUARD] Cannot determine API key environment (not sk_test_ or sk_live_), skipping livemode validation');
    } else {
      console.log('✅ [ENV-GUARD] Event livemode matches API key environment');
    }

    await processStripeEvent(event);

    res.json({ received: true });
  } catch (error) {
    if (error instanceof WebhookProcessingError) {
      console.error('âŒ Webhook processing error:', {
        message: error.message,
        statusCode: error.statusCode,
        details: error.details
      });
      return res.status(error.statusCode).send(error.message);
    }

    console.error('âŒ Webhook handler error:', error);
    res.status(500).send('Webhook handler error');
  }
});

app.post('/api/webhook/debug', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('ðŸ› DEBUG WEBHOOK - Testing with real Stripe-like data');
  console.log('ðŸ› Incoming debug body:', req.body ? req.body.toString() : 'NO BODY');

  const mockEvent = {
    type: 'checkout.session.completed',
    id: 'evt_debug_' + Date.now(),
    data: {
      object: {
        id: 'cs_test_debug_' + Date.now(),
        mode: 'payment',
        metadata: {
          donationType: 'direct_donation',
          donationId: '16',
          userId: '40',
          amount: '300'
        },
        customer_details: {
          email: 'test@example.com'
        },
        amount_total: 300,
        payment_intent: 'pi_debug_' + Date.now()
      }
    }
  };

  console.log('ðŸ› Mock event created:', JSON.stringify(mockEvent, null, 2));

  try {
    await processStripeEvent(mockEvent);
    res.json({ debug: true, mockEventProcessed: true });
  } catch (error) {
    if (error instanceof WebhookProcessingError) {
      console.error('ðŸ› Debug processing error:', {
        message: error.message,
        statusCode: error.statusCode,
        details: error.details
      });
      return res.status(error.statusCode).json({
        debug: true,
        mockEventProcessed: false,
        error: error.message,
        details: error.details
      });
    }

    console.error('ðŸ› Unexpected debug error:', error);
    res.status(500).json({ debug: true, mockEventProcessed: false, error: error.message });
  }
});
// Trust proxy for Railway deployment
app.set('trust proxy', 1);

// Session configuration - Enabled for production
app.use(session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' } // Secure cookies in production
}));

// Initialize Passport - Enabled for production
app.use(passport.initialize());
app.use(passport.session());

// Security middleware with relaxed CSP for development
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", // Allow inline scripts (needed for Tailwind config and auth check)
        "'unsafe-hashes'", // Allow inline event handlers
        "'unsafe-eval'", // Allow eval (needed for Vite/React in some cases)
        "blob:", // Allow blob URLs (Vite may use these)
        "https://vjs.zencdn.net", // Allow Video.js CDN
        "https://cdnjs.cloudflare.com", // Allow other CDNs if needed
        "https://js.stripe.com", // Allow Stripe.js
        "https://cdn.tailwindcss.com" // Allow Tailwind CDN (used by portal dashboard)
      ],
      scriptSrcAttr: ["'unsafe-inline'"], // Specifically allow onclick handlers
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", // Allow inline styles (needed for portal dashboard)
        "blob:", // Allow blob URLs for styles
        "https://vjs.zencdn.net", // Allow Video.js CSS
        "https://fonts.googleapis.com", // Allow Google Fonts
        "https://fonts.gstatic.com", // Allow Google Fonts
        "https://js.stripe.com", // Allow Stripe styles
        "https://cdn.tailwindcss.com" // Allow Tailwind CDN
      ],
      fontSrc: [
        "'self'",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "data:" // Allow data URLs for Video.js fonts
      ],
      mediaSrc: [
        "'self'", 
        "data:", 
        "blob:",
        "https://videos.stream.charity",
        "https://uploads.stream.charity",
        "https://sponsor-generated.stream.charity",
        "https://public.stream.charity",
        "https://*.r2.dev", // Fallback for local development
        "https://*.r2.cloudflarestorage.com" // Allow all R2 storage endpoints (for direct uploads)
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://videos.stream.charity",
        "https://uploads.stream.charity",
        "https://sponsor-generated.stream.charity",
        "https://public.stream.charity",
        "https://*.r2.dev", // Fallback for local development
        "https://*.r2.cloudflarestorage.com" // Allow all R2 storage endpoints
      ],
      connectSrc: [
        "'self'", // Allow API calls to same origin
        "blob:", // Allow blob URLs (Vite may use these)
        "https://api.stripe.com", // Allow Stripe API calls
        "https://videos.stream.charity",
        "https://uploads.stream.charity",
        "https://sponsor-generated.stream.charity",
        "https://public.stream.charity",
        "https://*.r2.dev", // Fallback for local development
        "https://*.r2.cloudflarestorage.com" // Allow direct uploads to Cloudflare R2 from advertiser portal (presigned PUT URLs)
      ],
      frameSrc: [
        "'self'",
        "https://js.stripe.com" // Allow Stripe frames
      ]
    }
  }
}));

// 🚫 GLOBAL RATE LIMITER REMOVED - Was causing cascade failures
// The global limiter (100 requests per 15 minutes per IP) was too restrictive
// and caused ALL users to get 429 errors when ANY user exceeded the limit.
// 
// Specific endpoint rate limiters (trackingRateLimit, videoRateLimit) 
// provide sufficient protection without breaking normal usage.

// REMOVED: app.use('/api/', limiter);

// CORS configuration - but skip for webhook endpoint (Stripe webhooks are server-to-server, no CORS needed)
app.use((req, res, next) => {
  // Log ALL incoming requests to /api/webhook for debugging
  if (req.path === '/api/webhook' || req.originalUrl === '/api/webhook') {
    console.log('🔔 ===== WEBHOOK REQUEST DETECTED IN MIDDLEWARE =====');
    console.log('🔔 Path:', req.path);
    console.log('🔔 Original URL:', req.originalUrl);
    console.log('🔔 Method:', req.method);
    console.log('🔔 Headers:', {
      'user-agent': req.headers['user-agent'],
      'stripe-signature': req.headers['stripe-signature'] ? 'PRESENT' : 'MISSING',
      'content-type': req.headers['content-type'],
      'origin': req.headers['origin'],
      'host': req.headers['host']
    });
    // Skip CORS for webhook endpoint (Stripe sends server-to-server requests)
    return next();
  }
  
  // Apply CORS for all other routes
  cors({
    origin: [
      'http://localhost:8081',    // Electron app
      'http://localhost:8082',    // Electron fallback
      'http://localhost:3001',    // Your existing ports
      'https://charitystream.vercel.app',  // Vercel production
      'https://charitystream.com',         // Custom domain (if configured)
      'https://www.charitystream.com',     // Custom domain www (if configured)
      'https://stream.charity'             // Production domain
    ],
    credentials: true
  })(req, res, next);
});

// Body parser for all other routes (webhook routes use express.raw at route-level)
// Increased limits to 50MB to support advertiser file uploads
app.use((req, res, next) => {
  if (
    req.path === '/api/webhook' ||
    req.originalUrl === '/api/webhook' ||
    req.path === '/api/webhook/test' ||
    req.originalUrl === '/api/webhook/test'
  ) {
    return next();
  }
  return bodyParser.json({ limit: '50mb' })(req, res, next);
});

// URL-encoded body parser with 50MB limit
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// TEMPORARY: Video proxy to bypass CORS issues while diagnosing R2
app.get('/proxy-video/:videoName', async (req, res) => {
  try {
    const { videoName } = req.params;
    const R2_URL = `${R2_VIDEOS_URL}/${videoName}`;
    
    console.log(`🎬 Proxying video: ${videoName} from R2 URL: ${R2_URL}`);
    
    const response = await fetch(R2_URL);
    
    if (!response.ok) {
      console.error(`❌ R2 returned status ${response.status} for ${videoName}`);
      return res.status(response.status).send(`Video not found: ${videoName}`);
    }
    
    console.log(`✅ Successfully fetched ${videoName} from R2 (status: ${response.status}), streaming to client`);
    
    // Get the video buffer
    const buffer = await response.arrayBuffer();
    const videoBuffer = Buffer.from(buffer);
    
    // Set proper headers for video streaming
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', videoBuffer.length);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Send the video
    res.send(videoBuffer);
    
  } catch (error) {
    console.error('❌ Video proxy error:', error.message);
    console.error('❌ Full error:', error);
    res.status(500).send(`Error loading video from R2: ${error.message}`);
  }
});

// Middleware to inject authentication context into HTML files
app.use((req, res, next) => {
  // Only process HTML files
  if (req.path.endsWith('.html')) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    // Store auth context for template processing
    req.authContext = {
      hasToken: !!token,
      token: token
    };
  }
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Serve actual static files for the portal (CSS, JS, assets)
app.use(
  '/portal',
  express.static(path.join(__dirname, '../portal/dist'))
);

// Explicit routes for HTML pages (SPA-style navigation)
// Serve the main app at root
app.get('/', (req, res) => {
  console.log('📄 Serving index.html (main app)');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Serve about.html at /about
app.get('/about', (req, res) => {
  console.log('📄 Serving about.html');
  res.sendFile(path.join(__dirname, '../public/about.html'));
});

// Serve advertise.html at /advertise
app.get('/advertise', (req, res) => {
  console.log('📄 Serving advertise.html');
  res.sendFile(path.join(__dirname, '../public/advertise.html'));
});

// ===== ADMIN UTILITY ROUTES =====

// ===== PASSWORD RESET + INITIAL PASSWORD SETUP PAGES =====
// These routes MUST be defined BEFORE the SPA fallback to ensure they are matched first
// Since we're using React Router, we serve index.html and let React Router handle the routing

app.get('/portal/request-password-reset', (req, res) => {
  console.log('📄 Serving /portal/request-password-reset (React Router will handle)');
  res.sendFile(path.join(__dirname, '../portal/dist/index.html'));
});

app.get('/portal/reset-password', (req, res) => {
  // Check if there's a token - if yes, serve static HTML page (for sponsor/advertiser password setup)
  // If no token, serve React SPA (for React Router navigation)
  if (req.query.token) {
    console.log('📄 Serving /portal/reset-password with token (static HTML)');
    res.sendFile(path.join(__dirname, '../public/reset-password.html'));
  } else {
    console.log('📄 Serving /portal/reset-password (React Router will handle)');
    res.sendFile(path.join(__dirname, '../portal/dist/index.html'));
  }
});

app.get('/portal/create-password', (req, res) => {
  console.log('📄 Serving /portal/create-password (React Router will handle)');
  res.sendFile(path.join(__dirname, '../portal/dist/index.html'));
});

// ===== SPA FALLBACK FOR /PORTAL ROUTES =====
// This MUST be LAST - it catches all other /portal/* routes that aren't matched above
app.get('/portal/*', (req, res) => {
  console.log('📄 SPA fallback: serving index.html for /portal route:', req.path);
  res.sendFile(path.join(__dirname, '../portal/dist/index.html'));
});

// Legacy route redirects for backward compatibility
app.get('/advertiser-portal', (req, res) => {
  console.log('📄 Redirecting /advertiser-portal to /portal');
  res.redirect('/portal');
});

app.get('/advertiser-portal/', (req, res) => {
  console.log('📄 Redirecting /advertiser-portal/ to /portal');
  res.redirect('/portal');
});

// Serve impact.html at /impact
app.get('/impact', (req, res) => {
  console.log('📄 Serving impact.html');
  res.sendFile(path.join(__dirname, '../public/impact.html'));
});

// Serve auth.html at /auth
app.get('/auth', (req, res) => {
  console.log('📄 Serving auth.html');
  res.sendFile(path.join(__dirname, '../public/auth.html'));
});

// Explicit route for auth.html (as backup - with .html extension)
app.get('/auth.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/auth.html'));
});

// Serve advertiser.html at /advertiser
app.get('/advertiser', (req, res) => {
  console.log('📄 Serving advertiser.html');
  res.sendFile(path.join(__dirname, '../public/advertiser.html'));
});

// Serve portal.html at /portal.html
app.get('/portal.html', (req, res) => {
  console.log('📄 Serving portal.html');
  res.sendFile(path.join(__dirname, '../public/portal.html'));
});

// Serve sponsor-login.html at /sponsor-login.html
app.get('/sponsor-login.html', (req, res) => {
  console.log('📄 Serving sponsor-login.html');
  res.sendFile(path.join(__dirname, '../public/sponsor-login.html'));
});

// Serve sponsor-portal.html at /sponsor-portal.html
app.get('/sponsor-portal.html', (req, res) => {
  console.log('📄 Serving sponsor-portal.html');
  res.sendFile(path.join(__dirname, '../public/sponsor-portal.html'));
});

// Serve charity.html at /charity
app.get('/charity', (req, res) => {
  console.log('📄 Serving charity.html');
  res.sendFile(path.join(__dirname, '../public/charity.html'));
});

// Serve subscribe.html at /subscribe
app.get('/subscribe', (req, res) => {
  console.log('📄 Serving subscribe.html');
  res.sendFile(path.join(__dirname, '../public/subscribe.html'));
});

// Authentication middleware for website user accounts
// CRITICAL: This middleware is for website routes only, NOT portal routes
// Portal routes use authenticateAdvertiserPortal which explicitly rejects website tokens
const authenticateToken = (req, res, next) => {
  // CRITICAL: Reject website tokens on portal routes
  if (req.path.startsWith('/api/advertiser/') || req.path.startsWith('/portal')) {
    console.log(`🚫 [AUTH] Website token middleware blocked on portal route: ${req.path}`);
    return res.status(403).json({ error: 'Portal routes require advertiser portal authentication' });
  }
  
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  console.log(`🔐 Auth check for ${req.path}:`, {
    hasAuthHeader: !!authHeader,
    hasToken: !!token,
    tokenPrefix: token ? token.substring(0, 10) + '...' : 'none',
    authHeaderValue: authHeader ? authHeader.substring(0, 20) + '...' : 'none'
  });

  if (!token) {
    console.log(`❌ No token for ${req.path}`);
    return res.status(401).json({ error: 'Access token required' });
  }

  console.log(`🔍 JWT_SECRET available:`, !!JWT_SECRET);
  console.log(`🔍 JWT_SECRET length:`, JWT_SECRET ? JWT_SECRET.length : 0);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log(`❌ Invalid token for ${req.path}:`, err.message);
      console.log(`❌ JWT Error details:`, {
        name: err.name,
        message: err.message,
        expiredAt: err.expiredAt
      });
      
      // 🚨 CRITICAL DEBUG: Check system time vs token expiration
      const now = new Date();
      const systemTime = now.toISOString();
      console.log(`🕐 SYSTEM TIME DEBUG:`, {
        currentTime: systemTime,
        currentTimestamp: now.getTime(),
        tokenExpiredAt: err.expiredAt,
        timeDifference: err.expiredAt ? (now.getTime() - new Date(err.expiredAt).getTime()) : 'N/A',
        isExpiredInPast: err.expiredAt ? (now.getTime() > new Date(err.expiredAt).getTime()) : 'N/A'
      });
      
      return res.status(403).json({ error: 'Invalid token' });
    }
    
    // CRITICAL: Reject advertiser portal tokens on website routes
    if (user.jwt_type === 'advertiser_portal') {
      console.log(`🚫 [AUTH] Advertiser portal token rejected on website route: ${req.path}`);
      return res.status(403).json({ error: 'Website routes require website user authentication' });
    }
    
    // 🔐 CRITICAL: Add debugging for authentication token
    console.log('🔐 Authentication - decoded token user:', {
      userId: user.userId,
      email: user.email,
      username: user.username,
      // Add any other relevant fields
    });
    
    console.log(`✅ Valid token for ${req.path}, user:`, user.userId);
    req.user = user;
    
    // Track the request after authentication
    requestTracker.track(req.path, user.userId, req.method);
    next();
  });
};

// Middleware for tracking requests without authentication
const trackRequest = (req, res, next) => {
  const userId = req.user?.userId || 'anonymous';
  requestTracker.track(req.path, userId, req.method);
  next();
};

// Token refresh endpoint for expired tokens
app.post('/api/auth/refresh-token', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    
    // Try to decode the expired token (without verification)
    let decoded;
    try {
      decoded = jwt.decode(token);
    } catch (decodeErr) {
      console.error('❌ Failed to decode token:', decodeErr);
      return res.status(400).json({ error: 'Invalid token format' });
    }
    
    if (!decoded || !decoded.userId) {
      return res.status(400).json({ error: 'Invalid token payload' });
    }
    
    // Check if token is actually expired
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp > now) {
      // Token is not expired, return it as-is
      return res.json({ 
        message: 'Token is still valid',
        token: token,
        refreshed: false
      });
    }
    
    // Token is expired, get user from database
    const [err, user] = await dbHelpers.getUserById(decoded.userId);
    if (err || !user) {
      console.error('❌ User not found for token refresh:', err);
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Generate new token
    const newToken = generateJWTToken(
      { userId: user.id, username: user.username, email: user.email },
      '7d'
    );
    
    console.log(`✅ Token refreshed for user: ${user.username}`);
    
    res.json({
      message: 'Token refreshed successfully',
      token: newToken,
      refreshed: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.is_premium ? 'premium' : 'free'
      }
    });

  } catch (error) {
    console.error('❌ Token refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Debug endpoint to test JWT token generation
app.get('/api/debug/test-jwt-generation', async (req, res) => {
  try {
    console.log('🧪 Testing JWT token generation...');
    
    const testPayload = { 
      userId: 999, 
      username: 'testuser', 
      email: 'test@example.com' 
    };
    
    const token = generateJWTToken(testPayload, '7d');
    
    // Verify the token
    const decoded = jwt.decode(token);
    const now = Math.floor(Date.now() / 1000);
    
    res.json({
      message: 'JWT token generation test completed',
      token: token,
      decoded: decoded,
      currentTime: new Date().toISOString(),
      tokenExpiry: new Date(decoded.exp * 1000).toISOString(),
      timeDifference: (decoded.exp * 1000) - Date.now(),
      isValidExpiration: decoded.exp > now,
      testPayload: testPayload
    });
    
  } catch (error) {
    console.error('❌ JWT generation test failed:', error);
    res.status(500).json({ 
      error: 'JWT generation test failed',
      details: error.message 
    });
  }
});

// ===== USER AUTHENTICATION ROUTES =====

// Register new user
app.post('/api/auth/register', async (req, res) => {
  try {
    console.log('📝 Registration attempt:', { email: req.body.email });
    const { email, password, confirmPassword } = req.body;

    // Basic validation
    if (!email || !password || !confirmPassword) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ error: 'Email, password, and password confirmation are required' });
    }

    if (password !== confirmPassword) {
      console.log('❌ Passwords do not match');
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 6) {
      console.log('❌ Password too short');
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    console.log('🔍 Checking if user exists...');
    const [err, existingUser] = await dbHelpers.getUserByEmail(email);
    if (err) {
      console.error('❌ Database error during registration:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (existingUser) {
      console.log('❌ User already exists');
      return res.status(409).json({ error: 'Email already exists' });
    }

    // Hash password
    console.log('🔐 Hashing password...');
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Generate verification token package
    console.log('🔐 Generating verification token...');
    let tokenPackage;
    
    if (!tokenService) {
      console.log('⚠️ Using fallback token generation');
      const token = generateFallbackToken();
      const expiresAt = getTokenExpiry();
      tokenPackage = {
        token: token,
        hashedToken: token, // Store plain token for now (less secure but functional)
        expiresAt: expiresAt
      };
    } else {
      tokenPackage = await tokenService.generateVerificationPackage();
    }

    // Create user with verification token (no username yet - will be set later)
    console.log('👤 Creating user...');
    const userData = { 
      email, 
      password_hash, 
      auth_provider: 'email',
      verification_token: tokenPackage.hashedToken,
      token_expires_at: tokenPackage.expiresAt
    };
    const [createErr, newUserId] = await dbHelpers.createUserWithVerification(userData);
    if (createErr) {
      console.error('❌ Registration error:', createErr);
      return res.status(500).json({ error: 'Failed to create user' });
    }

    // Send verification email
    console.log('📧 Sending verification email...');
    const emailResult = await emailService.sendVerificationEmail(email, null, tokenPackage.token);
    if (!emailResult.success) {
      console.error('❌ Failed to send verification email:', emailResult.error);
      // Don't fail registration if email fails, but log it
    }

    console.log(`✅ New user registered: ${email}`);
    res.status(201).json({
      message: 'User created successfully. Please check your email to verify your account.',
      requiresVerification: true,
      user: {
        id: newUserId,
        email: email,
        verified: false
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  try {
    console.log('🔑 Login attempt:', { login: req.body.login });
    const { login, password, rememberMe } = req.body; // login can be username or email

    if (!login || !password) {
      console.log('❌ Missing login credentials');
      return res.status(400).json({ error: 'Username/email and password are required' });
    }

    // Find user
    console.log('🔍 Looking up user...');
    const [err, user] = await dbHelpers.getUserByLogin(login);
    if (err) {
      console.error('❌ Database error during login:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.log('❌ User not found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if email is verified (skip for Google users)
    if (!user.verified && user.auth_provider !== 'google' && user.auth_provider !== 'email_google') {
      console.log('❌ Email not verified');
      return res.status(401).json({ 
        error: 'Please verify your email before logging in. Check your inbox for a verification link.',
        requiresVerification: true,
        email: user.email
      });
    }

    // Check if user has a password (Google users might not have one)
    console.log('🔐 Checking password...');
    console.log('🔍 Password hash type:', typeof user.password_hash);
    console.log('🔍 Password hash value:', user.password_hash);
    console.log('🔍 Auth provider:', user.auth_provider);
    
    if (!user.password_hash || typeof user.password_hash !== 'string') {
      // User doesn't have a password - check if they're a Google user
      if (user.auth_provider === 'google' || user.auth_provider === 'email_google') {
        console.log('🔑 Google user without password - redirecting to password setup');
        return res.status(401).json({ 
          error: 'Please set up a password for your account to enable manual login.',
          requiresPasswordSetup: true,
          email: user.email,
          username: user.username
        });
      } else {
        console.log('❌ Invalid password hash in database');
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      console.log('❌ Password mismatch');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login time
    const [updateErr] = await dbHelpers.updateLastLogin(user.id);
    if (updateErr) {
      console.error('Error updating last login:', updateErr);
    }

    // Generate JWT token with extended expiry for remember me
    const tokenExpiry = rememberMe ? '30d' : '7d'; // 30 days if remember me, 7 days otherwise
    console.log(`🔑 Generating JWT token for user ${user.id} with secret length:`, JWT_SECRET ? JWT_SECRET.length : 0);
    
    // Use robust token generation function
    const token = generateJWTToken(
      { userId: user.id, username: user.username },
      tokenExpiry
    );

    console.log(`✅ User logged in: ${user.username}`);
    res.json({
      message: 'Login successful',
      token: token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.is_premium ? 'premium' : 'free'
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    console.log('👤 Getting user info for ID:', req.user.userId);
    const [err, user] = await dbHelpers.getUserById(req.user.userId);
    if (err || !user) {
      console.log('❌ User not found:', err);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('👤 User data from DB:', { id: user.id, username: user.username, email: user.email });
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.is_premium ? 'premium' : 'free',
        profilePicture: user.profile_picture,
        emailVerified: user.email_verified,
        authProvider: user.auth_provider,
        isPremium: user.is_premium || false,
        premiumSince: user.premium_since,
        stripeSubscriptionId: user.stripe_subscription_id,
        subscriptionCancelAt: user.subscription_cancel_at || null
      }
    });
  } catch (error) {
    console.error('Error fetching user info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update username for Google OAuth users
app.post('/api/auth/update-username', authenticateToken, async (req, res) => {
  try {
    const { username } = req.body;
    const userId = req.user.userId;

    if (!username || username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long' });
    }

    // Check if username is already taken
    const [err, existingUser] = await dbHelpers.getUserByLogin(username);
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (existingUser && existingUser.id !== userId) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Update username
    const [updateErr, updatedUser] = await dbHelpers.updateUsername(userId, username);
    if (updateErr) {
      console.error('Error updating username:', updateErr);
      return res.status(500).json({ error: 'Failed to update username' });
    }

    console.log(`✅ Username updated for user ${userId}: ${username}`);

    // Send welcome email after username is set
    if (emailService && emailService.isEmailConfigured()) {
      console.log('📧 Sending welcome email...');
      const emailResult = await emailService.sendWelcomeEmail(updatedUser.email, username);
      if (emailResult.success) {
        console.log('✅ Welcome email sent successfully');
      } else {
        console.error('❌ Failed to send welcome email:', emailResult.error);
        // Don't fail the username update if email fails
      }
    } else {
      console.log('⚠️ Email service not configured, skipping welcome email');
    }

    res.json({ message: 'Username updated successfully', username: username });
  } catch (error) {
    console.error('Update username error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel incomplete Google registration
app.post('/api/auth/cancel-google-registration', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    console.log(`🗑️ Cancelling incomplete Google registration for user: ${userId}`);
    
    // Delete the incomplete Google user
    const [err, deletedUser] = await dbHelpers.deleteIncompleteGoogleUser(userId);
    if (err) {
      console.error('❌ Error deleting incomplete Google user:', err);
      return res.status(500).json({ error: 'Failed to cancel registration' });
    }
    
    console.log(`✅ Successfully cancelled Google registration for: ${deletedUser.email}`);
    res.json({ 
      message: 'Registration cancelled successfully',
      email: deletedUser.email 
    });
  } catch (error) {
    console.error('❌ Cancel Google registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set up password for Google users
app.post('/api/auth/setup-password', async (req, res) => {
  try {
    const { email, password, confirmPassword } = req.body;

    // Basic validation
    if (!email || !password || !confirmPassword) {
      return res.status(400).json({ error: 'Email, password, and password confirmation are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Find user by email
    const [err, user] = await dbHelpers.getUserByEmail(email);
    if (err) {
      console.error('❌ Database error during password setup:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user is a Google user
    if (user.auth_provider !== 'google' && user.auth_provider !== 'email_google') {
      return res.status(400).json({ error: 'This account is not eligible for password setup' });
    }

    // Check if user already has a password
    if (user.password_hash) {
      return res.status(400).json({ error: 'Password already set for this account' });
    }

    // Hash password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Update user with password
    const [updateErr, updatedUser] = await dbHelpers.setupPassword(user.id, password_hash);
    if (updateErr) {
      console.error('❌ Error setting up password:', updateErr);
      return res.status(500).json({ error: 'Failed to set up password' });
    }

    console.log(`✅ Password set up for Google user: ${user.email}`);

    // Generate JWT token for immediate login using robust function
    const token = generateJWTToken(
      { userId: user.id, username: user.username },
      '7d'
    );

    res.json({
      message: 'Password set up successfully! You are now logged in.',
      token: token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.is_premium ? 'premium' : 'free'
      }
    });

  } catch (error) {
    console.error('Setup password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== GOOGLE OAUTH ROUTES =====
// Enabled for production

// Redirect /auth to the actual Google OAuth endpoint
app.get('/auth', (req, res) => {
  console.log('🔐 /auth route hit, redirecting to Google OAuth');
  const queryString = new URLSearchParams(req.query).toString();
  const redirectUrl = queryString ? `/api/auth/google?${queryString}` : '/api/auth/google';
  res.redirect(redirectUrl);
});

// Google OAuth login
app.get('/api/auth/google', (req, res, next) => {
  const mode = req.query.mode || 'signin'; // Default to signin
  const { redirect_uri, app_type, source } = req.query;
  
  console.log('🔐 Google OAuth requested with mode:', mode);
  console.log('📱 App type:', app_type, 'Source:', source);
  console.log('Environment check:');
  console.log('- GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'Set' : 'Missing');
  console.log('- GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? 'Set' : 'Missing');
  console.log('- GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL || 'Using default');
  console.log('- Request URL:', req.url);
  console.log('- Request headers:', req.headers);

  // Check if this is from the Electron app
  if (app_type === 'electron' && source === 'desktop_app') {
    console.log('📱 Desktop app OAuth detected');
    
    // Validate required environment variables
    if (!process.env.GOOGLE_CLIENT_ID) {
      console.error('❌ GOOGLE_CLIENT_ID environment variable is missing!');
      return res.status(500).json({ 
        error: 'Server configuration error: Google OAuth not properly configured',
        details: 'GOOGLE_CLIENT_ID environment variable is required'
      });
    }
    
    console.log('🔍 Google OAuth Configuration Check:');
    console.log('  - Client ID:', process.env.GOOGLE_CLIENT_ID);
    console.log('  - Make sure these redirect URIs are registered in Google Cloud Console:');
    console.log('    http://localhost:3001/auth/google/callback (local dev)');
    console.log('    http://localhost:8081/auth/google/callback (Electron app)');
    console.log('    https://charitystream.vercel.app/auth/google/callback (production)');
    
    // Debug: Log all input parameters
    console.log('🔍 Debug - Input parameters:');
    console.log('  - redirect_uri:', redirect_uri);
    console.log('  - mode:', mode);
    console.log('  - app_type:', app_type);
    console.log('  - source:', source);
    console.log('  - GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'Set' : 'Missing');
    
    // Prepare redirect URI with fallback and validation
    // IMPORTANT: Google OAuth redirect_uri must ALWAYS be the backend URL, not the desktop app URL
    const isProduction = process.env.NODE_ENV === 'production';
    const backendRedirectUri = isProduction 
      ? 'https://charitystream.vercel.app/auth/google/callback'
      : 'http://localhost:3001/auth/google/callback';
    
    // For Google OAuth, we ALWAYS use the backend URL
    const finalRedirectUri = backendRedirectUri;
    
    // Store the desktop app URL in state for later use
    const desktopAppCallbackUrl = redirect_uri || 'http://localhost:8081/auth/google/callback';
    
    // Prepare state object
    const stateObject = { 
      app_type: 'electron', 
      source: 'desktop_app',
      mode: mode,
      redirect_uri: desktopAppCallbackUrl  // Store desktop app URL in state for final redirect
    };
    const encodedState = encodeURIComponent(JSON.stringify(stateObject));
    
    // Validate redirect URI format
    try {
      new URL(finalRedirectUri);
    } catch (error) {
      console.error('❌ Invalid redirect_uri format:', finalRedirectUri);
      return res.status(400).json({ 
        error: 'Invalid redirect_uri format' 
      });
    }
    
    // Debug: Log individual URL components
    console.log('🔍 Debug - URL Components:');
    console.log('  - client_id:', process.env.GOOGLE_CLIENT_ID);
    console.log('  - google_redirect_uri (backend):', finalRedirectUri);
    console.log('  - desktop_app_callback:', desktopAppCallbackUrl);
    console.log('  - encoded_redirect_uri:', encodeURIComponent(finalRedirectUri));
    console.log('  - response_type: code');
    console.log('  - scope: email profile openid');
    console.log('  - state_object:', JSON.stringify(stateObject));
    console.log('  - encoded_state:', encodedState);
    
    // For desktop app, redirect to Google OAuth with the app's callback URL
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(finalRedirectUri)}&` +
      `response_type=code&` +
      `scope=openid%20email%20profile&` +
      `access_type=offline&` +
      `prompt=consent&` +
      `state=${encodedState}`;
    
    console.log('🔍 Debug - Final Google OAuth URL:');
    console.log(googleAuthUrl);
    
    // Verify all required parameters are present
    const requiredParams = ['client_id', 'redirect_uri', 'response_type', 'scope', 'access_type', 'prompt', 'state'];
    const urlParams = new URLSearchParams(googleAuthUrl.split('?')[1]);
    console.log('🔍 Debug - Parameter verification:');
    requiredParams.forEach(param => {
      const value = urlParams.get(param);
      console.log(`  - ${param}: ${value ? '✅ Present' : '❌ Missing'} (${value || 'undefined'})`);
    });
    
    console.log('🔗 Redirecting to Google OAuth for desktop app');
    console.log('🔍 Final redirect URL length:', googleAuthUrl.length);
    console.log('🔍 URL preview (first 200 chars):', googleAuthUrl.substring(0, 200) + '...');
    
    // Additional validation before redirect
    if (googleAuthUrl.length > 2048) {
      console.error('❌ URL too long for redirect (', googleAuthUrl.length, 'chars)');
      return res.status(400).json({ error: 'OAuth URL too long' });
    }
    
    return res.redirect(googleAuthUrl);
  } else {
    console.log('🌐 Web OAuth flow');
  // Store the mode in session for the callback
  req.session.googleAuthMode = mode;

  passport.authenticate('google', {
    scope: ['profile', 'email', 'openid'],
    prompt: 'select_account' // Always show account chooser
  })(req, res, next);
  }
});

// Electron OAuth callback handler (separate from web OAuth)
// In-memory cache to prevent duplicate code processing
const processedCodes = new Set();

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    console.log('📱 Desktop app OAuth callback received');
    
    // Check if we've already processed this code
    if (code && processedCodes.has(code)) {
      console.log('⚠️ Authorization code already processed, ignoring duplicate request');
      return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('Code already processed')}`);
    }
    
    // Determine redirect URI based on environment and query params
    const isProduction = process.env.NODE_ENV === 'production';
    const defaultRedirectUri = isProduction 
      ? 'https://charitystream.vercel.app/auth/google/callback'
      : 'http://localhost:8081/auth/google/callback';
    
    // Extract redirect_uri from state parameter (stored during OAuth initiation)
    let finalRedirectUri = defaultRedirectUri;
    let stateData = {};
    if (state) {
      try {
        stateData = JSON.parse(decodeURIComponent(state));
        if (stateData.redirect_uri) {
          finalRedirectUri = stateData.redirect_uri;
          console.log('🔍 Using redirect_uri from state:', finalRedirectUri);
        }
      } catch (error) {
        console.log('⚠️ Could not parse state for redirect_uri, using default:', defaultRedirectUri);
      }
    }
    
    if (!code) {
      console.log('📱 OAuth callback without authorization code');
      console.log('🔍 Callback query params:', req.query);
      
      // Check if this is an OAuth error from Google
      if (req.query.error) {
        console.log('🔍 Google OAuth error:', req.query.error);
        return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent(req.query.error)}`);
      }
      
      // Check if this is a success response (token and user data present)
      if (req.query.token && req.query.user) {
        console.log('✅ OAuth success response received - desktop app callback');
        console.log('👤 User authenticated:', JSON.parse(decodeURIComponent(req.query.user)).email);
        console.log('🔑 Token present:', !!req.query.token);
        
        // Desktop app handles the callback through React routing
        // No HTML response needed - let the desktop app handle the redirect
        return res.status(200).send('Authentication successful - redirecting...');
      }
      
      // If no code, no error, and no success data, this might be a duplicate request
      console.log('⚠️ No authorization code, no error, no success data - possibly duplicate request');
      return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('No authorization code received')}`);
    }
    
    // State data already parsed above for redirect_uri extraction
    console.log('📊 State data:', stateData);
    
    if (stateData.app_type === 'electron') {
      console.log('📱 Processing desktop app OAuth callback');
      
      // Exchange code for token with Google
      console.log('🔄 Exchanging code for token with Google...');
      console.log('🔍 Token exchange parameters:');
      console.log('  - client_id:', process.env.GOOGLE_CLIENT_ID);
      console.log('  - redirect_uri:', finalRedirectUri);
      console.log('  - code present:', !!code);
      
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: finalRedirectUri
        })
      });
      
      console.log('📡 Token response status:', tokenResponse.status);
      
      const tokenData = await tokenResponse.json();
      
      if (!tokenData.access_token) {
        console.error('❌ No access token received from Google');
        console.error('❌ Token response:', tokenData);
        return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('Failed to get access token')}`);
      }
      
      // Get user info from Google
      const userResponse = await fetch(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokenData.access_token}`);
      const googleUser = await userResponse.json();
      
      console.log('👤 Google user data:', { email: googleUser.email, name: googleUser.name });
      
      // Find or create user in your database using existing helper
      const [err, user] = await dbHelpers.getUserByEmail(googleUser.email);
      
      if (err) {
        console.error('❌ Database error:', err);
        return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('Database error')}`);
      }
      
      if (!user) {
        console.error('❌ User not found in database:', googleUser.email);
        return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('User not found. Please create an account first.')}`);
      }
      
      // Update last login
      await dbHelpers.updateLastLogin(user.id);
      
      // Generate JWT token using robust function
      const token = generateJWTToken(
        { userId: user.id, username: user.username, email: user.email },
        '30d'
      );
      
      console.log(`✅ Desktop app OAuth successful for: ${user.email}`);
      
      // Mark code as processed
      if (code) {
        processedCodes.add(code);
        // Clean up old codes after 10 minutes
        setTimeout(() => processedCodes.delete(code), 10 * 60 * 1000);
      }

      // For desktop app (electron) - ALWAYS redirect to desktop app, not backend
      if (stateData.app_type === 'electron') {
        const desktopAppRedirectUri = 'http://localhost:8081/auth/google/callback'; // Desktop app React server
        console.log('✅ Electron app detected - redirecting to desktop app:', desktopAppRedirectUri);
        
        // Build user data object
        const userDataForClient = {
          id: user.id,
          username: user.username,
          email: user.email,
          isPremium: user.is_premium || false,
          totalMinutesWatched: user.total_minutes_watched,
          currentMonthMinutes: user.current_month_minutes,
          subscriptionTier: user.is_premium ? 'premium' : 'free',
          profilePicture: user.profile_picture,
          emailVerified: user.email_verified,
          authProvider: user.auth_provider,
          premiumSince: user.premium_since,
          stripeSubscriptionId: user.stripe_subscription_id
        };

        const redirectUrl = `${desktopAppRedirectUri}?` +
          `token=${encodeURIComponent(token)}&` +
          `user=${encodeURIComponent(JSON.stringify(userDataForClient))}`;

        console.log('🔗 Redirecting to desktop app:', redirectUrl);
        return res.redirect(redirectUrl);
      }
      
      // For non-electron apps, use state redirect_uri
      let desktopAppRedirectUri = 'http://localhost:8081/auth/google/callback'; // Default fallback
      if (stateData && stateData.redirect_uri) {
        desktopAppRedirectUri = stateData.redirect_uri;
        console.log('✅ Using callback URL from state:', desktopAppRedirectUri);
      } else {
        console.log('⚠️ No redirect_uri in state, using default:', desktopAppRedirectUri);
      }

      // For non-electron apps, build user data and redirect
      const userDataForClient = {
        id: user.id,
        username: user.username,
        email: user.email,
        isPremium: user.is_premium || false,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.is_premium ? 'premium' : 'free',
        profilePicture: user.profile_picture,
        emailVerified: user.email_verified,
        authProvider: user.auth_provider,
        premiumSince: user.premium_since,
        stripeSubscriptionId: user.stripe_subscription_id
      };

      // Redirect back to app with token and user data
      const redirectUrl = `${desktopAppRedirectUri}?` +
        `token=${encodeURIComponent(token)}&` +
        `user=${encodeURIComponent(JSON.stringify(userDataForClient))}`;

      console.log('🔗 Redirecting to app:', redirectUrl.substring(0, 100) + '...');
      console.log('👤 User premium status:', userDataForClient.isPremium);

      return res.redirect(redirectUrl);
    } else {
      console.log('🌐 Web OAuth callback, redirecting to web flow');
      // Fall through to the regular web OAuth flow
      return res.redirect('/api/auth/google/callback?' + new URLSearchParams(req.query).toString());
    }
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    console.error('Error stack:', error.stack);
    
    // Extract redirect URI safely
    let errorRedirectUri = 'http://localhost:8081/auth/google/callback';
    if (req.query.state) {
      try {
        const stateData = JSON.parse(decodeURIComponent(req.query.state));
        if (stateData.redirect_uri) {
          errorRedirectUri = stateData.redirect_uri;
        }
      } catch (parseError) {
        console.error('❌ Could not parse state for error redirect');
      }
    }
    
    const errorMessage = error.message || 'Authentication failed';
    res.redirect(`${errorRedirectUri}?error=${encodeURIComponent(errorMessage)}`);
  }
});

// Google OAuth callback (for web)
app.get('/api/auth/google/callback', 
  passport.authenticate('google', { 
    failureRedirect: `${process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? 'https://charitystream.vercel.app' : 'http://localhost:3001')}/auth.html?error=oauth_failed`,
    session: false // We'll use JWT instead of sessions
  }),
  async (req, res) => {
    try {
      console.log('🔄 Google OAuth callback received');
      console.log('User object:', req.user ? 'Present' : 'Missing');
      
      if (!req.user) {
        console.error('❌ No user object in request');
        return res.redirect('/auth.html?error=no_user');
      }

      const user = req.user;
      console.log('👤 User details:', {
        id: user.id,
        email: user.email,
        username: user.username,
        googleId: user.google_id,
        verified: user.verified,
        auth_provider: user.auth_provider
      });
      
      // Google OAuth callback - NO verification emails should be sent
      // All users coming through this callback are Google users and already verified by Google
      console.log('✅ Google OAuth callback - skipping email verification for:', user.email);

      // Generate JWT token using robust function
      console.log('🔑 Generating JWT token for user:', user.id);
      
      const token = generateJWTToken(
        { userId: user.id, username: user.username, email: user.email },
        '7d'
      );

      // Update last login
      try {
        await dbHelpers.updateLastLogin(user.id);
      } catch (err) {
        console.error('Error updating last login:', err);
      }

      console.log(`✅ Google OAuth login successful: ${user.email}`);
      console.log('🔗 Redirecting to auth.html with token');
      
      // Check if this was a signup attempt (from state parameter)
      const authMode = req.query.state || 'signin';
      console.log('🔍 Auth mode:', authMode);
      
      // For passwordless Google auth, always check if username needs setup
      const emailPrefix = user.email.split('@')[0];
      const needsUsernameSetup = user.username === emailPrefix;
      
      console.log('📝 Needs username setup:', needsUsernameSetup);
      console.log('👤 User auth provider:', user.auth_provider || 'google');
      
      // Redirect to frontend with token and setup flag
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      res.redirect(`${frontendUrl}/auth.html?token=${token}&email_verified=${user.verified}&setup_username=${needsUsernameSetup}&auth_provider=google`);
    } catch (error) {
      console.error('❌ Google OAuth callback error:', error);
      console.error('Error stack:', error.stack);
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      res.redirect(`${frontendUrl}/auth.html?error=oauth_callback_failed`);
    }
  }
);

// Email verification endpoint
app.get('/api/auth/verify-email/:token', async (req, res) => {
  try {
    const token = req.params.token;
    console.log('📧 Email verification attempt for token:', token.substring(0, 10) + '...');
    
    // Validate token format
    if (!tokenService) {
      console.log('⚠️ Using fallback token validation');
      // Basic format check for fallback tokens
      if (!token || typeof token !== 'string' || token.length !== 64) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    } else {
      if (!tokenService.isValidTokenFormat(token)) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    }

    // Find user by verification token (database handles expiry check)
    const [err, user] = await dbHelpers.getUserByVerificationToken(token);
    if (err) {
      console.error('❌ Database error during email verification:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.log('❌ Invalid or expired verification token');
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    console.log('✅ Token verified successfully for user:', user.email);

    // Update user as verified and clear token
    const [updateErr] = await dbHelpers.verifyUserEmail(user.id);
    if (updateErr) {
      console.error('❌ Error updating user verification status:', updateErr);
      return res.status(500).json({ error: 'Failed to verify email' });
    }

    console.log(`✅ Email verified for user: ${user.email}`);

    // Generate JWT token for immediate login using robust function
    const jwtToken = generateJWTToken(
      { userId: user.id, username: user.username },
      '7d'
    );

    // Check if user needs to set username (manual signup users)
    const emailPrefix = user.email.split('@')[0];
    const needsUsernameSetup = !user.username || user.username === emailPrefix;
    
    res.json({
      message: 'Email verified successfully!',
      token: jwtToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        verified: true,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.is_premium ? 'premium' : 'free'
      },
      needsUsernameSetup: needsUsernameSetup
    });
  } catch (error) {
    console.error('❌ Email verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resend verification email endpoint (with rate limiting)
const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Maximum 3 requests per hour per IP
  message: { error: 'Too many verification email requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Forgot password rate limiting
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Maximum 5 requests per hour per IP
  message: { error: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/auth/resend-verification', resendVerificationLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('📧 Resend verification request for:', email);

    // Find user by email
    const [err, user] = await dbHelpers.getUserByEmail(email);
    if (err) {
      console.error('❌ Database error during resend verification:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.verified) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    // Don't allow Google users to resend verification emails
    if (user.auth_provider === 'google' || user.auth_provider === 'email_google') {
      return res.status(400).json({ error: 'Google users do not need email verification' });
    }

    // Generate new verification token package
    let tokenPackage;
    
    if (!tokenService) {
      console.log('⚠️ Using fallback token generation for resend');
      const token = generateFallbackToken();
      const expiresAt = getTokenExpiry();
      tokenPackage = {
        token: token,
        hashedToken: token, // Store plain token for now (less secure but functional)
        expiresAt: expiresAt
      };
    } else {
      tokenPackage = await tokenService.generateVerificationPackage();
    }
    
    // Update user with new token
    const [updateErr] = await dbHelpers.updateVerificationToken(
      user.id, 
      tokenPackage.hashedToken, 
      tokenPackage.expiresAt
    );
    if (updateErr) {
      console.error('❌ Error updating verification token:', updateErr);
      return res.status(500).json({ error: 'Failed to generate verification token' });
    }

    // Send verification email
    const emailResult = await emailService.sendVerificationEmail(
      user.email, 
      user.username, 
      tokenPackage.token
    );
    if (!emailResult.success) {
      console.error('❌ Failed to send verification email:', emailResult.error);
      return res.status(500).json({ error: 'Failed to send verification email' });
    }

    console.log('✅ Verification email resent to:', user.email);
    res.json({ message: 'Verification email sent successfully' });

  } catch (error) {
    console.error('❌ Resend verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Forgot password endpoint
app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('🔐 Password reset request for:', email);

    // Find user by email
    const [err, user] = await dbHelpers.getUserByEmail(email);
    if (err) {
      console.error('❌ Database error during forgot password:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Always return success message for security (don't reveal if email exists)
    const successMessage = 'If an account exists for this email, a reset link has been sent.';

    if (!user) {
      console.log('📧 Email not found, but returning success message for security');
      return res.json({ success: true, message: successMessage });
    }

    // Allow Google users to set their first password via forgot password flow
    if (user.auth_provider === 'google' || user.auth_provider === 'email_google') {
      console.log('📧 Google user setting up password for manual login');
    }

    // Generate reset token package
    let tokenPackage;
    
    if (!tokenService) {
      console.log('⚠️ Using fallback token generation for password reset');
      const token = generateFallbackToken();
      const expiresAt = new Date(Date.now() + (30 * 60 * 1000)); // 30 minutes
      tokenPackage = {
        token: token,
        hashedToken: token, // Store plain token for now (less secure but functional)
        expiresAt: expiresAt
      };
    } else {
      tokenPackage = await tokenService.generateVerificationPackage();
    }

    // Update user with reset token
    const [updateErr] = await dbHelpers.setPasswordResetToken(
      user.id, 
      tokenPackage.hashedToken, 
      tokenPackage.expiresAt
    );
    if (updateErr) {
      console.error('❌ Error setting password reset token:', updateErr);
      return res.status(500).json({ error: 'Failed to generate reset token' });
    }

    // Send password reset email
    let emailSent = false;
    let emailError = null;
    
    if (emailService && emailService.isEmailConfigured()) {
      console.log('📧 Sending password reset email...');
      const emailResult = await emailService.sendPasswordResetEmail(
        user.email, 
        user.username || user.email.split('@')[0], 
        tokenPackage.token,
        user.auth_provider === 'google' || user.auth_provider === 'email_google'
      );
      if (emailResult.success) {
        console.log('✅ Password reset email sent successfully');
        emailSent = true;
      } else {
        console.error('❌ Failed to send password reset email:', emailResult.error);
        emailError = emailResult.error;
      }
    } else {
      console.log('⚠️ Email service not configured, skipping password reset email');
      emailError = 'Email service not configured';
    }

    // Always respond with success for the token creation, but note email status
    if (emailSent) {
      console.log('✅ Password reset email sent to:', user.email);
      res.json({ 
        success: true, 
        message: successMessage,
        note: 'Email sent! Delivery may take 1-5 minutes for new email addresses.'
      });
    } else {
      console.log('⚠️ Password reset token created but email failed to send:', user.email);
      res.json({ 
        success: true, 
        message: 'Password reset token created successfully. Email delivery failed - please try again.',
        error: emailError,
        note: 'You can try requesting another reset email in a few minutes.'
      });
    }

  } catch (error) {
    console.error('❌ Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset password endpoint (GET - show form)
app.get('/api/auth/reset-password', async (req, res) => {
  try {
    const token = req.query.token;
    
    if (!token) {
      return res.status(400).json({ error: 'Reset token is required' });
    }

    console.log('🔐 Password reset form request for token:', token.substring(0, 10) + '...');

    // Validate token format
    if (!tokenService) {
      console.log('⚠️ Using fallback token validation');
      if (!token || typeof token !== 'string' || token.length !== 64) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    } else {
      if (!tokenService.isValidTokenFormat(token)) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    }

    // Find user by reset token
    const [err, user] = await dbHelpers.getUserByResetToken(token);
    if (err) {
      console.error('❌ Database error during token validation:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.log('❌ Invalid or expired reset token');
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    console.log('✅ Reset token validated for user:', user.email);
    res.json({ 
      success: true, 
      message: 'Token is valid',
      user: {
        email: user.email,
        username: user.username
      }
    });

  } catch (error) {
    console.error('❌ Reset password validation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset password endpoint (POST - submit new password)
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    
    if (!token || !password || !confirmPassword) {
      return res.status(400).json({ error: 'Token, password, and password confirmation are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    console.log('🔐 Password reset submission for token:', token.substring(0, 10) + '...');

    // Validate token format
    if (!tokenService) {
      console.log('⚠️ Using fallback token validation');
      if (!token || typeof token !== 'string' || token.length !== 64) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    } else {
      if (!tokenService.isValidTokenFormat(token)) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    }

    // Find user by reset token
    const [err, user] = await dbHelpers.getUserByResetToken(token);
    if (err) {
      console.error('❌ Database error during password reset:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.log('❌ Invalid or expired reset token');
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    console.log('✅ Reset token validated for user:', user.email);

    // Check if new password is different from old password (only if user has an existing password)
    if (user.password_hash && typeof user.password_hash === 'string') {
      const isSamePassword = await bcrypt.compare(password, user.password_hash);
      if (isSamePassword) {
        console.log('❌ New password cannot be the same as the current password');
        return res.status(400).json({ error: 'New password must be different from your current password' });
      }
    } else {
      console.log('🔑 Setting up first password for Google user:', user.email);
    }

    // Hash new password
    const saltRounds = 10;
    const newPasswordHash = await bcrypt.hash(password, saltRounds);

    // Update user password and clear reset token
    const [updateErr] = await dbHelpers.resetUserPassword(user.id, newPasswordHash);
    if (updateErr) {
      console.error('❌ Error updating password:', updateErr);
      return res.status(500).json({ error: 'Failed to update password' });
    }

    console.log(`✅ Password ${user.password_hash ? 'reset' : 'setup'} successful for user: ${user.email}`);

    const message = user.password_hash 
      ? 'Password has been reset successfully. You can now log in with your new password.'
      : 'Password has been set up successfully! You can now log in manually with your email and password.';

    res.json({
      success: true,
      message: message
    });

  } catch (error) {
    console.error('❌ Password reset error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check username availability endpoint
app.post('/api/auth/check-username', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Basic validation
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    if (username.length > 20) {
      return res.status(400).json({ error: 'Username must be no more than 20 characters' });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, and hyphens' });
    }

    if (username.includes(' ')) {
      return res.status(400).json({ error: 'Username cannot contain spaces' });
    }

    console.log('🔍 Checking username availability:', username);

    // Check availability
    const [err, available] = await dbHelpers.checkUsernameAvailability(username);
    if (err) {
      console.error('❌ Database error during username check:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({ 
      available: available,
      username: username
    });

  } catch (error) {
    console.error('❌ Username check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Database test endpoint
app.get('/api/test/db', async (req, res) => {
  try {
    console.log('🧪 Testing database connectivity...');
    
    const { Pool } = require('pg');
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      return res.status(500).json({ error: 'DATABASE_URL not configured' });
    }
    
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
        require: true
      }
    });
    
    // Test connection
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL database');
    console.log('📅 Database time:', result.rows[0].now);
    
    // Test verification token query
    const tokenTest = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND column_name IN ('verified', 'verification_token', 'token_expires_at')
    `);
    
    console.log('📋 Verification columns:', tokenTest.rows.map(row => row.column_name));
    
    await pool.end();
    
    res.json({
      message: 'Database test successful',
      databaseTime: result.rows[0].now,
      verificationColumns: tokenTest.rows.map(row => row.column_name)
    });
  } catch (error) {
    console.error('❌ Database test failed:', error);
    res.status(500).json({ error: 'Database test failed', details: error.message });
  }
});

// Migration endpoint (remove after running once)
app.post('/api/admin/migrate-verification', async (req, res) => {
  try {
    console.log('🔧 Starting database migration for email verification...');
    
    // Import the database module to get access to the pool
    const { Pool } = require('pg');
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      return res.status(500).json({ error: 'DATABASE_URL not configured' });
    }
    
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
        require: true
      }
    });
    
    // Check if all required columns exist
    const checkColumns = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND column_name IN ('verified', 'verification_token', 'token_expires_at', 'reset_password_token', 'reset_password_expires')
    `);

    const existingColumns = checkColumns.rows.map(row => row.column_name);
    console.log('📋 Existing columns:', existingColumns);

    // Add missing columns
    const columnsToAdd = [
      { name: 'verified', sql: 'ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT FALSE' },
      { name: 'verification_token', sql: 'ALTER TABLE users ADD COLUMN verification_token VARCHAR(255)' },
      { name: 'token_expires_at', sql: 'ALTER TABLE users ADD COLUMN token_expires_at TIMESTAMP' },
      { name: 'reset_password_token', sql: 'ALTER TABLE users ADD COLUMN reset_password_token VARCHAR(255)' },
      { name: 'reset_password_expires', sql: 'ALTER TABLE users ADD COLUMN reset_password_expires TIMESTAMP' }
    ];

    for (const column of columnsToAdd) {
      if (!existingColumns.includes(column.name)) {
        try {
          console.log(`➕ Adding ${column.name} column...`);
          await pool.query(column.sql);
          console.log(`✅ ${column.name} column added`);
        } catch (error) {
          if (error.code === '42701') {
            console.log(`⚠️ Column ${column.name} already exists`);
          } else {
            console.error(`❌ Error adding ${column.name} column:`, error.message);
          }
        }
      } else {
        console.log(`✅ ${column.name} column already exists`);
      }
    }

    // Update existing users to be verified
    console.log('🔄 Updating existing users to verified status...');
    const updateResult = await pool.query('UPDATE users SET verified = TRUE WHERE verified IS NULL');
    console.log(`✅ Updated ${updateResult.rowCount} existing users to verified`);

    await pool.end();

    res.json({ 
      message: 'Migration completed successfully',
      addedColumns: existingColumns.length === 0 ? ['verified', 'verification_token', 'token_expires_at'] : [],
      updatedUsers: updateResult.rowCount
    });
  } catch (error) {
    console.error('❌ Migration error:', error);
    res.status(500).json({ error: 'Migration failed', details: error.message });
  }
});



// Database reset endpoint (remove after use)
app.post('/api/admin/reset-database', async (req, res) => {
  try {
    console.log('🗑️ Starting database reset...');
    
    const { Pool } = require('pg');
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      return res.status(500).json({ error: 'DATABASE_URL not configured' });
    }
    
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
        require: true
      }
    });
    
    // Check which tables exist and clear them (in correct order due to foreign keys)
    const tablesToClear = [
      'event_tracking',
      'watch_sessions', 
      'daily_analytics',
      'users'
    ];
    
    const clearedTables = [];
    
    for (const tableName of tablesToClear) {
      try {
        // Check if table exists
        const tableExists = await pool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = $1
          )
        `, [tableName]);
        
        if (tableExists.rows[0].exists) {
          console.log(`🗑️ Clearing ${tableName} table...`);
          await pool.query(`DELETE FROM ${tableName}`);
          clearedTables.push(tableName);
          console.log(`✅ ${tableName} table cleared`);
        } else {
          console.log(`⚠️ ${tableName} table does not exist, skipping`);
        }
      } catch (error) {
        console.error(`❌ Error clearing ${tableName} table:`, error.message);
        // Continue with other tables even if one fails
      }
    }
    
    // Reset auto-increment sequences (only for existing tables)
    console.log('🔄 Resetting sequences...');
    const sequencesToReset = [
      'users_id_seq',
      'watch_sessions_id_seq', 
      'event_tracking_id_seq',
      'daily_analytics_id_seq'
    ];
    
    for (const sequenceName of sequencesToReset) {
      try {
        await pool.query(`ALTER SEQUENCE IF EXISTS ${sequenceName} RESTART WITH 1`);
        console.log(`✅ ${sequenceName} reset`);
      } catch (error) {
        console.log(`⚠️ ${sequenceName} does not exist, skipping`);
      }
    }
    
    await pool.end();
    
    res.json({ 
      message: 'Database reset completed successfully',
      clearedTables: clearedTables,
      clearedData: clearedTables.includes('users') ? ['user accounts', 'password reset tokens', 'verification tokens'] : [],
      skippedTables: tablesToClear.filter(table => !clearedTables.includes(table)),
      resetSequences: sequencesToReset
    });
  } catch (error) {
    console.error('❌ Reset error:', error);
    res.status(500).json({ error: 'Reset failed', details: error.message });
  }
});

// ===== CLOUDFLARE R2 CONFIGURATION =====

// Configure Cloudflare R2 (S3-compatible)
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '9eeb17f20eafece615e6b3520faf05c0',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4'
  }
});

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Accept video and image files (including SVG for sponsor logos)
    const allowedMimes = ['video/mp4', 'image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4 videos, PNG/JPG images, and SVG files are allowed.'));
    }
  }
});

// ===== ADVERTISER/SPONSOR SUBMISSION ROUTE =====

app.post('/api/advertiser/submit', upload.single('creative'), async (req, res) => {
  try {
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
      isRecurring
    } = req.body;
    
    // Validate required fields
    if (!email) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'email is required'
      });
    }
    
    console.log(`📝 Advertiser submission received from ${email}`);
    console.log('📝 Received ad_format from frontend:', adFormat);
    
    // MAP frontend values to database values
    let databaseAdFormat;
    if (adFormat === 'static') {
      databaseAdFormat = 'static_image'; // Map "static" → "static_image"
    } else if (adFormat === 'video') {
      databaseAdFormat = 'video'; // Keep "video" as is
    } else {
      // Handle any other values or use the original
      databaseAdFormat = adFormat;
    }
    
    console.log('📝 Using database ad_format:', databaseAdFormat);
    
    let mediaUrl = null;
    
    // Upload file to R2 if provided
    if (req.file) {
      try {
        const timestamp = Date.now();
        const filename = `${timestamp}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        
        console.log(`📤 Uploading file to R2: ${filename}`);
        
        const uploadCommand = new PutObjectCommand({
          Bucket: 'advertiser-media',
          Key: filename,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        });
        
        await r2Client.send(uploadCommand);
        
        // Construct public URL using the correct public dev URL
        mediaUrl = normalizeBareMediaR2Link(`${R2_ADVERTISER_MEDIA_URL}/${filename}`);
        console.log(`✅ File uploaded successfully: ${mediaUrl}`);
        
      } catch (uploadError) {
        console.error('❌ R2 upload error:', uploadError);
        return res.status(500).json({
          error: 'File upload failed',
          message: 'Failed to upload media file to storage'
        });
      }
    }
    
    // Get database pool
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Normalize email (always lowercase and trimmed)
    const normalizedEmail = email.toLowerCase().trim();
    
    // Calculate max_weekly_impressions based on CPM + weekly budget
    let max_weekly_impressions = null;
    const weeklyBudgetNum = weeklyBudget ? parseFloat(weeklyBudget) : null;
    const cpmRateNum = cpmRate ? parseFloat(cpmRate) : null;
    
    if (
      typeof weeklyBudgetNum === "number" &&
      weeklyBudgetNum > 0 &&
      typeof cpmRateNum === "number" &&
      cpmRateNum > 0
    ) {
      max_weekly_impressions = Math.floor((weeklyBudgetNum / cpmRateNum) * 1000);
      console.log(`📊 Calculated max_weekly_impressions: ${max_weekly_impressions} (budget: ${weeklyBudgetNum}, CPM: ${cpmRateNum})`);
    } else {
      console.log('⚠️ max_weekly_impressions set to NULL (invalid budget or CPM rate)');
    }
    
    // ===== STEP 1: CHECK/CREATE advertiser_accounts BEFORE inserting into advertisers =====
    let advertiserAccountId = null;
    let accountPasswordHash = null;
    let rawSetupToken = null;
    
    try {
      // Check if advertiser_accounts entry already exists for this email (case-insensitive)
      const existingAccountResult = await pool.query(`
        SELECT id, password_hash, advertiser_id
        FROM advertiser_accounts 
        WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
      `, [normalizedEmail]);
      
      if (existingAccountResult.rows.length > 0) {
        // Account exists - reuse it
        const existingAccount = existingAccountResult.rows[0];
        advertiserAccountId = existingAccount.id;
        accountPasswordHash = existingAccount.password_hash;
        console.log('ℹ️ [SUBMISSION] Found existing advertiser_accounts for email:', normalizedEmail, 'account_id:', advertiserAccountId);
      } else {
        // Account does NOT exist - create new one with advertiser_id = NULL initially
        const accountResult = await pool.query(`
          INSERT INTO advertiser_accounts (
            advertiser_id,
            email,
            password_hash
          ) VALUES (NULL, $1, NULL)
          RETURNING id
        `, [normalizedEmail]);
        
        advertiserAccountId = accountResult.rows[0].id;
        accountPasswordHash = null; // New account, no password yet
        console.log('✅ [SUBMISSION] Created new advertiser_accounts with advertiser_id=NULL, account_id:', advertiserAccountId);
      }
      
      // Create password_setup token if password doesn't exist (Email #1)
      if (accountPasswordHash === null) {
        try {
          const tokenResult = await createPasswordToken(advertiserAccountId, 'password_setup', pool);
          rawSetupToken = tokenResult.rawToken;
          console.log('✅ [SUBMISSION] Created password_setup token for account_id:', advertiserAccountId);
        } catch (tokenError) {
          console.error('❌ [SUBMISSION] Failed to create password_setup token:', tokenError);
          // Continue without token - user can request password reset later
        }
      }
    } catch (accountError) {
      console.error('❌ [SUBMISSION] CRITICAL ERROR creating/finding advertiser_accounts:', accountError);
      console.error('❌ [SUBMISSION] SQL Error Details:', {
        message: accountError.message,
        code: accountError.code,
        detail: accountError.detail,
        constraint: accountError.constraint,
        stack: accountError.stack
      });
      return res.status(500).json({
        error: 'Account creation failed',
        message: 'Failed to create or find advertiser account. Please try again or contact support.',
        details: process.env.NODE_ENV === 'development' ? accountError.message : undefined
      });
    }
    
    // ===== STEP 2: INSERT INTO advertisers table =====
    let inserted;
    try {
      const result = await pool.query(
        `INSERT INTO advertisers (
          company_name, website_url, first_name, last_name, 
          email, title_role, ad_format, weekly_budget_cap, cpm_rate, 
          media_r2_link, recurring_weekly, max_weekly_impressions, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
        RETURNING id, email, media_r2_link, created_at`,
        [
          companyName || null,
          websiteUrl || null,
          firstName || null,
          lastName || null,
          normalizedEmail,
          jobTitle || null,
          databaseAdFormat || null,
          weeklyBudgetNum,
          cpmRateNum,
          normalizeBareMediaR2Link(mediaUrl),
          isRecurring === 'true' || isRecurring === true,
          max_weekly_impressions
        ]
      );
      
      inserted = result.rows[0];
      console.log(`✅ [SUBMISSION] Advertiser inserted with id:`, inserted.id);
    } catch (insertError) {
      console.error('❌ [SUBMISSION] CRITICAL ERROR inserting into advertisers:', insertError);
      console.error('❌ [SUBMISSION] SQL Error Details:', {
        message: insertError.message,
        code: insertError.code,
        detail: insertError.detail,
        constraint: insertError.constraint
      });
      return res.status(500).json({
        error: 'Submission failed',
        message: 'Failed to save advertiser submission. Please try again.',
        details: process.env.NODE_ENV === 'development' ? insertError.message : undefined
      });
    }
    
    // ===== STEP 3: LINK advertiser_accounts.advertiser_id to new advertiser.id =====
    try {
      // Only update if advertiser_id is NULL (don't overwrite existing link)
      const linkResult = await pool.query(`
        UPDATE advertiser_accounts
        SET advertiser_id = $1
        WHERE id = $2
          AND advertiser_id IS NULL
      `, [inserted.id, advertiserAccountId]);
      
      if (linkResult.rowCount > 0) {
        console.log('✅ [SUBMISSION] Linked advertiser_accounts.advertiser_id to advertiser.id:', inserted.id);
      } else {
        console.log('ℹ️ [SUBMISSION] advertiser_accounts already linked to another advertiser, skipping link');
      }
    } catch (linkError) {
      console.error('❌ [SUBMISSION] ERROR linking advertiser_accounts:', linkError);
      console.error('❌ [SUBMISSION] SQL Error Details:', {
        message: linkError.message,
        code: linkError.code,
        detail: linkError.detail
      });
      // Don't fail the submission if linking fails - log and continue
      // The account exists and advertiser was created, so submission is still successful
    }
    
    // ===== STEP 4: SEND EMAIL ONLY IF password_hash IS NULL =====
    // Note: The confirmation email will be sent by the payment webhook
    // This submission endpoint no longer sends a separate setup email
    if (accountPasswordHash !== null) {
      console.log('ℹ️ [SUBMISSION] Password already exists for this account - skipping token creation');
    }
    
    res.status(200).json({
      success: true,
      message: 'Advertiser submission received successfully',
      data: {
        id: inserted.id,
        email: inserted.email,
        mediaUrl: inserted.media_r2_link,
        createdAt: inserted.created_at
      }
    });
    
  } catch (error) {
    console.error('❌ Error submitting advertiser/sponsor application:', error);
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to submit application. Please try again later.'
    });
  }
});


// ===== SPONSOR SUBMISSION ROUTE =====

// Submit sponsor application with logo upload
app.post('/api/sponsor/submit', upload.single('logo'), async (req, res) => {
  try {
    console.log('🚀 ===== SPONSOR SUBMISSION STARTED =====');
    
    const {
      organization,
      contactEmail,
      website,
      einTaxId,
      sponsorTier,
      isRecurring,
      diamondAmount,
      tagline
    } = req.body;
    
    // Validate required fields
    if (!organization || !contactEmail) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'organization and contactEmail are required'
      });
    }

    // Character limit validation
    const orgTrimmed = (organization && typeof organization === 'string') ? organization.trim() : '';
    if (orgTrimmed.length > 21) {
      return res.status(400).json({
        error: 'Organization name too long',
        message: 'Organization (legal name) must be 21 characters or fewer'
      });
    }
    if (tagline && typeof tagline === 'string') {
      const taglineTrimmed = tagline.trim();
      if (taglineTrimmed.length > 40) {
        return res.status(400).json({
          error: 'Tagline too long',
          message: 'Tagline must be 40 characters or fewer'
        });
      }
    }
    
    // Validate sponsor tier
    const validTiers = ['bronze', 'silver', 'gold', 'diamond'];
    const tier = sponsorTier ? sponsorTier.toLowerCase() : null;
    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({
        error: 'Invalid sponsor tier',
        message: 'sponsorTier must be one of: bronze, silver, gold, diamond'
      });
    }
    
    // Validate Diamond tier amount (min $500, increments of $50 only)
    if (tier === 'diamond') {
      const amount = parseFloat(diamondAmount);
      if (!amount || isNaN(amount) || amount < 500) {
        return res.status(400).json({
          error: 'Invalid Diamond tier amount',
          message: 'Diamond tier requires a minimum contribution of $500'
        });
      }
      if (amount % 50 !== 0) {
        return res.status(400).json({
          error: 'Invalid Diamond tier amount',
          message: 'Diamond tier amount must be in $50 increments'
        });
      }
    }
    
    // Validate logo is provided
    if (!req.file) {
      return res.status(400).json({
        error: 'Missing logo',
        message: 'Logo file is required'
      });
    }
    
    console.log(`📝 Sponsor submission received from ${organization} (${contactEmail}), tier: ${tier}`);
    
    // Check Stripe configuration
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ error: 'Stripe configuration missing' });
    }
    
    // Get database pool
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Step 1: Create or fetch sponsor_accounts by contact_email
    console.log('💾 Step 1: Creating or fetching sponsor_accounts...');
    let sponsorAccount;
    const accountCheck = await pool.query(
      'SELECT * FROM sponsor_accounts WHERE contact_email = $1',
      [contactEmail.toLowerCase().trim()]
    );
    
    if (accountCheck.rows.length > 0) {
      sponsorAccount = accountCheck.rows[0];
      console.log('✅ Found existing sponsor_account:', sponsorAccount.id);
    } else {
      const accountResult = await pool.query(
        `INSERT INTO sponsor_accounts (
          organization_legal_name, contact_email, website, ein_tax_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *`,
        [
          organization,
          contactEmail.toLowerCase().trim(),
          website || null,
          einTaxId || null
        ]
      );
      sponsorAccount = accountResult.rows[0];
      console.log('✅ Created new sponsor_account:', sponsorAccount.id);
    }
    
    // Step 2: Recurring sponsor start_week is set from invoice.paid (billing period) when first charged, not at submission
    // Step 3: Upload logo to charity-stream-sponsor-uploads bucket
    console.log('📤 Step 3: Uploading logo to R2...');
    let logoR2Key = null;
    
    try {
      // Determine file extension from mimetype or filename
      const fileExtension = req.file.originalname.split('.').pop() || 
                           (req.file.mimetype === 'image/svg+xml' ? 'svg' : 
                            req.file.mimetype.includes('png') ? 'png' : 'png');
      
      // Create organization slug from organization name
      const orgSlug = createOrganizationSlug(organization);
      
      // Get submission date (YYYY-MM-DD)
      const submissionDate = new Date().toISOString().split('T')[0];
      
      // Get timestamp for uniqueness
      const timestamp = Date.now();
      
      // Create R2 key: {organization-slug}/logo_YYYY-MM-DD_{timestamp}.{ext}
      logoR2Key = `${orgSlug}/logo_${submissionDate}_${timestamp}.${fileExtension}`;
      
      console.log(`📤 Uploading logo to R2: ${logoR2Key}`);
      
      const uploadCommand = new PutObjectCommand({
        Bucket: 'charity-stream-sponsor-uploads',
        Key: logoR2Key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      });
      
      await r2Client.send(uploadCommand);
      console.log(`✅ Logo uploaded to R2: ${logoR2Key}`);
        
    } catch (uploadError) {
      console.error('❌ R2 upload error:', uploadError);
      return res.status(500).json({
        error: 'Logo upload failed',
        message: 'Failed to upload logo file to storage'
      });
    }
    
    // Step 4: Create sponsor_campaigns row
    console.log('💾 Step 4: Creating sponsor_campaigns row...');
    const isRecurringBool = isRecurring === 'true' || isRecurring === true;
    // tagline is already destructured from req.body at the top of the function
    // Handle empty string or undefined as null
    const taglineValue = (tagline && tagline.trim()) ? tagline.trim() : null;
    
    const insertStatus = 'payment_pending';
    // start_week NULL at submission: recurring set from invoice.paid; non-recurring set in FFmpeg script at approval
    const startWeekValue = null;
    const insertParams = [
      sponsorAccount.id,
      tier,
      insertStatus,
      isRecurringBool,
      startWeekValue,
      logoR2Key,
      taglineValue
    ];
    const insertSql = `INSERT INTO sponsor_campaigns (
        sponsor_account_id, tier, status, is_recurring, start_week, logo_r2_key, tagline, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`;
    
    console.log('[SPONSOR INSERT DEBUG]');
    console.log('[SPONSOR INSERT DEBUG] status = "' + String(insertStatus) + '"');
    console.log('[SPONSOR INSERT DEBUG] full payload (values):', {
      sponsor_account_id: sponsorAccount.id,
      tier,
      status: insertStatus,
      is_recurring: isRecurringBool,
      start_week: startWeekValue,
      logo_r2_key: logoR2Key,
      tagline: taglineValue
    });
    console.log('[SPONSOR INSERT DEBUG] tier =', JSON.stringify(tier), ', is_recurring =', isRecurringBool, ', start_week =', startWeekValue);
    console.log('[SPONSOR INSERT DEBUG] exact SQL:', insertSql);
    console.log('[SPONSOR INSERT DEBUG] parameter array (in order):', insertParams);
    
    const campaignResult = await pool.query(insertSql, insertParams);
    
    const sponsorCampaign = campaignResult.rows[0];
    console.log('✅ Created sponsor_campaign:', sponsorCampaign.id);
    
    // Create Stripe customer (needed for both recurring Checkout and non-recurring Setup Intent)
    let stripeCustomer;
    if (sponsorAccount.stripe_customer_id) {
      try {
        stripeCustomer = await stripe.customers.retrieve(sponsorAccount.stripe_customer_id);
        console.log('✅ Using existing Stripe customer:', stripeCustomer.id);
      } catch (err) {
        console.log('⚠️ Existing customer not found, creating new one');
        stripeCustomer = null;
      }
    }
    
    if (!stripeCustomer) {
      stripeCustomer = await stripe.customers.create({
        email: contactEmail,
        name: organization,
        metadata: {
          sponsorAccountId: String(sponsorAccount.id),
          campaignType: 'sponsor'
        }
      });
      console.log('✅ Created new Stripe customer:', stripeCustomer.id);
      
      await pool.query(
        'UPDATE sponsor_accounts SET stripe_customer_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [stripeCustomer.id, sponsorAccount.id]
      );
    }
    
    // ----- NON-RECURRING: Stripe Checkout (setup mode) to save card (charge at approval) -----
    if (!isRecurringBool) {
      const TIER_AMOUNTS_CENTS = { bronze: 5000, silver: 10000, gold: 25000, diamond: null };
      const amountCents = tier === 'diamond'
        ? Math.round(parseFloat(diamondAmount) * 100)
        : (TIER_AMOUNTS_CENTS[tier] || 5000);

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomer.id,
        payment_method_types: ['card'],
        mode: 'setup',
        success_url: `${frontendUrl}/advertiser.html?sponsor_success=true&sponsorCampaignId=${sponsorCampaign.id}`,
        cancel_url: `${frontendUrl}/advertiser.html`,
        metadata: {
          sponsorAccountId: String(sponsorAccount.id),
          sponsorCampaignId: String(sponsorCampaign.id),
          campaignType: 'sponsor',
          tier: tier,
          amountCents: String(amountCents)
        }
      });
      console.log('✅ [NON-RECURRING] Checkout Session (setup mode) created:', session.id);

      await pool.query(
        `INSERT INTO sponsor_billing (
          sponsor_campaign_id, stripe_mode, stripe_checkout_session_id, amount_cents, currency, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
        [
          sponsorCampaign.id,
          'one_time',
          session.id,
          amountCents,
          'usd',
          'open'
        ]
      );
      console.log('✅ Created sponsor_billing row (non-recurring, checkout setup mode)');
      console.log('✅ ===== SPONSOR SUBMISSION COMPLETED (NON-RECURRING) =====');

      return res.status(200).json({
        success: true,
        message: 'Sponsor submission received.',
        checkoutUrl: session.url,
        sponsorAccountId: sponsorAccount.id,
        sponsorCampaignId: sponsorCampaign.id
      });
    }
    
    // ----- RECURRING: Stripe Checkout Session -----
    console.log('🛒 Step 6: Creating Stripe Checkout Session...');
    let amountCents;
    let lineItems = [];
    
    if (tier === 'diamond') {
      amountCents = Math.round(parseFloat(diamondAmount) * 100);
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Diamond Sponsorship',
            description: `Diamond tier sponsorship - $${diamondAmount}`
          },
          unit_amount: amountCents,
          recurring: { interval: 'week' }
        },
        quantity: 1
      });
    } else {
      const lookupKey = `${tier}_recurring`;
      try {
        const prices = await stripe.prices.list({
          lookup_keys: [lookupKey],
          limit: 1
        });
        if (prices.data.length === 0) {
          throw new Error(`Stripe price with lookup key '${lookupKey}' not found`);
        }
        const price = prices.data[0];
        amountCents = price.unit_amount;
        lineItems.push({ price: price.id, quantity: 1 });
        console.log(`✅ Found Stripe price: ${price.id} (${lookupKey}), amount: $${amountCents / 100}`);
      } catch (priceError) {
        console.error('❌ Failed to retrieve Stripe price:', priceError);
        return res.status(500).json({
          error: 'Stripe price lookup failed',
          message: `Failed to find price for tier ${tier}`
        });
      }
    }
    
    const sessionConfig = {
      customer: stripeCustomer.id,
      payment_method_types: ['card'],
      phone_number_collection: { enabled: false },
      mode: 'subscription',
      line_items: lineItems,
      custom_text: {
        after_submit: {
          message: 'You will be charged once your sponsorship campaign is approved. No charges if it\'s not approved.'
        }
      },
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser.html?sponsor_success=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser.html`,
      metadata: {
        sponsorAccountId: String(sponsorAccount.id),
        sponsorCampaignId: String(sponsorCampaign.id),
        campaignType: 'sponsor',
        tier: tier,
        amountCents: String(amountCents)
      }
    };
    
    let nextMonday = getNextMondayLA();
    let nextMondayUnix = Math.floor(nextMonday.getTime() / 1000);
    const nowUnix = Math.floor(Date.now() / 1000);
    const fortyEightHoursSeconds = 48 * 60 * 60;
    if (nextMondayUnix - nowUnix < fortyEightHoursSeconds) {
      nextMonday = getNextMondayLA(new Date(nextMonday.getTime() + 24 * 60 * 60 * 1000));
      nextMondayUnix = Math.floor(nextMonday.getTime() / 1000);
      console.warn('⚠️ [TRIAL_END_SHIFTED] Trial end was <48h away — pushed to next Monday');
    }
    const customerDefaultPm = stripeCustomer.invoice_settings?.default_payment_method || null;
    sessionConfig.subscription_data = {
      trial_end: nextMondayUnix,
      metadata: {
        sponsor_campaign_id: String(sponsorCampaign.id),
        sponsor_account_id: String(sponsorAccount.id),
        campaignType: 'sponsor',
        tier: tier
      }
    };
    if (customerDefaultPm) {
      sessionConfig.metadata.customer_default_pm = customerDefaultPm;
    }
    
    const session = await stripe.checkout.sessions.create(sessionConfig);
    console.log('✅ Stripe Checkout Session created:', session.id);
    console.log('🔗 Checkout URL:', session.url);
    
    await pool.query(
      `INSERT INTO sponsor_billing (
        sponsor_campaign_id, stripe_mode, stripe_checkout_session_id, amount_cents, currency, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [
        sponsorCampaign.id,
        'subscription',
        session.id,
        amountCents,
        'usd',
        'open'
      ]
    );
    console.log('✅ Created sponsor_billing row');
    console.log('✅ ===== SPONSOR SUBMISSION COMPLETED =====');
    
    res.status(200).json({
      success: true,
      message: 'Sponsor submission received successfully',
      checkoutUrl: session.url,
      sessionId: session.id,
      sponsorAccountId: sponsorAccount.id,
      sponsorCampaignId: sponsorCampaign.id
    });
    
  } catch (error) {
    console.error('❌ ===== SPONSOR SUBMISSION FAILED =====');
    console.error('❌ Error details:', error.message);
    console.error('❌ Error stack:', error.stack);
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to submit sponsor application. Please try again later.'
    });
  }
});

// Send sponsor submission confirmation email (non-recurring flow: after confirmCardSetup, no redirect)
app.post('/api/sponsor/send-submission-confirmation', async (req, res) => {
  try {
    const { sponsorCampaignId } = req.body || {};
    if (!sponsorCampaignId) {
      return res.status(400).json({ error: 'sponsorCampaignId is required' });
    }
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({ error: 'Database unavailable' });
    }
    const campaignResult = await pool.query(
      `SELECT sc.id, sc.sponsor_account_id, sc.tier, sc.is_recurring, sc.tagline,
              sa.organization_legal_name, sa.contact_email
       FROM sponsor_campaigns sc
       JOIN sponsor_accounts sa ON sc.sponsor_account_id = sa.id
       WHERE sc.id = $1`,
      [sponsorCampaignId]
    );
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const row = campaignResult.rows[0];
    if (row.is_recurring) {
      return res.status(400).json({ error: 'Confirmation email is only for non-recurring submissions' });
    }
    const contactEmail = row.contact_email;
    const organizationName = row.organization_legal_name;
    let rawInitialSetupToken = null;
    try {
      const accountResult = await pool.query(
        'SELECT id, password_hash FROM sponsor_accounts WHERE id = $1',
        [row.sponsor_account_id]
      );
      if (accountResult.rows.length > 0 && !accountResult.rows[0].password_hash) {
        const tokenResult = await createSponsorPasswordToken(accountResult.rows[0].id, 'password_setup', pool);
        rawInitialSetupToken = tokenResult.rawToken;
      }
    } catch (tokenErr) {
      console.error('❌ [SPONSOR CONFIRM] Token creation failed:', tokenErr.message);
    }
    const submissionSummary = {
      organizationName,
      tier: row.tier,
      isRecurring: false,
      tagline: row.tagline || null
    };
    if (emailService && emailService.isEmailConfigured()) {
      await emailService.sendSponsorConfirmationEmail(
        contactEmail,
        organizationName,
        submissionSummary,
        rawInitialSetupToken
      );
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ [SPONSOR CONFIRM] send-submission-confirmation failed:', err);
    return res.status(500).json({ error: 'Failed to send confirmation email' });
  }
});


// ===== ADVERTISER PAGE PUBLIC STATS =====
app.get('/api/advertiser/public-stats', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database unavailable' });
    const [advertiserCount, allocation, charitiesSupported] = await Promise.all([
      pool.query('SELECT COUNT(*) AS count FROM advertiser_accounts'),
      pool.query('SELECT COALESCE(SUM(total_amount), 0) AS total FROM weekly_charity_allocation'),
      pool.query('SELECT COUNT(*) AS count FROM charity_week_winner')
    ]);
    res.json({
      advertiserCount: parseInt(advertiserCount.rows[0].count, 10),
      donatedToDate: parseFloat(allocation.rows[0].total),
      charitiesSupported: parseInt(charitiesSupported.rows[0].count, 10)
    });
  } catch (err) {
    console.error('❌ [ADVERTISER PUBLIC STATS] Error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ===== CHARITY PUBLIC STATS =====
app.get('/api/charity/stats', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database unavailable' });
    const [poolCount, allocation, winnersCount] = await Promise.all([
      pool.query('SELECT COUNT(*) AS count FROM charity_week_pool'),
      pool.query('SELECT COALESCE(SUM(total_amount), 0) AS total FROM weekly_charity_allocation'),
      pool.query('SELECT COUNT(*) AS count FROM charity_week_winner')
    ]);
    res.json({
      nonprofitCount: parseInt(poolCount.rows[0].count, 10),
      donatedToDate: parseFloat(allocation.rows[0].total),
      charitiesSupported: parseInt(winnersCount.rows[0].count, 10)
    });
  } catch (err) {
    console.error('❌ [CHARITY STATS] Error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ===== CHARITY INTAKE (NEW APPLICATION FLOW) =====

// Legacy endpoint – no longer writes to charities table
app.post('/api/charity/submit', async (req, res) => {
  console.log('⚠️ Deprecated /api/charity/submit called – new charity-entry flow is in use');
  return res.status(410).json({
    error: 'deprecated_endpoint',
    message: 'This endpoint has been replaced by the new charity-entry flow.'
  });
});

// Step 1: Create a $1 PaymentIntent for charity entry
app.post('/api/charity-entry/create-payment-intent', async (req, res) => {
  try {
    const { charityName, federalEin, contactEmail } = req.body || {};

    if (!charityName || !federalEin || !contactEmail) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'Please provide charityName, federalEin, and contactEmail'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(contactEmail)) {
      return res.status(400).json({
        error: 'invalid_email',
        message: 'Please provide a valid email address'
      });
    }

    const amount = 100; // $1 in cents

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata: {
        type: 'charity_entry',
        charity_name: charityName,
        federal_ein: federalEin,
        contact_email: contactEmail
      }
    });

    console.log('✅ Created charity entry PaymentIntent:', {
      id: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: paymentIntent.status
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret
    });
  } catch (error) {
    console.error('❌ Error creating charity entry PaymentIntent:', error);
    return res.status(500).json({
      error: 'payment_intent_error',
      message: 'Failed to create payment. Please try again.'
    });
  }
});

// Step 4: Finalize charity application after successful payment confirmation
app.post('/api/charity-entry/finalize', async (req, res) => {
  try {
    const { charityName, federalEin, contactEmail, paymentIntentId } = req.body || {};

    if (!charityName || !federalEin || !contactEmail || !paymentIntentId) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'Please provide charityName, federalEin, contactEmail, and paymentIntentId'
      });
    }

    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'database_unavailable' });
    }

    // Verify PaymentIntent with Stripe
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (err) {
      console.error('❌ Failed to retrieve PaymentIntent:', err);
      return res.status(400).json({
        error: 'invalid_payment_intent',
        message: 'Payment could not be verified.'
      });
    }

    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      console.error('❌ PaymentIntent not succeeded for charity entry:', {
        id: paymentIntent && paymentIntent.id,
        status: paymentIntent && paymentIntent.status
      });
      return res.status(400).json({
        error: 'payment_not_succeeded',
        message: 'Payment has not completed successfully.'
      });
    }

    if (paymentIntent.amount !== 100 || paymentIntent.currency !== 'usd') {
      console.error('❌ PaymentIntent amount/currency mismatch:', {
        id: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency
      });
      return res.status(400).json({
        error: 'invalid_payment_amount',
        message: 'Payment amount or currency is invalid for charity entry.'
      });
    }

    if (!paymentIntent.metadata || paymentIntent.metadata.type !== 'charity_entry') {
      console.error('❌ PaymentIntent missing or invalid metadata for charity entry:', {
        id: paymentIntent.id,
        metadata: paymentIntent.metadata
      });
      return res.status(400).json({
        error: 'invalid_payment_metadata',
        message: 'Payment metadata does not match charity entry.'
      });
    }

    // Insert into charity_applications
    let inserted;
    try {
      const result = await pool.query(
        `
          INSERT INTO charity_applications (
            charity_name,
            federal_ein,
            contact_email,
            entry_payment_intent_id,
            status,
            created_at
          )
          VALUES ($1, $2, $3, $4, 'pending', CURRENT_TIMESTAMP)
          ON CONFLICT (entry_payment_intent_id) DO UPDATE
          SET charity_name = EXCLUDED.charity_name,
              federal_ein = EXCLUDED.federal_ein,
              contact_email = EXCLUDED.contact_email
          RETURNING id, charity_name, federal_ein, contact_email, entry_payment_intent_id, status, created_at
        `,
        [charityName, federalEin, contactEmail, paymentIntent.id]
      );
      inserted = result.rows[0];
    } catch (dbError) {
      console.error('❌ Error inserting charity application:', dbError);
      return res.status(500).json({
        error: 'database_error',
        message: 'Failed to save charity application. Please contact support if you were charged.'
      });
    }

    console.log('✅ Charity application recorded:', inserted);

    if (emailService && emailService.isEmailConfigured()) {
      try {
        const emailResult = await emailService.sendCharityConfirmationEmail(
          inserted.contact_email,
          inserted.charity_name,
          inserted.created_at
        );
        if (emailResult.success) {
          console.log('✅ Charity confirmation email sent successfully');
        } else {
          console.error('❌ Failed to send charity confirmation email:', emailResult.error);
        }
      } catch (emailErr) {
        console.error('❌ Error sending charity confirmation email:', emailErr);
      }
    } else {
      console.warn('⚠️ Email service not configured, skipping charity confirmation email');
    }

    return res.status(200).json({
      success: true,
      message: 'Charity application submitted successfully.',
      application: inserted
    });
  } catch (error) {
    console.error('❌ Error finalizing charity application:', error);
    return res.status(500).json({
      error: 'finalize_error',
      message: 'Failed to finalize charity application.'
    });
  }
});

// ===== TRACKING ROUTES (Ready for your video player) =====

// Device fingerprint-based desktop detection endpoints

// Desktop app heartbeat (called by desktop app)
app.post('/api/tracking/desktop-active', trackRequest, trackingRateLimit, async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) {
      return res.status(400).json({ error: 'Missing fingerprint' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    await pool.query(`
      INSERT INTO desktop_active_sessions (fingerprint, last_heartbeat)
      VALUES ($1, NOW())
      ON CONFLICT (fingerprint) DO UPDATE SET last_heartbeat = NOW()
    `, [fingerprint]);

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error in desktop-active:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Desktop app shutdown (called when desktop app closes)
app.post('/api/tracking/desktop-inactive', async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) {
      return res.status(400).json({ error: 'Missing fingerprint' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    await pool.query(`DELETE FROM desktop_active_sessions WHERE fingerprint = $1`, [fingerprint]);
    
    console.log(`🔚 Desktop app deactivated for fingerprint: ${fingerprint}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error in desktop-inactive:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check if desktop app is active on this device
app.post('/api/tracking/desktop-active-status', async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) {
      return res.status(400).json({ error: 'Missing fingerprint' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    // Clean up old desktop sessions (> 30 seconds old) before checking
    await pool.query(`
      DELETE FROM desktop_active_sessions 
      WHERE last_heartbeat < NOW() - INTERVAL '30 seconds'
    `);

    const result = await pool.query(`
      SELECT 1 FROM desktop_active_sessions
      WHERE fingerprint = $1 AND last_heartbeat > NOW() - INTERVAL '10 seconds'
    `, [fingerprint]);

    const isDesktopActive = result.rowCount > 0;
    
    console.log(`🔍 Desktop status check for fingerprint ${fingerprint}: ${isDesktopActive ? 'ACTIVE' : 'INACTIVE'}`);
    
    res.json({ isDesktopActive });
  } catch (error) {
    console.error('❌ Error in desktop-active-status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Session-based detection (fallback method)
app.get('/api/tracking/session-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    // First, auto-cleanup any stale desktop sessions older than 3 minutes
    // This prevents false positives from crashed/force-quit desktop apps
    await pool.query(`
      UPDATE watch_sessions
      SET end_time = NOW(),
          completed = false
      WHERE user_id = $1
        AND end_time IS NULL
        AND user_agent ILIKE '%electron%'
        AND start_time < NOW() - INTERVAL '3 minutes'
    `, [userId]);

    // Now check for RECENT active desktop sessions (last 3 minutes)
    // Check user_agent for "Electron", not device_type
    const result = await pool.query(`
      SELECT COUNT(*) as desktop_count
      FROM watch_sessions
      WHERE user_id = $1
        AND end_time IS NULL
        AND user_agent ILIKE '%electron%'
        AND start_time > NOW() - INTERVAL '3 minutes'
    `, [userId]);

    const hasDesktopSession = parseInt(result.rows[0]?.desktop_count || 0) > 0;
    
    console.log(`🔍 Session status check for user ${userId}: ${hasDesktopSession ? 'DESKTOP ACTIVE' : 'NO DESKTOP'}`);
    
    res.json({ 
      hasDesktopSession,
      conflictDetected: hasDesktopSession
    });
  } catch (error) {
    console.error('❌ Error in session-status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Track request counts per user
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 5000; // Max requests per minute

// MODIFY rate limiting to be very generous for event-driven architecture
const VIDEO_RATE_LIMIT_WINDOW = 60000; // 60 seconds (1 minute)
const MAX_VIDEO_REQUESTS = 999999; // Very generous - we won't hit this with event-driven pattern

// ============================================================
// 🔍 DEBUGGING: Request tracking dashboard
// ============================================================
const requestTracker = {
  counts: new Map(), // Track requests per endpoint per user
  startTime: Date.now(),
  
  track(endpoint, userId, method = 'ANY') {
    const key = `${method}_${endpoint}_${userId || 'anonymous'}`;
    const current = this.counts.get(key) || { count: 0, lastRequest: 0 };
    current.count++;
    current.lastRequest = Date.now();
    this.counts.set(key, current);
  },
  
  getStats() {
    const stats = {};
    const uptimeMinutes = (Date.now() - this.startTime) / 60000;
    
    for (const [key, data] of this.counts.entries()) {
      const requestsPerMinute = (data.count / uptimeMinutes).toFixed(2);
      stats[key] = {
        total: data.count,
        perMinute: requestsPerMinute,
        lastRequest: new Date(data.lastRequest).toLocaleTimeString()
      };
    }
    
    return stats;
  },
  
  printDashboard() {
    console.log('\n========================================');
    console.log('📊 REQUEST TRACKING DASHBOARD');
    console.log('========================================');
    
    const stats = this.getStats();
    const sorted = Object.entries(stats).sort((a, b) => b[1].total - a[1].total);
    
    for (const [key, data] of sorted) {
      const [method, endpoint, userId] = key.split('_');
      console.log(`${endpoint} (${method})`);
      console.log(`  User: ${userId}`);
      console.log(`  Total: ${data.total} requests`);
      console.log(`  Rate: ${data.perMinute} req/min`);
      console.log(`  Last: ${data.lastRequest}`);
      console.log('----------------------------------------');
    }
    
    console.log('========================================\n');
  }
};

// Print dashboard every 30 seconds
// TEMPORARILY DISABLED FOR CLEANER CONSOLE OUTPUT
// setInterval(() => {
//   requestTracker.printDashboard();
// }, 30000);

// Rate limiting middleware for tracking endpoints
function trackingRateLimit(req, res, next) {
  const userId = req.user?.userId;
  const username = req.user?.username || 'unknown';
  const endpoint = req.path;
  
  if (!userId) return next();
  
  const now = Date.now();
  const userRequests = requestCounts.get(userId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
  
  // Reset if window expired
  if (now > userRequests.resetTime) {
    console.log(`🔄 Rate limit reset for user ${username} (${userId})`);
    console.log(`   Previous window: ${userRequests.count} requests`);
    userRequests.count = 0;
    userRequests.resetTime = now + RATE_LIMIT_WINDOW;
  }
  
  userRequests.count++;
  requestCounts.set(userId, userRequests);
  
  console.log(`📊 Tracking rate limit check: ${username} @ ${endpoint}`);
  console.log(`   Current: ${userRequests.count}/${MAX_REQUESTS} requests`);
  console.log(`   Window resets in: ${Math.ceil((userRequests.resetTime - now) / 1000)}s`);
  
  if (userRequests.count > MAX_REQUESTS) {
    console.error(`🚨 TRACKING RATE LIMIT EXCEEDED for ${username} (${userId})`);
    console.error(`   Endpoint: ${endpoint}`);
    console.error(`   Request count: ${userRequests.count}/${MAX_REQUESTS}`);
    
    return res.status(429).json({ 
      error: 'Too many requests',
      message: 'Please slow down. Try again in a minute.',
      retryAfter: Math.ceil((userRequests.resetTime - now) / 1000),
      debug: {
        currentCount: userRequests.count,
        limit: MAX_REQUESTS,
        windowEndsIn: Math.ceil((userRequests.resetTime - now) / 1000)
      }
    });
  }
  
  next();
}

// Video-specific rate limiting (more generous)
function videoRateLimit(req, res, next) {
  const userId = req.user?.userId;
  const username = req.user?.username || 'unknown';
  const endpoint = req.path;
  
  if (!userId) return next();
  
  const now = Date.now();
  const key = `video_${userId}`;
  const userRequests = requestCounts.get(key) || { 
    count: 0, 
    resetTime: now + VIDEO_RATE_LIMIT_WINDOW,
    requests: [] // Track individual requests
  };
  
  if (now > userRequests.resetTime) {
    console.log(`🔄 Video rate limit reset for user ${username} (${userId})`);
    console.log(`   Previous window: ${userRequests.count} requests`);
    if (userRequests.requests.length > 0) {
      console.log(`   Top endpoints:`);
      const endpointCounts = {};
      userRequests.requests.forEach(r => {
        endpointCounts[r.endpoint] = (endpointCounts[r.endpoint] || 0) + 1;
      });
      Object.entries(endpointCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([endpoint, count]) => {
          console.log(`     ${endpoint}: ${count} calls`);
        });
    }
    
    userRequests.count = 0;
    userRequests.resetTime = now + VIDEO_RATE_LIMIT_WINDOW;
    userRequests.requests = [];
  }
  
  userRequests.count++;
  userRequests.requests.push({
    endpoint: endpoint,
    timestamp: now,
    timeString: new Date(now).toLocaleTimeString()
  });
  requestCounts.set(key, userRequests);
  
  console.log(`📊 Video rate limit check: ${username} @ ${endpoint}`);
  console.log(`   Current: ${userRequests.count}/${MAX_VIDEO_REQUESTS} requests`);
  console.log(`   Window resets in: ${Math.ceil((userRequests.resetTime - now) / 1000)}s`);
  
  if (userRequests.count > MAX_VIDEO_REQUESTS) {
    console.error(`🚨 VIDEO RATE LIMIT EXCEEDED for ${username} (${userId})`);
    console.error(`   Endpoint: ${endpoint}`);
    console.error(`   Request count: ${userRequests.count}/${MAX_VIDEO_REQUESTS}`);
    console.error(`   Recent requests (last 10):`);
    userRequests.requests.slice(-10).forEach(r => {
      console.error(`     ${r.timeString} - ${r.endpoint}`);
    });
    
    return res.status(429).json({ 
      error: 'Too many requests', 
      message: 'Please slow down your requests',
      retryAfter: Math.ceil((userRequests.resetTime - now) / 1000),
      debug: {
        currentCount: userRequests.count,
        limit: MAX_VIDEO_REQUESTS,
        windowEndsIn: Math.ceil((userRequests.resetTime - now) / 1000)
      }
    });
  }
  
  next();
}

// ADD a database connection middleware for all tracking endpoints
function withDatabaseConnection(handler) {
  return async (req, res, next) => {
    let client = null;
    try {
      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Database connection not available' });
      }
      
      client = await pool.connect();
      req.dbClient = client;
      
      // Call the handler
      await handler(req, res, next);
      
    } catch (error) {
      console.error('❌ Database connection error:', error);
      
      // Don't send database errors to client
      if (error.message && (error.message.includes('database') || error.message.includes('connection'))) {
        if (!res.headersSent) {
          return res.status(500).json({ error: 'Database temporarily unavailable' });
        }
      }
      
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Internal server error' });
      }
    } finally {
      // ALWAYS release the client back to the pool
      if (client) {
        try {
          client.release();
        } catch (releaseError) {
          console.error('❌ Error releasing database client:', releaseError);
        }
      }
    }
  };
}

// Server-side request deduplication for start-session
const recentSessionStarts = new Map();
const SESSION_DEDUP_WINDOW = 5000; // 5 seconds

// Start watching session
app.post('/api/tracking/start-session', authenticateToken, async (req, res) => {
  console.log('🎬 START-SESSION ENDPOINT CALLED');
  console.log('🎬 Request body:', req.body);
  console.log('🎬 User from auth:', req.user);
  
  let client = null;
  try {
    const { videoName, quality } = req.body;
    const userId = req.user.userId;
    const username = req.user.username;
    const userIP = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    // Layer 4: Server-side request deduplication
    const dedupKey = `${userId}_${videoName}_${quality}`;
    const now = Date.now();
    
    // Clean up old entries
    for (const [key, timestamp] of recentSessionStarts.entries()) {
      if (now - timestamp > SESSION_DEDUP_WINDOW) {
        recentSessionStarts.delete(key);
      }
    }
    
    // Check if we have a recent duplicate request
    if (recentSessionStarts.has(dedupKey)) {
      console.log(`⏸️ Duplicate session start request detected for ${username}, returning cached sessionId`);
      // Return a cached session ID if available
      const pool = getPool();
      if (pool) {
        try {
          const client = await pool.connect();
          const result = await client.query(
            `SELECT id FROM watch_sessions 
             WHERE user_id = $1 AND end_time IS NULL 
             ORDER BY start_time DESC LIMIT 1`,
            [userId]
          );
          client.release();
          
          if (result.rows.length > 0) {
            return res.json({ sessionId: result.rows[0].id });
          }
        } catch (error) {
          console.error('Error fetching cached session:', error);
        }
      }
      return res.status(409).json({ error: 'Session already active' });
    }
    
    // Record this request
    recentSessionStarts.set(dedupKey, now);

    console.log(`🔍 Checking for active sessions for user ${username} (ID: ${userId})`);
    
    // Get database pool for direct queries
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // ADD connection check before querying
    try {
      client = await pool.connect();
    } catch (connectionError) {
      console.error('❌ Failed to get database connection:', connectionError);
      return res.status(500).json({ error: 'Database temporarily unavailable' });
    }
    
    // Find any incomplete sessions for this user using the connected client
    // Only check sessions from the last 3 minutes to prevent stale sessions from blocking
    const activeSessionsResult = await client.query(
      `SELECT id, video_name, start_time, user_agent 
       FROM watch_sessions 
       WHERE user_id = $1 
         AND end_time IS NULL 
         AND start_time > NOW() - INTERVAL '3 minutes'`,
      [userId]
    );
    
    // Check for desktop app precedence - only treat as desktop app if user agent explicitly contains "Electron"
    const currentUserAgent = userAgent || '';
    const isDesktopApp = currentUserAgent.toLowerCase().includes('electron');
    
    if (activeSessionsResult.rows.length > 0) {
      // Check if there's an active desktop session - only sessions with "Electron" in user agent
      const desktopSessions = activeSessionsResult.rows.filter(session => 
        session.user_agent && session.user_agent.toLowerCase().includes('electron')
      );
      
      const hasDesktopSession = desktopSessions.length > 0;
      
      // Desktop app precedence rule
      if (hasDesktopSession && !isDesktopApp) {
        // Desktop session exists, but this is a web request - BLOCK IT
        console.log(`🚫 Blocking web session for ${username} - desktop session active`);
        return res.status(409).json({ 
          error: 'Multiple watch sessions detected',
          message: 'Desktop app is currently active. Please close the desktop app to watch on the website.',
          conflictType: 'desktop_active',
          hasActiveDesktopSession: true
        });
      }
      
      // If we get here, either:
      // 1. This is a desktop app request (takes precedence)
      // 2. No desktop sessions exist, so web session is allowed
      
      console.log(`⚠️ Found ${activeSessionsResult.rows.length} active session(s) for ${username}, closing them`);
      
      for (const session of activeSessionsResult.rows) {
        // Ensure duration is never negative (handles timezone issues)
        const duration = Math.max(0, Math.floor((Date.now() - new Date(session.start_time).getTime()) / 1000));
        console.log(`🔚 Auto-completing session ${session.id} (${session.video_name}) - ${duration}s`);
        
        // Complete the old session using connected client
        await client.query(
          `UPDATE watch_sessions 
           SET end_time = CURRENT_TIMESTAMP, 
               duration_seconds = $2, 
               completed = false 
           WHERE id = $1`,
          [session.id, duration]
        );
        
        // Also close any active ad tracking for this session
        await client.query(
          `UPDATE ad_tracking 
           SET ad_end_time = CURRENT_TIMESTAMP, 
               duration_seconds = $2,
               completed = false 
           WHERE session_id = $1 AND ad_end_time IS NULL`,
          [session.id, duration]
        );
      }
      
      console.log(`✅ All previous sessions closed for ${username}`);
    }
    
    // Now create the new session
    const sessionData = {
      userId: userId,
      videoName: videoName,
      quality: quality,
      userIP: userIP,
      userAgent: userAgent
    };

    const [err, sessionId] = await dbHelpers.createWatchSession(sessionData);
    if (err) {
      console.error('❌ Failed to create session:', err);
      return res.status(500).json({ error: 'Failed to start session' });
    }

    console.log(`✅ New session ${sessionId} started for ${username}`);
    res.json({
      sessionId: sessionId,
      message: 'Session started'
    });
  } catch (error) {
    console.error('❌ Error in start-session:', error);
    
    // Don't send database errors to client
    if (error.message && (error.message.includes('database') || error.message.includes('connection'))) {
      return res.status(500).json({ error: 'Service temporarily unavailable' });
    }
    
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    // ALWAYS release the client back to the pool
    if (client) {
      try {
        client.release();
      } catch (releaseError) {
        console.error('❌ Error releasing database client:', releaseError);
      }
    }
  }
});

// Clean up old desktop sessions (for debugging and manual cleanup)
app.post('/api/tracking/cleanup-desktop-sessions', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    console.log(`🧹 Cleaning up old Electron app sessions for ${username}`);
    
    // ONLY close sessions that have "Electron" in the user agent
    const result = await pool.query(
      `UPDATE watch_sessions 
       SET end_time = CURRENT_TIMESTAMP, 
           duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - start_time))::INTEGER),
           completed = false
       WHERE user_id = $1 
       AND user_agent ILIKE '%electron%'
       AND end_time IS NULL
       RETURNING id, video_name, duration_seconds, user_agent`,
      [userId]
    );
    
    console.log(`✅ Cleaned up ${result.rowCount} Electron app sessions`);
    if (result.rowCount > 0) {
      console.log('Closed sessions:', result.rows.map(r => ({
        id: r.id,
        video: r.video_name,
        userAgent: r.user_agent?.substring(0, 50)
      })));
    }
    
    res.json({
      success: true,
      cleanedSessions: result.rowCount,
      message: `Cleaned up ${result.rowCount} Electron app sessions`
    });
    
  } catch (error) {
    console.error('❌ Error cleaning up sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Debug endpoint to see all sessions for a user
app.get('/api/debug/sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Get all sessions for this user from the last hour
    const result = await pool.query(
      `SELECT id, video_name, start_time, end_time, user_agent, user_ip, completed
       FROM watch_sessions 
       WHERE user_id = $1 
       AND start_time > NOW() - INTERVAL '1 hour'
       ORDER BY start_time DESC`,
      [userId]
    );
    
    console.log(`🔍 Debug: All sessions for ${username}:`, result.rows);
    
    res.json({
      username: username,
      userId: userId,
      sessions: result.rows,
      sessionCount: result.rows.length
    });
    
  } catch (error) {
    console.error('❌ Error in debug sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete watching session
app.post('/api/tracking/complete-session', authenticateToken, async (req, res) => {
  try {
    const { sessionId, durationSeconds, completed, pausedCount } = req.body;
    const minutesWatched = Math.floor(durationSeconds / 60);

    // Complete the session
    const [err] = await dbHelpers.updateWatchSession(sessionId, {
      end_time: new Date(),
      duration_seconds: durationSeconds,
      completed: completed,
      paused_count: pausedCount || 0
    });

    if (err) {
      console.error('Error completing session:', err);
      return res.status(500).json({ error: 'Failed to complete session' });
    }

    // Note: Watch time is now tracked per-ad via updateWatchSeconds, not per-session
    // This prevents double-tracking and ensures immediate minute updates

    res.json({
      message: 'Session completed',
      minutesWatched: minutesWatched
    });
  } catch (error) {
    console.error('Error in complete-session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== AD TRACKING ENDPOINTS =====

// Start ad tracking
app.post('/api/tracking/start-ad', authenticateToken, trackingRateLimit, async (req, res) => {
  console.log('📺 START-AD ENDPOINT CALLED');
  console.log('📺 Request body:', req.body);
  console.log('📺 User from auth:', req.user);
  
  try {
    const { sessionId } = req.body;
    
    const [err, adTrackingId] = await dbHelpers.startAdTracking(req.user.userId, sessionId);
    if (err) {
      console.error('Error starting ad tracking:', err);
      return res.status(500).json({ error: 'Failed to start ad tracking' });
    }

    console.log(`📺 Ad tracking started for user ${req.user.userId}, session ${sessionId}`);
    res.json({
      adTrackingId: adTrackingId,
      message: 'Ad tracking started'
    });
  } catch (error) {
    console.error('Error in start-ad:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete ad tracking
// Track click on advertiser campaign
app.post('/api/track-click', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const { campaign_id } = req.body;
    
    if (!campaign_id) {
      return res.status(400).json({ error: 'campaign_id is required' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Increment weekly_clicks, total_clicks, and weekly_contributed_amount for the campaign (atomic operation)
    // Each click contributes $0.25 to weekly_contributed_amount
    const clickContribution = 0.25;
    const result = await pool.query(`
      UPDATE advertisers
      SET weekly_clicks = COALESCE(weekly_clicks, 0) + 1,
          total_clicks = COALESCE(total_clicks, 0) + 1,
          weekly_contributed_amount = weekly_contributed_amount + $2
      WHERE id = $1
        AND status = 'active'
        AND payment_completed = TRUE
      RETURNING weekly_clicks, total_clicks
    `, [campaign_id, clickContribution]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or not eligible for click tracking' });
    }
    
    // Fetch updated weekly_contributed_amount for logging
    const contributionResult = await pool.query(
      `SELECT weekly_contributed_amount FROM advertisers WHERE id = $1`,
      [campaign_id]
    );
    const updatedContribution = contributionResult.rows[0]?.weekly_contributed_amount || 0;
    
    console.log(`✅ Click tracked for campaign ${campaign_id}, weekly_clicks: ${result.rows[0].weekly_clicks}, total_clicks: ${result.rows[0].total_clicks}, contributionDelta: $${clickContribution.toFixed(2)}, weeklyContributedAmount: $${parseFloat(updatedContribution).toFixed(2)}`);
    
    return res.json({ 
      success: true,
      campaign_id: campaign_id,
      weekly_clicks: result.rows[0].weekly_clicks,
      total_clicks: result.rows[0].total_clicks
    });
  } catch (error) {
    console.error('❌ Error tracking click:', error);
    return res.status(500).json({ error: 'Failed to track click' });
  }
});

// UTC Monday of current week (ISO week start) as YYYY-MM-DD — used as weekly rollup key for sponsor metrics
function getSponsorWeekStartDateUTC() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}

// ===== SPONSOR CLICK TRACKING (sponsor_campaigns only; no advertiser tables) =====
app.post('/api/sponsor-clicks/record', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const { sponsorCampaignId } = req.body;
    if (!sponsorCampaignId) {
      return res.status(400).json({ success: false, error: 'sponsorCampaignId is required' });
    }
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    const weekStartDate = getSponsorWeekStartDateUTC();
    const result = await pool.query(`
      UPDATE sponsor_campaigns
      SET
        weekly_impressions = CASE WHEN weekly_rollup_date IS DISTINCT FROM $2::date THEN 0 ELSE COALESCE(weekly_impressions, 0) END,
        weekly_clicks = (CASE WHEN weekly_rollup_date IS DISTINCT FROM $2::date THEN 0 ELSE COALESCE(weekly_clicks, 0) END) + 1,
        weekly_unique_viewers = CASE WHEN weekly_rollup_date IS DISTINCT FROM $2::date THEN 0 ELSE COALESCE(weekly_unique_viewers, 0) END,
        weekly_rollup_date = $2::date,
        clicks_total = COALESCE(clicks_total, 0) + 1,
        updated_at = NOW()
      WHERE id = $1
      RETURNING clicks_total, weekly_clicks
    `, [sponsorCampaignId, weekStartDate]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sponsor campaign not found' });
    }
    console.log(`✅ Sponsor click recorded: campaign ${sponsorCampaignId}, clicks_total=${result.rows[0].clicks_total}, weekly_clicks=${result.rows[0].weekly_clicks}`);
    return res.json({
      success: true,
      sponsorCampaignId,
      clicks_total: Number(result.rows[0].clicks_total),
      weekly_clicks: Number(result.rows[0].weekly_clicks)
    });
  } catch (error) {
    console.error('❌ Error recording sponsor click:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/tracking/complete-ad', authenticateToken, trackingRateLimit, async (req, res) => {
  console.log('🚨 COMPLETE-AD ENDPOINT HIT');
  console.log('✅ COMPLETE-AD ENDPOINT CALLED');
  console.log('✅ Request body:', req.body);
  console.log('✅ User from auth:', req.user);
  
  try {
    const { adTrackingId, durationSeconds, completed = true } = req.body;
    
    console.log('🔍 Processing ad completion:', {
      adTrackingId: adTrackingId,
      userId: req.user.userId,
      timestamp: new Date().toISOString()
    });
    
    // Check if this ad tracking ID has already been completed
    const pool = getPool();
    if (pool) {
      try {
        const checkResult = await pool.query(
          'SELECT id, completed FROM ad_tracking WHERE id = $1',
          [adTrackingId]
        );
        
        if (checkResult.rows.length > 0) {
          const existingTracking = checkResult.rows[0];
          if (existingTracking.completed) {
            console.log('⚠️ Ad tracking ID already completed:', adTrackingId);
            return res.json({
              message: 'Ad tracking already completed',
              durationSeconds: durationSeconds
            });
          }
        } else {
          console.log('❌ Ad tracking ID not found:', adTrackingId);
          return res.status(404).json({ error: 'Ad tracking ID not found' });
        }
      } catch (checkError) {
        console.error('Error checking ad tracking status:', checkError);
      }
    }
    
    const [err, adTracking] = await dbHelpers.completeAdTracking(adTrackingId, durationSeconds, completed);
    if (err) {
      console.error('Error completing ad tracking:', err);
      return res.status(500).json({ error: 'Failed to complete ad tracking' });
    }

    // Update daily stats and user's monthly minutes if ad was completed
    if (completed && durationSeconds > 0) {
      console.log('📊 UPDATE-DAILY-STATS - EXECUTING:', {
        userId: req.user.userId,
        adsWatched: 1,
        watchTimeSeconds: durationSeconds
      });
      
      const [statsErr] = await dbHelpers.updateDailyStats(req.user.userId, 1, durationSeconds);
      if (statsErr) {
        console.error('❌ Error updating daily stats:', statsErr);
      } else {
        console.log(`✅ Updated daily stats for user ${req.user.userId}`);
        
        // CRITICAL FIX: Invalidate user impact cache immediately after ad completion
        const cacheKey = `impact_${req.user.userId}`;
        userImpactCache.delete(cacheKey);
        console.log(`🗑️ Invalidated impact cache for user ${req.user.userId} after ad completion`);
      }

      // Update user's total and monthly watch time (record seconds every time an ad completes)
      const secondsWatched = parseInt(durationSeconds, 10) || 0;
      console.log('🔍 Backend received ad completion:', {
        userId: req.user.userId,
        username: req.user.username,
        durationSeconds: durationSeconds,
        parsedSeconds: secondsWatched,
        willUpdateMonthly: secondsWatched > 0
      });
      if (secondsWatched > 0) {
        console.log('⏱️ UPDATE-WATCH-SECONDS - EXECUTING:', {
          userId: req.user.userId,
          secondsWatched: secondsWatched
        });
        
        const [watchTimeErr, updatedUser] = await dbHelpers.updateWatchSeconds(req.user.userId, secondsWatched);
        if (watchTimeErr) {
          console.error('❌ Error updating watch seconds:', watchTimeErr);
        } else {
          console.log(`✅ ${req.user.username} watched ${secondsWatched} seconds (${durationSeconds} sec) - Total: ${updatedUser.total_seconds_watched}s, Monthly: ${updatedUser.current_month_seconds}s`);
        }
      } else {
        console.log('⚠️ No seconds to update (secondsWatched = 0)');
      }
    }

    res.json({
      message: 'Ad tracking completed',
      durationSeconds: durationSeconds
    });
  } catch (error) {
    console.error('Error in complete-ad:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== IMPRESSIONS TRACKING =====

// Utility function to get start of week (Sunday 00:00)
function startOfWeekSundayMidnight(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, etc.
  const diff = d.getDate() - day; // Days to subtract to get to Sunday
  const sunday = new Date(d.setDate(diff));
  sunday.setHours(0, 0, 0, 0);
  return sunday;
}

// Utility function to get next calendar week start (next Sunday 00:00)
function getNextCalendarWeekStart() {
  const now = new Date();
  const currentWeekStart = startOfWeekSundayMidnight(now);
  const nextWeekStart = new Date(currentWeekStart);
  nextWeekStart.setDate(nextWeekStart.getDate() + 7);
  return nextWeekStart;
}

// Utility function to get next Monday 00:00 (for recurring sponsor billing alignment)
function getNextMondayMidnight() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  nextMonday.setHours(0, 0, 0, 0);
  return nextMonday;
}

// Utility function to get next Monday 00:00 strictly after a given base date
function getNextMondayMidnightAfter(baseDate) {
  const dayOfWeek = baseDate.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  // If baseDate is Monday, we want the NEXT Monday (7 days later)
  // Otherwise, compute days until next Monday from baseDate
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7 || 7;
  const nextMonday = new Date(baseDate);
  nextMonday.setDate(baseDate.getDate() + daysUntilMonday);
  nextMonday.setHours(0, 0, 0, 0);
  return nextMonday;
}

// Returns a Date (UTC) representing next Monday 00:00:00 America/Los_Angeles
// If today is Monday in LA, returns the following Monday (7 days out)
function getNextMondayLA(from = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  });
  const parts = formatter.formatToParts(from);
  const laValues = {};
  parts.forEach(part => {
    if (part.type !== 'literal') laValues[part.type] = part.value;
  });
  const year = parseInt(laValues.year);
  const month = parseInt(laValues.month);
  const day = parseInt(laValues.day);
  const weekdayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  const weekday = weekdayMap[laValues.weekday] ?? 1;
  const daysUntilMonday = weekday === 1 ? 7 : (weekday === 0 ? 1 : 8 - weekday);
  const nextMondayDate = new Date(year, month - 1, day + daysUntilMonday);
  const nmYear = nextMondayDate.getFullYear();
  const nmMonth = nextMondayDate.getMonth() + 1;
  const nmDay = nextMondayDate.getDate();
  const isDST = nmMonth >= 3 && nmMonth <= 11;
  const offsetHours = isDST ? 7 : 8;
  return new Date(Date.UTC(nmYear, nmMonth - 1, nmDay, offsetHours, 0, 0, 0));
}

// Utility function to create slug from organization name
// Converts: "Pizza Steve, Inc." → "pizza-steve-inc"
function createOrganizationSlug(organizationName) {
  return organizationName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

// ===== WEEKLY RESET SYSTEM =====

// Perform weekly reset for paid campaigns (active or archived status)
async function performWeeklyReset() {
  try {
    const pool = getPool();
    if (!pool) {
      console.error("❌ [WEEKLY RESET] Weekly reset failed: no database pool");
      return { success: false, error: 'Database pool not available' };
    }

    console.log("🔄 [WEEKLY RESET] Starting advertiser weekly reset...");
    console.log("🔄 [WEEKLY RESET] Reset time:", new Date().toISOString());

    // Pre-reset check: Get current state of advertisers
    // CRITICAL: Only reset campaigns where payment_completed = TRUE (exclude abandoned signups)
    // Note: Archived campaigns are included in reset to ensure weekly_contributed_amount resets correctly
    const preCheck = await pool.query(`
      SELECT id, current_week_impressions, capped, status, recurring_weekly, weekly_contributed_amount
      FROM advertisers
      WHERE payment_completed = TRUE AND status IN ('active', 'archived')
    `);
    console.log(`📊 [WEEKLY RESET] Pre-reset: Found ${preCheck.rows.length} advertisers to reset`);
    console.log("📊 [WEEKLY RESET] Pre-reset advertiser states:", preCheck.rows.map(ad => ({
      id: ad.id,
      impressions: ad.current_week_impressions,
      capped: ad.capped,
      recurring: ad.recurring_weekly
    })));

    // Reset paid campaigns (active or archived) so weekly_contributed_amount does not carry across weeks
    const result = await pool.query(`
      UPDATE advertisers
      SET 
        current_week_impressions = 0,
        weekly_clicks = 0,
        weekly_contributed_amount = 0,
        capped = FALSE,
        current_week_start = NOW(),
        updated_at = NOW()
      WHERE payment_completed = TRUE 
        AND status IN ('active', 'archived')
    `);
    
    // Try to reset optional columns if they exist (gracefully handle if they don't)
    try {
      await pool.query(`
        UPDATE advertisers
        SET weekly_clicks = 0
        WHERE payment_completed = TRUE
          AND status = 'active'
      `);
      console.log("✅ [WEEKLY RESET] Reset weekly_clicks");
    } catch (err) {
      if (err.message.includes('column "weekly_clicks" does not exist')) {
        console.log("⚠️ [WEEKLY RESET] weekly_clicks column does not exist - skipping");
      } else {
        console.error("❌ [WEEKLY RESET] Error resetting weekly_clicks:", err.message);
      }
    }
    
    try {
      await pool.query(`
        UPDATE advertisers
        SET weekly_charge_amount = 0
        WHERE payment_completed = TRUE
          AND status = 'active'
      `);
      console.log("✅ [WEEKLY RESET] Reset weekly_charge_amount");
    } catch (err) {
      if (err.message.includes('column "weekly_charge_amount" does not exist')) {
        console.log("⚠️ [WEEKLY RESET] weekly_charge_amount column does not exist - skipping");
      } else {
        console.error("❌ [WEEKLY RESET] Error resetting weekly_charge_amount:", err.message);
      }
    }
    
    try {
      await pool.query(`
        UPDATE advertisers
        SET last_billing_date = NOW()
        WHERE payment_completed = TRUE
          AND status = 'active'
      `);
      console.log("✅ [WEEKLY RESET] Updated last_billing_date");
    } catch (err) {
      if (err.message.includes('column "last_billing_date" does not exist')) {
        console.log("⚠️ [WEEKLY RESET] last_billing_date column does not exist - skipping");
      } else {
        console.error("❌ [WEEKLY RESET] Error updating last_billing_date:", err.message);
      }
    }

    console.log(`✅ [WEEKLY RESET] Reset ${result.rowCount} advertisers`);

    // Post-reset check: Verify the reset
    // Note: Includes archived campaigns to verify weekly_contributed_amount reset
    const postCheck = await pool.query(`
      SELECT id, current_week_impressions, capped, current_week_start, status, weekly_contributed_amount
      FROM advertisers
      WHERE payment_completed = TRUE AND status IN ('active', 'archived')
    `);
    console.log("📊 [WEEKLY RESET] Post-reset states:", postCheck.rows.map(ad => ({
      id: ad.id,
      impressions: ad.current_week_impressions,
      capped: ad.capped,
      weekStart: ad.current_week_start,
      status: ad.status,
      weeklyContributedAmount: parseFloat(ad.weekly_contributed_amount || 0).toFixed(2)
    })));

    // Clear playlist cache so new resets reflect instantly
    if (playlistCache) {
      playlistCache.clear();
      console.log("🧽 [WEEKLY RESET] Cleared playlist cache");
    }

    console.log("✅ [WEEKLY RESET] Weekly reset completed successfully");
    return { 
      success: true, 
      advertisersReset: result.rowCount,
      timestamp: new Date().toISOString()
    };

  } catch (err) {
    console.error("❌ [WEEKLY RESET] Error:", err);
    console.error("❌ [WEEKLY RESET] Error stack:", err.stack);
    return { success: false, error: err.message };
  }
}

// Record impression for an advertiser video
app.post('/api/impressions/record', async (req, res) => {
  try {
    const { advertiserId, videoFilename } = req.body;
    
    // Validation: If advertiserId OR videoFilename is NULL → return 200 OK (do nothing)
    // This protects old videos without impression tracking
    if (!advertiserId || !videoFilename) {
      console.log('📊 Impression skipped - old video without tracking:', { advertiserId, videoFilename });
      return res.status(200).json({ success: true, message: 'Skipped (old video)' });
    }
    
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Look up advertiser by id
    // CRITICAL: Only record impressions for campaigns where payment_completed = TRUE (exclude abandoned signups)
    const advertiserResult = await pool.query(
      `SELECT id, video_filename, status, payment_completed, recurring_weekly, 
              current_week_start, campaign_start_date, current_week_impressions, total_impressions,
              is_paused, max_weekly_impressions, capped, weekly_budget_cap, cpm_rate,
              weekly_contributed_amount
       FROM advertisers 
       WHERE id = $1`,
      [advertiserId]
    );
    
    if (advertiserResult.rows.length === 0) {
      console.log('⚠️ Advertiser not found:', advertiserId);
      return res.status(200).json({ success: true, message: 'Advertiser not found (ignored)' });
    }
    
    const advertiser = advertiserResult.rows[0];
    
    // Validate advertiser is live (active) and paid
    if (advertiser.status !== 'active' || !advertiser.payment_completed) {
      console.log('⚠️ Advertiser not active or payment incomplete:', advertiserId, {
        status: advertiser.status,
        payment_completed: advertiser.payment_completed
      });
      return res.status(200).json({ success: true, message: 'Advertiser not active (ignored)' });
    }
    
    // CRITICAL: Paused campaigns must NOT accrue impressions (defense-in-depth for billing integrity)
    // This check is authoritative and server-side, independent of playlist logic
    if (advertiser.is_paused === true) {
      console.log('⏸️ Impression skipped - campaign is paused:', advertiserId);
      return res.status(200).json({ success: true, message: 'Skipped (campaign paused)' });
    }
    
    // Validate advertiser.video_filename matches the provided filename (avoid tampering)
    if (advertiser.video_filename !== videoFilename) {
      console.log('⚠️ Video filename mismatch:', {
        provided: videoFilename,
        expected: advertiser.video_filename
      });
      return res.status(400).json({ error: 'Video filename mismatch' });
    }
    
    const now = new Date();
    const isRecurring = advertiser.recurring_weekly === true;
    
    // Weekly reset logic
    let currentWeekStart = advertiser.current_week_start;
    let currentWeekImpressions = advertiser.current_week_impressions || 0;
    
    // Initialize current_week_start if null
    if (!currentWeekStart) {
      currentWeekStart = startOfWeekSundayMidnight(now);
    }
    
    // Check if we need to reset (7 days have passed)
    const weekStartTime = new Date(currentWeekStart).getTime();
    const nowTime = now.getTime();
    const daysSinceWeekStart = (nowTime - weekStartTime) / (1000 * 60 * 60 * 24);
    
    if (daysSinceWeekStart >= 7) {
      console.log('🔄 Resetting weekly impressions for advertiser:', advertiserId);
      currentWeekImpressions = 0;
      currentWeekStart = startOfWeekSundayMidnight(now);
    }
    
    // For non-recurring campaigns: guard against premature impressions (before go-live)
    if (!isRecurring && advertiser.campaign_start_date) {
      const campaignStart = new Date(advertiser.campaign_start_date);
      if (now < campaignStart) {
        console.log('⚠️ Campaign not started yet for advertiser:', advertiserId);
        return res.status(200).json({ success: true, message: 'Campaign not started (ignored)' });
      }
    }
    
    // For non-recurring campaigns, check if campaign has ended (7 days after go-live)
    if (!isRecurring && advertiser.campaign_start_date) {
      const campaignStart = new Date(advertiser.campaign_start_date);
      const campaignEnd = new Date(campaignStart);
      campaignEnd.setDate(campaignEnd.getDate() + 7); // 7 days from start
      
      if (now > campaignEnd) {
        console.log('⚠️ Campaign has ended for advertiser:', advertiserId);
        return res.status(200).json({ success: true, message: 'Campaign ended (ignored)' });
      }
    }
    
    // Update impressions
    const totalImpressions = (advertiser.total_impressions || 0) + 1;
    currentWeekImpressions += 1;
    
    // CRITICAL: Check if weekly cap is hit AFTER incrementing impressions
    const maxWeeklyImpressions = advertiser.max_weekly_impressions;
    const capHit = maxWeeklyImpressions !== null && 
                   currentWeekImpressions >= maxWeeklyImpressions && 
                   !advertiser.capped;
    
    // Prepare update query - set capped and is_paused if cap is hit
    let updateQuery;
    let updateParams;
    
    // Calculate contribution delta for this single impression
    // Formula: (impression_delta / 1000) * cpm_rate
    // Since we're incrementing by 1, delta = 1
    const cpmRate = parseFloat(advertiser.cpm_rate || 0);
    const contributionDelta = (1 / 1000) * cpmRate;
    
    if (capHit) {
      console.log(`🛑 [IMPRESSION RECORD] Cap hit for advertiser ${advertiserId} - impressions (${currentWeekImpressions}) >= max (${maxWeeklyImpressions})`);
      
      // Set capped = TRUE when cap is hit (do NOT set is_paused - that's for manual pauses only)
      // Increment weekly_contributed_amount by the contribution delta for this impression
      updateQuery = `UPDATE advertisers SET
        total_impressions = $1,
        current_week_impressions = $2,
        current_week_start = $3,
        capped = TRUE,
        weekly_contributed_amount = weekly_contributed_amount + $5,
        updated_at = NOW()
       WHERE id = $4`;
      updateParams = [totalImpressions, currentWeekImpressions, currentWeekStart, advertiserId, contributionDelta];
      
      // Clear playlist cache immediately when cap is hit
      playlistCache.clear();
      console.log("🧽 [IMPRESSION RECORD] Cleared playlist cache because advertiser hit weekly cap");
      
      // For non-recurring campaigns, trigger immediate billing and archive when capped
      if (!isRecurring && advertiser.status === 'active' && advertiser.video_filename) {
        console.log(`[CAP HIT] campaignId=${advertiserId} from endpoint=/api/impressions/record triggeredBy=cap_hit`);
        console.log(`[CAP HIT] Non-recurring campaign ${advertiserId} hit cap - triggering immediate billing`);
        
        // Bill immediately with budget cap amount (not calculated impressions)
        // This ensures advertiser pays the full budget they agreed to when cap is hit
        billNonRecurringCampaign({
          campaignId: advertiserId,
          pool: pool,
          useBudgetCap: true // Flag to use weekly_budget_cap instead of calculated amount
        }).then(billingResult => {
          if (billingResult.success && !billingResult.skipped) {
            console.log(`[CAP HIT] campaignId=${advertiserId} - Billing succeeded: invoice ${billingResult.invoiceId}, amount $${billingResult.amount?.toFixed(2)}`);
          } else if (billingResult.skipped) {
            console.log(`[CAP HIT] campaignId=${advertiserId} - Billing skipped: ${billingResult.reason}`);
            // If billing was skipped (e.g., < $0.50), still archive the campaign
            if (billingResult.archived !== true) {
              archiveCampaign(advertiserId, `Non-recurring campaign capped (billing skipped: ${billingResult.reason})`, pool).catch(err => {
                console.error(`[CAP HIT] campaignId=${advertiserId} - Archive error after skipped billing:`, err);
              });
            }
          } else {
            console.error(`[CAP HIT] campaignId=${advertiserId} - Billing failed: ${billingResult.error}`);
            // If billing failed, still archive to stop serving ads
            archiveCampaign(advertiserId, 'Non-recurring campaign capped (billing failed, archived anyway)', pool).catch(err => {
              console.error(`[CAP HIT] campaignId=${advertiserId} - Archive error after billing failure:`, err);
            });
          }
        }).catch(billingError => {
          console.error(`[CAP HIT] campaignId=${advertiserId} - Billing error:`, billingError);
          // If billing threw an error, still archive to stop serving ads
          archiveCampaign(advertiserId, 'Non-recurring campaign capped (billing error, archived anyway)', pool).catch(err => {
            console.error(`[CAP HIT] campaignId=${advertiserId} - Archive error after billing exception:`, err);
          });
        });
      }
    } else {
      // Normal update without cap enforcement
      // Increment weekly_contributed_amount by the contribution delta for this impression
      updateQuery = `UPDATE advertisers SET
        total_impressions = $1,
        current_week_impressions = $2,
        current_week_start = $3,
        weekly_contributed_amount = weekly_contributed_amount + $5,
        updated_at = NOW()
       WHERE id = $4`;
      updateParams = [totalImpressions, currentWeekImpressions, currentWeekStart, advertiserId, contributionDelta];
    }
    
    await pool.query(updateQuery, updateParams);
    
    // Fetch updated weekly_contributed_amount for logging
    const contributionResult = await pool.query(
      `SELECT weekly_contributed_amount FROM advertisers WHERE id = $1`,
      [advertiserId]
    );
    const updatedContribution = contributionResult.rows[0]?.weekly_contributed_amount || 0;
    
    console.log(`📊 Impression recorded for advertiser ${advertiserId}:`, {
      total: totalImpressions,
      currentWeek: currentWeekImpressions,
      videoFilename: videoFilename,
      capHit: capHit,
      paused: capHit,
      contributionDelta: contributionDelta.toFixed(4),
      weeklyContributedAmount: parseFloat(updatedContribution).toFixed(2)
    });
    
    res.json({ 
      success: true,
      totalImpressions: totalImpressions,
      currentWeekImpressions: currentWeekImpressions,
      capped: capHit
    });
    
  } catch (error) {
    console.error('❌ Error recording impression:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== SPONSOR IMPRESSION TRACKING (sponsor_campaigns only; no advertiser tables) =====
// Unique viewer: one anonymous viewer_id (localStorage) per sponsor campaign per week via sponsor_unique_viewers (rollup_date = week start).
app.post('/api/sponsor-impressions/record', async (req, res) => {
  try {
    const { sponsorCampaignId, videoFilename, viewerId } = req.body;
    if (!sponsorCampaignId) {
      return res.status(200).json({ success: true, message: 'Skipped (missing sponsorCampaignId)' });
    }
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    const weekStartDate = getSponsorWeekStartDateUTC();
    let uniqueViewerIncrement = 0;
    if (viewerId && typeof viewerId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(viewerId)) {
      const ins = await pool.query(`
        INSERT INTO sponsor_unique_viewers (sponsor_campaign_id, viewer_id, rollup_date)
        VALUES ($1::uuid, $2::uuid, $3::date)
        ON CONFLICT (sponsor_campaign_id, viewer_id, rollup_date) DO NOTHING
        RETURNING 1
      `, [sponsorCampaignId, viewerId, weekStartDate]);
      uniqueViewerIncrement = ins.rows.length > 0 ? 1 : 0;
    }
    const result = await pool.query(`
      UPDATE sponsor_campaigns
      SET
        weekly_impressions = (CASE WHEN weekly_rollup_date IS DISTINCT FROM $2::date THEN 0 ELSE COALESCE(weekly_impressions, 0) END) + 1,
        weekly_clicks = CASE WHEN weekly_rollup_date IS DISTINCT FROM $2::date THEN 0 ELSE COALESCE(weekly_clicks, 0) END,
        weekly_unique_viewers = (CASE WHEN weekly_rollup_date IS DISTINCT FROM $2::date THEN 0 ELSE COALESCE(weekly_unique_viewers, 0) END) + $4,
        weekly_rollup_date = $2::date,
        impressions_total = COALESCE(impressions_total, 0) + 1,
        updated_at = NOW()
      WHERE id = $1
        AND (($3::text IS NULL) OR (video_r2_key = $3))
        AND status = 'active'
        AND generation_completed = TRUE
      RETURNING impressions_total, weekly_impressions, weekly_unique_viewers
    `, [sponsorCampaignId, weekStartDate, videoFilename || null, uniqueViewerIncrement]);
    if (result.rows.length === 0) {
      return res.status(200).json({ success: true, message: 'Sponsor campaign not found or not active (ignored)' });
    }
    const row = result.rows[0];
    console.log(`✅ Sponsor impression recorded: campaign ${sponsorCampaignId}, impressions_total=${row.impressions_total}, weekly_impressions=${row.weekly_impressions}, weekly_unique_viewers=${row.weekly_unique_viewers}`);
    return res.json({
      success: true,
      sponsorCampaignId,
      impressions_total: Number(row.impressions_total),
      weekly_impressions: Number(row.weekly_impressions),
      weekly_unique_viewers: Number(row.weekly_unique_viewers)
    });
  } catch (error) {
    console.error('❌ Error recording sponsor impression:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Check and enforce impression cap for an advertiser
app.post('/api/advertisers/check-cap', authenticateToken, async (req, res) => {
  try {
    const { advertiserId, videoFilename } = req.body;
    
    // Validation
    if (!advertiserId || !videoFilename) {
      return res.status(200).json({ success: true, message: 'Missing parameters (ignored)' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Get advertiser data
    const advertiserResult = await pool.query(`
      SELECT id, video_filename, current_week_impressions, max_weekly_impressions,
             capped, status, recurring_weekly, is_paused
      FROM advertisers
      WHERE id = $1
    `, [advertiserId]);
    
    if (advertiserResult.rows.length === 0) {
      return res.status(200).json({ success: true, message: 'Advertiser not found (ignored)' });
    }
    
    const ad = advertiserResult.rows[0];
    
    // Validate video filename matches
    if (ad.video_filename !== videoFilename) {
      return res.status(400).json({ error: 'Video filename mismatch' });
    }
    
      // Check if impressions >= max_weekly_impressions → cap the advertiser
      if (ad.max_weekly_impressions !== null && 
          ad.current_week_impressions >= ad.max_weekly_impressions && 
          !ad.capped) {
        console.log(`🛑 Capping advertiser ${advertiserId} - impressions (${ad.current_week_impressions}) >= max (${ad.max_weekly_impressions})`);
        
        // Set capped = TRUE when cap is hit (do NOT set is_paused - that's for manual pauses only)
        await pool.query(`
          UPDATE advertisers
          SET capped = TRUE
          WHERE id = $1
        `, [advertiserId]);
        
        // CLEAR PLAYLIST CACHE IMMEDIATELY when advertiser is capped
        playlistCache.clear();
        console.log("🧽 [CHECK-CAP] Cleared playlist cache because advertiser hit weekly cap");
      
      // Automatic archiving for non-recurring capped campaigns
      // Non-recurring campaigns have recurring_weekly = FALSE
      // If they're capped and active, archive them immediately (move to R2 archived/ folder)
      // TODO: For non-recurring campaigns, when implementing "time left" logic,
      // we need to account for paused duration so only live time counts toward the 7-day window.
      if (ad.recurring_weekly === false && ad.status === 'active' && ad.is_paused === false && ad.video_filename) {
        console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} from endpoint=/api/advertisers/check-cap triggeredBy=auto_capped`);
        
        // Safety guard: Double-check status right before R2 operations (race condition protection)
        const doubleCheckResult = await pool.query(
          `SELECT status FROM advertisers WHERE id = $1`,
          [advertiserId]
        );
        
        if (doubleCheckResult.rows.length === 0) {
          console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - Campaign disappeared during processing`);
          return res.json({ success: true, capped: ad.capped || false, archived: false });
        }
        
        if (doubleCheckResult.rows[0].status === 'archived') {
          console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - Already archived (double-check), skipping R2 operations`);
          return res.json({ success: true, capped: true, archived: true });
        }
        
        try {
          // MOVE FILE IN R2 (copy + delete)
          const CHARITY_BUCKET = 'charity-stream-videos';
          const R2_PUBLIC_URL = R2_VIDEOS_URL;
          const sourceKey = ad.video_filename;
          const destKey = `archived/${ad.video_filename}`;
          
          console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - Starting R2 operations: ${sourceKey} -> ${destKey}`);
          const copyCommand = new CopyObjectCommand({
            Bucket: CHARITY_BUCKET,
            CopySource: `${CHARITY_BUCKET}/${sourceKey}`,
            Key: destKey
          });
          await r2Client.send(copyCommand);
          console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - R2 copy successful: ${sourceKey} -> ${destKey}`);
          
          const deleteCommand = new DeleteObjectCommand({
            Bucket: CHARITY_BUCKET,
            Key: sourceKey
          });
          await r2Client.send(deleteCommand);
          console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - R2 delete successful: ${sourceKey}`);

          // Construct the archived media URL
          const archivedMediaUrl = normalizeBareMediaR2Link(`${R2_PUBLIC_URL}/${destKey}`);
          console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - Updated media_r2_link to archived location: ${archivedMediaUrl}`);
          
          // Update database - use WHERE clause to ensure we only update if not already archived
          // Also update media_r2_link to point to the archived location
          // Reset weekly counters for non-recurring campaigns to prevent stale data
          const updateResult = await pool.query(`
            UPDATE advertisers
            SET status = 'archived',
                archived_at = NOW(),
                archived_reason = 'Non-recurring campaign capped',
                media_r2_link = $2,
                current_week_impressions = 0,
                weekly_clicks = 0
            WHERE id = $1 AND status != 'archived'
            RETURNING id
          `, [advertiserId, archivedMediaUrl]);
          
          if (updateResult.rows.length === 0) {
            // Another process may have archived it
            console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - Database update skipped (already archived by another process)`);
          } else {
            console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - Successfully archived`);
            console.log(`🔄 [CHECK-CAP] Reset weekly counters (current_week_impressions=0, weekly_clicks=0) for non-recurring campaign ${advertiserId}`);
          }
          
          // CLEAR PLAYLIST CACHE when non-recurring advertiser is archived
          playlistCache.clear();
          console.log("🧽 [CHECK-CAP] Cleared playlist cache because non-recurring advertiser was archived");
        } catch (r2Error) {
          console.error(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - R2 error:`, r2Error);
          // Still update database as archived even if R2 move fails - but only if not already archived
          // Note: media_r2_link is NOT updated if R2 operations failed
          // Reset weekly counters for non-recurring campaigns to prevent stale data
          const updateResult = await pool.query(`
            UPDATE advertisers
            SET status = 'archived',
                archived_at = NOW(),
                archived_reason = 'Non-recurring campaign capped (R2 archive failed)',
                current_week_impressions = 0,
                weekly_clicks = 0
            WHERE id = $1 AND status != 'archived'
            RETURNING id
          `, [advertiserId]);
          
          if (updateResult.rows.length > 0) {
            console.log(`[ARCHIVE ATTEMPT] campaignId=${advertiserId} - Database marked as archived despite R2 failure`);
            console.log(`🔄 [CHECK-CAP] Reset weekly counters (current_week_impressions=0, weekly_clicks=0) for non-recurring campaign ${advertiserId}`);
          }
        }
      }
      
      // Debug logging
      console.log("🧪 [CHECK-CAP] Advertiser status after update:", {
        id: ad.id,
        capped: true,
        archived: ad.recurring_weekly === false ? true : false,
        recurring_weekly: ad.recurring_weekly,
        current_week_impressions: ad.current_week_impressions,
        max_weekly_impressions: ad.max_weekly_impressions,
        video_filename: ad.video_filename,
        dbStatus: ad.status
      });
      
      return res.json({
        success: true,
        capped: true,
        archived: ad.max_weekly_impressions === null,
        message: 'Advertiser capped'
      });
    }
    
    // Debug logging for non-capped status
    console.log("🧪 [CHECK-CAP] Returned capped:", ad.capped, "archived:", ad.status === 'archived');
    
    res.json({
      success: true,
      capped: ad.capped || false,
      archived: ad.status === 'archived',
      currentImpressions: ad.current_week_impressions,
      maxImpressions: ad.max_weekly_impressions
    });
    
  } catch (error) {
    console.error('❌ Error checking cap:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== HELPER FUNCTION: Archive Campaign =====
// Shared helper function to archive a campaign (used by manual end and auto-billing)
async function archiveCampaign(campaignId, archivedReason, pool) {
  try {
    // Fetch campaign details (including recurring_weekly to determine if we need to reset weekly counters)
    const result = await pool.query(
      `SELECT id, video_filename, status, email, recurring_weekly, company_name, total_impressions
       FROM advertisers
       WHERE id = $1`,
      [campaignId]
    );

    if (result.rows.length === 0) {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Campaign not found`);
      return { success: false, error: 'Campaign not found' };
    }

    const ad = result.rows[0];

    // Safety guard: Check if already archived
    if (ad.status === 'archived') {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Already archived, skipping`);
      return { success: true, alreadyArchived: true };
    }

    // Double-check status right before R2 operations
    const doubleCheckResult = await pool.query(
      `SELECT status FROM advertisers WHERE id = $1`,
      [campaignId]
    );
    
    if (doubleCheckResult.rows.length === 0) {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Campaign disappeared during processing`);
      return { success: false, error: 'Campaign not found' };
    }
    
    if (doubleCheckResult.rows[0].status === 'archived') {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Already archived (double-check), skipping R2 operations`);
      return { success: true, alreadyArchived: true };
    }

    let archivedMediaUrl = null;
    if (ad.video_filename) {
      try {
        const CHARITY_BUCKET = 'charity-stream-videos';
        const R2_PUBLIC_URL = R2_VIDEOS_URL;
        const sourceKey = ad.video_filename;
        const destKey = `archived/${ad.video_filename}`;

        console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Starting R2 operations: ${sourceKey} -> ${destKey}`);
        const copyCommand = new CopyObjectCommand({
          Bucket: CHARITY_BUCKET,
          CopySource: `${CHARITY_BUCKET}/${sourceKey}`,
          Key: destKey
        });
        await r2Client.send(copyCommand);
        console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - R2 copy successful: ${sourceKey} -> ${destKey}`);

        const deleteCommand = new DeleteObjectCommand({
          Bucket: CHARITY_BUCKET,
          Key: sourceKey
        });
        await r2Client.send(deleteCommand);
        console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - R2 delete successful: ${sourceKey}`);

        // Construct the archived media URL
        archivedMediaUrl = normalizeBareMediaR2Link(`${R2_PUBLIC_URL}/${destKey}`);
        console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Updated media_r2_link to archived location: ${archivedMediaUrl}`);
      } catch (r2Error) {
        console.error(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - R2 error:`, r2Error);
        // Continue with DB update even if R2 fails
      }
    }

    // Update database
    // For non-recurring campaigns, also reset weekly counters to prevent stale data in future weeks
    const isNonRecurring = ad.recurring_weekly === false;
    const updateResult = await pool.query(
      `UPDATE advertisers
       SET status = 'archived',
           archived_at = NOW(),
           archived_reason = $2,
           is_paused = TRUE,
           media_r2_link = COALESCE($3, media_r2_link),
           current_week_impressions = CASE WHEN $4 = true THEN 0 ELSE current_week_impressions END,
           weekly_clicks = CASE WHEN $4 = true THEN 0 ELSE weekly_clicks END
       WHERE id = $1 AND status != 'archived'
       RETURNING id`,
      [campaignId, archivedReason, archivedMediaUrl, isNonRecurring]
    );

    if (updateResult.rows.length === 0) {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Database update skipped (already archived by another process)`);
      return { success: true, alreadyArchived: true };
    }

    // Log weekly counter reset for non-recurring campaigns
    if (isNonRecurring) {
      console.log(`🔄 [ARCHIVE ATTEMPT] campaignId=${campaignId} - Reset weekly counters (current_week_impressions=0, weekly_clicks=0) for non-recurring campaign`);
    }

    // Clear playlist cache
    playlistCache.clear();
    console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Successfully archived: ${archivedReason}`);

    // Send campaign ended email (fire-and-forget — don't block archive success)
    if (ad.email && emailService && emailService.isEmailConfigured()) {
      emailService.sendAdvertiserCampaignEndedEmail(
        ad.email,
        ad.company_name || 'Advertiser',
        ad.total_impressions || 0
      ).catch(err => console.error(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - End email failed:`, err.message));
    }

    return { success: true, email: ad.email };
  } catch (error) {
    console.error(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Error:`, error);
    return { success: false, error: error.message };
  }
}

// ===== WEEKLY RECURRING BILLING =====

// Utility function to get Monday 00:00 America/Los_Angeles for a given date
// Returns a Date object (UTC) representing Monday 00:00:00 in LA timezone
// This date will be stored in the database for idempotency checking
function getBillingWeekStart(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  });

  const parts = formatter.formatToParts(date);
  const laValues = {};
  parts.forEach(part => {
    if (part.type !== 'literal') {
      laValues[part.type] = part.value;
    }
  });

  const year = parseInt(laValues.year);
  const month = parseInt(laValues.month);
  const day = parseInt(laValues.day);

  const weekdayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  const weekday = weekdayMap[laValues.weekday] ?? 1;

  const daysToMonday = weekday === 0 ? 6 : weekday - 1;

  const mondayDate = new Date(year, month - 1, day - daysToMonday);

  const mondayYear = mondayDate.getFullYear();
  const mondayMonth = mondayDate.getMonth() + 1;
  const mondayDay = mondayDate.getDate();

  const isDST = mondayMonth >= 3 && mondayMonth <= 11;
  const offsetHours = isDST ? 7 : 8;

  const mondayUTC = new Date(Date.UTC(mondayYear, mondayMonth - 1, mondayDay, offsetHours, 0, 0, 0));

  return mondayUTC;
}

// Utility function to get billing week end (Sunday 23:59:59 America/Los_Angeles)
function getBillingWeekEnd(weekStart) {
  // weekStart is a UTC Date representing Monday 00:00 LA
  // Add 6 days and 23:59:59 to get Sunday 23:59:59 LA
  // Keep same offset calculation
  const weekStartYear = weekStart.getUTCFullYear();
  const weekStartMonth = weekStart.getUTCMonth() + 1;
  const weekStartDay = weekStart.getUTCDate();
  const offsetHours = weekStart.getUTCHours(); // Preserve the offset from weekStart
  
  // Sunday is 6 days after Monday
  const sundayUTC = new Date(Date.UTC(weekStartYear, weekStartMonth - 1, weekStartDay + 6, offsetHours + 23, 59, 59, 999));
  
  return sundayUTC;
}

/**
 * When a recurring advertiser invoice is actually paid, record donation_ledger + weekly_donation_pool.
 * Looks up recurring_billing_records by Stripe invoice id (written at finalize time).
 */
async function applyAdvertiserRecurringLedgerFromInvoicePaid(invoice, pool, logPrefix = '[INVOICE.PAID]') {
  const invoiceId = invoice?.id;
  if (!invoiceId) {
    return;
  }

  const rec = await pool.query(
    `SELECT advertiser_id, amount_billed, billing_week_start
     FROM recurring_billing_records
     WHERE stripe_invoice_id = $1
     LIMIT 1`,
    [invoiceId]
  );
  if (rec.rows.length === 0) {
    return;
  }

  const { advertiser_id: advertiserId, amount_billed: amountBilled, billing_week_start: billingWeekStart } =
    rec.rows[0];
  const weekStartStr =
    billingWeekStart instanceof Date
      ? billingWeekStart.toISOString().slice(0, 10)
      : String(billingWeekStart).split('T')[0];

  const amt = typeof amountBilled === 'number' ? amountBilled : parseFloat(amountBilled, 10);

  const ledgerResult = await pool.query(
    `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
     VALUES ('advertiser', $1, $2, $3, $4::date)
     ON CONFLICT (source_id, week_start) DO NOTHING
     RETURNING id`,
    [String(advertiserId), invoiceId, amt, weekStartStr]
  );
  if (ledgerResult.rows.length === 0) {
    console.warn(
      `${logPrefix} Donation ledger entry already exists for recurring advertiser campaign ${advertiserId} week ${weekStartStr}, skipping.`
    );
    return;
  }
  await pool.query(
    `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total)
     VALUES ($1::date, 0, $2)
     ON CONFLICT (week_start) DO UPDATE
     SET advertiser_total = weekly_donation_pool.advertiser_total + $2,
         updated_at = NOW()`,
    [weekStartStr, amt]
  );
  // Clear billing_failed and un-pause now that payment succeeded
  await pool.query(
    `UPDATE advertisers SET billing_failed = FALSE, is_paused = FALSE WHERE id = $1 AND billing_failed = TRUE`,
    [advertiserId]
  );
  console.log(
    `${logPrefix} Advertiser donation ledger and pool updated for advertiser ${advertiserId} week ${weekStartStr}`
  );
}

/**
 * When a non-recurring advertiser invoice is paid, record donation_ledger + weekly_donation_pool.
 * Looks up non_recurring_billing_records by Stripe invoice id (written at finalize time).
 * Called from invoice.paid and invoice.payment_succeeded webhooks — idempotent via ON CONFLICT.
 */
async function applyAdvertiserNonRecurringLedgerFromInvoicePaid(invoice, pool, logPrefix = '[INVOICE.PAID]') {
  const invoiceId = invoice?.id;
  if (!invoiceId) return;

  const rec = await pool.query(
    `SELECT advertiser_id, amount_billed, billing_week_start
     FROM non_recurring_billing_records
     WHERE stripe_invoice_id = $1
     LIMIT 1`,
    [invoiceId]
  );
  if (rec.rows.length === 0) return;

  const { advertiser_id: advertiserId, amount_billed: amountBilled, billing_week_start: billingWeekStart } = rec.rows[0];
  const weekStartStr =
    billingWeekStart instanceof Date
      ? billingWeekStart.toISOString().slice(0, 10)
      : String(billingWeekStart).split('T')[0];

  const amt = typeof amountBilled === 'number' ? amountBilled : parseFloat(amountBilled);

  const ledgerResult = await pool.query(
    `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
     VALUES ('advertiser', $1, $2, $3, $4::date)
     ON CONFLICT (source_id, week_start) DO NOTHING
     RETURNING id`,
    [String(advertiserId), invoiceId, amt, weekStartStr]
  );
  if (ledgerResult.rows.length === 0) {
    console.warn(`${logPrefix} Donation ledger entry already exists for non-recurring advertiser ${advertiserId} week ${weekStartStr}, skipping.`);
    return;
  }
  await pool.query(
    `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total)
     VALUES ($1::date, 0, $2)
     ON CONFLICT (week_start) DO UPDATE
     SET advertiser_total = weekly_donation_pool.advertiser_total + $2,
         updated_at = NOW()`,
    [weekStartStr, amt]
  );
  // Clear billing_failed now that payment succeeded (non-recurring campaigns stay archived)
  await pool.query(
    `UPDATE advertisers SET billing_failed = FALSE WHERE id = $1 AND billing_failed = TRUE`,
    [advertiserId]
  );
  console.log(`${logPrefix} Non-recurring advertiser donation ledger and pool updated for advertiser ${advertiserId} week ${weekStartStr}`);
}

/**
 * Charge $5 expedited approval fee after advertiser setup Checkout completes.
 * Idempotent per checkout session (Stripe idempotency key) and per PaymentIntent (donation_ledger.billing_record_id).
 * Failures are logged only; caller should not throw for PI failures.
 */
async function processAdvertiserExpeditedFeeAfterCheckoutSession(sessionCompleted) {
  if (sessionCompleted.metadata?.expedited !== 'true') {
    return;
  }
  const pool = getPool();
  if (!pool) {
    console.warn('⚠️ [EXPEDITED] No DB pool, skipping expedited fee');
    return;
  }
  const advertiserId = parseInt(sessionCompleted.metadata?.advertiserId, 10);
  if (!advertiserId || Number.isNaN(advertiserId)) {
    console.warn('⚠️ [EXPEDITED] Invalid advertiserId in metadata, skipping');
    return;
  }
  const setupIntentRef = sessionCompleted.setup_intent;
  const setupIntentId = typeof setupIntentRef === 'string' ? setupIntentRef : setupIntentRef?.id;
  const customerRef = sessionCompleted.customer;
  const customerId = typeof customerRef === 'string' ? customerRef : customerRef?.id;
  if (!setupIntentId || !customerId) {
    console.warn('⚠️ [EXPEDITED] Missing setup_intent or customer on session, skipping charge');
    return;
  }

  try {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    const paymentMethodId = typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id;
    if (!paymentMethodId) {
      console.warn('⚠️ [EXPEDITED] SetupIntent has no payment_method, skipping charge');
      return;
    }

    const idempotencyKey = `expedited-approval-${sessionCompleted.id}`;
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: 500,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: true,
        off_session: true,
        description: 'Expedited approval fee',
        metadata: {
          advertiserId: String(advertiserId),
          campaignType: 'advertiser',
          type: 'expedited_approval'
        }
      },
      { idempotencyKey }
    );

    if (paymentIntent.status !== 'succeeded') {
      console.error('❌ [EXPEDITED] PaymentIntent not succeeded:', paymentIntent.id, paymentIntent.status);
      return;
    }

    const dupLedger = await pool.query(
      'SELECT id FROM donation_ledger WHERE billing_record_id = $1 LIMIT 1',
      [paymentIntent.id]
    );
    if (dupLedger.rows.length > 0) {
      console.log('⏭️ [EXPEDITED] donation_ledger already records PI, skipping pool/email:', paymentIntent.id);
      return;
    }

    const weekStart = getBillingWeekStart(new Date());
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    let ledgerTouched = false;
    try {
      const ins = await pool.query(
        `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
         VALUES ('advertiser', $1, $2, $3, $4::date)
         RETURNING id`,
        [String(advertiserId), paymentIntent.id, 5.0, weekStartStr]
      );
      ledgerTouched = ins.rows.length > 0;
    } catch (insertErr) {
      if (insertErr.code === '23505') {
        const upd = await pool.query(
          `UPDATE donation_ledger
           SET amount = amount + $3,
               billing_record_id = $2
           WHERE source_id = $1 AND week_start = $4::date`,
          [String(advertiserId), paymentIntent.id, 5.0, weekStartStr]
        );
        ledgerTouched = upd.rowCount > 0;
      } else {
        throw insertErr;
      }
    }

    if (ledgerTouched) {
      await pool.query(
        `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total)
         VALUES ($1::date, 0, $2)
         ON CONFLICT (week_start) DO UPDATE
         SET advertiser_total = weekly_donation_pool.advertiser_total + $2,
             updated_at = NOW()`,
        [weekStartStr, 5.0]
      );
      console.log('✅ [EXPEDITED] Ledger and weekly pool updated for advertiser', advertiserId, 'week', weekStartStr);
    }

    const adminTo = process.env.ADMIN_EMAIL;
    if (adminTo && emailService?.transporter) {
      try {
        await emailService.transporter.sendMail({
          from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
          to: adminTo,
          subject: 'Expedited Approval Submitted',
          text: `Advertiser ID ${advertiserId} has submitted expedited approval.`
        });
        console.log('✅ [EXPEDITED] Admin notification sent to', adminTo);
      } catch (mailErr) {
        console.error('❌ [EXPEDITED] Admin email failed:', mailErr.message);
      }
    } else if (!adminTo) {
      console.warn('⚠️ [EXPEDITED] ADMIN_EMAIL not set, skipping admin notification');
    }
  } catch (err) {
    console.error('❌ [EXPEDITED] Error charging expedited fee (non-fatal):', err.message);
  }
}

// ===== SHARED BILLING EXECUTION FUNCTION =====
// Bills a campaign for current week impressions
// Used by both weekly cron and campaign end
// Returns: { success: boolean, skipped: boolean, error?: string, invoiceId?: string, amount?: number }
async function billCampaignUsage({ campaignId, billingWeekStart, billingWeekEnd, trigger, pool }) {
  const triggerLabel = trigger === 'campaign_end' ? 'CAMPAIGN-END-BILL' 
    : trigger === 'campaign_revoke' ? 'CAMPAIGN-REVOKE-BILL' 
    : 'WEEKLY-RECURRING-BILL';
  
  try {
    // Fetch campaign billing data
    const campaignResult = await pool.query(`
      SELECT 
        a.id, a.email, a.company_name, a.campaign_name,
        aa.stripe_customer_id,
        a.current_week_impressions, a.cpm_rate, a.weekly_budget_cap, a.status, a.payment_completed,
        a.click_tracking, a.weekly_clicks
      FROM advertisers a
      INNER JOIN advertiser_accounts aa ON LOWER(TRIM(aa.email)) = LOWER(TRIM(a.email))
      WHERE a.id = $1
    `, [campaignId]);

    if (campaignResult.rows.length === 0) {
      return { success: false, skipped: false, error: 'Campaign not found' };
    }

    const ad = campaignResult.rows[0];

    // CRITICAL: Only bill campaigns where payment_completed = TRUE (exclude abandoned signups)
    if (ad.payment_completed !== true) {
      console.log(`⏭️ [${triggerLabel}] Skipping advertiser ${ad.id} - payment_completed is not TRUE (abandoned signup)`);
      return { success: true, skipped: true, reason: 'Payment not completed' };
    }

    // Check if campaign is archived (should not bill archived campaigns)
    if (ad.status === 'archived') {
      console.log(`⏭️ [${triggerLabel}] Skipping advertiser ${ad.id} - campaign is archived`);
      return { success: true, skipped: true, reason: 'Campaign archived' };
    }

    // Check if has billable impressions
    const impressions = ad.current_week_impressions || 0;
    if (impressions === 0) {
      console.log(`⏭️ [${triggerLabel}] Skipping advertiser ${ad.id} - no impressions`);
      return { success: true, skipped: true, reason: 'No impressions' };
    }

    // Check Stripe customer exists
    if (!ad.stripe_customer_id) {
      console.log(`⏭️ [${triggerLabel}] Skipping advertiser ${ad.id} - no Stripe customer ID`);
      return { success: true, skipped: true, reason: 'No Stripe customer ID' };
    }

    // Idempotency check: check if already billed for this week
    const existingBillingCheck = await pool.query(`
      SELECT id FROM recurring_billing_records
      WHERE advertiser_id = $1
        AND billing_week_start = $2
    `, [ad.id, billingWeekStart]);

    if (existingBillingCheck.rows.length > 0) {
      console.log(`⏭️ [${triggerLabel}] Skipping advertiser ${ad.id} - already billed for this week`);
      return { success: true, skipped: true, reason: 'Already billed for this week' };
    }

    const cpmRate = parseFloat(ad.cpm_rate || 0);
    const clickTracking = ad.click_tracking === true;
    const clicks = clickTracking ? (ad.weekly_clicks || 0) : 0;
    
    // Calculate impression cost
    const impressionCost = (impressions / 1000) * cpmRate;
    
    // Calculate click cost (only if click tracking is enabled)
    const clickCost = clickTracking ? (clicks * 0.25) : 0;
    
    // Calculate total cost
    const totalCost = impressionCost + clickCost;
    
    // Apply budget cap to total cost (impressions + clicks)
    const weeklyBudgetCap = parseFloat(ad.weekly_budget_cap || 0);
    let billedAmount = totalCost;
    let wasCapped = false;
    
    if (weeklyBudgetCap > 0 && totalCost >= weeklyBudgetCap) {
      billedAmount = weeklyBudgetCap;
      wasCapped = true;
    }
    
    // Log billing calculations for debugging
    console.log(`💳 [${triggerLabel}] Billing calculations for advertiser ${ad.id}:`, {
      impressions: impressions,
      clicks: clicks,
      clickTracking: clickTracking,
      impressionCost: impressionCost.toFixed(2),
      clickCost: clickCost.toFixed(2),
      totalCost: totalCost.toFixed(2),
      weeklyBudgetCap: weeklyBudgetCap.toFixed(2),
      billedAmount: billedAmount.toFixed(2),
      wasCapped: wasCapped
    });

    // Skip if below Stripe minimum ($0.50)
    if (billedAmount < 0.50) {
      console.log(`⏭️ [${triggerLabel}] Skipping advertiser ${ad.id} - amount ${billedAmount.toFixed(2)} below $0.50 minimum`);
      return { 
        success: true, 
        skipped: true, 
        reason: `Amount $${billedAmount.toFixed(2)} below Stripe minimum $0.50`,
        impressions: impressions,
        clicks: clicks,
        impressionCost: impressionCost.toFixed(2),
        clickCost: clickCost.toFixed(2),
        totalCost: totalCost.toFixed(2),
        cappedAmount: billedAmount.toFixed(2)
      };
    }
    
    // Skip click billing if click tracking enabled but no clicks
    if (clickTracking && clicks === 0) {
      console.log(`⏭️ [${triggerLabel}] Click tracking enabled for advertiser ${ad.id} but weekly_clicks = 0, skipping click billing`);
    }

    const billedAmountCents = Math.round(billedAmount * 100); // Convert to cents

    // Logging already done above in billing calculations

    // Retrieve customer to get current default payment method (must be done immediately before invoice creation)
    // Stripe snapshots the payment method at invoice creation time, not finalization time
    let customer;
    try {
      customer = await stripe.customers.retrieve(ad.stripe_customer_id);
      console.log(`✅ [${triggerLabel}] Retrieved customer ${ad.stripe_customer_id} for advertiser ${ad.id}`);
    } catch (customerError) {
      console.error(`❌ [${triggerLabel}] Failed to retrieve customer for advertiser ${ad.id}:`, customerError.message);
      return { success: false, skipped: false, error: `Customer retrieval failed: ${customerError.message}` };
    }

    // Get default payment method from customer
    const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method || null;
    
    if (!defaultPaymentMethodId) {
      console.error(`❌ [${triggerLabel}] No default payment method found for customer ${ad.stripe_customer_id} (advertiser ${ad.id})`);
      return { 
        success: false, 
        skipped: false, 
        error: 'Customer has no default payment method set. Please add a payment method in the billing settings.' 
      };
    }

    console.log(`💳 [${triggerLabel}] Using default payment method ${defaultPaymentMethodId} for customer ${ad.stripe_customer_id}`);

    // Create Stripe Invoice FIRST (draft state, no auto-advance)
    // Explicitly pass default_payment_method to ensure we use the current default, not a cached one
    let invoice;
    try {
      // NOTE: campaignId === advertiserId for now (one campaign per advertiser)
      // This metadata structure supports future multi-campaign per advertiser scenarios
      
      // CRITICAL: campaignName MUST come from advertisers.campaign_name ONLY
      // Do NOT fall back to company_name, first_name, or any other field
      let campaignName = null;
      if (ad.campaign_name && ad.campaign_name.trim()) {
        campaignName = ad.campaign_name.trim();
      } else {
        // Log error if campaign_name is missing - this should never happen for valid campaigns
        console.error(`❌ [${triggerLabel}] CRITICAL: campaign_name is NULL or empty for advertiser ${ad.id}. Using fallback.`);
        campaignName = `Campaign ${ad.id}`;
      }
      
      invoice = await stripe.invoices.create({
        customer: ad.stripe_customer_id,
        collection_method: 'charge_automatically',
        default_payment_method: defaultPaymentMethodId,  // Explicitly set to current default
        auto_advance: false,  // Manual finalization after item attachment
        metadata: {
          advertiserId: String(ad.id),
          campaignId: String(ad.id),  // For recurring, campaign_id = advertiser_id
          campaignName: campaignName,
          campaignType: 'recurring',
          billingWeekStart: billingWeekStart.toISOString(),
          billingWeekEnd: billingWeekEnd.toISOString()
        }
      });
      console.log(`✅ [${triggerLabel}] Invoice created (draft): ${invoice.id} for advertiser ${ad.id} with payment method ${defaultPaymentMethodId}`);
    } catch (invoiceError) {
      console.error(`❌ [${triggerLabel}] Failed to create invoice for advertiser ${ad.id}:`, invoiceError.message);
      return { success: false, skipped: false, error: `Invoice creation failed: ${invoiceError.message}` };
    }

    // Create Stripe InvoiceItem(s) EXPLICITLY ATTACHED to the invoice
    // For campaigns WITH click tracking: create 2 items (impressions + clicks)
    // For campaigns WITHOUT click tracking: create 1 item (impressions only)
    const invoiceItems = [];
    
    try {
      if (clickTracking && clicks > 0) {
        // Campaign WITH click tracking: create 2 invoice items
        
        // Calculate amounts for each item (proportional to total)
        // If capped, distribute cap proportionally
        let impressionAmountCents = Math.round(impressionCost * 100);
        let clickAmountCents = Math.round(clickCost * 100);
        
        if (wasCapped && totalCost > 0) {
          // Distribute cap proportionally
          const impressionRatio = impressionCost / totalCost;
          const clickRatio = clickCost / totalCost;
          impressionAmountCents = Math.round(billedAmountCents * impressionRatio);
          clickAmountCents = billedAmountCents - impressionAmountCents; // Ensure exact total
        }
        
        // Create impression invoice item
        const impressionItem = await stripe.invoiceItems.create({
          customer: ad.stripe_customer_id,
          invoice: invoice.id,
          amount: impressionAmountCents,
          currency: 'usd',
          description: `Charity Stream – Weekly CPM Donation (${impressions} impressions)`
        });
        invoiceItems.push(impressionItem);
        console.log(`✅ [${triggerLabel}] Impression InvoiceItem created: ${impressionItem.id} ($${(impressionAmountCents / 100).toFixed(2)})`);
        
        // Create click invoice item
        const clickItem = await stripe.invoiceItems.create({
          customer: ad.stripe_customer_id,
          invoice: invoice.id,
          amount: clickAmountCents,
          currency: 'usd',
          description: `Charity Stream – Click Tracking (${clicks} clicks × $0.25)`
        });
        invoiceItems.push(clickItem);
        console.log(`✅ [${triggerLabel}] Click InvoiceItem created: ${clickItem.id} ($${(clickAmountCents / 100).toFixed(2)})`);
        
        console.log(`✅ [${triggerLabel}] Created 2 InvoiceItems for advertiser ${ad.id} (with click tracking):`, {
          impressionItem: impressionItem.id,
          clickItem: clickItem.id,
          totalAmount: billedAmount.toFixed(2)
        });
      } else {
        // Campaign WITHOUT click tracking: create 1 invoice item (impressions only)
        const impressionItem = await stripe.invoiceItems.create({
          customer: ad.stripe_customer_id,
          invoice: invoice.id,  // Explicitly attach to invoice (prevents $0 invoices)
          amount: billedAmountCents,
          currency: 'usd',
          description: 'Charity Stream – Weekly CPM Donation'
        });
        invoiceItems.push(impressionItem);
        console.log(`✅ [${triggerLabel}] InvoiceItem created: ${impressionItem.id} attached to invoice ${invoice.id} for advertiser ${ad.id} (impressions only)`);
      }
    } catch (invoiceItemError) {
      console.error(`❌ [${triggerLabel}] Failed to create InvoiceItem(s) for advertiser ${ad.id}:`, invoiceItemError.message);
      return { 
        success: false, 
        skipped: false, 
        error: `InvoiceItem creation failed: ${invoiceItemError.message}`,
        invoiceId: invoice.id
      };
    }

    // Explicitly finalize the invoice (this will attempt to charge automatically)
    try {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id, {
        auto_advance: true
      });
      console.log(`✅ [${triggerLabel}] Invoice finalized: ${invoice.id} for advertiser ${ad.id}`);
      console.log(`💳 [${triggerLabel}] Invoice status after finalization: ${invoice.status}`);

      // Log billed amount from invoice line items
      const invoiceAmount = invoice.lines?.data?.[0]?.amount || billedAmountCents;
      console.log(`💳 [${triggerLabel}] Invoice amount billed: $${(invoiceAmount / 100).toFixed(2)}`);
      
      // Verify invoice has line items and non-zero amount
      if (invoiceAmount === 0 || !invoice.lines?.data?.length) {
        console.error(`❌ [${triggerLabel}] WARNING: Invoice ${invoice.id} finalized with $0.00 or no line items!`);
        console.error(`❌ [${triggerLabel}] Invoice lines:`, invoice.lines?.data);
      }
      
      // Verify invoice status
      if (invoice.status !== 'paid' && invoice.status !== 'open') {
        console.warn(`⚠️ [${triggerLabel}] Invoice ${invoice.id} status is ${invoice.status} (expected 'paid' or 'open')`);
      }
      
      // Log which payment method was actually charged
      console.log(`💳 [${triggerLabel}] Charged PM: ${invoice.default_payment_method || 'N/A'}`);
    } catch (finalizeError) {
      console.error(`❌ [${triggerLabel}] Failed to finalize invoice ${invoice.id} for advertiser ${ad.id}:`, finalizeError.message);
      return { 
        success: false, 
        skipped: false, 
        error: `Invoice finalization failed: ${finalizeError.message}`,
        invoiceId: invoice.id,
        invoiceItemIds: invoiceItems.map(item => item.id)
      };
    }

    // Persist billing record (idempotency protection)
    // Do this BEFORE resetting impressions to ensure atomicity
    // donation_ledger / weekly_donation_pool are written when invoice.paid (or invoice.payment_succeeds) fires after payment settles
    try {
      await pool.query(`
        INSERT INTO recurring_billing_records 
        (advertiser_id, billing_week_start, billing_week_end, impressions_billed, amount_billed, stripe_invoice_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING id
      `, [
        ad.id,
        billingWeekStart,
        billingWeekEnd,
        impressions,
        billedAmount,
        invoice.id
      ]);
      console.log(`✅ [${triggerLabel}] Billing record saved for advertiser ${ad.id}`);
    } catch (dbError) {
      // If unique constraint violation (idempotency), another process may have billed
      if (dbError.code === '23505' || dbError.message.includes('unique') || dbError.message.includes('duplicate')) {
        console.log(`⏭️ [${triggerLabel}] Billing record already exists for advertiser ${ad.id} (idempotency protection - race condition)`);
        return { 
          success: true, 
          skipped: true, 
          reason: 'Billing record already exists (concurrent billing attempt)',
          invoiceId: invoice.id
        };
      }
      // For other DB errors, return error (invoice created but record failed)
      console.error(`⚠️ [${triggerLabel}] Failed to save billing record for advertiser ${ad.id}:`, dbError.message);
      console.error(`⚠️ [${triggerLabel}] Invoice ${invoice.id} was created but billing record save failed`);
      return {
        success: false,
        skipped: false,
        error: `Billing record save failed: ${dbError.message}`,
        invoiceId: invoice.id
      };
    }

    // Reset impressions and clicks ONLY if billing succeeded and campaign is not archived
    // For campaign_end and campaign_revoke triggers, we don't reset (campaign is being archived/revoked)
    // For weekly_cron trigger, we reset to start new week
    if (trigger === 'weekly_cron') {
      try {
        const resetResult = await pool.query(`
          UPDATE advertisers
          SET current_week_impressions = 0,
              weekly_clicks = 0,
              current_week_start = NOW(),
              capped = FALSE,
              updated_at = NOW()
          WHERE id = $1
            AND status != 'archived'
        `, [ad.id]);
        
        if (resetResult.rowCount > 0) {
          console.log(`✅ [${triggerLabel}] Reset impressions, clicks, and capped flag for advertiser ${ad.id}`);
        } else {
          console.warn(`⚠️ [${triggerLabel}] No rows updated when resetting impressions/clicks for advertiser ${ad.id} (may have been archived)`);
        }
      } catch (resetError) {
        console.error(`❌ [${triggerLabel}] Failed to reset impressions/clicks for advertiser ${ad.id}:`, resetError.message);
        // Log error but don't fail - billing already succeeded and was recorded
      }
    }

    console.log(`✅ [${triggerLabel}] Successfully billed advertiser ${ad.id}:`, {
      impressions: impressions,
      clicks: clicks,
      clickTracking: clickTracking,
      impressionCost: impressionCost.toFixed(2),
      clickCost: clickCost.toFixed(2),
      totalCost: totalCost.toFixed(2),
      cappedAmount: billedAmount.toFixed(2),
      wasCapped: wasCapped,
      stripeInvoiceId: invoice.id,
      invoiceItemCount: invoiceItems.length
    });

    return {
      success: true,
      skipped: false,
      invoiceId: invoice.id,
      amount: billedAmount,
      impressions: impressions
    };

  } catch (error) {
    console.error(`❌ [${triggerLabel}] Error billing campaign ${campaignId}:`, error);
    return { success: false, skipped: false, error: error.message };
  }
}

// Perform weekly recurring billing for active, paid, recurring advertisers
async function runWeeklyRecurringBilling() {
  console.log("💳 [WEEKLY-RECURRING-BILL] Starting weekly recurring billing job");
  console.log("💳 [WEEKLY-RECURRING-BILL] Job time:", new Date().toISOString());
  
  try {
    const pool = getPool();
    if (!pool) {
      console.error("❌ [WEEKLY-RECURRING-BILL] Billing job failed: no database pool");
      return { success: false, error: 'Database pool not available' };
    }

    // Calculate billing week boundaries (Monday 00:00 to Sunday 23:59:59 America/Los_Angeles)
    const now = new Date();
    const billingWeekStart = getBillingWeekStart(now);
    const billingWeekEnd = getBillingWeekEnd(billingWeekStart);
    
    console.log("💳 [WEEKLY-RECURRING-BILL] Billing week:", {
      start: billingWeekStart.toISOString(),
      end: billingWeekEnd.toISOString()
    });

    // Select eligible recurring advertisers
    // CRITICAL: Only bill campaigns where payment_completed = TRUE (exclude abandoned signups)
    const eligibleAdvertisers = await pool.query(`
      SELECT 
        a.id, a.email, a.company_name,
        aa.stripe_customer_id,
        a.current_week_impressions, a.cpm_rate, a.weekly_budget_cap
      FROM advertisers a
      INNER JOIN advertiser_accounts aa ON LOWER(TRIM(aa.email)) = LOWER(TRIM(a.email))
      WHERE a.status = 'active'
        AND a.payment_completed = TRUE
        AND a.recurring_weekly = TRUE
        AND aa.stripe_customer_id IS NOT NULL
        AND a.current_week_impressions > 0
    `);

    console.log(`💳 [WEEKLY-RECURRING-BILL] Found ${eligibleAdvertisers.rows.length} eligible recurring advertisers`);

    let billedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];
    const skipped = [];

    for (const ad of eligibleAdvertisers.rows) {
      try {
        // Use shared billing function
        const billingResult = await billCampaignUsage({
          campaignId: ad.id,
          billingWeekStart: billingWeekStart,
          billingWeekEnd: billingWeekEnd,
          trigger: 'weekly_cron',
          pool: pool
        });

        if (billingResult.skipped) {
          skipped.push({ 
            advertiserId: ad.id, 
            reason: billingResult.reason || 'Skipped',
            ...(billingResult.invoiceId && { stripeInvoiceId: billingResult.invoiceId })
          });
          skippedCount++;
          continue;
        }

        if (!billingResult.success) {
          errors.push({ 
            advertiserId: ad.id, 
            error: billingResult.error || 'Billing failed',
            ...(billingResult.invoiceId && { invoiceId: billingResult.invoiceId })
          });
          errorCount++;
          continue;
        }

        billedCount++;
        console.log(`✅ [WEEKLY-RECURRING-BILL] Successfully billed advertiser ${ad.id}:`, {
          impressions: billingResult.impressions,
          amount: billingResult.amount?.toFixed(2),
          stripeInvoiceId: billingResult.invoiceId
        });

      } catch (error) {
        console.error(`❌ [WEEKLY-RECURRING-BILL] Error processing advertiser ${ad.id}:`, error);
        errors.push({ 
          advertiserId: ad.id, 
          error: error.message 
        });
        errorCount++;
      }
    }

    console.log(`✅ [WEEKLY-RECURRING-BILL] Weekly recurring billing completed:`, {
      billedCount: billedCount,
      skippedCount: skippedCount,
      errorCount: errorCount,
      billingWeekStart: billingWeekStart.toISOString()
    });

    return {
      success: true,
      billedCount: billedCount,
      skippedCount: skippedCount,
      errorCount: errorCount,
      errors: errors,
      skipped: skipped,
      billingWeekStart: billingWeekStart.toISOString(),
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error("❌ [WEEKLY-RECURRING-BILL] Weekly recurring billing job error:", error);
    console.error("❌ [WEEKLY-RECURRING-BILL] Error stack:", error.stack);
    return { success: false, error: error.message };
  }
}

// ===== NON-RECURRING CAMPAIGN BILLING =====

// Bills a non-recurring campaign for its entire lifetime usage
// Returns: { success: boolean, skipped: boolean, error?: string, invoiceId?: string, amount?: number }
// Options:
//   - useBudgetCap: if true, bill the weekly_budget_cap amount instead of calculating from impressions
async function billNonRecurringCampaign({ campaignId, pool, useBudgetCap = false }) {
  const triggerLabel = 'NON-RECURRING-BILL';
  
  try {
    // Fetch campaign billing data (campaign_start_date = go-live date for invoice metadata)
    const campaignResult = await pool.query(`
      SELECT 
        a.id, a.email, a.company_name, a.campaign_name,
        aa.stripe_customer_id,
        a.total_impressions, a.cpm_rate, a.status, a.approved_at, a.campaign_start_date, a.recurring_weekly, a.weekly_budget_cap, a.payment_completed,
        a.click_tracking, a.weekly_clicks
      FROM advertisers a
      INNER JOIN advertiser_accounts aa ON LOWER(TRIM(aa.email)) = LOWER(TRIM(a.email))
      WHERE a.id = $1
    `, [campaignId]);

    if (campaignResult.rows.length === 0) {
      return { success: false, skipped: false, error: 'Campaign not found' };
    }

    const ad = campaignResult.rows[0];

    // CRITICAL: Only bill campaigns where payment_completed = TRUE (exclude abandoned signups)
    if (ad.payment_completed !== true) {
      console.log(`⏭️ [${triggerLabel}] Skipping campaign ${ad.id} - payment_completed is not TRUE (abandoned signup)`);
      return { success: true, skipped: true, reason: 'Payment not completed' };
    }

    // Verify this is a non-recurring campaign
    if (ad.recurring_weekly === true) {
      console.log(`⏭️ [${triggerLabel}] Skipping campaign ${ad.id} - is recurring campaign`);
      return { success: true, skipped: true, reason: 'Recurring campaign' };
    }

    // Check if campaign is archived (should not bill archived campaigns)
    if (ad.status === 'archived') {
      console.log(`⏭️ [${triggerLabel}] Skipping campaign ${ad.id} - campaign is archived`);
      return { success: true, skipped: true, reason: 'Campaign archived' };
    }

    // Check if has billable impressions
    const impressions = ad.total_impressions || 0;
    if (impressions === 0) {
      console.log(`⏭️ [${triggerLabel}] Skipping billing for campaign ${ad.id} - no impressions`);
      console.log(`📦 [${triggerLabel}] Archiving non-recurring campaign ${ad.id} (billing skipped due to 0 impressions)`);
      
      // Archive the campaign even though billing is skipped
      try {
        const archiveResult = await archiveCampaign(
          ad.id,
          'Non-recurring campaign archived (no impressions to bill)',
          pool
        );

        if (!archiveResult.success) {
          console.error(`❌ [${triggerLabel}] Failed to archive campaign ${ad.id}:`, archiveResult.error);
          return { success: false, skipped: true, reason: 'No impressions - archive failed', error: archiveResult.error };
        } else {
          console.log(`✅ [${triggerLabel}] Successfully archived campaign ${ad.id} (no impressions)`);
        }
      } catch (archiveError) {
        console.error(`❌ [${triggerLabel}] Error archiving campaign ${ad.id}:`, archiveError.message);
        return { success: false, skipped: true, reason: 'No impressions - archive error', error: archiveError.message };
      }

      return { success: true, skipped: true, reason: 'No impressions', archived: true };
    }

    // Check Stripe customer exists
    if (!ad.stripe_customer_id) {
      console.log(`⏭️ [${triggerLabel}] Skipping campaign ${ad.id} - no Stripe customer ID`);
      return { success: true, skipped: true, reason: 'No Stripe customer ID' };
    }

    // Check if campaign_start_date exists (go-live date; required for billing window metadata)
    if (!ad.campaign_start_date) {
      console.log(`⏭️ [${triggerLabel}] Skipping campaign ${ad.id} - no campaign_start_date (go-live)`);
      return { success: true, skipped: true, reason: 'No campaign start date' };
    }

    // Idempotency check: check if already billed (campaign_id is unique in non_recurring_billing_records)
    const existingBillingCheck = await pool.query(`
      SELECT id FROM non_recurring_billing_records
      WHERE campaign_id = $1
    `, [ad.id]);

    if (existingBillingCheck.rows.length > 0) {
      console.log(`⏭️ [${triggerLabel}] Skipping campaign ${ad.id} - already billed (idempotency protection)`);
      return { success: true, skipped: true, reason: 'Already billed' };
    }

    const cpmRate = parseFloat(ad.cpm_rate || 0);
    const clickTracking = ad.click_tracking === true;
    const clicks = clickTracking ? (ad.weekly_clicks || 0) : 0;
    
    // Calculate impression cost
    const impressionCost = (impressions / 1000) * cpmRate;
    
    // Calculate click cost (only if click tracking is enabled)
    const clickCost = clickTracking ? (clicks * 0.25) : 0;
    
    // Calculate total cost
    const totalCost = impressionCost + clickCost;
    
    // Calculate billing amount
    let billedAmount;
    let wasCapped = false;
    
    if (useBudgetCap && ad.weekly_budget_cap) {
      // When cap is hit, bill the full budget cap amount (what advertiser agreed to pay)
      // But cap applies to total cost (impressions + clicks)
      const weeklyBudgetCap = parseFloat(ad.weekly_budget_cap);
      if (totalCost >= weeklyBudgetCap) {
        billedAmount = weeklyBudgetCap;
        wasCapped = true;
      } else {
        billedAmount = totalCost;
      }
      console.log(`💳 [${triggerLabel}] Using budget cap logic for campaign ${ad.id}:`, {
        impressionCost: impressionCost.toFixed(2),
        clickCost: clickCost.toFixed(2),
        totalCost: totalCost.toFixed(2),
        weeklyBudgetCap: weeklyBudgetCap.toFixed(2),
        billedAmount: billedAmount.toFixed(2),
        wasCapped: wasCapped
      });
    } else {
      // Normal billing: calculate from impressions + clicks
      billedAmount = totalCost; // No weekly budget cap for non-recurring (lifetime total)
      console.log(`💳 [${triggerLabel}] Calculating billing amount for campaign ${ad.id}:`, {
        impressions: impressions,
        clicks: clicks,
        clickTracking: clickTracking,
        impressionCost: impressionCost.toFixed(2),
        clickCost: clickCost.toFixed(2),
        totalCost: totalCost.toFixed(2),
        billedAmount: billedAmount.toFixed(2)
      });
    }

    // Skip if below Stripe minimum ($0.50)
    if (billedAmount < 0.50) {
      console.log(`⏭️ [${triggerLabel}] Skipping billing for campaign ${ad.id} - amount ${billedAmount.toFixed(2)} below $0.50 minimum`);
      console.log(`📦 [${triggerLabel}] Archiving non-recurring campaign ${ad.id} (billing skipped due to amount below threshold)`);
      
      // Archive the campaign even though billing is skipped
      try {
        const archiveResult = await archiveCampaign(
          ad.id,
          `Non-recurring campaign archived (billing amount $${billedAmount.toFixed(2)} below $0.50 minimum)`,
          pool
        );

        if (!archiveResult.success) {
          console.error(`❌ [${triggerLabel}] Failed to archive campaign ${ad.id}:`, archiveResult.error);
          return { 
            success: false, 
            skipped: true, 
            reason: `Amount $${billedAmount.toFixed(2)} below Stripe minimum $0.50 - archive failed`,
            error: archiveResult.error,
            impressions: impressions,
            clicks: clicks,
            totalCost: totalCost.toFixed(2)
          };
        } else {
          console.log(`✅ [${triggerLabel}] Successfully archived campaign ${ad.id} (amount below threshold)`);
        }
      } catch (archiveError) {
        console.error(`❌ [${triggerLabel}] Error archiving campaign ${ad.id}:`, archiveError.message);
        return { 
          success: false, 
          skipped: true, 
          reason: `Amount $${billedAmount.toFixed(2)} below Stripe minimum $0.50 - archive error`,
          error: archiveError.message,
          impressions: impressions,
          clicks: clicks,
          totalCost: totalCost.toFixed(2)
        };
      }

      return { 
        success: true, 
        skipped: true, 
        reason: `Amount $${billedAmount.toFixed(2)} below Stripe minimum $0.50`,
        impressions: impressions,
        clicks: clicks,
        totalCost: totalCost.toFixed(2),
        archived: true
      };
    }

    const billedAmountCents = Math.round(billedAmount * 100); // Convert to cents
    
    // Skip click billing if click tracking enabled but no clicks
    if (clickTracking && clicks === 0) {
      console.log(`⏭️ [${triggerLabel}] Click tracking enabled for campaign ${ad.id} but weekly_clicks = 0, skipping click billing`);
    }

    // Billing window = go-live week (campaign_start_date to campaign_start_date + 7 days)
    const goLiveDate = new Date(ad.campaign_start_date);
    const billingWeekStart = goLiveDate;
    const billingWeekEnd = new Date(goLiveDate);
    billingWeekEnd.setDate(billingWeekEnd.getDate() + 7); // 7 days after go-live

    // Logging already done above in billing calculations

    // Retrieve customer to get current default payment method (must be done immediately before invoice creation)
    // Stripe snapshots the payment method at invoice creation time, not finalization time
    let customer;
    try {
      customer = await stripe.customers.retrieve(ad.stripe_customer_id);
      console.log(`✅ [${triggerLabel}] Retrieved customer ${ad.stripe_customer_id} for campaign ${ad.id}`);
    } catch (customerError) {
      console.error(`❌ [${triggerLabel}] Failed to retrieve customer for campaign ${ad.id}:`, customerError.message);
      return { success: false, skipped: false, error: `Customer retrieval failed: ${customerError.message}` };
    }

    // Get default payment method from customer
    let defaultPaymentMethodId = customer.invoice_settings?.default_payment_method || null;

    if (!defaultPaymentMethodId) {
      console.log(`⚠️ [${triggerLabel}] No invoice_settings.default_payment_method for customer ${ad.stripe_customer_id}, falling back to payment methods list`);
      try {
        const paymentMethods = await stripe.paymentMethods.list({
          customer: ad.stripe_customer_id,
          type: 'card',
          limit: 1,
        });

        if (paymentMethods.data.length > 0) {
          defaultPaymentMethodId = paymentMethods.data[0].id;
          console.log(`✅ [${triggerLabel}] Found payment method via list fallback: ${defaultPaymentMethodId}`);

          // Promote to default so future retrievals work correctly
          await stripe.customers.update(ad.stripe_customer_id, {
            invoice_settings: { default_payment_method: defaultPaymentMethodId },
          });
          console.log(`✅ [${triggerLabel}] Promoted ${defaultPaymentMethodId} to default for customer ${ad.stripe_customer_id}`);
        }
      } catch (pmListError) {
        console.error(`❌ [${triggerLabel}] Failed to list payment methods for customer ${ad.stripe_customer_id}:`, pmListError.message);
      }
    }

    if (!defaultPaymentMethodId) {
      console.error(`❌ [${triggerLabel}] No default payment method found for customer ${ad.stripe_customer_id} (campaign ${ad.id})`);
      return {
        success: false,
        skipped: false,
        error: 'Customer has no default payment method set. Please add a payment method in the billing settings.',
      };
    }

    console.log(`💳 [${triggerLabel}] Using default payment method ${defaultPaymentMethodId} for customer ${ad.stripe_customer_id}`);

    // Create Stripe Invoice FIRST (draft state, no auto-advance)
    // Explicitly pass default_payment_method to ensure we use the current default, not a cached one
    let invoice;
    try {
      // NOTE: campaignId === advertiserId for now (one campaign per advertiser)
      // This metadata structure supports future multi-campaign per advertiser scenarios
      
      // CRITICAL: campaignName MUST come from advertisers.campaign_name ONLY
      // Do NOT fall back to company_name, first_name, or any other field
      let campaignName = null;
      if (ad.campaign_name && ad.campaign_name.trim()) {
        campaignName = ad.campaign_name.trim();
      } else {
        // Log error if campaign_name is missing - this should never happen for valid campaigns
        console.error(`❌ [${triggerLabel}] CRITICAL: campaign_name is NULL or empty for campaign ${ad.id}. Using fallback.`);
        campaignName = `Campaign ${ad.id}`;
      }
      
      invoice = await stripe.invoices.create({
        customer: ad.stripe_customer_id,
        collection_method: 'charge_automatically',
        default_payment_method: defaultPaymentMethodId,  // Explicitly set to current default
        auto_advance: false,  // Manual finalization after item attachment
        metadata: {
          advertiserId: String(ad.id),
          campaignId: String(ad.id),  // For non-recurring, campaign_id = advertiser_id
          campaignName: campaignName,
          campaignType: 'non-recurring',
          billingWeekStart: billingWeekStart.toISOString(),
          billingWeekEnd: billingWeekEnd.toISOString()
        }
      });
      console.log(`✅ [${triggerLabel}] Invoice created (draft): ${invoice.id} for campaign ${ad.id} with payment method ${defaultPaymentMethodId}`);
    } catch (invoiceError) {
      console.error(`❌ [${triggerLabel}] Failed to create invoice for campaign ${ad.id}:`, invoiceError.message);
      return { success: false, skipped: false, error: `Invoice creation failed: ${invoiceError.message}` };
    }

    // Create Stripe InvoiceItem(s) EXPLICITLY ATTACHED to the invoice
    // For campaigns WITH click tracking: create 2 items (impressions + clicks)
    // For campaigns WITHOUT click tracking: create 1 item (impressions only)
    const invoiceItems = [];
    
    try {
      if (clickTracking && clicks > 0) {
        // Campaign WITH click tracking: create 2 invoice items
        
        // Calculate amounts for each item (proportional to total)
        // If capped, distribute cap proportionally
        let impressionAmountCents = Math.round(impressionCost * 100);
        let clickAmountCents = Math.round(clickCost * 100);
        
        if (wasCapped && totalCost > 0) {
          // Distribute cap proportionally
          const impressionRatio = impressionCost / totalCost;
          impressionAmountCents = Math.round(billedAmountCents * impressionRatio);
          clickAmountCents = billedAmountCents - impressionAmountCents; // Ensure exact total
        }
        
        // Create impression invoice item
        const impressionItem = await stripe.invoiceItems.create({
          customer: ad.stripe_customer_id,
          invoice: invoice.id,
          amount: impressionAmountCents,
          currency: 'usd',
          description: `Charity Stream – Non-Recurring Campaign CPM Donation (${impressions} impressions)`
        });
        invoiceItems.push(impressionItem);
        console.log(`✅ [${triggerLabel}] Impression InvoiceItem created: ${impressionItem.id} ($${(impressionAmountCents / 100).toFixed(2)})`);
        
        // Create click invoice item
        const clickItem = await stripe.invoiceItems.create({
          customer: ad.stripe_customer_id,
          invoice: invoice.id,
          amount: clickAmountCents,
          currency: 'usd',
          description: `Charity Stream – Click Tracking (${clicks} clicks × $0.25)`
        });
        invoiceItems.push(clickItem);
        console.log(`✅ [${triggerLabel}] Click InvoiceItem created: ${clickItem.id} ($${(clickAmountCents / 100).toFixed(2)})`);
        
        console.log(`✅ [${triggerLabel}] Created 2 InvoiceItems for campaign ${ad.id} (with click tracking):`, {
          impressionItem: impressionItem.id,
          clickItem: clickItem.id,
          totalAmount: billedAmount.toFixed(2)
        });
      } else {
        // Campaign WITHOUT click tracking: create 1 invoice item (impressions only)
        const impressionItem = await stripe.invoiceItems.create({
          customer: ad.stripe_customer_id,
          invoice: invoice.id,  // Explicitly attach to invoice (prevents $0 invoices)
          amount: billedAmountCents,
          currency: 'usd',
          description: 'Charity Stream – Non-Recurring Campaign CPM Donation'
        });
        invoiceItems.push(impressionItem);
        console.log(`✅ [${triggerLabel}] InvoiceItem created: ${impressionItem.id} attached to invoice ${invoice.id} for campaign ${ad.id} (impressions only)`);
      }
    } catch (invoiceItemError) {
      console.error(`❌ [${triggerLabel}] Failed to create InvoiceItem(s) for campaign ${ad.id}:`, invoiceItemError.message);
      return { 
        success: false, 
        skipped: false, 
        error: `InvoiceItem creation failed: ${invoiceItemError.message}`,
        invoiceId: invoice.id
      };
    }

    // Explicitly finalize the invoice (this will attempt to charge automatically)
    try {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id, {
        auto_advance: true
      });
      console.log(`✅ [${triggerLabel}] Invoice finalized: ${invoice.id} for campaign ${ad.id}`);
      console.log(`💳 [${triggerLabel}] Invoice status after finalization: ${invoice.status}`);

      // Log billed amount from invoice line items
      const invoiceAmount = invoice.lines?.data?.[0]?.amount || billedAmountCents;
      console.log(`💳 [${triggerLabel}] Invoice amount billed: $${(invoiceAmount / 100).toFixed(2)}`);
      
      // Verify invoice has line items and non-zero amount
      if (invoiceAmount === 0 || !invoice.lines?.data?.length) {
        console.error(`❌ [${triggerLabel}] WARNING: Invoice ${invoice.id} finalized with $0.00 or no line items!`);
        console.error(`❌ [${triggerLabel}] Invoice lines:`, invoice.lines?.data);
      }
      
      // Verify invoice status
      if (invoice.status !== 'paid' && invoice.status !== 'open') {
        console.warn(`⚠️ [${triggerLabel}] Invoice ${invoice.id} status is ${invoice.status} (expected 'paid' or 'open')`);
      }
      
      // Log which payment method was actually charged
      console.log(`💳 [${triggerLabel}] Charged PM: ${invoice.default_payment_method || 'N/A'}`);
    } catch (finalizeError) {
      console.error(`❌ [${triggerLabel}] Failed to finalize invoice ${invoice.id} for campaign ${ad.id}:`, finalizeError.message);
      return { 
        success: false, 
        skipped: false, 
        error: `Invoice finalization failed: ${finalizeError.message}`,
        invoiceId: invoice.id,
        invoiceItemIds: invoiceItems.map(item => item.id)
      };
    }

    // Persist billing record (idempotency protection)
    // Do this BEFORE archiving to ensure atomicity
    try {
      await pool.query(`
        INSERT INTO non_recurring_billing_records
        (campaign_id, advertiser_id, billing_week_start, billing_week_end, impressions_billed, amount_billed, stripe_invoice_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [
        ad.id,  // campaign_id (unique constraint)
        ad.id,  // advertiser_id (same as campaign_id for non-recurring)
        billingWeekStart,
        billingWeekEnd,
        impressions,
        billedAmount,
        invoice.id
      ]);
      console.log(`✅ [${triggerLabel}] Billing record saved for campaign ${ad.id} — donation_ledger and pool will be written when invoice.paid webhook fires`);
    } catch (dbError) {
      // If unique constraint violation (idempotency), another process may have billed
      if (dbError.code === '23505' || dbError.message.includes('unique') || dbError.message.includes('duplicate')) {
        console.log(`⏭️ [${triggerLabel}] Billing record already exists for campaign ${ad.id} (idempotency protection - race condition)`);
        return { 
          success: true, 
          skipped: true, 
          reason: 'Billing record already exists (concurrent billing attempt)',
          invoiceId: invoice.id
        };
      }
      // For other DB errors, return error (invoice created but record failed)
      console.error(`⚠️ [${triggerLabel}] Failed to save billing record for campaign ${ad.id}:`, dbError.message);
      console.error(`⚠️ [${triggerLabel}] Invoice ${invoice.id} was created but billing record save failed`);
      return {
        success: false,
        skipped: false,
        error: `Billing record save failed: ${dbError.message}`,
        invoiceId: invoice.id
      };
    }

    // Archive the campaign after successful billing
    // This is the final step - campaign will never be billed again
    try {
      const archiveResult = await archiveCampaign(
        ad.id,
        'Non-recurring campaign billed and archived',
        pool
      );

      if (!archiveResult.success) {
        console.error(`❌ [${triggerLabel}] Failed to archive campaign ${ad.id} after billing:`, archiveResult.error);
        // Log error but don't fail - billing already succeeded and was recorded
        // Campaign will be archived on next cron run or manual intervention
      } else {
        console.log(`✅ [${triggerLabel}] Successfully archived campaign ${ad.id} after billing`);
      }
    } catch (archiveError) {
      console.error(`❌ [${triggerLabel}] Error archiving campaign ${ad.id} after billing:`, archiveError.message);
      // Log error but don't fail - billing already succeeded and was recorded
    }

    console.log(`✅ [${triggerLabel}] Successfully billed campaign ${ad.id}:`, {
      impressions: impressions,
      clicks: clicks,
      clickTracking: clickTracking,
      impressionCost: impressionCost.toFixed(2),
      clickCost: clickCost.toFixed(2),
      totalCost: totalCost.toFixed(2),
      billedAmount: billedAmount.toFixed(2),
      wasCapped: wasCapped,
      stripeInvoiceId: invoice.id,
      invoiceItemCount: invoiceItems.length
    });

    return {
      success: true,
      skipped: false,
      invoiceId: invoice.id,
      amount: billedAmount,
      impressions: impressions
    };

  } catch (error) {
    console.error(`❌ [${triggerLabel}] Error billing campaign ${campaignId}:`, error);
    return { success: false, skipped: false, error: error.message };
  }
}

// Perform non-recurring campaign billing for campaigns that are 7+ days old
async function runNonRecurringBilling() {
  console.log("💳 [NON-RECURRING-BILL] Starting non-recurring billing job");
  console.log("💳 [NON-RECURRING-BILL] Job time:", new Date().toISOString());
  
  try {
    const pool = getPool();
    if (!pool) {
      console.error("❌ [NON-RECURRING-BILL] Billing job failed: no database pool");
      return { success: false, error: 'Database pool not available' };
    }

    // Select eligible non-recurring campaigns
    // Criteria:
    // - recurring_weekly = FALSE
    // - status = 'active'
    // - payment_completed = TRUE (CRITICAL: exclude abandoned signups)
    // - campaign_start_date (go-live) was >= 7 days ago (run week has ended)
    // - No existing billing record (idempotency check)
    const eligibleCampaigns = await pool.query(`
      SELECT 
        a.id, a.email, a.company_name,
        aa.stripe_customer_id,
        a.total_impressions, a.cpm_rate, a.campaign_start_date
      FROM advertisers a
      INNER JOIN advertiser_accounts aa ON LOWER(TRIM(aa.email)) = LOWER(TRIM(a.email))
      WHERE a.recurring_weekly = FALSE
        AND a.status = 'active'
        AND a.payment_completed = TRUE
        AND aa.stripe_customer_id IS NOT NULL
        AND a.campaign_start_date IS NOT NULL
        AND a.campaign_start_date <= NOW() - INTERVAL '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM non_recurring_billing_records nrb
          WHERE nrb.campaign_id = a.id
        )
    `);

    console.log(`💳 [NON-RECURRING-BILL] Found ${eligibleCampaigns.rows.length} eligible non-recurring campaigns`);

    let billedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];
    const skipped = [];

    for (const campaign of eligibleCampaigns.rows) {
      try {
        // Use billing function
        const billingResult = await billNonRecurringCampaign({
          campaignId: campaign.id,
          pool: pool
        });

        if (billingResult.skipped) {
          skipped.push({ 
            campaignId: campaign.id, 
            reason: billingResult.reason || 'Skipped',
            ...(billingResult.invoiceId && { stripeInvoiceId: billingResult.invoiceId })
          });
          skippedCount++;
          continue;
        }

        if (!billingResult.success) {
          errors.push({ 
            campaignId: campaign.id, 
            error: billingResult.error || 'Billing failed',
            ...(billingResult.invoiceId && { invoiceId: billingResult.invoiceId })
          });
          errorCount++;
          continue;
        }

        billedCount++;
        console.log(`✅ [NON-RECURRING-BILL] Successfully billed campaign ${campaign.id}:`, {
          impressions: billingResult.impressions,
          amount: billingResult.amount?.toFixed(2),
          stripeInvoiceId: billingResult.invoiceId
        });

      } catch (error) {
        console.error(`❌ [NON-RECURRING-BILL] Error processing campaign ${campaign.id}:`, error);
        errors.push({ 
          campaignId: campaign.id, 
          error: error.message 
        });
        errorCount++;
      }
    }

    console.log(`✅ [NON-RECURRING-BILL] Non-recurring billing completed:`, {
      billedCount: billedCount,
      skippedCount: skippedCount,
      errorCount: errorCount
    });

    return {
      success: true,
      billedCount: billedCount,
      skippedCount: skippedCount,
      errorCount: errorCount,
      errors: errors,
      skipped: skipped,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error("❌ [NON-RECURRING-BILL] Non-recurring billing job error:", error);
    console.error("❌ [NON-RECURRING-BILL] Error stack:", error.stack);
    return { success: false, error: error.message };
  }
}

// ===== WEEKLY RECURRING BILLING CRON ROUTE (Vercel Cron) =====
// Weekly recurring billing endpoint for Vercel cron job (runs every Monday at 00:00 America/Los_Angeles = 08:00 UTC)
app.get("/api/system/weekly-recurring-billing", async (req, res) => {
  console.log("💳 [CRON] Weekly recurring billing triggered");
  console.log("💳 [CRON] Request time:", new Date().toISOString());
  console.log("💳 [CRON] Request headers:", {
    'user-agent': req.headers['user-agent'],
    'x-vercel-cron': req.headers['x-vercel-cron']
  });

  // Verify this is a legitimate Vercel cron request (security check)
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const isManualTrigger = process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;

  if (!isVercelCron && !isLocalDev && !isManualTrigger) {
    console.warn("⚠️ [CRON] Request missing x-vercel-cron header - rejecting");
    return res.status(401).json({ 
      success: false, 
      error: "Unauthorized - missing Vercel cron header" 
    });
  }

  console.log("✅ [CRON] Request verified as Vercel cron job");

  try {
    const result = await runWeeklyRecurringBilling();
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: "Weekly recurring billing executed",
        billedCount: result.billedCount,
        skippedCount: result.skippedCount,
        errorCount: result.errorCount,
        billingWeekStart: result.billingWeekStart,
        timestamp: result.timestamp
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error || "Weekly recurring billing failed"
      });
    }
  } catch (error) {
    console.error("❌ [CRON] Weekly recurring billing route error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ===== NON-RECURRING BILLING CRON ROUTE (Vercel Cron) =====
// Non-recurring billing endpoint for Vercel cron job (runs periodically to check for campaigns >= 7 days old)
app.get("/api/system/non-recurring-billing", async (req, res) => {
  console.log("💳 [CRON] Non-recurring billing triggered");
  console.log("💳 [CRON] Request time:", new Date().toISOString());
  console.log("💳 [CRON] Request headers:", {
    'user-agent': req.headers['user-agent'],
    'x-vercel-cron': req.headers['x-vercel-cron']
  });

  // Verify this is a legitimate Vercel cron request (security check)
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const isManualTrigger = process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;

  if (!isVercelCron && !isLocalDev && !isManualTrigger) {
    console.warn("⚠️ [CRON] Request missing x-vercel-cron header - rejecting");
    return res.status(401).json({ 
      success: false, 
      error: "Unauthorized - missing Vercel cron header" 
    });
  }

  console.log("✅ [CRON] Request verified as Vercel cron job");

  try {
    const result = await runNonRecurringBilling();
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: "Non-recurring billing executed",
        billedCount: result.billedCount,
        skippedCount: result.skippedCount,
        errorCount: result.errorCount,
        timestamp: result.timestamp
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error || "Non-recurring billing failed"
      });
    }
  } catch (error) {
    console.error("❌ [CRON] Non-recurring billing route error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ===== WEEKLY RESET ROUTE (Vercel Cron) =====

// Weekly reset endpoint for Vercel cron job (runs every Sunday at 11:59 PM)
app.get("/api/system/weekly-reset", async (req, res) => {
  console.log("⏰ [CRON] Weekly reset triggered");
  console.log("⏰ [CRON] Request time:", new Date().toISOString());
  console.log("⏰ [CRON] Request headers:", {
    'user-agent': req.headers['user-agent'],
    'x-vercel-cron': req.headers['x-vercel-cron']
  });

  // Verify this is a legitimate Vercel cron request (security check)
  // In production, Vercel will send this header. For local testing, we allow it without the header.
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const isManualTrigger = process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;

  if (!isVercelCron && !isLocalDev && !isManualTrigger) {
    console.warn("⚠️ [CRON] Request missing x-vercel-cron header - rejecting");
    return res.status(401).json({ 
      success: false, 
      error: "Unauthorized - missing Vercel cron header" 
    });
  }

  console.log("✅ [CRON] Request verified as Vercel cron job");

  try {
    const result = await performWeeklyReset();
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: "Weekly reset executed",
        advertisersReset: result.advertisersReset,
        timestamp: result.timestamp
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error || "Weekly reset failed"
      });
    }
  } catch (error) {
    console.error("❌ [CRON] Weekly reset route error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===== FINALIZE WEEKLY DONATIONS JOB =====
// Monday 02:00 AM PT (10:00 UTC); during PDT runs at 03:00 AM PT — acceptable, week boundary is from date computation.
app.get("/api/system/finalize-weekly-donations", async (req, res) => {
  console.log("📋 [CRON] Finalize weekly donations triggered");
  console.log("📋 [CRON] Request time:", new Date().toISOString());

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const isManualTrigger = process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;

  if (!isVercelCron && !isLocalDev && !isManualTrigger) {
    console.warn("⚠️ [CRON] Request missing x-vercel-cron header - rejecting");
    return res.status(401).json({
      success: false,
      error: "Unauthorized - missing Vercel cron header"
    });
  }

  const pool = getPool();
  if (!pool) {
    return res.status(500).json({
      success: false,
      error: "Database connection not available"
    });
  }

  try {
    const { runFinalizeWeeklyDonations } = require('./scripts/finalize-weekly-donations');
    const result = await runFinalizeWeeklyDonations(pool);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || "Finalize weekly donations failed"
      });
    }

    if (result.skipped) {
      return res.json({
        success: true,
        skipped: true,
        reason: result.reason,
        message: "Finalize skipped (already finalized, no pool row, or no winner)"
      });
    }

    // Send finalization email to winning charity
    if (result.charityApplicationId && emailService && emailService.isEmailConfigured()) {
      pool.query(
        `SELECT contact_email, charity_name FROM charity_applications WHERE id = $1`,
        [result.charityApplicationId]
      ).then(r => {
        if (r.rows.length > 0 && r.rows[0].contact_email) {
          emailService.sendCharityFinalizationEmail(r.rows[0].contact_email, r.rows[0].charity_name)
            .catch(err => console.error('[CRON] Charity finalization email failed:', err.message));
        }
      }).catch(err => console.error('[CRON] Charity finalization email query failed:', err.message));
    }

    res.json({
      success: true,
      skipped: false,
      weeksAccumulated: result.weeksAccumulated,
      sponsorTotal: result.sponsorTotal,
      advertiserTotal: result.advertiserTotal,
      totalAmount: result.totalAmount,
      charityApplicationId: result.charityApplicationId
    });
  } catch (error) {
    console.error("❌ [CRON] Finalize weekly donations route error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===== SPONSOR END-CAMPAIGNS JOB =====
// Ends non-recurring sponsor campaigns whose 7-day window has expired.
// Runs Monday 00:00 AM PT / Monday 08:00 UTC — after full Sunday has elapsed in PT.

async function performSponsorEndCampaigns() {
  console.log("🔄 [SPONSOR-END] Starting sponsor end-campaigns job...");
  console.log("🔄 [SPONSOR-END] Job time:", new Date().toISOString());

  const pool = getPool();
  if (!pool) {
    console.error("❌ [SPONSOR-END] Database pool not available");
    return { success: false, error: "Database connection not available" };
  }

  try {
    // Compute today's date in America/Los_Angeles so campaigns with end_at = Sunday
    // are correctly caught when this job fires at midnight PT on Monday.
    const laParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const laDate = {};
    laParts.forEach(p => { if (p.type !== 'literal') laDate[p.type] = p.value; });
    const todayLA = `${laDate.year}-${laDate.month}-${laDate.day}`;

    // End non-recurring campaigns whose end_at has passed (using <= for safety against missed runs / DST drift)
    const endResult = await pool.query(`
      UPDATE sponsor_campaigns
      SET status = 'ended',
          updated_at = NOW()
      WHERE is_recurring = false
        AND status = 'active'
        AND end_at IS NOT NULL
        AND end_at::date <= $1::date
      RETURNING id
    `, [todayLA]);

    const endedCount = endResult.rowCount || 0;
    console.log(`📊 [SPONSOR-END] Ended ${endedCount} non-recurring campaign(s) (end_at <= today_LA = ${todayLA})`);

    return {
      success: true,
      endedCount,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error("❌ [SPONSOR-END] Error in end-campaigns job:", error);
    return { success: false, error: error.message };
  }
}

// ===== SPONSOR MONDAY JOB =====
// Extends Stripe trials for recurring campaigns not yet ready (not approved or no video generated).
// Activation is handled by the invoice.paid webhook when first billing fires.
// Runs Sunday 10:00 PM PT / Monday 06:00 UTC

async function performSponsorMondayActivation() {
  console.log("🔄 [SPONSOR-MONDAY] Starting sponsor Monday job...");
  console.log("🔄 [SPONSOR-MONDAY] Job time:", new Date().toISOString());

  const pool = getPool();
  if (!pool) {
    console.error("❌ [SPONSOR-MONDAY] Database pool not available");
    return { success: false, error: "Database connection not available" };
  }

  try {
    // Find recurring campaigns NOT ready (no video generated or not yet approved by admin).
    // These need their Stripe trial extended by one week so sponsors aren't billed before their
    // campaign is ready. Ready campaigns (approved + video generated) are activated by invoice.paid.
    const notReadyCampaignsResult = await pool.query(`
      SELECT
        sc.id AS campaign_id,
        sc.status,
        sc.generation_completed,
        sb.stripe_subscription_id
      FROM sponsor_campaigns sc
      JOIN sponsor_billing sb ON sb.sponsor_campaign_id = sc.id
      WHERE sc.is_recurring = true
        AND sb.stripe_subscription_id IS NOT NULL
        AND sc.status NOT IN ('active', 'ended', 'canceled', 'rejected', 'payment_failed')
        AND (sc.status != 'approved' OR sc.generation_completed = false)
      ORDER BY sc.id
    `);

    console.log(`📊 [SPONSOR-MONDAY] Found ${notReadyCampaignsResult.rows.length} campaigns not ready for activation`);

    let extendedCount = 0;

    for (const campaign of notReadyCampaignsResult.rows) {
      try {
        const subscriptionId = campaign.stripe_subscription_id;
        console.log(`🔄 [SPONSOR-MONDAY] Processing not-ready campaign ${campaign.campaign_id}, subscription ${subscriptionId}`);

        // Retrieve current subscription to get trial_end
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const currentTrialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;

        // Compute next Monday midnight PT strictly after current trial_end (or now if no trial_end).
        // Adding 1 day before passing to getNextMondayLA ensures we advance past the current
        // trial_end Monday rather than landing on it. getNextMondayLA returns midnight PT (UTC-aware).
        const baseTime = currentTrialEnd || new Date();
        const baseTimePlusDay = new Date(baseTime);
        baseTimePlusDay.setDate(baseTimePlusDay.getDate() + 1);
        const nextMondayAfterTrial = getNextMondayLA(baseTimePlusDay);
        const nextMondayUnix = Math.floor(nextMondayAfterTrial.getTime() / 1000);

        await stripe.subscriptions.update(subscriptionId, {
          trial_end: nextMondayUnix
        });

        console.log(`✅ [SPONSOR-MONDAY] Extended trial for subscription ${subscriptionId} to ${nextMondayAfterTrial.toISOString()}`);
        console.log(`📋 [SPONSOR-MONDAY] Campaign ID: ${campaign.campaign_id}, Subscription ID: ${subscriptionId}, Action: Extended trial — campaign not ready`);

        extendedCount++;

      } catch (campaignError) {
        console.error(`❌ [SPONSOR-MONDAY] Error extending trial for campaign ${campaign.campaign_id}:`, campaignError.message);
        // Continue with next campaign
      }
    }

    console.log(`✅ [SPONSOR-MONDAY] Monday job completed: ${extendedCount} trial(s) extended`);

    return {
      success: true,
      extendedCount,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error("❌ [SPONSOR-MONDAY] Error in Monday activation job:", error);
    console.error("❌ [SPONSOR-MONDAY] Error stack:", error.stack);
    return {
      success: false,
      error: error.message
    };
  }
}

// Monday sponsor activation endpoint for Vercel cron job (runs Monday at 12:00 AM)
app.get("/api/system/sponsor-monday-activation", async (req, res) => {
  console.log("⏰ [CRON] Sponsor Monday activation triggered");
  console.log("⏰ [CRON] Request time:", new Date().toISOString());
  console.log("⏰ [CRON] Request headers:", {
    'user-agent': req.headers['user-agent'],
    'x-vercel-cron': req.headers['x-vercel-cron']
  });

  // Verify this is a legitimate Vercel cron request (security check)
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const isManualTrigger = process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;

  if (!isVercelCron && !isLocalDev && !isManualTrigger) {
    console.warn("⚠️ [CRON] Request missing x-vercel-cron header - rejecting");
    return res.status(401).json({ 
      success: false, 
      error: "Unauthorized - missing Vercel cron header" 
    });
  }

  console.log("✅ [CRON] Request verified as Vercel cron job");

  try {
    const result = await performSponsorMondayActivation();
    
    if (result.success) {
      res.json({
        success: true,
        message: "Sponsor Monday job executed",
        extendedCount: result.extendedCount,
        timestamp: result.timestamp
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error || "Sponsor Monday activation failed"
      });
    }
  } catch (error) {
    console.error("❌ [CRON] Sponsor Monday activation route error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===== SPONSOR END-CAMPAIGNS CRON ROUTE (Vercel Cron) =====
// Ends non-recurring sponsor campaigns whose 7-day window has expired.
// Runs Monday 00:00 AM PT / Monday 08:00 UTC — after full Sunday has elapsed in PT.
app.get("/api/system/sponsor-end-campaigns", async (req, res) => {
  console.log("⏰ [CRON] Sponsor end-campaigns triggered");
  console.log("⏰ [CRON] Request time:", new Date().toISOString());

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const isManualTrigger = process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;

  if (!isVercelCron && !isLocalDev && !isManualTrigger) {
    console.warn("⚠️ [CRON] Request missing x-vercel-cron header - rejecting");
    return res.status(401).json({
      success: false,
      error: "Unauthorized - missing Vercel cron header"
    });
  }

  try {
    const result = await performSponsorEndCampaigns();

    if (result.success) {
      res.json({
        success: true,
        message: "Sponsor end-campaigns executed",
        endedCount: result.endedCount,
        timestamp: result.timestamp
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || "Sponsor end-campaigns failed"
      });
    }
  } catch (error) {
    console.error("❌ [CRON] Sponsor end-campaigns route error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===== FALLBACK WINNER SELECTION CRON ROUTE (Vercel Cron) =====
// Selects a fallback winner for the upcoming week if none has been chosen manually.
// Runs Saturday 8:00 PM UTC (12:00 PM PST / 1:00 PM PDT).
app.get("/api/system/fallback-winner-selection", async (req, res) => {
  console.log("🏆 [CRON] Fallback winner selection triggered");
  console.log("🏆 [CRON] Request time:", new Date().toISOString());

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const isManualTrigger = process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;

  if (!isVercelCron && !isLocalDev && !isManualTrigger) {
    console.warn("⚠️ [CRON] Request missing x-vercel-cron header - rejecting");
    return res.status(401).json({
      success: false,
      error: "Unauthorized - missing Vercel cron header"
    });
  }

  const pool = getPool();
  if (!pool) {
    return res.status(500).json({ success: false, error: "Database connection not available" });
  }

  try {
    const { runFallbackWinnerSelection } = require('./scripts/fallback-winner-job');
    const result = await runFallbackWinnerSelection(pool);

    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error || "Fallback winner selection failed" });
    }

    // Send notification email and stamp notification_sent_at only on email success
    if (!result.skipped && result.contactEmail && emailService && emailService.isEmailConfigured()) {
      try {
        const emailResult = await emailService.sendCharityWeekWinnerEmail(
          result.contactEmail,
          result.charityName,
          result.weekStart,
          result.weekEnd,
          { automatic: true }
        );
        if (emailResult.success) {
          await pool.query(
            'UPDATE charity_week_winner SET notification_sent_at = NOW() WHERE week_start = $1::date',
            [result.weekStart]
          );
          console.log(`🏆 [CRON] Winner notification sent to ${result.contactEmail}`);
        } else {
          console.error("❌ [CRON] Winner notification email failed:", emailResult.error);
        }
      } catch (emailErr) {
        console.error("❌ [CRON] Winner notification email error:", emailErr.message);
      }
    }

    return res.json({
      success: true,
      skipped: result.skipped || false,
      reason: result.reason,
      charityName: result.charityName,
      weekStart: result.weekStart,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("❌ [CRON] Fallback winner selection route error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ===== ADVERTISER PORTAL SIGNUP ROUTES =====

// Get signup info for a portal signup token
app.get('/api/advertiser/signup-info', async (req, res) => {
  try {
    const { token } = req.query;

    console.log(
      '🔍 [PORTAL SIGNUP] Signup info request for token:',
      token ? token.substring(0, 8) + '...' : 'MISSING'
    );

    if (!token) {
      return res.json({ valid: false });
    }

    const pool = getPool();

    const result = await pool.query(`
      SELECT 
        aa.id AS account_id,
        aa.advertiser_id,
        aa.email,
        aa.initial_setup_expires_at,
        a.status
      FROM advertiser_accounts aa
      JOIN advertisers a ON a.id = aa.advertiser_id
      WHERE aa.initial_setup_token = $1
        AND aa.initial_setup_expires_at > NOW()
    `, [token]);

    if (result.rows.length === 0) {
      console.log('❌ [PORTAL SIGNUP] Token not found or expired');
      return res.json({ valid: false });
    }

    const row = result.rows[0];

    console.log('✅ [PORTAL SIGNUP] Token valid for advertiser:', row.advertiser_id);

    return res.json({
      valid: true,
      email: row.email,
      accountExists: false,
      createdFromSubmission: true,
      createdFromApproval: false
    });

  } catch (error) {
    console.error('❌ [PORTAL SIGNUP] Error:', error);
    res.status(500).json({ valid: false });
  }
});


// Create advertiser portal account (password setup)
app.post('/api/advertiser/signup', async (req, res) => {
  try {
    const { token, password } = req.body;

    console.log(
      '🔐 [PORTAL SIGNUP] Signup request for token:',
      token ? token.substring(0, 8) + '...' : 'MISSING'
    );

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: 'Token and password are required'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters'
      });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({
        success: false,
        error: 'Database connection not available'
      });
    }

    // ✅ Look up account by INITIAL SETUP TOKEN (correct table)
    const accountResult = await pool.query(
      `
      SELECT
        aa.id AS account_id,
        aa.advertiser_id,
        aa.email,
        aa.initial_setup_token,
        aa.initial_setup_expires_at,
        a.status
      FROM advertiser_accounts aa
      JOIN advertisers a ON a.id = aa.advertiser_id
      WHERE aa.initial_setup_token = $1
      `,
      [token]
    );

    if (accountResult.rows.length === 0) {
      console.log('❌ [PORTAL SIGNUP] Token not found');
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    const account = accountResult.rows[0];

    // ✅ Validate token expiration
    if (
      account.initial_setup_expires_at &&
      new Date() > new Date(account.initial_setup_expires_at)
    ) {
      console.log('❌ [PORTAL SIGNUP] Token expired');
      return res.status(400).json({
        success: false,
        error: 'Token has expired'
      });
    }

    // ✅ Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    console.log('✅ [PORTAL SIGNUP] Password hashed');

    console.log('📊 [PORTAL SIGNUP] Finalizing account:', {
      accountId: account.account_id,
      advertiserId: account.advertiser_id,
      email: account.email,
      createdFromSubmission: account.status !== 'active',
      createdFromApproval: account.status === 'active'
    });

    // ✅ Update EXISTING advertiser_accounts row (NO INSERT)
    await pool.query(
      `
      UPDATE advertiser_accounts
      SET
        password_hash = $1,
        initial_setup_token = NULL,
        initial_setup_expires_at = NULL
      WHERE id = $2
      `,
      [passwordHash, account.account_id]
    );

    console.log(
      '✅ [PORTAL SIGNUP] Account activated for advertiser:',
      account.advertiser_id
    );

    // ✅ Generate advertiser portal JWT (unchanged)
    const jwtToken = jwt.sign(
      {
        advertiser_id: account.advertiser_id,
        email: account.email,
        jwt_type: 'advertiser_portal'
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    console.log('✅ [PORTAL SIGNUP] JWT issued for advertiser:', account.advertiser_id);

    return res.json({
      success: true,
      token: jwtToken,
      advertiserId: account.advertiser_id,
      createdFromSubmission: account.status !== 'active',
      createdFromApproval: account.status === 'active'
    });

  } catch (error) {
    console.error('❌ [PORTAL SIGNUP] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});


// ===== ADVERTISER PORTAL LOGIN =====
app.post('/api/advertiser/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('🔐 [PORTAL LOGIN] Login attempt for email:', email);
    
    if (!email || !password) {
      console.log('❌ [PORTAL LOGIN] Missing email or password');
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    
    const pool = getPool();
    if (!pool) {
      console.error('❌ [PORTAL LOGIN] Database pool not available');
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Look up advertiser account by email (case-insensitive)
    const normalizedEmail = email.toLowerCase().trim();
    const accountResult = await pool.query(`
      SELECT aa.id, aa.email, aa.password_hash, aa.advertiser_id,
             a.company_name
      FROM advertiser_accounts aa
      INNER JOIN advertisers a ON aa.advertiser_id = a.id
      WHERE LOWER(TRIM(aa.email)) = LOWER(TRIM($1))
    `, [normalizedEmail]);
    
    if (accountResult.rows.length === 0) {
      console.log('❌ [PORTAL LOGIN] Account not found for email:', email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    
    const account = accountResult.rows[0];
    
    // Check if password_hash is NULL - user needs to create password
    if (!account.password_hash) {
      console.log('⚠️ [PORTAL LOGIN] Password not set for email:', email);
      return res.status(403).json({ 
        success: false, 
        error: 'You need to create a password. Check your email or request a new link.',
        needsPassword: true
      });
    }
    
    // Verify password
    const passwordMatch = await bcrypt.compare(password, account.password_hash);
    if (!passwordMatch) {
      console.log('❌ [PORTAL LOGIN] Password mismatch for email:', email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    
    console.log('✅ [PORTAL LOGIN] Password verified for email:', email);
    
    // Update last login timestamp
    await pool.query(`
      UPDATE advertiser_accounts
      SET last_login_at = NOW()
      WHERE id = $1
    `, [account.id]);
    
    // Generate advertiser portal JWT token
    const token = jwt.sign(
      {
        advertiser_id: account.advertiser_id,
        email: account.email,
        jwt_type: 'advertiser_portal'
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    console.log('🔑 [PORTAL LOGIN TOKEN PAYLOAD]', {
      advertiser_id: account.advertiser_id,
      email: account.email,
      jwt_type: 'advertiser_portal'
    });
    console.log('✅ [PORTAL LOGIN] Token generated for advertiser:', account.advertiser_id);
    
    return res.json({
      success: true,
      token: token,
      advertiserId: account.advertiser_id,
      companyName: account.company_name
    });
    
  } catch (error) {
    console.error('❌ [PORTAL LOGIN] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error', details: error.message });
  }
});

// ===== SPONSOR LOGIN ROUTE =====

app.post('/api/sponsor/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('🔐 [SPONSOR LOGIN] Login attempt for email:', email);
    
    if (!email || !password) {
      console.log('❌ [SPONSOR LOGIN] Missing email or password');
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    
    const pool = getPool();
    if (!pool) {
      console.error('❌ [SPONSOR LOGIN] Database pool not available');
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Look up sponsor account by email (case-insensitive)
    const normalizedEmail = email.toLowerCase().trim();
    const accountResult = await pool.query(`
      SELECT id, contact_email, password_hash, organization_legal_name
      FROM sponsor_accounts
      WHERE LOWER(TRIM(contact_email)) = LOWER(TRIM($1))
    `, [normalizedEmail]);
    
    if (accountResult.rows.length === 0) {
      console.log('❌ [SPONSOR LOGIN] Account not found for email:', email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    
    const account = accountResult.rows[0];
    
    // Check if password_hash is NULL - user needs to create password
    if (!account.password_hash) {
      console.log('⚠️ [SPONSOR LOGIN] Password not set for email:', email);
      return res.status(403).json({ 
        success: false, 
        error: 'You need to create a password. Check your email or request a new link.',
        needsPassword: true
      });
    }
    
    // Verify password
    const passwordMatch = await bcrypt.compare(password, account.password_hash);
    if (!passwordMatch) {
      console.log('❌ [SPONSOR LOGIN] Password mismatch for email:', email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    
    console.log('✅ [SPONSOR LOGIN] Password verified for email:', email);
    
    // Generate sponsor portal JWT token (mirroring advertiser structure)
    const token = jwt.sign(
      {
        sponsorAccountId: account.id,
        email: account.contact_email,
        role: 'sponsor',
        jwt_type: 'sponsor_portal'
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    console.log('🔑 [SPONSOR LOGIN TOKEN PAYLOAD]', {
      sponsorAccountId: account.id,
      email: account.contact_email,
      role: 'sponsor',
      jwt_type: 'sponsor_portal'
    });
    console.log('✅ [SPONSOR LOGIN] Token generated for sponsor account:', account.id);
    
    return res.json({
      success: true,
      token: token,
      sponsorAccountId: account.id,
      organizationName: account.organization_legal_name
    });
    
  } catch (error) {
    console.error('❌ [SPONSOR LOGIN] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error', details: error.message });
  }
});

// Middleware to authenticate sponsor portal tokens (JWT with jwt_type === 'sponsor_portal')
function requireSponsorAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.jwt_type !== 'sponsor_portal') {
      console.error('❌ [SPONSOR AUTH] Invalid jwt_type:', decoded.jwt_type);
      return res.status(403).json({ error: 'Invalid token type' });
    }

    if (!decoded.sponsorAccountId) {
      console.error('❌ [SPONSOR AUTH] Token missing sponsorAccountId');
      return res.status(403).json({ error: 'Invalid token' });
    }

    req.sponsor = {
      sponsorAccountId: decoded.sponsorAccountId,
      email: decoded.email,
    };

    next();
  } catch (err) {
    console.error('❌ [SPONSOR AUTH] JWT verification failed:', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ===== SPONSOR DASHBOARD (read-only, single campaign overview) =====
// GET /api/sponsor/dashboard
// Optional query: campaignId — if provided and owned by sponsor, return that campaign; else default.
// Default campaign: most recent WHERE status != 'ended' (and != 'canceled'), else most recent.
app.get('/api/sponsor/dashboard', requireSponsorAuth, async (req, res) => {
  try {
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const campaignIdParam = req.query.campaignId;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    let result;
    if (campaignIdParam && typeof campaignIdParam === 'string' && campaignIdParam.trim()) {
      result = await pool.query(`
        SELECT
          sc.id AS campaign_id,
          sc.status AS campaign_status,
          sc.generation_completed,
          sc.video_r2_key,
          sc.tier,
          sc.created_at,
          sc.start_week,
          COALESCE(sc.weekly_impressions, 0) AS weekly_impressions,
          COALESCE(sc.impressions_total, 0) AS impressions_total,
          COALESCE(sc.weekly_clicks, 0) AS weekly_clicks,
          COALESCE(sc.clicks_total, 0) AS clicks_total,
          COALESCE(sc.weekly_unique_viewers, 0) AS weekly_unique_viewers,
          sb.status AS billing_status,
          sb.stripe_mode,
          sa.organization_legal_name
        FROM sponsor_campaigns sc
        JOIN sponsor_billing sb ON sb.sponsor_campaign_id = sc.id
        JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
        WHERE sc.sponsor_account_id = $1 AND sc.id = $2
      `, [sponsorAccountId, campaignIdParam.trim()]);
    } else {
      result = { rows: [] };
    }

    if (!result.rows || result.rows.length === 0) {
      // Prefer most recent non-ended campaign; fallback to most recent any
      result = await pool.query(`
      SELECT
        sc.id AS campaign_id,
        sc.status AS campaign_status,
        sc.generation_completed,
        sc.video_r2_key,
        sc.tier,
        sc.created_at,
        sc.start_week,
        COALESCE(sc.weekly_impressions, 0) AS weekly_impressions,
        COALESCE(sc.impressions_total, 0) AS impressions_total,
        COALESCE(sc.weekly_clicks, 0) AS weekly_clicks,
        COALESCE(sc.clicks_total, 0) AS clicks_total,
        COALESCE(sc.weekly_unique_viewers, 0) AS weekly_unique_viewers,
        sb.status AS billing_status,
        sb.stripe_mode,
        sa.organization_legal_name
      FROM sponsor_campaigns sc
      JOIN sponsor_billing sb ON sb.sponsor_campaign_id = sc.id
      JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
      WHERE sc.sponsor_account_id = $1
        AND LOWER(TRIM(sc.status)) NOT IN ('ended', 'canceled', 'rejected')
      ORDER BY sc.created_at DESC
      LIMIT 1
    `, [sponsorAccountId]);

    if (result.rows.length === 0) {
      result = await pool.query(`
        SELECT
          sc.id AS campaign_id,
          sc.status AS campaign_status,
          sc.generation_completed,
          sc.video_r2_key,
          sc.tier,
          sc.created_at,
          sc.start_week,
          COALESCE(sc.weekly_impressions, 0) AS weekly_impressions,
          COALESCE(sc.impressions_total, 0) AS impressions_total,
          COALESCE(sc.weekly_clicks, 0) AS weekly_clicks,
          COALESCE(sc.clicks_total, 0) AS clicks_total,
          COALESCE(sc.weekly_unique_viewers, 0) AS weekly_unique_viewers,
          sb.status AS billing_status,
          sb.stripe_mode,
          sa.organization_legal_name
        FROM sponsor_campaigns sc
        JOIN sponsor_billing sb ON sb.sponsor_campaign_id = sc.id
        JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
        WHERE sc.sponsor_account_id = $1
        ORDER BY sc.created_at DESC
        LIMIT 1
      `, [sponsorAccountId]);
    }
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No campaign found for this sponsor account' });
    }

    const row = result.rows[0];
    const campaignStatus = row.campaign_status;
    const generationCompleted = row.generation_completed === true;
    const billingStatus = row.billing_status;

    let status;
    if (campaignStatus === 'rejected') {
      status = 'REJECTED';
    } else if (campaignStatus === 'ended' || campaignStatus === 'canceled') {
      status = 'ENDED';
    } else if (campaignStatus === 'payment_failed') {
      status = 'PAYMENT_FAILED';
    } else if (campaignStatus === 'pending_approval' && !generationCompleted && billingStatus === 'trialing') {
      status = 'PENDING_APPROVAL';
    } else if ((campaignStatus === 'approved' || campaignStatus === 'pending_approval') && generationCompleted && billingStatus === 'trialing') {
      status = 'APPROVED'; // video ready, waiting for trial to end
    } else if ((campaignStatus === 'approved' || campaignStatus === 'active') && generationCompleted && billingStatus === 'paid') {
      const todayStr = new Date().toISOString().slice(0, 10);
      const startWeekStr = row.start_week ? new Date(row.start_week).toISOString().slice(0, 10) : null;
      status = (startWeekStr && startWeekStr > todayStr) ? 'APPROVED' : 'LIVE';
    } else if (campaignStatus === 'pending_approval') {
      status = 'PENDING_APPROVAL';
    } else {
      status = 'PENDING_APPROVAL';
    }

    const orgName = row.organization_legal_name || 'Sponsorship';
    const campaignDisplayName = orgName;

    // Same base URL as playlist; null if no video key or generation not completed
    const SPONSOR_VIDEO_BASE_URL = R2_SPONSOR_GENERATED_URL;
    const hasVideo = row.video_r2_key != null && String(row.video_r2_key).trim() !== '' && generationCompleted;
    const creativeUrl = hasVideo ? `${SPONSOR_VIDEO_BASE_URL}/${row.video_r2_key}` : null;

    let weeklyRecipient = null;
    if (status === 'LIVE') {
      const recipientResult = await pool.query(`
        SELECT ca.charity_name
        FROM charity_week_winner cww
        JOIN charity_applications ca ON ca.id = cww.charity_application_id
        WHERE cww.week_start = DATE_TRUNC('week', CURRENT_DATE)::date
        LIMIT 1
      `);
      if (recipientResult.rows.length > 0) {
        weeklyRecipient = recipientResult.rows[0].charity_name;
      }
    }

    res.json({
      campaignId: row.campaign_id,
      campaignTitle: campaignDisplayName,
      campaignDisplayName,
      organizationName: row.organization_legal_name || null,
      status,
      stripeMode: row.stripe_mode || null,
      tier: row.tier || null,
      creativeUrl,
      startWeek: row.start_week,
      impressionsToday: Number(row.weekly_impressions),
      impressionsTotal: Number(row.impressions_total),
      clicksToday: Number(row.weekly_clicks),
      clicksTotal: Number(row.clicks_total),
      uniqueViewersToday: Number(row.weekly_unique_viewers),
      weeklyRecipient,
    });
  } catch (err) {
    console.error('❌ [SPONSOR DASHBOARD] Error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ===== SPONSOR CANCEL (end campaign: recurring = cancel Stripe + DB; non-recurring = DB only) =====
// POST /api/sponsor/cancel
// Body: { sponsor_campaign_id: string } (UUID)
// Recurring: Cancels Stripe subscription immediately; updates sponsor_billing + sponsor_campaigns to canceled.
// Non-recurring: Updates sponsor_campaigns.status = 'ended' only. No Stripe or billing changes.
// Idempotent for both types. Response: ended, campaign_type ('recurring' | 'non_recurring').
app.post('/api/sponsor/cancel', requireSponsorAuth, async (req, res) => {
  try {
    const raw = req.body?.sponsor_campaign_id;
    if (raw == null) {
      return res.status(400).json({ success: false, error: 'sponsor_campaign_id is required' });
    }
    if (typeof raw !== 'string') {
      return res.status(400).json({ success: false, error: 'sponsor_campaign_id must be a valid UUID' });
    }
    const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!UUID_REGEX.test(raw)) {
      return res.status(400).json({ success: false, error: 'sponsor_campaign_id must be a valid UUID' });
    }
    const sponsor_campaign_id = raw;

    const pool = getPool();
    if (!pool) {
      console.error('❌ [SPONSOR CANCEL] Database pool not available');
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }

    // Load campaign; 404 if not found
    const campaignResult = await pool.query(
      `SELECT id, sponsor_account_id, status FROM sponsor_campaigns WHERE id = $1`,
      [sponsor_campaign_id]
    );
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }
    const campaign = campaignResult.rows[0];

    // 403 if not owned by this sponsor
    if (campaign.sponsor_account_id !== req.sponsor.sponsorAccountId) {
      return res.status(403).json({ success: false, error: 'Campaign does not belong to this sponsor' });
    }

    const campaignStatusLower = String(campaign.status).toLowerCase();

    // Idempotent: already canceled (recurring ended)
    if (campaignStatusLower === 'canceled') {
      console.log('ℹ️ [SPONSOR CANCEL] Campaign already canceled (idempotent), campaign_id:', sponsor_campaign_id);
      return res.status(200).json({
        success: true,
        ended: false,
        campaign_type: 'recurring',
        message: 'Campaign is already canceled',
        campaign_id: sponsor_campaign_id,
      });
    }

    // Idempotent: already ended (non-recurring ended)
    if (campaignStatusLower === 'ended') {
      console.log('ℹ️ [SPONSOR CANCEL] Campaign already ended (idempotent), campaign_id:', sponsor_campaign_id);
      return res.status(200).json({
        success: true,
        ended: false,
        campaign_type: 'non_recurring',
        message: 'Campaign is already ended',
        campaign_id: sponsor_campaign_id,
      });
    }

    // Load sponsor_billing to determine recurring vs non-recurring (has stripe_subscription_id?)
    const billingResult = await pool.query(
      `SELECT sponsor_campaign_id, stripe_subscription_id, status
       FROM sponsor_billing
       WHERE sponsor_campaign_id = $1
       ORDER BY id DESC LIMIT 1`,
      [sponsor_campaign_id]
    );

    const hasSubscription = billingResult.rows.length > 0 &&
      billingResult.rows[0].stripe_subscription_id != null &&
      String(billingResult.rows[0].stripe_subscription_id).trim() !== '';

    // ---- Non-recurring: no Stripe subscription — set status = 'ended' only ----
    if (!hasSubscription) {
      await pool.query(
        `UPDATE sponsor_campaigns SET status = 'ended', updated_at = NOW() WHERE id = $1`,
        [sponsor_campaign_id]
      );
      console.log('✅ [SPONSOR CANCEL] Non-recurring campaign ended, campaign_id:', sponsor_campaign_id);

      // Send sponsorship ended email
      if (emailService && emailService.isEmailConfigured()) {
        pool.query(
          `SELECT sa.contact_email, sa.organization_legal_name, sc.impressions_total
           FROM sponsor_campaigns sc
           JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
           WHERE sc.id = $1`,
          [sponsor_campaign_id]
        ).then(r => {
          if (r.rows.length > 0) {
            const { contact_email, organization_legal_name, impressions_total } = r.rows[0];
            emailService.sendSponsorCampaignEndedEmail(contact_email, organization_legal_name, impressions_total || 0)
              .catch(err => console.error('[SPONSOR CANCEL] End email failed:', err.message));
          }
        }).catch(err => console.error('[SPONSOR CANCEL] End email query failed:', err.message));
      }

      return res.status(200).json({
        success: true,
        ended: true,
        campaign_type: 'non_recurring',
        campaign_id: sponsor_campaign_id,
      });
    }

    // ---- Recurring: cancel Stripe subscription and update DB ----
    const billing = billingResult.rows[0];
    if (String(billing.status).toLowerCase() === 'canceled') {
      console.log('ℹ️ [SPONSOR CANCEL] sponsor_billing already canceled (idempotent), campaign_id:', sponsor_campaign_id);
      return res.status(200).json({
        success: true,
        ended: false,
        campaign_type: 'recurring',
        message: 'Subscription is already canceled',
        campaign_id: sponsor_campaign_id,
        subscription_id: billing.stripe_subscription_id,
      });
    }

    const stripe_subscription_id = billing.stripe_subscription_id;

    // Cancel in Stripe immediately (do not update DB on Stripe failure)
    let sub;
    try {
      sub = await stripe.subscriptions.cancel(stripe_subscription_id);
    } catch (stripeErr) {
      console.error('❌ [SPONSOR CANCEL] Stripe cancel failed, campaign_id:', sponsor_campaign_id, 'subscription_id:', stripe_subscription_id, stripeErr);
      return res.status(500).json({
        success: false,
        error: 'Failed to cancel subscription in Stripe',
        details: stripeErr.message,
      });
    }

    // Atomically update DB: sponsor_billing.status and sponsor_campaigns.status
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE sponsor_billing SET status = 'canceled' WHERE sponsor_campaign_id = $1 AND stripe_subscription_id = $2`,
        [sponsor_campaign_id, stripe_subscription_id]
      );

      await client.query(
        `UPDATE sponsor_campaigns SET status = 'canceled', updated_at = NOW() WHERE id = $1`,
        [sponsor_campaign_id]
      );

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.error('❌ [SPONSOR CANCEL] DB transaction failed after Stripe cancel, campaign_id:', sponsor_campaign_id, dbErr);
      return res.status(500).json({
        success: false,
        error: 'Subscription was canceled in Stripe but database update failed',
        details: dbErr.message,
      });
    } finally {
      client.release();
    }

    console.log('✅ [SPONSOR CANCEL] Recurring campaign canceled, campaign_id:', sponsor_campaign_id, 'subscription_id:', stripe_subscription_id, 'Stripe status:', sub?.status || 'N/A');

    // Send sponsorship ended email
    if (emailService && emailService.isEmailConfigured()) {
      pool.query(
        `SELECT sa.contact_email, sa.organization_legal_name, sc.impressions_total
         FROM sponsor_campaigns sc
         JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
         WHERE sc.id = $1`,
        [sponsor_campaign_id]
      ).then(r => {
        if (r.rows.length > 0) {
          const { contact_email, organization_legal_name, impressions_total } = r.rows[0];
          emailService.sendSponsorCampaignEndedEmail(contact_email, organization_legal_name, impressions_total || 0)
            .catch(err => console.error('[SPONSOR CANCEL] End email failed:', err.message));
        }
      }).catch(err => console.error('[SPONSOR CANCEL] End email query failed:', err.message));
    }

    return res.status(200).json({
      success: true,
      ended: true,
      campaign_type: 'recurring',
      campaign_id: sponsor_campaign_id,
      subscription_id: stripe_subscription_id,
    });
  } catch (err) {
    console.error('❌ [SPONSOR CANCEL] Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
  }
});

// ===== SPONSOR RETRY PAYMENT (non-recurring payment_failed campaigns) =====
// Re-charges the customer's default card for a non-recurring campaign that previously failed payment.
// On success: updates sponsor_billing to paid, writes donation_ledger + pool, sets campaign to approved.
app.post('/api/sponsor/retry-payment', requireSponsorAuth, async (req, res) => {
  try {
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const { sponsor_campaign_id } = req.body || {};
    if (!sponsor_campaign_id) {
      return res.status(400).json({ success: false, error: 'sponsor_campaign_id is required' });
    }

    const pool = getPool();
    if (!pool) return res.status(500).json({ success: false, error: 'Database unavailable' });

    // Load campaign + billing + account in one query; verify ownership and state
    const lookupResult = await pool.query(`
      SELECT sc.id AS campaign_id, sc.status AS campaign_status, sc.start_week,
             sb.id AS billing_id, sb.amount_cents, sb.stripe_mode, sb.status AS billing_status,
             sa.stripe_customer_id
      FROM sponsor_campaigns sc
      JOIN sponsor_billing sb ON sb.sponsor_campaign_id = sc.id
      JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
      WHERE sc.id = $1 AND sc.sponsor_account_id = $2
      LIMIT 1
    `, [sponsor_campaign_id, sponsorAccountId]);

    if (lookupResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    const row = lookupResult.rows[0];

    if (row.campaign_status !== 'payment_failed') {
      return res.status(400).json({ success: false, error: 'Campaign is not in payment_failed status' });
    }
    if (row.stripe_mode !== 'one_time') {
      return res.status(400).json({ success: false, error: 'Retry is only available for non-recurring campaigns' });
    }
    if (!row.stripe_customer_id) {
      return res.status(400).json({ success: false, error: 'No Stripe customer on file' });
    }
    if (!stripe) {
      return res.status(500).json({ success: false, error: 'Stripe not configured' });
    }

    // Get the customer's current default payment method
    const customer = await stripe.customers.retrieve(row.stripe_customer_id);
    const defaultPmId = customer.invoice_settings?.default_payment_method;
    let paymentMethodId = defaultPmId;
    if (!paymentMethodId) {
      const pmList = await stripe.paymentMethods.list({ customer: row.stripe_customer_id, type: 'card', limit: 1 });
      paymentMethodId = pmList.data[0]?.id;
    }
    if (!paymentMethodId) {
      return res.status(400).json({ success: false, error: 'No saved payment method. Please add a card in the Billing tab first.' });
    }

    const amountCents = parseInt(row.amount_cents, 10);

    // Attempt charge
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        customer: row.stripe_customer_id,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        metadata: { campaignId: sponsor_campaign_id, sponsorAccountId, campaignType: 'non-recurring', isRetry: 'true' }
      });
    } catch (stripeErr) {
      console.error('❌ [SPONSOR RETRY] Stripe charge failed:', stripeErr.message);
      return res.status(402).json({ success: false, error: stripeErr.message || 'Payment failed' });
    }

    if (paymentIntent.status !== 'succeeded') {
      return res.status(402).json({ success: false, error: `Payment not completed: ${paymentIntent.status}` });
    }

    console.log(`✅ [SPONSOR RETRY] Payment succeeded for campaign ${sponsor_campaign_id}, PI: ${paymentIntent.id}`);

    // Compute a fresh next Monday LA as the start week — always recalculate at retry time
    // so a stale start_week from a past failed approval attempt is never reused.
    const startMonday = getNextMondayLA();
    const startWeekStr = startMonday.toISOString().slice(0, 10);
    const endAt = new Date(startMonday);
    endAt.setUTCDate(endAt.getUTCDate() + 7);
    const endAtStr = endAt.toISOString().slice(0, 10);

    // Write donation + ledger + pool, update billing + campaign — all in one transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const donResult = await client.query(
        `INSERT INTO sponsor_donations (sponsor_account_id, sponsor_campaign_id, stripe_payment_intent_id, amount_cents, source)
         VALUES ($1, $2, $3, $4, 'one_time_payment') RETURNING id`,
        [sponsorAccountId, sponsor_campaign_id, paymentIntent.id, amountCents]
      );
      const donationId = donResult.rows[0].id;
      const amountDollars = amountCents / 100;

      await client.query(
        `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
         VALUES ('sponsor', $1, $2, $3, $4)
         ON CONFLICT (source_id, week_start) DO NOTHING`,
        [sponsor_campaign_id, donationId, amountDollars, startWeekStr]
      );

      await client.query(
        `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total)
         VALUES ($1::date, $2, 0)
         ON CONFLICT (week_start) DO UPDATE
         SET sponsor_total = weekly_donation_pool.sponsor_total + $2, updated_at = NOW()`,
        [startWeekStr, amountDollars]
      );

      await client.query(
        `UPDATE sponsor_billing SET status = 'paid', stripe_payment_intent_id = $1 WHERE id = $2`,
        [paymentIntent.id, row.billing_id]
      );

      await client.query(
        `UPDATE sponsor_campaigns SET status = 'approved', start_week = $2::date, end_at = $3::date, updated_at = NOW() WHERE id = $1`,
        [sponsor_campaign_id, startWeekStr, endAtStr]
      );

      await client.query('COMMIT');
      console.log(`✅ [SPONSOR RETRY] Campaign ${sponsor_campaign_id} restored to approved`);
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.error('❌ [SPONSOR RETRY] DB error after successful charge:', dbErr.message);
      return res.status(500).json({ success: false, error: 'Payment succeeded but failed to update records. Please contact support.' });
    } finally {
      client.release();
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ [SPONSOR RETRY] Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ===== SPONSOR ACCOUNT (Sponsor Portal Account tab) =====
app.get('/api/sponsor/account', requireSponsorAuth, async (req, res) => {
  try {
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const result = await pool.query(
      `SELECT organization_legal_name, contact_email, phone_number
       FROM sponsor_accounts WHERE id = $1`,
      [sponsorAccountId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sponsor account not found' });
    }
    const row = result.rows[0];
    res.json({
      companyName: row.organization_legal_name || null,
      email: row.contact_email || null,
      phoneNumber: row.phone_number || null
    });
  } catch (err) {
    console.error('❌ [SPONSOR ACCOUNT] Error:', err);
    res.status(500).json({ error: 'Failed to load account' });
  }
});

app.patch('/api/sponsor/account', requireSponsorAuth, async (req, res) => {
  try {
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const { phoneNumber } = req.body;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    if (phoneNumber !== null && phoneNumber !== undefined && typeof phoneNumber !== 'string') {
      return res.status(400).json({ error: 'Phone number must be a string' });
    }
    const normalized = phoneNumber && phoneNumber.trim() ? phoneNumber.trim() : null;
    const result = await pool.query(
      `UPDATE sponsor_accounts SET phone_number = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING phone_number`,
      [normalized, sponsorAccountId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sponsor account not found' });
    }
    res.json({ success: true, phoneNumber: result.rows[0].phone_number || null });
  } catch (err) {
    console.error('❌ [SPONSOR ACCOUNT PATCH] Error:', err);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

// ===== SPONSOR CAMPAIGNS LIST (Sponsor Portal Campaigns tab) =====
app.get('/api/sponsor/campaigns', requireSponsorAuth, async (req, res) => {
  try {
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const result = await pool.query(`
      SELECT sc.id, sc.status AS campaign_status, sc.tier, sc.created_at,
             sb.status AS billing_status, sc.generation_completed,
             sc.start_week,
             sa.organization_legal_name
      FROM sponsor_campaigns sc
      JOIN sponsor_billing sb ON sb.sponsor_campaign_id = sc.id
      JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
      WHERE sc.sponsor_account_id = $1
      ORDER BY sc.created_at DESC
    `, [sponsorAccountId]);

    // Fetch recipients for all campaigns via donation_ledger → charity_week_winner → charity_applications
    const campaignIds = result.rows.map(r => String(r.id));
    const recipientsByCampaignId = {};
    if (campaignIds.length > 0) {
      const recipientsResult = await pool.query(`
        SELECT dl.source_id AS campaign_id, ca.charity_name, cww.week_start
        FROM donation_ledger dl
        JOIN charity_week_winner cww ON cww.week_start = dl.week_start
        JOIN charity_applications ca ON ca.id = cww.charity_application_id
        WHERE dl.source_type = 'sponsor'
          AND dl.source_id = ANY($1::text[])
        ORDER BY dl.source_id, cww.week_start DESC
      `, [campaignIds]);
      recipientsResult.rows.forEach(row => {
        const id = row.campaign_id;
        if (!recipientsByCampaignId[id]) recipientsByCampaignId[id] = [];
        if (!recipientsByCampaignId[id].includes(row.charity_name)) {
          recipientsByCampaignId[id].push(row.charity_name);
        }
      });
    }

    const campaigns = result.rows.map(row => {
      let status;
      const cs = (row.campaign_status || '').toLowerCase();
      const billingStatus = (row.billing_status || '').toLowerCase();
      const genComplete = row.generation_completed === true;
      const todayStr = new Date().toISOString().slice(0, 10);
      const startWeekStr = row.start_week ? new Date(row.start_week).toISOString().slice(0, 10) : null;
      const startWeekFuture = startWeekStr && startWeekStr > todayStr;
      if (cs === 'rejected') status = 'REJECTED';
      else if (cs === 'ended' || cs === 'canceled') status = 'ENDED';
      else if (cs === 'payment_failed') status = 'PAYMENT_FAILED';
      else if (cs === 'approved' && genComplete && billingStatus === 'trialing') status = 'APPROVED';
      else if ((cs === 'approved' || cs === 'active') && genComplete && billingStatus === 'paid') status = startWeekFuture ? 'APPROVED' : 'LIVE';
      else status = 'PENDING_APPROVAL';

      const orgName = row.organization_legal_name || 'Sponsorship';
      const campaignName = orgName;

      return {
        id: row.id,
        campaignName,
        tier: row.tier || null,
        status,
        startWeek: row.start_week,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        recipients: recipientsByCampaignId[String(row.id)] || []
      };
    });
    res.json(campaigns);
  } catch (err) {
    console.error('❌ [SPONSOR CAMPAIGNS] Error:', err);
    res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

// ===== SPONSOR BILLING (Sponsor Portal Billing tab) =====
app.get('/api/sponsor/stripe-config', requireSponsorAuth, async (req, res) => {
  try {
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
    res.json({ publishableKey });
  } catch (err) {
    console.error('❌ [SPONSOR STRIPE-CONFIG] Error:', err);
    res.status(500).json({ error: 'Failed to get Stripe config' });
  }
});

app.get('/api/sponsor/payment-methods', requireSponsorAuth, async (req, res) => {
  try {
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const custResult = await pool.query(
      'SELECT stripe_customer_id FROM sponsor_accounts WHERE id = $1 AND stripe_customer_id IS NOT NULL',
      [sponsorAccountId]
    );
    if (custResult.rows.length === 0 || !custResult.rows[0].stripe_customer_id) {
      return res.json({ paymentMethods: [], defaultPaymentMethodId: null });
    }
    const customerId = custResult.rows[0].stripe_customer_id;
    const customer = await stripe.customers.retrieve(customerId);
    const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method || null;
    const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    const formatted = paymentMethods.data.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand || 'unknown',
      last4: pm.card?.last4 || '',
      exp_month: pm.card?.exp_month || null,
      exp_year: pm.card?.exp_year || null,
      is_default: pm.id === defaultPaymentMethodId
    }));
    res.json({ paymentMethods: formatted, defaultPaymentMethodId });
  } catch (err) {
    console.error('❌ [SPONSOR PAYMENT-METHODS] Error:', err);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

app.post('/api/sponsor/create-setup-intent', requireSponsorAuth, async (req, res) => {
  try {
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const custResult = await pool.query(
      'SELECT stripe_customer_id FROM sponsor_accounts WHERE id = $1 AND stripe_customer_id IS NOT NULL',
      [sponsorAccountId]
    );
    if (custResult.rows.length === 0 || !custResult.rows[0].stripe_customer_id) {
      return res.status(404).json({ error: 'Stripe customer not found. Complete a sponsorship first.' });
    }
    const customerId = custResult.rows[0].stripe_customer_id;
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      payment_method_types: ['card']
    });
    res.json({ client_secret: setupIntent.client_secret });
  } catch (err) {
    console.error('❌ [SPONSOR CREATE-SETUP-INTENT] Error:', err);
    res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

app.post('/api/sponsor/set-default-payment-method', requireSponsorAuth, async (req, res) => {
  try {
    const { payment_method_id } = req.body;
    if (!payment_method_id) {
      return res.status(400).json({ error: 'payment_method_id is required' });
    }
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const custResult = await pool.query(
      'SELECT stripe_customer_id FROM sponsor_accounts WHERE id = $1 AND stripe_customer_id IS NOT NULL',
      [sponsorAccountId]
    );
    if (custResult.rows.length === 0 || !custResult.rows[0].stripe_customer_id) {
      return res.status(404).json({ error: 'Stripe customer not found' });
    }
    const customerId = custResult.rows[0].stripe_customer_id;
    const pm = await stripe.paymentMethods.retrieve(payment_method_id);
    if (pm.customer !== customerId) {
      return res.status(403).json({ error: 'Payment method does not belong to this customer' });
    }
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: payment_method_id }
    });
    // Propagate default to all active recurring subscriptions for this sponsor
    try {
      const subsResult = await pool.query(
        `SELECT sb.stripe_subscription_id
         FROM sponsor_billing sb
         JOIN sponsor_campaigns sc ON sc.id = sb.sponsor_campaign_id
         WHERE sc.sponsor_account_id = $1
           AND sc.is_recurring = true
           AND sb.stripe_subscription_id IS NOT NULL
           AND sb.status IN ('trialing', 'paid')`,
        [sponsorAccountId]
      );
      for (const row of subsResult.rows || []) {
        const subId = row.stripe_subscription_id;
        if (!subId) continue;
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          const subPm = typeof sub.default_payment_method === 'string' ? sub.default_payment_method : sub.default_payment_method?.id || null;
          if (subPm !== payment_method_id) {
            await stripe.subscriptions.update(subId, { default_payment_method: payment_method_id });
            console.log('✅ [SPONSOR] Updated subscription to new default PM:', subId);
          }
        } catch (subErr) {
          console.error('❌ [SPONSOR] Failed to update subscription', subId, subErr.message);
        }
      }
    } catch (propErr) {
      console.error('❌ [SPONSOR] Default propagation to subscriptions failed:', propErr.message);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ [SPONSOR SET-DEFAULT-PAYMENT] Error:', err);
    res.status(500).json({ error: 'Failed to set default payment method' });
  }
});

// Billing history from sponsor_billing only (DB-first; no live Stripe invoice listing)
app.get('/api/sponsor/billing-history', requireSponsorAuth, async (req, res) => {
  try {
    const sponsorAccountId = req.sponsor.sponsorAccountId;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const result = await pool.query(`
      SELECT sb.id, sb.created_at AS date, sb.amount_cents, sb.currency, sb.status,
             sb.stripe_mode, sa.organization_legal_name
      FROM sponsor_billing sb
      JOIN sponsor_campaigns sc ON sc.id = sb.sponsor_campaign_id
      JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
      WHERE sc.sponsor_account_id = $1
        AND sb.status IN ('paid', 'failed', 'canceled', 'trialing')
      ORDER BY sb.created_at DESC
      LIMIT 100
    `, [sponsorAccountId]);

    const history = result.rows.map(row => {
      const desc = row.organization_legal_name
        ? `${row.organization_legal_name} Sponsorship`
        : 'Sponsorship';
      const amount = (row.amount_cents || 0) / 100;
      const status = (row.status || 'open').toLowerCase();
      const displayStatus = status === 'paid' ? 'paid' : status === 'failed' || status === 'canceled' ? 'failed' : status === 'trialing' ? 'open' : status;
      return {
        id: row.id,
        date: row.date ? new Date(row.date).toISOString() : null,
        description: desc,
        amount,
        currency: row.currency || 'usd',
        status: displayStatus
      };
    });
    res.json(history);
  } catch (err) {
    console.error('❌ [SPONSOR BILLING-HISTORY] Error:', err);
    res.status(500).json({ error: 'Failed to load billing history' });
  }
});

// ===== ADVERTISER PASSWORD RESET/CREATION ROUTES =====

// Unified password token validation endpoint
app.get('/api/advertiser/validate-password-token', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.json({ valid: false });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ valid: false, error: 'Database connection not available' });
    }
    
    // Get all password tokens (both password_setup and password_reset) that are not used and not expired
    const result = await pool.query(`
      SELECT 
        aat.id AS token_id,
        aat.advertiser_account_id,
        aat.purpose,
        aat.token_hash,
        aat.expires_at,
        aat.used_at,
        aa.id AS account_id,
        aa.email,
        aa.password_hash,
        aa.advertiser_id,
        a.company_name
      FROM advertiser_account_tokens aat
      INNER JOIN advertiser_accounts aa ON aat.advertiser_account_id = aa.id
      LEFT JOIN advertisers a ON aa.advertiser_id = a.id
      WHERE aat.purpose IN ('password_setup', 'password_reset')
        AND aat.used_at IS NULL
        AND aat.expires_at > NOW()
    `);
    
    // Compare raw token with each hashed token
    let matchedToken = null;
    for (const tokenRow of result.rows) {
      const isMatch = await compareToken(token, tokenRow.token_hash);
      if (isMatch) {
        matchedToken = tokenRow;
        break;
      }
    }
    
    if (!matchedToken) {
      return res.json({ valid: false });
    }
    
    // Branch based on token purpose
    if (matchedToken.purpose === 'password_setup') {
      // password_setup tokens: only valid if password_hash is NULL
      if (matchedToken.password_hash) {
        return res.json({ 
          valid: false, 
          accountAlreadySetup: true,
          message: 'Account already set up. Please sign in.'
        });
      }
    }
    // password_reset tokens: always valid (ignore password_hash existence)
    
    return res.json({ 
      valid: true, 
      email: matchedToken.email,
      companyName: matchedToken.company_name || null,
      purpose: matchedToken.purpose
    });
    
  } catch (error) {
    console.error('❌ [VALIDATE PASSWORD TOKEN] Error:', error);
    return res.json({ valid: false });
  }
});

// Unified set password endpoint
app.post('/api/advertiser/set-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    console.log('🔐 [SET PASSWORD] Request for token:', token ? token.substring(0, 8) + '...' : 'MISSING');
    
    if (!token || !password) {
      return res.status(400).json({ success: false, error: 'Token and password are required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Get all password tokens (both password_setup and password_reset) that are not used and not expired
    const tokenResult = await pool.query(`
      SELECT 
        aat.id AS token_id,
        aat.advertiser_account_id,
        aat.purpose,
        aat.token_hash,
        aat.expires_at,
        aat.used_at,
        aa.id AS account_id,
        aa.email,
        aa.password_hash,
        aa.advertiser_id,
        a.status
      FROM advertiser_account_tokens aat
      INNER JOIN advertiser_accounts aa ON aat.advertiser_account_id = aa.id
      LEFT JOIN advertisers a ON aa.advertiser_id = a.id
      WHERE aat.purpose IN ('password_setup', 'password_reset')
        AND aat.used_at IS NULL
        AND aat.expires_at > NOW()
    `);
    
    // Compare raw token with each hashed token
    let matchedToken = null;
    for (const tokenRow of tokenResult.rows) {
      const isMatch = await compareToken(token, tokenRow.token_hash);
      if (isMatch) {
        matchedToken = tokenRow;
        break;
      }
    }
    
    if (!matchedToken) {
      console.log('❌ [SET PASSWORD] Token not found or expired');
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }
    
    // Double-check expiration
    const now = new Date();
    const expiresAt = new Date(matchedToken.expires_at);
    if (now > expiresAt) {
      console.log('❌ [SET PASSWORD] Token expired');
      return res.status(400).json({ success: false, error: 'Token has expired. Please request a new link.' });
    }
    
    // Branch based on token purpose
    if (matchedToken.purpose === 'password_setup') {
      // password_setup tokens: only valid if password_hash is NULL
      if (matchedToken.password_hash) {
        console.log('⚠️ [SET PASSWORD] Password already exists for password_setup token');
        return res.status(400).json({ 
          success: false, 
          accountAlreadySetup: true,
          error: 'Account already set up. Please sign in.'
        });
      }
    }
    // password_reset tokens: always valid (ignore password_hash existence)
    
    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    
    // Update password_hash in advertiser_accounts
    await pool.query(`
      UPDATE advertiser_accounts
      SET password_hash = $1
      WHERE id = $2
    `, [passwordHash, matchedToken.account_id]);
    
    // Mark tokens as used based on purpose
    if (matchedToken.purpose === 'password_reset') {
      // Invalidate all password_reset tokens for this account
      await pool.query(`
        UPDATE advertiser_account_tokens
        SET used_at = NOW()
        WHERE advertiser_account_id = $1
          AND purpose = 'password_reset'
          AND used_at IS NULL
      `, [matchedToken.advertiser_account_id]);
      console.log('✅ [SET PASSWORD] Invalidated all password_reset tokens for account');
    } else {
      // Invalidate all password_setup tokens for this account
      await pool.query(`
        UPDATE advertiser_account_tokens
        SET used_at = NOW()
        WHERE advertiser_account_id = $1
          AND purpose = 'password_setup'
          AND used_at IS NULL
      `, [matchedToken.advertiser_account_id]);
      console.log('✅ [SET PASSWORD] Invalidated all password_setup tokens for account');
    }
    
    console.log('✅ [SET PASSWORD] Password created for email:', matchedToken.email);
    
    return res.json({
      success: true,
      message: 'Password has been created successfully'
    });
    
  } catch (error) {
    console.error('❌ [SET PASSWORD] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ===== SPONSOR PASSWORD RESET/CREATION ROUTES =====

// Unified sponsor password token validation endpoint
app.get('/api/sponsor/validate-password-token', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.json({ valid: false });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ valid: false, error: 'Database connection not available' });
    }
    
    // Get all sponsor password tokens (both password_setup and password_reset) that are not used and not expired
    const result = await pool.query(`
      SELECT 
        sat.id AS token_id,
        sat.sponsor_account_id,
        sat.purpose,
        sat.token_hash,
        sat.expires_at,
        sat.used_at,
        sa.id AS account_id,
        sa.contact_email AS email,
        sa.password_hash,
        sa.organization_legal_name
      FROM sponsor_account_tokens sat
      INNER JOIN sponsor_accounts sa ON sat.sponsor_account_id = sa.id
      WHERE sat.purpose IN ('password_setup', 'password_reset')
        AND sat.used_at IS NULL
        AND sat.expires_at > NOW()
    `);
    
    // Compare raw token with each hashed token
    let matchedToken = null;
    for (const tokenRow of result.rows) {
      const isMatch = await compareToken(token, tokenRow.token_hash);
      if (isMatch) {
        matchedToken = tokenRow;
        break;
      }
    }
    
    if (!matchedToken) {
      return res.json({ valid: false });
    }
    
    // Branch based on token purpose
    if (matchedToken.purpose === 'password_setup') {
      // password_setup tokens: only valid if password_hash is NULL
      if (matchedToken.password_hash) {
        return res.json({ 
          valid: false, 
          accountAlreadySetup: true,
          message: 'Account already set up. Please sign in.'
        });
      }
    }
    // password_reset tokens: always valid (ignore password_hash existence)
    
    return res.json({ 
      valid: true, 
      email: matchedToken.email,
      organizationName: matchedToken.organization_legal_name || null,
      purpose: matchedToken.purpose
    });
    
  } catch (error) {
    console.error('❌ [SPONSOR VALIDATE PASSWORD TOKEN] Error:', error);
    return res.json({ valid: false });
  }
});

// Unified sponsor set password endpoint
app.post('/api/sponsor/set-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    console.log('🔐 [SPONSOR SET PASSWORD] Request for token:', token ? token.substring(0, 8) + '...' : 'MISSING');
    
    if (!token || !password) {
      return res.status(400).json({ success: false, error: 'Token and password are required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Get all sponsor password tokens (both password_setup and password_reset) that are not used and not expired
    const tokenResult = await pool.query(`
      SELECT 
        sat.id AS token_id,
        sat.sponsor_account_id,
        sat.purpose,
        sat.token_hash,
        sat.expires_at,
        sat.used_at,
        sa.id AS account_id,
        sa.contact_email AS email,
        sa.password_hash
      FROM sponsor_account_tokens sat
      INNER JOIN sponsor_accounts sa ON sat.sponsor_account_id = sa.id
      WHERE sat.purpose IN ('password_setup', 'password_reset')
        AND sat.used_at IS NULL
        AND sat.expires_at > NOW()
    `);
    
    // Compare raw token with each hashed token
    let matchedToken = null;
    for (const tokenRow of tokenResult.rows) {
      const isMatch = await compareToken(token, tokenRow.token_hash);
      if (isMatch) {
        matchedToken = tokenRow;
        break;
      }
    }
    
    if (!matchedToken) {
      console.log('❌ [SPONSOR SET PASSWORD] Token not found or expired');
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }
    
    // Double-check expiration
    const now = new Date();
    const expiresAt = new Date(matchedToken.expires_at);
    if (now > expiresAt) {
      console.log('❌ [SPONSOR SET PASSWORD] Token expired');
      return res.status(400).json({ success: false, error: 'Token has expired. Please request a new link.' });
    }
    
    // Branch based on token purpose
    if (matchedToken.purpose === 'password_setup') {
      // password_setup tokens: only valid if password_hash is NULL
      if (matchedToken.password_hash) {
        console.log('⚠️ [SPONSOR SET PASSWORD] Password already exists for password_setup token');
        return res.status(400).json({ 
          success: false, 
          accountAlreadySetup: true,
          error: 'Account already set up. Please sign in.'
        });
      }
    }
    // password_reset tokens: always valid (ignore password_hash existence)
    
    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    
    // Update password_hash in sponsor_accounts
    await pool.query(`
      UPDATE sponsor_accounts
      SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [passwordHash, matchedToken.account_id]);
    
    // Mark tokens as used based on purpose
    if (matchedToken.purpose === 'password_reset') {
      // Invalidate all password_reset tokens for this account
      await pool.query(`
        UPDATE sponsor_account_tokens
        SET used_at = NOW()
        WHERE sponsor_account_id = $1
          AND purpose = 'password_reset'
          AND used_at IS NULL
      `, [matchedToken.sponsor_account_id]);
      console.log('✅ [SPONSOR SET PASSWORD] Invalidated all password_reset tokens for account');
    } else {
      // Invalidate all password_setup tokens for this account
      await pool.query(`
        UPDATE sponsor_account_tokens
        SET used_at = NOW()
        WHERE sponsor_account_id = $1
          AND purpose = 'password_setup'
          AND used_at IS NULL
      `, [matchedToken.sponsor_account_id]);
      console.log('✅ [SPONSOR SET PASSWORD] Invalidated all password_setup tokens for account');
    }
    
    console.log('✅ [SPONSOR SET PASSWORD] Password created for email:', matchedToken.email);
    
    return res.json({
      success: true,
      message: 'Password has been created successfully'
    });
    
  } catch (error) {
    console.error('❌ [SPONSOR SET PASSWORD] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ===== SPONSOR PASSWORD RESET REQUEST =====
app.post('/api/sponsor/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    
    console.log('🔐 [SPONSOR PASSWORD RESET] Request for email:', email);
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Look up sponsor_accounts by contact_email ONLY (case-insensitive)
    // CRITICAL: Do NOT fallback to advertiser_accounts - sponsors and advertisers are isolated
    const normalizedEmail = email.toLowerCase().trim();
    const accountResult = await pool.query(`
      SELECT id, contact_email, password_hash, organization_legal_name
      FROM sponsor_accounts
      WHERE LOWER(TRIM(contact_email)) = LOWER(TRIM($1))
    `, [normalizedEmail]);
    
    // Always return success message (security: don't reveal if email exists)
    // But only send email if sponsor account exists
    if (accountResult.rows.length > 0) {
      const account = accountResult.rows[0];
      
      // Create password_reset token using sponsor token function
      let rawResetToken = null;
      try {
        const tokenResult = await createSponsorPasswordToken(account.id, 'password_reset', pool);
        rawResetToken = tokenResult.rawToken;
        console.log('✅ [SPONSOR PASSWORD RESET] Token generated for email:', email);
      } catch (tokenError) {
        console.error('❌ [SPONSOR PASSWORD RESET] Failed to create token:', tokenError);
        // Continue - will return success message anyway
      }
      
      // Send email with reset link
      if (emailService && emailService.isEmailConfigured() && rawResetToken) {
        const resetUrl = `${process.env.FRONTEND_URL || 'https://portal.charitystream'}/portal/reset-password?token=${rawResetToken}`;
        
        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: email,
          subject: account.password_hash ? 'Reset Your Sponsor Portal Password' : 'Create Your Sponsor Portal Password',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>${account.password_hash ? 'Reset Your Password' : 'Create Your Password'}</h2>
              <p>${account.password_hash ? 'You requested to reset your password for the Charity Stream Sponsor Portal.' : 'You need to create a password to access your sponsor portal account.'}</p>
              <p>Click the button below to ${account.password_hash ? 'reset' : 'create'} your password:</p>
              <p><a href="${resetUrl}" style="background-color: #2F7D31; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">${account.password_hash ? 'Reset Password' : 'Create Password'}</a></p>
              <p>This link will expire in 24 hours.</p>
              <p>If you didn't request this, you can safely ignore this email.</p>
            </div>
          `
        };
        
        await emailService.transporter.sendMail(mailOptions);
        console.log('✅ [SPONSOR PASSWORD RESET] Email sent to:', email);
      } else {
        console.warn('⚠️ [SPONSOR PASSWORD RESET] Email service not configured');
      }
    } else {
      console.log('⚠️ [SPONSOR PASSWORD RESET] Sponsor account not found (not revealing to user)');
      // CRITICAL: Do NOT fallback to advertiser lookup - return success anyway
    }
    
    // Always return success (security best practice - never reveal if email exists)
    return res.json({
      success: true,
      message: 'If an account exists, an email has been sent.'
    });
    
  } catch (error) {
    console.error('❌ [SPONSOR PASSWORD RESET] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ===== ADVERTISER PASSWORD RESET REQUEST =====
// Request password reset or creation link
app.post('/api/advertiser/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    
    console.log('🔐 [PASSWORD RESET] Request for email:', email);
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Look up advertiser_accounts by email (case-insensitive)
    const normalizedEmail = email.toLowerCase().trim();
    const accountResult = await pool.query(`
      SELECT aa.id, aa.email, aa.password_hash, aa.advertiser_id,
             a.company_name
      FROM advertiser_accounts aa
      INNER JOIN advertisers a ON aa.advertiser_id = a.id
      WHERE LOWER(TRIM(aa.email)) = LOWER(TRIM($1))
    `, [normalizedEmail]);
    
    // Always return success message (security: don't reveal if email exists)
    // But only send email if account exists
    if (accountResult.rows.length > 0) {
      const account = accountResult.rows[0];
      
      // Create password_reset token (always allowed, even if password exists)
      let rawResetToken = null;
      try {
        const tokenResult = await createPasswordToken(account.id, 'password_reset', pool);
        rawResetToken = tokenResult.rawToken;
        console.log('✅ [PASSWORD RESET] Token generated for email:', email);
      } catch (tokenError) {
        console.error('❌ [PASSWORD RESET] Failed to create token:', tokenError);
        // Continue - will return success message anyway
      }
      
      // Send email with reset link (unified URL - no type parameter)
      if (emailService && emailService.isEmailConfigured() && rawResetToken) {
        const resetUrl = `${process.env.FRONTEND_URL || 'https://portal.charitystream'}/portal/reset-password?token=${rawResetToken}`;
        
        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: email,
          subject: account.password_hash ? 'Reset Your Advertiser Portal Password' : 'Create Your Advertiser Portal Password',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>${account.password_hash ? 'Reset Your Password' : 'Create Your Password'}</h2>
              <p>${account.password_hash ? 'You requested to reset your password for the Charity Stream Advertiser Portal.' : 'You need to create a password to access your advertiser portal account.'}</p>
              <p>Click the button below to ${account.password_hash ? 'reset' : 'create'} your password:</p>
              <p><a href="${resetUrl}" style="background-color: #2F7D31; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">${account.password_hash ? 'Reset Password' : 'Create Password'}</a></p>
              <p>This link will expire in 24 hours.</p>
              <p>If you didn't request this, you can safely ignore this email.</p>
            </div>
          `
        };
        
        await emailService.transporter.sendMail(mailOptions);
        console.log('✅ [PASSWORD RESET] Email sent to:', email);
      } else {
        console.warn('⚠️ [PASSWORD RESET] Email service not configured');
      }
    } else {
      console.log('⚠️ [PASSWORD RESET] Account not found (not revealing to user)');
    }
    
    // Always return success (security best practice - never reveal if email exists)
    return res.json({
      success: true,
      message: 'If an account exists, an email has been sent.'
    });
    
  } catch (error) {
    console.error('❌ [PASSWORD RESET] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Validate reset token (for frontend to check if token is valid)
app.get('/api/advertiser/validate-reset-token', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.json({ valid: false });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ valid: false, error: 'Database connection not available' });
    }
    
    // Get all accounts with password_reset_token (we'll compare hashed tokens)
    const result = await pool.query(`
      SELECT id, email, password_reset_token, password_reset_expires_at
      FROM advertiser_accounts
      WHERE password_reset_token IS NOT NULL
        AND password_reset_expires_at > NOW()
    `);
    
    // Compare raw token with each hashed token
    let matchedAccount = null;
    for (const account of result.rows) {
      const isMatch = await compareToken(token, account.password_reset_token);
      if (isMatch) {
        matchedAccount = account;
        break;
      }
    }
    
    if (!matchedAccount) {
      return res.json({ valid: false });
    }
    
    const now = new Date();
    const expiresAt = new Date(matchedAccount.password_reset_expires_at);
    
    if (now > expiresAt) {
      return res.json({ valid: false, expired: true });
    }
    
    return res.json({ valid: true, email: matchedAccount.email });
    
  } catch (error) {
    console.error('❌ [VALIDATE RESET TOKEN] Error:', error);
    return res.json({ valid: false });
  }
});

// Reset password using token
app.post('/api/advertiser/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    console.log('🔐 [RESET PASSWORD] Request for token:', token ? token.substring(0, 8) + '...' : 'MISSING');
    
    if (!token || !password) {
      return res.status(400).json({ success: false, error: 'Token and password are required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Look up accounts with password_reset_token (compare hashed tokens)
    const accountResult = await pool.query(`
      SELECT id, email, password_reset_token, password_reset_expires_at
      FROM advertiser_accounts
      WHERE password_reset_token IS NOT NULL
        AND password_reset_expires_at > NOW()
    `);
    
    // Compare raw token with each hashed token
    let matchedAccount = null;
    for (const account of accountResult.rows) {
      const isMatch = await compareToken(token, account.password_reset_token);
      if (isMatch) {
        matchedAccount = account;
        break;
      }
    }
    
    if (!matchedAccount) {
      console.log('❌ [RESET PASSWORD] Token not found or expired');
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }
    
    const account = matchedAccount;
    
    // Double-check expiration
    const now = new Date();
    const expiresAt = new Date(account.password_reset_expires_at);
    
    if (now > expiresAt) {
      console.log('❌ [RESET PASSWORD] Token expired');
      return res.status(400).json({ success: false, error: 'Token has expired. Please request a new link.' });
    }
    
    // Hash new password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    
    // Update password and clear reset token
    await pool.query(`
      UPDATE advertiser_accounts
      SET password_hash = $1,
          password_reset_token = NULL,
          password_reset_expires_at = NULL
      WHERE id = $2
    `, [passwordHash, account.id]);
    
    console.log('✅ [RESET PASSWORD] Password updated for email:', account.email);
    
    return res.json({
      success: true,
      message: 'Password has been updated successfully'
    });
    
  } catch (error) {
    console.error('❌ [RESET PASSWORD] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Validate initial setup token (for frontend - used for campaign submission/approval)
app.get('/api/advertiser/validate-initial-setup-token', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.json({ valid: false });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ valid: false, error: 'Database connection not available' });
    }
    
    // Look up account directly by plaintext initial_setup_token
    const result = await pool.query(`
      SELECT aa.id, aa.email, aa.initial_setup_token, aa.initial_setup_expires_at,
             a.company_name
      FROM advertiser_accounts aa
      INNER JOIN advertisers a ON aa.advertiser_id = a.id
      WHERE aa.initial_setup_token = $1
        AND aa.initial_setup_expires_at > NOW()
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.json({ valid: false });
    }
    
    const account = result.rows[0];
    const now = new Date();
    const expiresAt = new Date(account.initial_setup_expires_at);
    
    if (now > expiresAt) {
      return res.json({ valid: false, expired: true });
    }
    
    return res.json({ 
      valid: true, 
      email: account.email,
      companyName: account.company_name
    });
    
  } catch (error) {
    console.error('❌ [VALIDATE INITIAL SETUP TOKEN] Error:', error);
    return res.json({ valid: false });
  }
});

// Create password using initial setup token (from campaign submission/approval)
app.post('/api/advertiser/create-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    console.log('🔐 [CREATE PASSWORD] Request for token:', token ? token.substring(0, 8) + '...' : 'MISSING');
    
    if (!token || !password) {
      return res.status(400).json({ success: false, error: 'Token and password are required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Look up account directly by plaintext initial_setup_token
    const accountResult = await pool.query(`
      SELECT aa.id, aa.email, aa.initial_setup_token, aa.initial_setup_expires_at, aa.password_hash,
             aa.advertiser_id,
             a.status
      FROM advertiser_accounts aa
      INNER JOIN advertisers a ON aa.advertiser_id = a.id
      WHERE aa.initial_setup_token = $1
        AND aa.initial_setup_expires_at > NOW()
    `, [token]);
    
    if (accountResult.rows.length === 0) {
      console.log('❌ [CREATE PASSWORD] Token not found or expired');
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }
    
    const account = accountResult.rows[0];
    
    // Double-check expiration
    const now = new Date();
    const expiresAt = new Date(account.initial_setup_expires_at);
    
    if (now > expiresAt) {
      console.log('❌ [CREATE PASSWORD] Token expired');
      return res.status(400).json({ success: false, error: 'Token has expired. Please request a new link.' });
    }
    
    // Check if password already exists
    if (account.password_hash) {
      console.log('⚠️ [CREATE PASSWORD] Password already exists for this account');
      return res.status(400).json({ success: false, error: 'Password already exists. Use the login page or request a password reset.' });
    }
    
    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    
    // Update password and clear initial_setup_token (separate from password_reset_token)
    await pool.query(`
      UPDATE advertiser_accounts
      SET password_hash = $1,
          initial_setup_token = NULL,
          initial_setup_expires_at = NULL
      WHERE advertiser_id = $2
    `, [passwordHash, account.advertiser_id]);
    
    console.log('✅ [CREATE PASSWORD] Password created for email:', account.email);
    
    return res.json({
      success: true,
      message: 'Password has been created successfully'
    });
    
  } catch (error) {
    console.error('❌ [CREATE PASSWORD] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Middleware to authenticate advertiser portal tokens (separate from viewer/user auth)
// CRITICAL: Only accepts tokens with jwt_type === 'advertiser_portal'
// Website user tokens are explicitly rejected
function requireAdvertiserAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Ensure this is an advertiser portal token
    if (decoded.jwt_type !== 'advertiser_portal') {
      console.error('❌ [ADVERTISER AUTH] Invalid jwt_type for advertiser token:', decoded.jwt_type);
      return res.status(403).json({ error: 'Invalid token type' });
    }

    if (!decoded.advertiser_id) {
      console.error('❌ [ADVERTISER AUTH] Token missing advertiser_id');
      return res.status(403).json({ error: 'Invalid token' });
    }

    // Attach advertiser identity to request (preferred shape)
    req.advertiser = {
      advertiserId: decoded.advertiser_id,
      email: decoded.email,
    };

    // Backwards-compatible fields used elsewhere in the codebase
    req.advertiserId = decoded.advertiser_id;
    req.advertiserEmail = decoded.email;

    next();
  } catch (err) {
    console.error('❌ [ADVERTISER AUTH] JWT verification failed:', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Backwards-compatible alias for any legacy references
const authenticateAdvertiserPortal = requireAdvertiserAuth;

// Helper function to determine campaign status (unified logic)
function determineStatus(campaign) {
  const rowStatus = campaign.status;
  const reason = campaign.archived_reason;

  if (rowStatus === 'archived' && reason === 'Campaign revoked before approval') {
    return 'REVOKED';
  }
  if (rowStatus === 'rejected') {
    return 'REJECTED';
  }
  if (rowStatus === 'archived') {
    return 'ENDED';
  }
  if (rowStatus === 'pending_review' || rowStatus === 'payment_pending') {
    return 'IN REVIEW';
  }
  if (rowStatus === 'active' && campaign.campaign_start_date) {
    const startDate = new Date(campaign.campaign_start_date);
    const now = new Date();
    if (startDate > now) {
      return 'APPROVED';
    }
  }
  if (rowStatus === 'active') {
    if (campaign.is_paused === true) {
      return 'PAUSED';
    }
    if (campaign.capped === true) {
      return 'CAPPED';
    }
    return 'LIVE';
  }
  return 'IN REVIEW';
}

// Get advertiser dashboard data
app.get('/api/advertiser/dashboard', requireAdvertiserAuth, async (req, res) => {
  console.log('Advertiser dashboard auth:', req.advertiser);
  try {
    const advertiserAccountId = req.advertiser.advertiserId;
    const advertiserEmail = req.advertiser.email;
    const campaignIdFromQuery = req.query.campaignId;
    
    const pool = getPool();
    if (!pool) {
      console.error('❌ [DASHBOARD] Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }

    let idToLoad = null;
    let ad = null;

    // If campaignId is provided, try to load that specific campaign for this email
    // CRITICAL: Only load campaigns where payment_completed = TRUE (exclude abandoned signups)
    if (campaignIdFromQuery) {
      const advertiserResult = await pool.query(`
        SELECT
          id,
          campaign_name,
          company_name,
          total_impressions,
          current_week_impressions,
          weekly_budget_cap,
          cpm_rate,
          status,
          archived_reason,
          is_paused,
          billing_failed,
          media_r2_link,
          campaign_start_date,
          recurring_weekly,
          capped,
          ad_format,
          click_tracking,
          weekly_clicks,
          total_clicks
        FROM advertisers
        WHERE id = $1
          AND email = $2
          AND payment_completed = TRUE
      `, [campaignIdFromQuery, advertiserEmail]);

      if (advertiserResult.rows.length > 0) {
        ad = advertiserResult.rows[0];
        idToLoad = ad.id;
      } else {
        console.warn(`❗ [DASHBOARD] Requested campaignId does not belong to this account or does not exist, falling back to most recent campaign for email: ${advertiserEmail}, requestedId: ${campaignIdFromQuery}`);
      }
    }

    // If there's no valid ad yet, fall back to the most recent campaign for this advertiser email
    // CRITICAL: Only load campaigns where payment_completed = TRUE (exclude abandoned signups)
    if (!ad) {
      const fallbackResult = await pool.query(`
        SELECT
          id,
          campaign_name,
          company_name,
          total_impressions,
          current_week_impressions,
          weekly_budget_cap,
          cpm_rate,
          status,
          archived_reason,
          is_paused,
          billing_failed,
          media_r2_link,
          campaign_start_date,
          recurring_weekly,
          capped,
          ad_format,
          click_tracking,
          weekly_clicks,
          total_clicks
        FROM advertisers
        WHERE email = $1
          AND payment_completed = TRUE
          AND status != 'rejected'
        ORDER BY campaign_start_date DESC NULLS LAST, created_at DESC
        LIMIT 1
      `, [advertiserEmail]);

      if (fallbackResult.rows.length === 0) {
        console.log(`❌ [DASHBOARD] No campaigns found for advertiser email: ${advertiserEmail}`);
        return res.status(404).json({ error: 'No campaigns found for this advertiser' });
      }

      ad = fallbackResult.rows[0];
      idToLoad = ad.id;
    }

    // Determine status using unified helper function
    const status = determineStatus(ad);

    // Compute metrics
    const cpmRate = parseFloat(ad.cpm_rate) || 0;
    const weeklyBudgetCap = parseFloat(ad.weekly_budget_cap) || 0;
    
    // For ENDED campaigns: show Delivery and Total Spent, but null for weekly metrics
    // For LIVE and PAUSED: show all metrics
    // For IN REVIEW and REJECTED: show null for all metrics
    const isEnded = status === 'ENDED';
    const hasMetrics = status === 'LIVE' || status === 'PAUSED' || status === 'ENDED';
    
    // Total impressions and total spent: show for LIVE, PAUSED, and ENDED
    const totalImpressions = hasMetrics ? (ad.total_impressions || 0) : null;
    
    // Calculate total spent: impressions + clicks (if click tracking enabled)
    const clickTracking = ad.click_tracking === true;
    const totalClicks = clickTracking ? (ad.total_clicks || 0) : 0;
    const impressionSpendLifetime = totalImpressions !== null ? (totalImpressions / 1000) * cpmRate : 0;
    const clickSpendLifetime = clickTracking ? (totalClicks * 0.25) : 0;
    const totalSpent = hasMetrics && totalImpressions !== null 
      ? impressionSpendLifetime + clickSpendLifetime
      : null;
    
    // Weekly metrics: only show for LIVE and PAUSED (null for ENDED)
    // For ENDED non-recurring campaigns, also null out weekly metrics
    const isRecurring = ad.recurring_weekly === true;
    const isEndedNonRecurring = status === 'ENDED' && !isRecurring;
    const hasWeeklyMetrics = (status === 'LIVE' || status === 'PAUSED') && !isEndedNonRecurring;
    const currentWeekImpressions = hasWeeklyMetrics ? (ad.current_week_impressions || 0) : null;
    
    // Calculate weekly clicks (needed for both donationsThisWeek and currentWeekSpent)
    const weeklyClicks = clickTracking ? (ad.weekly_clicks || 0) : 0;
    
    // Calculate donationsThisWeek: impressions + clicks (if click tracking enabled)
    // This is the "Spent This Week" value shown in the dashboard
    const impressionSpendThisWeek = currentWeekImpressions !== null ? (currentWeekImpressions / 1000) * cpmRate : 0;
    const clickSpendThisWeek = clickTracking ? (weeklyClicks * 0.25) : 0;
    const donationsThisWeek = hasWeeklyMetrics && currentWeekImpressions !== null
      ? impressionSpendThisWeek + clickSpendThisWeek
      : null;

    // Calculate current week spent (same as donationsThisWeek, used for remaining budget calculation)
    const currentWeekSpent = donationsThisWeek;

    // Calculate remaining budget differently for recurring vs non-recurring
    // For ENDED campaigns (especially non-recurring), show null for remaining
    // Budget cap applies to total cost (impressions + clicks) when click tracking is enabled
    let remainingBudget = null;
    if (hasWeeklyMetrics) {
      if (isRecurring) {
        // Recurring: Remaining is based on this week's spend (impressions + clicks)
        if (currentWeekSpent !== null) {
          remainingBudget = Math.max(0, weeklyBudgetCap - currentWeekSpent);
        }
      } else {
        // Non-recurring: Remaining is based on total spend lifetime (impressions + clicks)
        // Does NOT reset at week boundaries
        if (totalSpent !== null) {
          remainingBudget = Math.max(0, weeklyBudgetCap - totalSpent);
        }
      }
    }

    // Use campaign_name if available, otherwise fall back to company_name + " Campaign"
    const campaignTitle = ad.campaign_name || (ad.company_name ? `${ad.company_name} Campaign` : 'Campaign');
    
    // Fetch all campaigns for this advertiser account (same email)
    // CRITICAL: Only load campaigns where payment_completed = TRUE (exclude abandoned signups)
    const allCampaignsResult = await pool.query(`
      SELECT 
        id,
        campaign_name,
        campaign_start_date,
        status,
        archived_reason,
        is_paused,
        weekly_budget_cap,
        total_impressions,
        cpm_rate,
        capped,
        click_tracking,
        total_clicks
      FROM advertisers
      WHERE email = $1
        AND payment_completed = TRUE
      ORDER BY campaign_start_date DESC NULLS LAST, created_at DESC
    `, [advertiserEmail]);

    // Fetch recipients for all campaigns via donation_ledger → charity_week_winner → charity_applications
    const campaignIds = allCampaignsResult.rows.map(c => String(c.id));
    const recipientsByCampaignId = {};
    if (campaignIds.length > 0) {
      const recipientsResult = await pool.query(`
        SELECT dl.source_id AS campaign_id, ca.charity_name, cww.week_start
        FROM donation_ledger dl
        JOIN charity_week_winner cww ON cww.week_start = dl.week_start
        JOIN charity_applications ca ON ca.id = cww.charity_application_id
        WHERE dl.source_type = 'advertiser'
          AND dl.source_id = ANY($1::text[])
        ORDER BY dl.source_id, cww.week_start DESC
      `, [campaignIds]);

      recipientsResult.rows.forEach(row => {
        const id = row.campaign_id;
        if (!recipientsByCampaignId[id]) recipientsByCampaignId[id] = [];
        // Deduplicate by charity name, preserving most-recent-first order
        if (!recipientsByCampaignId[id].includes(row.charity_name)) {
          recipientsByCampaignId[id].push(row.charity_name);
        }
      });
    }

    // Format campaigns for response
    const campaigns = allCampaignsResult.rows.map(campaign => {
      // Determine status using unified helper function
      const campaignStatus = determineStatus(campaign);

      // Calculate spent: impressions + clicks (if click tracking enabled)
      const campaignCpmRate = parseFloat(campaign.cpm_rate) || 0;
      const campaignTotalImpressions = campaign.total_impressions || 0;
      const campaignClickTracking = campaign.click_tracking === true;
      const campaignTotalClicks = campaignClickTracking ? (campaign.total_clicks || 0) : 0;
      const campaignImpressionSpend = (campaignTotalImpressions / 1000) * campaignCpmRate;
      const campaignClickSpend = campaignClickTracking ? (campaignTotalClicks * 0.25) : 0;
      const spent = campaignImpressionSpend + campaignClickSpend;

      // Format start date
      let startDateFormatted = null;
      if (campaign.campaign_start_date) {
        const date = new Date(campaign.campaign_start_date);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = date.getFullYear();
        startDateFormatted = `${month}/${day}/${year}`;
      }

      return {
        id: campaign.id,
        campaignName: campaign.campaign_name || null,
        startDate: startDateFormatted,
        status: campaignStatus,
        budget: parseFloat(campaign.weekly_budget_cap) || 0,
        spent: spent,
        recipients: recipientsByCampaignId[campaign.id] || []
      };
    });

    let weeklyRecipient = null;
    if (status === 'LIVE' || status === 'CAPPED') {
      const recipientResult = await pool.query(`
        SELECT ca.charity_name
        FROM charity_week_winner cww
        JOIN charity_applications ca ON ca.id = cww.charity_application_id
        WHERE cww.week_start = DATE_TRUNC('week', CURRENT_DATE)::date
        LIMIT 1
      `);
      if (recipientResult.rows.length > 0) {
        weeklyRecipient = recipientResult.rows[0].charity_name;
      }
    }
    
    const response = {
      activeCampaignId: idToLoad,
      status: status,
      campaignTitle: campaignTitle,
      campaignName: ad.campaign_name || null,
      companyName: ad.company_name || null,
      totalImpressions: totalImpressions,
      currentWeekImpressions: currentWeekImpressions,
      cpmRate: cpmRate,
      weeklyBudgetCap: weeklyBudgetCap,
      totalSpent: totalSpent,
      donationsThisWeek: donationsThisWeek,
      remainingBudget: remainingBudget,
      creativeUrl: normalizeBareMediaR2Link(ad.media_r2_link) || null,
      recurringWeekly: ad.recurring_weekly === true,
      billingFailed: ad.billing_failed === true,
      adFormat: ad.ad_format || 'video',
      clickTracking: clickTracking,
      totalClicks: hasMetrics ? (ad.total_clicks || 0) : null,
      campaigns: campaigns,
      weeklyRecipient
    };

    console.log('✅ [DASHBOARD] Returning dashboard data:', {
      advertiserAccountId: advertiserAccountId,
      advertiserEmail: advertiserEmail,
      requestedCampaignId: campaignIdFromQuery || null,
      loadedCampaignId: idToLoad,
      status: status,
      campaignTitle: response.campaignTitle,
      campaignsCount: campaigns.length
    });

    res.json(response);
  } catch (err) {
    console.error('❌ [DASHBOARD] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get leaderboard data (top 4 campaigns by weekly spend)
app.get('/api/advertiser/leaderboard', requireAdvertiserAuth, async (req, res) => {
  try {
    const advertiserEmail = req.advertiser.email;
    const pool = getPool();
    
    if (!pool) {
      console.error('❌ [LEADERBOARD] Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }

    // Fetch all non-archived campaigns with payment_completed = TRUE
    // Include status-related fields to determine if campaign has weekly metrics
    const campaignsResult = await pool.query(`
      SELECT 
        id,
        campaign_name,
        email,
        current_week_impressions,
        cpm_rate,
        click_tracking,
        weekly_clicks,
        status,
        archived_reason,
        is_paused,
        campaign_start_date,
        recurring_weekly,
        capped
      FROM advertisers
      WHERE status = 'active'
        AND payment_completed = TRUE
    `);

    // Calculate weekly spend for each campaign (same formula as donationsThisWeek)
    // Only calculate for campaigns that have weekly metrics (LIVE/PAUSED, not ENDED)
    const campaignsWithSpend = campaignsResult.rows
      .map(campaign => {
        // Determine status to check if campaign has weekly metrics
        const status = determineStatus(campaign);
        const isRecurring = campaign.recurring_weekly === true;
        const isEndedNonRecurring = status === 'ENDED' && !isRecurring;
        const hasWeeklyMetrics = (status === 'LIVE' || status === 'PAUSED' || status === 'CAPPED') && !isEndedNonRecurring;
        
        // Only calculate weekly spend if campaign has weekly metrics
        if (!hasWeeklyMetrics || campaign.current_week_impressions === null) {
          return null;
        }

        const cpmRate = parseFloat(campaign.cpm_rate) || 0;
        const currentWeekImpressions = campaign.current_week_impressions || 0;
        const clickTracking = campaign.click_tracking === true;
        const weeklyClicks = clickTracking ? (campaign.weekly_clicks || 0) : 0;
        
        // Same calculation as donationsThisWeek in dashboard endpoint
        const impressionSpendThisWeek = (currentWeekImpressions / 1000) * cpmRate;
        const clickSpendThisWeek = clickTracking ? (weeklyClicks * 0.25) : 0;
        const weeklySpend = impressionSpendThisWeek + clickSpendThisWeek;

        return {
          id: campaign.id,
          campaignName: campaign.campaign_name || null,
          email: campaign.email,
          weeklySpend: weeklySpend
        };
      })
      .filter(campaign => campaign !== null);

    // Filter campaigns with weekly spend >= $1.00
    const eligibleCampaigns = campaignsWithSpend.filter(c => c.weeklySpend >= 1.00);

    // Sort by weekly spend descending
    eligibleCampaigns.sort((a, b) => b.weeklySpend - a.weeklySpend);

    // Take top 4
    const topCampaigns = eligibleCampaigns.slice(0, 4);

    // Format response with "(You)" indicator
    const leaderboard = topCampaigns.map((campaign, index) => ({
      id: campaign.id,
      campaignName: campaign.campaignName,
      weeklySpend: campaign.weeklySpend,
      isOwned: campaign.email === advertiserEmail,
      rank: index + 1
    }));

    res.json({ leaderboard });
  } catch (err) {
    console.error('❌ [LEADERBOARD] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Stripe publishable key (public, for sponsor form Setup Intent / Elements)
app.get('/api/stripe-publishable-key', (req, res) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
  return res.json({ publishableKey });
});

// Get Stripe publishable key (safe to expose)
app.get('/api/advertiser/stripe-config', requireAdvertiserAuth, async (req, res) => {
  try {
    // Return publishable key (safe to expose to frontend)
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
    return res.json({ publishableKey });
  } catch (err) {
    console.error('❌ [STRIPE-CONFIG] Error:', err);
    return res.status(500).json({ error: 'Failed to get Stripe config' });
  }
});

// Get canonical Stripe customer ID for advertiser account (advertiser_accounts.stripe_customer_id)
async function getCanonicalAdvertiserCustomerId(pool, advertiserEmail) {
  const normalized = (advertiserEmail || '').toLowerCase().trim();
  const accountResult = await pool.query(
    `SELECT id, stripe_customer_id FROM advertiser_accounts WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
    [normalized]
  );
  if (accountResult.rows.length > 0 && accountResult.rows[0].stripe_customer_id) {
    return { customerId: accountResult.rows[0].stripe_customer_id, source: 'advertiser_accounts' };
  }
  return { customerId: null, source: null };
}

// Get payment methods for advertiser
app.get('/api/advertiser/payment-methods', requireAdvertiserAuth, async (req, res) => {
  try {
    const advertiserEmail = req.advertiserEmail;
    const pool = getPool();

    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const { customerId, source } = await getCanonicalAdvertiserCustomerId(pool, advertiserEmail);
    console.log('[PAYMENT-METHODS] Canonical customer:', customerId ? `${customerId} (${source})` : 'none');

    if (!customerId) {
      return res.json({ paymentMethods: [], defaultPaymentMethodId: null });
    }

    // Get customer to retrieve default payment method (validate customer exists in Stripe)
    let customer;
    try {
      customer = await stripe.customers.retrieve(customerId);
    } catch (stripeErr) {
      if (stripeErr.code === 'resource_missing' || stripeErr.statusCode === 404) {
        console.warn('[PAYMENT-METHODS] Stored customer id invalid in Stripe:', customerId);
        return res.json({ paymentMethods: [], defaultPaymentMethodId: null });
      }
      throw stripeErr;
    }
    const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method || null;

    // List all payment methods for this customer
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card'
    });

    // Format payment methods with is_default flag
    const formattedMethods = paymentMethods.data.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand || 'unknown',
      last4: pm.card?.last4 || '',
      exp_month: pm.card?.exp_month || null,
      exp_year: pm.card?.exp_year || null,
      is_default: pm.id === defaultPaymentMethodId
    }));

    return res.json({
      paymentMethods: formattedMethods,
      defaultPaymentMethodId: defaultPaymentMethodId
    });
  } catch (err) {
    console.error('❌ [PAYMENT-METHODS] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

// Create SetupIntent for adding new payment method
app.post('/api/advertiser/create-setup-intent', requireAdvertiserAuth, async (req, res) => {
  try {
    const advertiserEmail = req.advertiserEmail;
    const pool = getPool();

    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const { customerId, source } = await getCanonicalAdvertiserCustomerId(pool, advertiserEmail);
    console.log('[CREATE-SETUP-INTENT] Canonical customer:', customerId ? `${customerId} (${source})` : 'none');

    if (!customerId) {
      return res.status(404).json({ error: 'Stripe customer not found. Please complete your campaign setup first.' });
    }

    // Validate customer exists in Stripe
    try {
      await stripe.customers.retrieve(customerId);
    } catch (stripeErr) {
      if (stripeErr.code === 'resource_missing' || stripeErr.statusCode === 404) {
        return res.status(404).json({ error: 'Payment profile not found. Please complete a campaign checkout first.' });
      }
      throw stripeErr;
    }

    // Create SetupIntent
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      payment_method_types: ['card']
    });

    return res.json({
      client_secret: setupIntent.client_secret
    });
  } catch (err) {
    console.error('❌ [CREATE-SETUP-INTENT] Error:', err);
    return res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

// Set default payment method
app.post('/api/advertiser/set-default-payment-method', requireAdvertiserAuth, async (req, res) => {
  try {
    const { payment_method_id } = req.body;
    const advertiserEmail = req.advertiserEmail;
    const pool = getPool();

    if (!payment_method_id) {
      return res.status(400).json({ error: 'payment_method_id is required' });
    }

    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const { customerId } = await getCanonicalAdvertiserCustomerId(pool, advertiserEmail);

    if (!customerId) {
      return res.status(404).json({ error: 'Stripe customer not found' });
    }

    // Verify the payment method belongs to this customer
    const paymentMethod = await stripe.paymentMethods.retrieve(payment_method_id);
    if (paymentMethod.customer !== customerId) {
      return res.status(403).json({ error: 'Payment method does not belong to this customer' });
    }

    // Update customer's default payment method
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: payment_method_id
      }
    });

    console.log(`✅ [SET-DEFAULT-PAYMENT] Updated default payment method for customer ${customerId} to ${payment_method_id}`);

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ [SET-DEFAULT-PAYMENT] Error:', err);
    return res.status(500).json({ error: 'Failed to set default payment method' });
  }
});

// Get billing history
app.get('/api/advertiser/billing-history', requireAdvertiserAuth, async (req, res) => {
  try {
    const advertiserEmail = req.advertiserEmail;
    const pool = getPool();

    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const { customerId } = await getCanonicalAdvertiserCustomerId(pool, advertiserEmail);

    if (!customerId) {
      return res.json({ invoices: [] });
    }

    // Retrieve invoices from Stripe (source of truth)
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 100
    });

    // Collect invoice IDs for batch DB lookup (fallback for missing metadata)
    const invoiceIds = invoices.data.map(inv => inv.id);

    // Batch query to get campaign names and billing_failed flag from billing records
    let campaignNameMap = {};
    const billingFailedInvoiceIds = new Set();
    if (invoiceIds.length > 0) {
      try {
        // CRITICAL: Only join with campaigns where payment_completed = TRUE (exclude abandoned signups)
        const billingMatches = await pool.query(`
          SELECT
            rbr.stripe_invoice_id,
            a.company_name,
            a.campaign_name,
            a.billing_failed
          FROM recurring_billing_records rbr
          JOIN advertisers a ON rbr.advertiser_id = a.id
          WHERE rbr.stripe_invoice_id = ANY($1)
            AND a.payment_completed = TRUE

          UNION ALL

          SELECT
            nrb.stripe_invoice_id,
            a.company_name,
            a.campaign_name,
            a.billing_failed
          FROM non_recurring_billing_records nrb
          JOIN advertisers a ON nrb.campaign_id = a.id
          WHERE nrb.stripe_invoice_id = ANY($1)
            AND a.payment_completed = TRUE
        `, [invoiceIds]);

        // CRITICAL: campaignName MUST come from advertisers.campaign_name ONLY
        // Do NOT fall back to company_name, first_name, or any other field
        billingMatches.rows.forEach(row => {
          if (row.campaign_name && row.campaign_name.trim()) {
            campaignNameMap[row.stripe_invoice_id] = row.campaign_name.trim();
          } else {
            // Log warning for old invoices without campaign_name
            console.warn(`⚠️ [BILLING-HISTORY] campaign_name is NULL or empty for invoice ${row.stripe_invoice_id}. Using fallback.`);
            campaignNameMap[row.stripe_invoice_id] = 'Unknown Campaign';
          }
          if (row.billing_failed === true) {
            billingFailedInvoiceIds.add(row.stripe_invoice_id);
          }
        });
      } catch (dbError) {
        console.error('❌ [BILLING-HISTORY] Error querying billing records:', dbError);
        // Continue without DB fallback - will use metadata or "Unknown Campaign"
      }
    }

    // Map Stripe status to display status
    // If billing_failed is set and invoice is still open, show as failed rather than open
    const mapStatus = (stripeStatus, invoiceId) => {
      if (stripeStatus === 'open' && billingFailedInvoiceIds.has(invoiceId)) {
        return 'failed';
      }
      const statusMap = {
        'paid': 'paid',
        'open': 'open',
        'draft': 'draft',
        'uncollectible': 'failed',
        'void': 'failed',
        'marked_uncollectible': 'failed'
      };
      return statusMap[stripeStatus] || 'open';
    };

    // Map Stripe invoices to response DTO
    const billingHistory = invoices.data.map(invoice => {
      // Campaign name resolution: metadata > DB lookup > fallback
      let campaignName = invoice.metadata?.campaignName;
      if (!campaignName) {
        campaignName = campaignNameMap[invoice.id] || 'Unknown Campaign';
      }

      // Determine amount: use amount_paid if paid, otherwise amount_due
      const amount = invoice.status === 'paid'
        ? invoice.amount_paid / 100  // Convert cents to dollars
        : invoice.amount_due / 100;

      // Map status
      const status = mapStatus(invoice.status, invoice.id);

      // Convert Unix timestamp to ISO date string (YYYY-MM-DD)
      const date = new Date(invoice.created * 1000).toISOString().split('T')[0];

      return {
        invoiceId: invoice.id,
        date: date,
        campaignName: campaignName,
        amount: amount,
        currency: invoice.currency.toUpperCase(),
        status: status
      };
    });

    // Sort newest first (Stripe already returns newest first, but ensure it)
    billingHistory.sort((a, b) => new Date(b.date) - new Date(a.date));

    console.log(`✅ [BILLING-HISTORY] Returning ${billingHistory.length} invoices for customer ${customerId}`);

    return res.json({ invoices: billingHistory });
  } catch (err) {
    console.error('❌ [BILLING-HISTORY] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch billing history' });
  }
});

// Get advertiser account information
app.get('/api/advertiser/account', requireAdvertiserAuth, async (req, res) => {
  try {
    const advertiserEmail = req.advertiser.email;
    const pool = getPool();
    
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    // Get account info from the most recent campaign for this advertiser
    // We use the most recent campaign to get company_name and phone_number
    const result = await pool.query(`
      SELECT 
        company_name,
        email,
        phone_number
      FROM advertisers
      WHERE email = $1
        AND payment_completed = TRUE
      ORDER BY campaign_start_date DESC NULLS LAST, created_at DESC
      LIMIT 1
    `, [advertiserEmail]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Advertiser account not found' });
    }

    const account = result.rows[0];

    return res.json({
      companyName: account.company_name || null,
      email: account.email || null,
      phoneNumber: account.phone_number || null
    });
  } catch (err) {
    console.error('❌ [ACCOUNT] Error fetching account info:', err);
    return res.status(500).json({ error: 'Failed to fetch account information' });
  }
});

// Update advertiser phone number
app.patch('/api/advertiser/account', requireAdvertiserAuth, async (req, res) => {
  try {
    const advertiserEmail = req.advertiser.email;
    const { phoneNumber } = req.body;
    const pool = getPool();
    
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    // Validate phoneNumber (allow null/empty string, but if provided, must be string)
    if (phoneNumber !== null && phoneNumber !== undefined && typeof phoneNumber !== 'string') {
      return res.status(400).json({ error: 'Phone number must be a string' });
    }

    // Normalize: convert empty string to null
    const normalizedPhoneNumber = phoneNumber && phoneNumber.trim() ? phoneNumber.trim() : null;

    // Update phone_number for all campaigns belonging to this advertiser email
    // This ensures consistency across all campaigns for the same advertiser
    const result = await pool.query(`
      UPDATE advertisers
      SET phone_number = $1,
          updated_at = NOW()
      WHERE email = $2
        AND payment_completed = TRUE
      RETURNING phone_number
    `, [normalizedPhoneNumber, advertiserEmail]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Advertiser account not found' });
    }

    console.log(`✅ [ACCOUNT] Updated phone number for advertiser ${advertiserEmail}: ${normalizedPhoneNumber || 'NULL'}`);

    return res.json({
      success: true,
      phoneNumber: normalizedPhoneNumber
    });
  } catch (err) {
    console.error('❌ [ACCOUNT] Error updating phone number:', err);
    return res.status(500).json({ error: 'Failed to update phone number' });
  }
});

// Change password (authenticated, requires current password)
app.post('/api/advertiser/change-password', requireAdvertiserAuth, async (req, res) => {
  try {
    const advertiserEmail = req.advertiser.email;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const accountResult = await pool.query(
      `SELECT id, password_hash FROM advertiser_accounts WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
      [advertiserEmail]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = accountResult.rows[0];

    if (!account.password_hash) {
      return res.status(400).json({ error: 'No password set on this account' });
    }

    const isMatch = await bcrypt.compare(currentPassword, account.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const saltRounds = 10;
    const newHash = await bcrypt.hash(newPassword, saltRounds);

    await pool.query(
      `UPDATE advertiser_accounts SET password_hash = $1 WHERE id = $2`,
      [newHash, account.id]
    );

    console.log(`✅ [CHANGE-PASSWORD] Password updated for ${advertiserEmail}`);
    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('❌ [CHANGE-PASSWORD] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Pause campaign
app.post('/api/advertiser/pause', requireAdvertiserAuth, async (req, res) => {
  try {
    const idToUpdate = req.query.campaignId || req.body.campaignId || req.advertiser.advertiserId;
    const advertiserEmail = req.advertiser.email;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    console.log('⏸️ [PAUSE CAMPAIGN] Pausing campaign:', idToUpdate);

    // Verify the campaign belongs to the same advertiser account
    const result = await pool.query(
      `UPDATE advertisers
       SET is_paused = TRUE
       WHERE id = $1 AND email = $2 AND status != 'archived'
       RETURNING id, company_name`,
      [idToUpdate, advertiserEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or access denied' });
    }

    // Clear playlist cache so paused campaign is removed from loop
    playlistCache.clear();
    console.log(`✅ [PAUSE CAMPAIGN] Advertiser ${idToUpdate} paused`);

    // Send campaign paused email
    if (advertiserEmail && emailService && emailService.isEmailConfigured()) {
      emailService.sendAdvertiserCampaignPausedEmail(
        advertiserEmail,
        result.rows[0].company_name || 'Advertiser'
      ).catch(err => console.error(`[PAUSE CAMPAIGN] Paused email failed for ${idToUpdate}:`, err.message));
    }

    return res.json({ success: true, status: 'PAUSED' });
  } catch (err) {
    console.error('❌ [PAUSE CAMPAIGN] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Unpause campaign
app.post('/api/advertiser/unpause', requireAdvertiserAuth, async (req, res) => {
  try {
    const idToUpdate = req.query.campaignId || req.body.campaignId || req.advertiser.advertiserId;
    const advertiserEmail = req.advertiser.email;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    console.log('▶️ [UNPAUSE CAMPAIGN] Unpausing campaign:', idToUpdate);

    // Verify the campaign belongs to the same advertiser account
    const result = await pool.query(
      `UPDATE advertisers
       SET is_paused = FALSE
       WHERE id = $1 AND email = $2 AND status != 'archived'
       RETURNING id`,
      [idToUpdate, advertiserEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or access denied' });
    }

    playlistCache.clear();
    console.log(`✅ [UNPAUSE CAMPAIGN] Advertiser ${idToUpdate} unpaused`);

    return res.json({ success: true, status: 'LIVE' });
  } catch (err) {
    console.error('❌ [UNPAUSE CAMPAIGN] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// End campaign
app.post('/api/advertiser/end', requireAdvertiserAuth, async (req, res) => {
  try {
    const campaignId = req.query.campaignId || req.body.campaignId;
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }
    
    const advertiserEmail = req.advertiser.email;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} from endpoint=/api/advertiser/end triggeredBy=manual_end`);

    // Verify the campaign belongs to the same advertiser account
    const result = await pool.query(
      `SELECT id, video_filename, status
       FROM advertisers
       WHERE id = $1 AND email = $2`,
      [campaignId, advertiserEmail]
    );

    if (result.rows.length === 0) {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Campaign not found or access denied`);
      return res.status(404).json({ error: 'Campaign not found or access denied' });
    }

    const ad = result.rows[0];

    // Safety guard: Check if already archived BEFORE any R2 operations
    if (ad.status === 'archived') {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Already archived, skipping`);
      return res.json({ success: true, status: 'ENDED' });
    }

    // Double-check archived status right before R2 operations (race condition protection)
    const doubleCheckResult = await pool.query(
      `SELECT status FROM advertisers WHERE id = $1`,
      [campaignId]
    );
    
    if (doubleCheckResult.rows.length === 0) {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Campaign disappeared during processing`);
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    if (doubleCheckResult.rows[0].status === 'archived') {
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Already archived (double-check), skipping R2 operations`);
      return res.json({ success: true, status: 'ENDED' });
    }

    // ===== IMMEDIATE BILLING ON CAMPAIGN END =====
    // Bill before archiving (recurring: current week, non-recurring: total lifetime)
    console.log(`💳 [CAMPAIGN-END-BILL] Checking if campaign ${campaignId} should be billed before archiving`);
    
    // Fetch full campaign billing data
    const billingDataResult = await pool.query(`
      SELECT
        id, current_week_impressions, total_impressions, cpm_rate, weekly_budget_cap,
        recurring_weekly, status, approved_at, company_name
      FROM advertisers
      WHERE id = $1
    `, [campaignId]);

    if (billingDataResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const billingData = billingDataResult.rows[0];

    // Handle billing based on campaign type
    if (billingData.recurring_weekly === true) {
      // Recurring campaign: bill for current week impressions
      const now = new Date();
      const billingWeekStart = getBillingWeekStart(now);
      const billingWeekEnd = getBillingWeekEnd(billingWeekStart);

      const billingResult = await billCampaignUsage({
        campaignId: campaignId,
        billingWeekStart: billingWeekStart,
        billingWeekEnd: billingWeekEnd,
        trigger: 'campaign_end',
        pool: pool
      });

      if (!billingResult.success && !billingResult.skipped) {
        console.error(`❌ [CAMPAIGN-END-BILL] Billing failed for campaign ${campaignId}, aborting archive`);
        return res.status(500).json({ 
          error: 'Failed to bill campaign before ending',
          details: billingResult.error
        });
      }

      if (billingResult.skipped) {
        console.log(`⏭️ [CAMPAIGN-END-BILL] Billing skipped for campaign ${campaignId}: ${billingResult.reason || 'Unknown reason'}`);
      } else {
        console.log(`✅ [CAMPAIGN-END-BILL] Successfully billed campaign ${campaignId} before archiving:`, {
          invoiceId: billingResult.invoiceId,
          amount: billingResult.amount?.toFixed(2),
          impressions: billingResult.impressions
        });
      }
    } else {
      // Non-recurring campaign: bill for total lifetime impressions
      const billingResult = await billNonRecurringCampaign({
        campaignId: campaignId,
        pool: pool
      });

      if (!billingResult.success && !billingResult.skipped) {
        // Billing failed (Stripe error) - do NOT archive, return error
        console.error(`❌ [CAMPAIGN-END-BILL] Billing failed for non-recurring campaign ${campaignId}, aborting archive`);
        return res.status(500).json({ 
          error: 'Failed to bill campaign before ending',
          details: billingResult.error
        });
      }

      if (billingResult.skipped) {
        // Billing skipped (0 impressions, < $0.50, already billed, or no approval timestamp) - continue with archive
        console.log(`⏭️ [CAMPAIGN-END-BILL] Billing skipped for non-recurring campaign ${campaignId}: ${billingResult.reason || 'Unknown reason'}`);
      } else {
        // Billing succeeded - campaign is already archived by billNonRecurringCampaign
        console.log(`✅ [CAMPAIGN-END-BILL] Successfully billed non-recurring campaign ${campaignId} before archiving:`, {
          invoiceId: billingResult.invoiceId,
          amount: billingResult.amount?.toFixed(2),
          impressions: billingResult.impressions
        });
        // Campaign is already archived, return success
        return res.json({ success: true, status: 'ENDED', billed: true });
      }
    }

    let archivedMediaUrl = null;
    if (ad.video_filename) {
      try {
        const CHARITY_BUCKET = 'charity-stream-videos';
        const R2_PUBLIC_URL = R2_VIDEOS_URL;
        const sourceKey = ad.video_filename;
        const destKey = `archived/${ad.video_filename}`;

        console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Starting R2 operations: ${sourceKey} -> ${destKey}`);
        const copyCommand = new CopyObjectCommand({
          Bucket: CHARITY_BUCKET,
          CopySource: `${CHARITY_BUCKET}/${sourceKey}`,
          Key: destKey
        });
        await r2Client.send(copyCommand);
        console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - R2 copy successful: ${sourceKey} -> ${destKey}`);

        const deleteCommand = new DeleteObjectCommand({
          Bucket: CHARITY_BUCKET,
          Key: sourceKey
        });
        await r2Client.send(deleteCommand);
        console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - R2 delete successful: ${sourceKey}`);

        // Construct the archived media URL
        archivedMediaUrl = normalizeBareMediaR2Link(`${R2_PUBLIC_URL}/${destKey}`);
        console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Updated media_r2_link to archived location: ${archivedMediaUrl}`);
      } catch (r2Error) {
        console.error(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - R2 error:`, r2Error);
        // Even if this fails, we still mark as archived below
      }
    }

    // Update database - use WHERE clause to ensure we only update if not already archived
    // Also update media_r2_link to point to the archived location if the file was moved
    const updateResult = await pool.query(
      `UPDATE advertisers
       SET status = 'archived',
           archived_at = NOW(),
           archived_reason = 'Manually ended by advertiser',
           media_r2_link = COALESCE($2, media_r2_link)
       WHERE id = $1 AND status != 'archived'
       RETURNING id`,
      [campaignId, archivedMediaUrl]
    );

    if (updateResult.rows.length === 0) {
      // Another process may have archived it
      console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Database update skipped (already archived by another process)`);
      return res.json({ success: true, status: 'ENDED' });
    }

    playlistCache.clear();
    console.log(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - Successfully archived`);

    // Send campaign ended email
    if (advertiserEmail && emailService && emailService.isEmailConfigured()) {
      emailService.sendAdvertiserCampaignEndedEmail(
        advertiserEmail,
        billingData.company_name || 'Advertiser',
        billingData.total_impressions || 0
      ).catch(err => console.error(`[ARCHIVE ATTEMPT] campaignId=${campaignId} - End email failed:`, err.message));
    }

    return res.json({ success: true, status: 'ENDED' });
  } catch (err) {
    console.error(`[ARCHIVE ATTEMPT] campaignId=${req.query.campaignId || req.body.campaignId} - Error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Switch non-recurring campaign to recurring
app.post('/api/advertiser/switch-to-recurring', requireAdvertiserAuth, async (req, res) => {
  try {
    const campaignId = req.query.campaignId || req.body.campaignId;
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }
    
    const advertiserEmail = req.advertiser.email;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    console.log(`🔄 [SWITCH-TO-RECURRING] Switching campaign ${campaignId} to recurring`);

    // Verify the campaign exists and belongs to the advertiser
    const campaignResult = await pool.query(
      `SELECT id, recurring_weekly, status, current_week_start
       FROM advertisers
       WHERE id = $1 AND email = $2`,
      [campaignId, advertiserEmail]
    );

    if (campaignResult.rows.length === 0) {
      console.log(`❌ [SWITCH-TO-RECURRING] Campaign ${campaignId} not found or access denied`);
      return res.status(404).json({ error: 'Campaign not found or access denied' });
    }

    const campaign = campaignResult.rows[0];

    // Validate: must be non-recurring
    if (campaign.recurring_weekly === true) {
      console.log(`❌ [SWITCH-TO-RECURRING] Campaign ${campaignId} is already recurring`);
      return res.status(400).json({ error: 'Campaign is already recurring' });
    }

    // Validate: must not be archived
    if (campaign.status === 'archived') {
      console.log(`❌ [SWITCH-TO-RECURRING] Campaign ${campaignId} is archived`);
      return res.status(400).json({ error: 'Cannot switch archived campaign to recurring' });
    }

    // Update campaign to recurring
    // Ensure current_week_start is set if missing (COALESCE will use existing value or NOW() if null)
    // The weekly billing cron will handle proper week boundaries
    const updateResult = await pool.query(
      `UPDATE advertisers
       SET recurring_weekly = TRUE,
           current_week_start = COALESCE(current_week_start, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND email = $2
       RETURNING id, recurring_weekly, current_week_start`,
      [campaignId, advertiserEmail]
    );

    if (updateResult.rows.length === 0) {
      console.log(`❌ [SWITCH-TO-RECURRING] Failed to update campaign ${campaignId}`);
      return res.status(500).json({ error: 'Failed to update campaign' });
    }

    const updatedCampaign = updateResult.rows[0];
    console.log(`✅ [SWITCH-TO-RECURRING] Successfully switched campaign ${campaignId} to recurring`);

    res.json({ 
      success: true, 
      message: 'Campaign switched to recurring successfully',
      campaignId: updatedCampaign.id,
      recurringWeekly: updatedCampaign.recurring_weekly
    });
  } catch (err) {
    console.error(`❌ [SWITCH-TO-RECURRING] Error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Revoke campaign (for pending approval campaigns)
app.post('/api/advertiser/revoke', requireAdvertiserAuth, async (req, res) => {
  try {
    const campaignId = req.query.campaignId || req.body.campaignId;
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }
    
    const advertiserEmail = req.advertiser.email;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    console.log(`🚫 [REVOKE CAMPAIGN] Revoking campaign ${campaignId}`);

    // Verify the campaign belongs to the same advertiser account
    const result = await pool.query(`
      SELECT id, status, archived_reason
      FROM advertisers
      WHERE id = $1 AND email = $2
    `, [campaignId, advertiserEmail]);

    if (result.rows.length === 0) {
      console.log(`[REVOKE CAMPAIGN] campaignId=${campaignId} - Campaign not found or access denied`);
      return res.status(404).json({ error: 'Campaign not found or access denied' });
    }

    const ad = result.rows[0];

    // Check if already archived/revoked
    if (ad.status === 'archived') {
      console.log(`[REVOKE CAMPAIGN] campaignId=${campaignId} - Already archived/revoked, skipping`);
      return res.json({ success: true, status: 'REVOKED' });
    }

    // ===== IMMEDIATE BILLING ON CAMPAIGN REVOKE =====
    // Bill for current week impressions before revoking (if any)
    console.log(`💳 [CAMPAIGN-REVOKE-BILL] Checking if campaign ${campaignId} should be billed before revoking`);
    
    // Fetch full campaign billing data (including recurring_weekly for weekly counter reset)
    const billingDataResult = await pool.query(`
      SELECT 
        id, current_week_impressions, cpm_rate, weekly_budget_cap,
        recurring_weekly, status
      FROM advertisers
      WHERE id = $1
    `, [campaignId]);

    if (billingDataResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const billingData = billingDataResult.rows[0];

    // Bill if campaign has impressions (regardless of approved/completed status)
    if (billingData.current_week_impressions > 0) {
      // Calculate billing week boundaries using existing helper
      const now = new Date();
      const billingWeekStart = getBillingWeekStart(now);
      const billingWeekEnd = getBillingWeekEnd(billingWeekStart);

      // Attempt to bill the campaign
      const billingResult = await billCampaignUsage({
        campaignId: campaignId,
        billingWeekStart: billingWeekStart,
        billingWeekEnd: billingWeekEnd,
        trigger: 'campaign_revoke',
        pool: pool
      });

      // Handle billing results
      if (!billingResult.success && !billingResult.skipped) {
        // Billing failed (Stripe error) - do NOT revoke, return error
        console.error(`❌ [CAMPAIGN-REVOKE-BILL] Billing failed for campaign ${campaignId}, aborting revoke`);
        return res.status(500).json({ 
          error: 'Failed to bill campaign before revoking',
          details: billingResult.error
        });
      }

      if (billingResult.skipped) {
        // Billing skipped (already billed, < $0.50, or archived) - continue with revoke
        console.log(`⏭️ [CAMPAIGN-REVOKE-BILL] Billing skipped for campaign ${campaignId}: ${billingResult.reason || 'Unknown reason'}`);
      } else {
        // Billing succeeded
        console.log(`✅ [CAMPAIGN-REVOKE-BILL] Successfully billed campaign ${campaignId} before revoking:`, {
          invoiceId: billingResult.invoiceId,
          amount: billingResult.amount?.toFixed(2),
          impressions: billingResult.impressions
        });
      }
    } else {
      // No impressions - skip billing
      console.log(`⏭️ [CAMPAIGN-REVOKE-BILL] Skipping billing for campaign ${campaignId} - no impressions`);
    }

    // Archive the campaign (revoke)
    // Media stays in advertiser-media (no R2 operations)
    // For non-recurring campaigns, also reset weekly counters to prevent stale data
    const isNonRecurring = billingData.recurring_weekly === false;
    const updateResult = await pool.query(`
      UPDATE advertisers
      SET status = 'archived',
          archived_at = NOW(),
          archived_reason = 'Campaign revoked before approval',
          current_week_impressions = CASE WHEN $2 = true THEN 0 ELSE current_week_impressions END,
          weekly_clicks = CASE WHEN $2 = true THEN 0 ELSE weekly_clicks END
      WHERE id = $1 AND status != 'archived'
      RETURNING id
    `, [campaignId, isNonRecurring]);

    if (updateResult.rows.length === 0) {
      // Another process may have archived it
      console.log(`[REVOKE CAMPAIGN] campaignId=${campaignId} - Database update skipped (already archived by another process)`);
      return res.json({ success: true, status: 'REVOKED' });
    }

    // Log weekly counter reset for non-recurring campaigns
    if (isNonRecurring) {
      console.log(`🔄 [REVOKE CAMPAIGN] campaignId=${campaignId} - Reset weekly counters (current_week_impressions=0, weekly_clicks=0) for non-recurring campaign`);
    }

    // Clear playlist cache
    playlistCache.clear();
    console.log(`[REVOKE CAMPAIGN] campaignId=${campaignId} - Successfully revoked`);

    return res.json({ success: true, status: 'REVOKED' });
  } catch (err) {
    console.error(`[REVOKE CAMPAIGN] campaignId=${req.query.campaignId || req.body.campaignId} - Error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Presigned URL endpoint for advertiser portal uploads
app.post('/api/advertiser/presign-upload', requireAdvertiserAuth, async (req, res) => {
  try {
    const { fileName, contentType, fileSize } = req.body;
    
    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'fileName and contentType are required' });
    }
    
    // Sanitize filename
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = Date.now();
    const key = `${timestamp}-${sanitizedFileName}`;
    
    // Create PutObjectCommand for presigning
    const putCommand = new PutObjectCommand({
      Bucket: 'advertiser-media',
      Key: key,
      ContentType: contentType,
      ...(fileSize && { ContentLength: fileSize })
    });
    
    // Generate presigned URL (expires in 10 minutes)
    const expiresIn = 600; // 10 minutes in seconds
    const uploadUrl = await getSignedUrl(r2Client, putCommand, { expiresIn });
    
    // Generate public URL (for after upload completes)
    const publicUrl = `${R2_ADVERTISER_MEDIA_URL}/${key}`;
    
    console.log(`[PRESIGN UPLOAD] Generated presigned URL for advertiser: ${key}`);
    
    res.json({
      success: true,
      uploadUrl: uploadUrl,
      publicUrl: publicUrl,
      key: key,
      expiresIn: expiresIn
    });
    
  } catch (error) {
    console.error('❌ Presigned URL generation error:', error);
    res.status(500).json({
      error: 'Failed to generate presigned URL',
      message: error.message || 'An unexpected error occurred'
    });
  }
});

// Helper function to normalize R2 key from either a raw key or full URL
function normalizeR2Key(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid input: key must be a non-empty string');
  }
  
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Invalid input: key cannot be empty');
  }
  
  // Case 1: Full URL (starts with http/https or contains r2.dev/)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('r2.dev/')) {
    try {
      // If it's a full URL, parse it and extract the pathname
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const url = new URL(trimmed);
        // Extract pathname and remove leading slash
        const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
        if (!key) {
          throw new Error('Invalid URL: no object key found in pathname');
        }
        return key;
      } else {
        // Contains r2.dev/ but might not be a full URL, extract everything after r2.dev/
        const r2Index = trimmed.indexOf('r2.dev/');
        if (r2Index !== -1) {
          const key = trimmed.substring(r2Index + 7); // 7 = length of "r2.dev/"
          if (!key) {
            throw new Error('Invalid URL: no object key found after r2.dev/');
          }
          // Remove any leading slashes
          return key.startsWith('/') ? key.slice(1) : key;
        }
      }
    } catch (urlError) {
      throw new Error(`Failed to parse URL: ${urlError.message}`);
    }
  }
  
  // Case 2: Contains slashes but not a full URL (e.g., "path/to/file.jpg")
  if (trimmed.includes('/')) {
    // Extract the last part after the final slash
    const key = trimmed.split('/').pop();
    if (!key) {
      throw new Error('Invalid input: path contains no filename');
    }
    return key;
  }
  
  // Case 3: Already a raw key (e.g., "1234-file.jpg")
  return trimmed;
}

// Replace creative endpoint
app.post('/api/advertiser/replace-creative', requireAdvertiserAuth, async (req, res) => {
  try {
    const campaignId = req.query.campaignId || req.body.campaignId;
    const newVideoKey = req.body.newVideoKey;
    const contentType = req.body.contentType; // MIME type of uploaded file
    
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }
    
    if (!newVideoKey) {
      return res.status(400).json({ error: 'newVideoKey is required' });
    }
    
    if (!contentType) {
      return res.status(400).json({ error: 'contentType is required' });
    }
    
    const advertiserEmail = req.advertiserEmail;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    console.log(`[REPLACE CREATIVE] campaignId=${campaignId} newVideoKey=${newVideoKey} contentType=${contentType}`);

    const keyForNormalize = normalizeBareMediaR2Link(newVideoKey) || String(newVideoKey).trim();

    // Normalize the R2 key (handles both raw key and full URL cases)
    let normalizedKey;
    try {
      normalizedKey = normalizeR2Key(keyForNormalize);
      console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Normalized key: ${normalizedKey}`);
    } catch (normalizeError) {
      console.error(`[REPLACE CREATIVE] campaignId=${campaignId} - Failed to normalize key: ${normalizeError.message}`);
      return res.status(400).json({ 
        error: 'Invalid key format',
        message: `Failed to parse R2 key: ${normalizeError.message}`
      });
    }

    // Verify the campaign belongs to the same advertiser account and get current video info
    const result = await pool.query(
      `SELECT id, video_filename, media_r2_link, status, ad_format
       FROM advertisers
       WHERE id = $1 AND email = $2`,
      [campaignId, advertiserEmail]
    );

    if (result.rows.length === 0) {
      console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Campaign not found or access denied`);
      return res.status(404).json({ error: 'Campaign not found or access denied' });
    }

    const ad = result.rows[0];

    // Don't allow replacing creative for archived campaigns
    if (ad.status === 'archived') {
      console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Cannot replace creative for archived campaign`);
      return res.status(400).json({ error: 'Cannot replace creative for archived campaign' });
    }

    // CRITICAL: Validate file type matches campaign's ad_format
    const adFormat = ad.ad_format || 'video'; // Default to 'video' for legacy campaigns
    const isVideoCampaign = adFormat === 'video' || adFormat === 'Video';
    const isImageCampaign = adFormat === 'image' || adFormat === 'static_image' || adFormat === 'Image' || adFormat === 'Static Image';
    
    // Determine expected file types based on ad_format
    const isVideoFile = contentType.startsWith('video/');
    const isImageFile = contentType.startsWith('image/');
    
    // Validate file type matches campaign format
    if (isVideoCampaign && !isVideoFile) {
      console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - File type mismatch: video campaign cannot accept ${contentType}`);
      return res.status(400).json({ 
        error: 'File type mismatch',
        message: 'Video campaigns can only accept video files (MP4). Please upload a video file.'
      });
    }
    
    if (isImageCampaign && !isImageFile) {
      console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - File type mismatch: image campaign cannot accept ${contentType}`);
      return res.status(400).json({ 
        error: 'File type mismatch',
        message: 'Static image campaigns can only accept image files (JPG, PNG, GIF, WEBP). Please upload an image file.'
      });
    }
    
    // Additional validation: ensure video files are MP4 for video campaigns
    if (isVideoCampaign && isVideoFile && contentType !== 'video/mp4') {
      console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Invalid video format: ${contentType}, only MP4 is allowed`);
      return res.status(400).json({ 
        error: 'Invalid video format',
        message: 'Only MP4 video files are supported for video campaigns.'
      });
    }
    
    // Additional validation: ensure image files are supported formats for image campaigns
    if (isImageCampaign && isImageFile) {
      const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedImageTypes.includes(contentType.toLowerCase())) {
        console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Invalid image format: ${contentType}`);
        return res.status(400).json({ 
          error: 'Invalid image format',
          message: 'Only JPG, PNG, GIF, and WEBP image files are supported for static image campaigns.'
        });
      }
    }

    // Delete old creative from charity-stream-videos bucket if it exists
    const oldVideoFilename = ad.video_filename;
    if (oldVideoFilename) {
      try {
        const CHARITY_BUCKET = 'charity-stream-videos';
        console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Deleting old video: ${oldVideoFilename}`);
        
        const deleteCommand = new DeleteObjectCommand({
          Bucket: CHARITY_BUCKET,
          Key: oldVideoFilename
        });
        await r2Client.send(deleteCommand);
        console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Successfully deleted old video: ${oldVideoFilename}`);
      } catch (r2Error) {
        // Log error but continue - the old file might not exist or already be deleted
        console.error(`[REPLACE CREATIVE] campaignId=${campaignId} - Error deleting old video (non-critical):`, r2Error.message);
      }
    }

    // Construct public URL using normalized key
    // Base URL for advertiser-media bucket
    const R2_ADVERTISER_MEDIA_BASE_URL = R2_ADVERTISER_MEDIA_URL;
    const fullPublicUrl = normalizeBareMediaR2Link(`${R2_ADVERTISER_MEDIA_BASE_URL}/${normalizedKey}`);
    
    console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Final media_r2_link: ${fullPublicUrl}`);

    // Update database to put campaign back into review
    // Store normalized key only in video_filename, full URL in media_r2_link
    const updateResult = await pool.query(
      `UPDATE advertisers
       SET status = 'pending_review',
           is_paused = TRUE,
           media_r2_link = $1,
           video_filename = $2,
           updated_at = NOW()
       WHERE id = $3 AND status != 'archived'
       RETURNING id`,
      [fullPublicUrl, normalizedKey, campaignId]
    );

    if (updateResult.rows.length === 0) {
      console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Database update failed (campaign may be archived)`);
      return res.status(400).json({ error: 'Failed to update campaign' });
    }

    // Clear playlist cache so the old video is removed from the loop
    playlistCache.clear();
    console.log(`[REPLACE CREATIVE] campaignId=${campaignId} - Successfully replaced creative, campaign set to IN REVIEW`);

    return res.json({ success: true, status: 'IN REVIEW' });
  } catch (err) {
    console.error(`[REPLACE CREATIVE] campaignId=${req.query.campaignId || req.body.campaignId} - Error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Increase budget endpoint
app.post('/api/advertiser/increase-budget', requireAdvertiserAuth, async (req, res) => {
  try {
    const campaignId = req.query.campaignId || req.body.campaignId;
    const amountToAdd = parseFloat(req.body.amountToAdd);

    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }

    if (!amountToAdd || isNaN(amountToAdd) || amountToAdd <= 0) {
      return res.status(400).json({ error: 'amountToAdd must be a positive number' });
    }

    const advertiserEmail = req.advertiserEmail;
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    console.log(`[INCREASE BUDGET] campaignId=${campaignId} amountToAdd=${amountToAdd}`);

    // Verify the campaign belongs to the same advertiser account and get current budget, CPM, and impressions
    const verifyResult = await pool.query(
      `SELECT id, weekly_budget_cap, cpm_rate, current_week_impressions, capped
       FROM advertisers
       WHERE id = $1 AND email = $2`,
      [campaignId, advertiserEmail]
    );

    if (verifyResult.rows.length === 0) {
      console.log(`[INCREASE BUDGET] campaignId=${campaignId} - Campaign not found or access denied`);
      return res.status(404).json({ error: 'Campaign not found or access denied' });
    }

    const currentBudget = parseFloat(verifyResult.rows[0].weekly_budget_cap) || 0;
    const cpmRate = parseFloat(verifyResult.rows[0].cpm_rate) || 0;
    const currentWeekImpressions = parseInt(verifyResult.rows[0].current_week_impressions) || 0;
    const wasCapped = verifyResult.rows[0].capped === true;

    // Calculate new budget
    const newBudget = currentBudget + amountToAdd;

    // Recalculate max_weekly_impressions based on new budget
    let newMaxWeeklyImpressions = null;
    if (cpmRate > 0 && newBudget > 0) {
      newMaxWeeklyImpressions = Math.floor((newBudget / cpmRate) * 1000);
      console.log(`📊 [INCREASE BUDGET] Recalculated max_weekly_impressions: ${newMaxWeeklyImpressions} (budget: ${newBudget}, CPM: ${cpmRate})`);
    } else {
      console.log('⚠️ [INCREASE BUDGET] max_weekly_impressions set to NULL (invalid budget or CPM rate)');
    }

    // Determine if campaign should be uncapped
    // Uncap if: was capped AND current impressions < new max
    const shouldUncap = wasCapped && newMaxWeeklyImpressions !== null && currentWeekImpressions < newMaxWeeklyImpressions;

    // Update weekly_budget_cap, max_weekly_impressions, and capped status
    const updateResult = await pool.query(
      `UPDATE advertisers
       SET weekly_budget_cap = $1,
           max_weekly_impressions = $2,
           capped = CASE WHEN $3 = true THEN false ELSE capped END,
           updated_at = NOW()
       WHERE id = $4 AND email = $5
       RETURNING weekly_budget_cap, max_weekly_impressions, capped`,
      [newBudget, newMaxWeeklyImpressions, shouldUncap, campaignId, advertiserEmail]
    );

    if (updateResult.rows.length === 0) {
      console.log(`[INCREASE BUDGET] campaignId=${campaignId} - Update failed`);
      return res.status(400).json({ error: 'Failed to update budget' });
    }

    const updatedBudget = parseFloat(updateResult.rows[0].weekly_budget_cap);
    const updatedMaxImpressions = updateResult.rows[0].max_weekly_impressions;
    const isNowCapped = updateResult.rows[0].capped === true;

    if (shouldUncap) {
      console.log(`🔄 [INCREASE BUDGET] campaignId=${campaignId} - Campaign uncapped (impressions: ${currentWeekImpressions} < new max: ${updatedMaxImpressions})`);
      // Clear playlist cache when uncapping
      playlistCache.clear();
      console.log("🧽 [INCREASE BUDGET] Cleared playlist cache because campaign was uncapped");
    }

    console.log(`[INCREASE BUDGET] campaignId=${campaignId} - Budget increased from ${currentBudget} to ${updatedBudget}, max_weekly_impressions: ${updatedMaxImpressions}`);

    return res.json({ 
      success: true, 
      newBudget: updatedBudget,
      previousBudget: currentBudget,
      amountAdded: amountToAdd,
      maxWeeklyImpressions: updatedMaxImpressions,
      uncapped: shouldUncap
    });
  } catch (err) {
    console.error(`[INCREASE BUDGET] campaignId=${req.query.campaignId || req.body.campaignId} - Error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get advertiser status (capped, impressions, etc.)
app.get('/api/advertisers/:id/status', authenticateToken, async (req, res) => {
  try {
    const advertiserId = parseInt(req.params.id);
    
    if (!advertiserId || isNaN(advertiserId)) {
      return res.status(400).json({ error: 'Invalid advertiser ID' });
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    const result = await pool.query(`
      SELECT capped, current_week_impressions, max_weekly_impressions
      FROM advertisers
      WHERE id = $1
    `, [advertiserId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Advertiser not found' });
    }
    
    const ad = result.rows[0];
    
    res.json({
      capped: ad.capped || false,
      current_week_impressions: ad.current_week_impressions || 0,
      max_weekly_impressions: ad.max_weekly_impressions
    });
    
  } catch (error) {
    console.error('❌ Error fetching advertiser status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== LEADERBOARD ROUTES =====

// Server-side caching for leaderboard data
const leaderboardCache = new Map();
const LEADERBOARD_CACHE_TTL = 60000; // 1 minute

// Get monthly leaderboard (top 5 users)
app.get('/api/leaderboard/monthly', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const cacheKey = `leaderboard_${limit}`;
    const now = Date.now();
    
    // Check cache first
    const cached = leaderboardCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < LEADERBOARD_CACHE_TTL) {
      console.log(`📊 Returning cached leaderboard data`);
      return res.json(cached.data);
    }
    
    const [err, leaderboard] = await dbHelpers.getMonthlyLeaderboard(limit);
    
    if (err) {
      console.error('Error getting monthly leaderboard:', err);
      return res.status(500).json({ error: 'Failed to get leaderboard' });
    }

    const leaderboardData = {
      leaderboard: leaderboard.map((user, index) => ({
        rank: user.rank_number,
        username: user.username,
        isPremium: user.is_premium || false,
        minutesWatched: Math.floor(user.current_month_seconds / 60),
        profilePicture: user.profile_picture,
        adsWatchedToday: user.ads_watched_today,
        streakDays: user.streak_days,
        accountAgeDays: Math.floor((new Date() - new Date(user.created_at)) / (1000 * 60 * 60 * 24))
      }))
    };
    
    // Cache the result
    leaderboardCache.set(cacheKey, {
      data: leaderboardData,
      timestamp: now
    });
    
    // Clean up old cache entries
    for (const [key, value] of leaderboardCache.entries()) {
      if (now - value.timestamp > LEADERBOARD_CACHE_TTL) {
        leaderboardCache.delete(key);
      }
    }
    
    res.json(leaderboardData);
  } catch (error) {
    console.error('Error in monthly leaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's impact data
// Restore daily stats endpoint (for recovery purposes)
app.post('/api/debug/restore-daily-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { adsWatched, watchTimeSeconds = 0, date } = req.body;
    
    if (!adsWatched || adsWatched < 0) {
      return res.status(400).json({ error: 'Invalid ads watched count' });
    }
    
    const [err, restoredStats] = await dbHelpers.restoreDailyStats(userId, adsWatched, watchTimeSeconds, date);
    
    if (err) {
      console.error('Error restoring daily stats:', err);
      return res.status(500).json({ error: 'Failed to restore daily stats' });
    }
    
    res.json({
      message: 'Daily stats restored successfully',
      restoredStats: restoredStats
    });
  } catch (error) {
    console.error('Error in restore endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Debug endpoint to check daily stats
app.get('/api/debug/daily-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [err, debugData] = await dbHelpers.debugDailyStats(userId);
    
    if (err) {
      console.error('Error getting debug data:', err);
      return res.status(500).json({ error: 'Failed to get debug data' });
    }
    
    res.json({
      userId: userId,
      debugData: debugData,
      currentTime: new Date().toISOString(),
      currentDate: new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Server-side caching for user impact data
const userImpactCache = new Map();
const IMPACT_CACHE_TTL = 2000; // 2 seconds (reduced for real-time updates)

app.get('/api/user/impact', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cacheKey = `impact_${userId}`;
    const now = Date.now();
    const bypassCache = req.query.force === 'true'; // Allow cache bypass
    
    // Check cache first (unless bypassed)
    if (!bypassCache) {
      const cached = userImpactCache.get(cacheKey);
      if (cached && (now - cached.timestamp) < IMPACT_CACHE_TTL) {
        console.log(`📊 Returning cached impact data for user ${userId}`);
        return res.json(cached.data);
      }
    } else {
      console.log(`⚡ Cache bypassed for user ${userId} - fetching fresh data`);
    }
    
    // Get all user data in parallel
    const [
      [adsTodayErr, adsWatchedToday],
      [totalAdsErr, totalAdsWatched],
      [monthlyRankErr, monthlyRank],
      [overallRankErr, overallRank],
      [totalUsersErr, totalUsers],
      [accountAgeErr, accountAgeDays],
      [streakErr, streakDays],
      [userErr, user]
    ] = await Promise.all([
      dbHelpers.getAdsWatchedToday(userId),
      dbHelpers.getTotalAdsWatched(userId),
      dbHelpers.getUserMonthlyRank(userId),
      dbHelpers.getUserOverallRank(userId),
      dbHelpers.getTotalActiveUsers(),
      dbHelpers.getUserAccountAge(userId),
      dbHelpers.calculateUserStreak(userId),
      dbHelpers.getUserById(userId)
    ]);

    if (userErr || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const impactData = {
      impact: {
        adsWatchedToday: adsWatchedToday,
        totalAdsWatched: totalAdsWatched,
        currentRank: monthlyRank,
        overallRank: overallRank,
        totalUsers: totalUsers,
        watchTimeMinutes: Math.floor((user.current_month_seconds || 0) / 60),
        totalWatchTimeMinutes: Math.floor((user.total_seconds_watched || 0) / 60),
        streakDays: streakDays,
        accountAgeDays: accountAgeDays,
        donationsGenerated: Math.round(totalAdsWatched * 0.01) // Placeholder: $0.01 per ad
      }
    };
    
    // Cache the result
    userImpactCache.set(cacheKey, {
      data: impactData,
      timestamp: now
    });
    
    // Clean up old cache entries
    for (const [key, value] of userImpactCache.entries()) {
      if (now - value.timestamp > IMPACT_CACHE_TTL) {
        userImpactCache.delete(key);
      }
    }
    
    res.json(impactData);
  } catch (error) {
    console.error('Error getting user impact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual database check endpoint (for debugging)
app.get('/api/debug/user/:userId', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    console.log('🔍 Manual user check for ID:', userId);
    
    const [err, user] = await dbHelpers.getUserById(userId);
    
    if (err || !user) {
      console.error('❌ User not found:', err);
      return res.status(404).json({ error: 'User not found' });
    }
    
    console.log('✅ User found:', {
      id: user.id,
      email: user.email,
      is_premium: user.is_premium,
      premium_since: user.premium_since,
      stripe_customer_id: user.stripe_customer_id,
      stripe_subscription_id: user.stripe_subscription_id
    });
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        is_premium: user.is_premium,
        premium_since: user.premium_since,
        stripe_customer_id: user.stripe_customer_id,
        stripe_subscription_id: user.stripe_subscription_id,
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error('❌ Error in debug user endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user info
app.get('/api/user/me', authenticateToken, async (req, res) => {
  try {
    const [err, user] = await dbHelpers.getUserById(req.user.userId);
    
    if (err || !user) {
      console.error('Error getting user:', err);
      return res.status(404).json({ error: 'User not found' });
    }

    // Remove sensitive data
    const userData = {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isPremium: user.is_premium,
        subscriptionTier: user.is_premium ? 'premium' : 'free',
        premiumSince: user.premium_since,
        stripeCustomerId: user.stripe_customer_id,
        stripeSubscriptionId: user.stripe_subscription_id,
        createdAt: user.created_at
      }
    };

    res.json(userData);
  } catch (error) {
    console.error('Error in /api/user/me:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's rank
app.get('/api/leaderboard/my-rank', authenticateToken, async (req, res) => {
  try {
    const [err, rank] = await dbHelpers.getUserMonthlyRank(req.user.userId);
    
    if (err) {
      console.error('Error getting user rank:', err);
      return res.status(500).json({ error: 'Failed to get rank' });
    }

    res.json({
      rank: rank,
      username: req.user.username
    });
  } catch (error) {
    console.error('Error in my-rank:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy leaderboard endpoint (for backward compatibility)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const [err, leaderboard] = await dbHelpers.getMonthlyLeaderboard(limit);
    
    if (err) {
      console.error('Error getting leaderboard:', err);
      return res.status(500).json({ error: 'Failed to get leaderboard' });
    }

    res.json({
      leaderboard: leaderboard.map((user, index) => ({
        rank: index + 1,
        username: user.username,
        minutesWatched: user.current_month_minutes,
        profilePicture: user.profile_picture
      }))
    });
  } catch (error) {
    console.error('Error in leaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Guaranteed total from unfinalized pool + accumulation mode (no winner = accumulation)
app.get('/api/charity/guaranteed-total', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const poolResult = await pool.query(`
      SELECT
        COALESCE(SUM(sponsor_total), 0) + COALESCE(SUM(advertiser_total), 0) AS guaranteed_total
      FROM weekly_donation_pool
      WHERE finalized_at IS NULL
    `);
    const guaranteedTotal = parseFloat(poolResult.rows[0]?.guaranteed_total || 0);

    const currentMonday = getBillingWeekStart(new Date());
    const weekStartStr = currentMonday.toISOString().slice(0, 10);
    const winnerResult = await pool.query(
      'SELECT charity_application_id FROM charity_week_winner WHERE week_start = $1::date LIMIT 1',
      [weekStartStr]
    );
    const accumulationMode = winnerResult.rows.length === 0;

    return res.json({
      accumulationMode: accumulationMode,
      guaranteedTotal: guaranteedTotal
    });
  } catch (err) {
    console.error('❌ [GUARANTEED-TOTAL] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch guaranteed total' });
  }
});

// Lifetime total raised for charity across all finalized weeks (public endpoint)
app.get('/api/charity/lifetime-total', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database connection not available' });

    const result = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) AS lifetime_total
      FROM weekly_charity_allocation
    `);

    const lifetimeTotal = parseFloat(result.rows[0]?.lifetime_total || 0);
    return res.json({ lifetimeTotal });
  } catch (err) {
    console.error('❌ [LIFETIME-TOTAL] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch lifetime total' });
  }
});

// Public endpoint: whether ANY charity week winner exists (used for frontend banner gating)
app.get('/api/charity/winner-exists', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const result = await pool.query('SELECT 1 FROM charity_week_winner LIMIT 1');
    return res.json({ hasWinner: result.rows.length > 0 });
  } catch (err) {
    console.error('❌ [WINNER-EXISTS] Error:', err);
    return res.status(500).json({ error: 'Failed to check winner' });
  }
});

// Get weekly donation progress (public endpoint)
app.get('/api/weekly-progress', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const weeklyGoal = 500;
    let weeklyPartnerName = null;
    const partnerResult = await pool.query(`
      SELECT ca.charity_name
      FROM charity_week_winner cww
      JOIN charity_applications ca ON ca.id = cww.charity_application_id
      WHERE cww.week_start = DATE_TRUNC('week', CURRENT_DATE)::date
      LIMIT 1
    `);
    if (partnerResult.rows.length > 0) {
      weeklyPartnerName = partnerResult.rows[0].charity_name || null;
    }

    // Advertiser contribution: real-time accrued this week via impressions + clicks
    const advertiserResult = await pool.query(`
      SELECT COALESCE(SUM(weekly_contributed_amount), 0) AS advertiser_total
      FROM advertisers
      WHERE payment_completed = TRUE
        AND status NOT IN ('archived', 'rejected')
    `);

    // Sponsor contribution: combine both payment paths for the current week
    // Path 1 — recurring sponsors (already in weekly_donation_pool)
    // Path 2 — one-time sponsors (in sponsor_donations joined to sponsor_campaigns by start_week)
    const sponsorResult = await pool.query(`
      SELECT
        COALESCE(
          (
            SELECT sponsor_total
            FROM weekly_donation_pool
            WHERE week_start = DATE_TRUNC('week', CURRENT_DATE)::date
              AND finalized_at IS NULL
            LIMIT 1
          ), 0
        )
        +
        COALESCE(
          (
            SELECT SUM(sd.amount_cents) / 100.0
            FROM sponsor_donations sd
            JOIN sponsor_campaigns sc ON sc.id = sd.sponsor_campaign_id
            WHERE sc.start_week = DATE_TRUNC('week', CURRENT_DATE)::date
              AND sd.source = 'one_time_payment'
          ), 0
        )
      AS sponsor_total
    `);

    const advertiserTotal = parseFloat(advertiserResult.rows[0]?.advertiser_total || 0);
    const sponsorTotal = parseFloat(sponsorResult.rows[0]?.sponsor_total || 0);
    const weeklyDonated = advertiserTotal + sponsorTotal;

    console.log(`✅ [WEEKLY-PROGRESS] Goal: $${weeklyGoal.toFixed(2)}, Donated: $${weeklyDonated.toFixed(2)} (Advertisers: $${advertiserTotal.toFixed(2)}, Sponsors: $${sponsorTotal.toFixed(2)}), Partner: ${weeklyPartnerName || 'None'}`);

    return res.json({
      weeklyGoal: weeklyGoal,
      weeklyDonated: weeklyDonated,
      weeklyPartnerName: weeklyPartnerName
    });
  } catch (err) {
    console.error('❌ [WEEKLY-PROGRESS] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch weekly progress' });
  }
});

// About page public stats
app.get('/api/about/stats', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database connection not available' });

    const [donationResult, usersResult, advertisersResult] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(total_amount), 0) AS donated_this_month
        FROM weekly_charity_allocation
        WHERE week_start >= CURRENT_DATE - INTERVAL '1 month'
      `),
      pool.query(`SELECT COUNT(*) AS count FROM users`),
      pool.query(`SELECT COUNT(*) AS count FROM advertiser_accounts`)
    ]);

    res.json({
      donatedThisMonth: parseFloat(donationResult.rows[0].donated_this_month),
      activeContributors: parseInt(usersResult.rows[0].count, 10),
      advertisersPartnered: parseInt(advertisersResult.rows[0].count, 10)
    });
  } catch (error) {
    console.error('Error fetching about stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Sponsors of the Week (Gold + Diamond, deduped by account, tier priority diamond > gold)
app.get('/api/sponsors/of-the-week', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const result = await pool.query(`
      SELECT DISTINCT ON (sa.id)
        sa.organization_legal_name AS company_name,
        LOWER(sc.tier) AS tier
      FROM sponsor_campaigns sc
      JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
      WHERE sc.status = 'active'
        AND LOWER(TRIM(sc.tier)) IN ('gold', 'diamond')
      ORDER BY sa.id, CASE WHEN LOWER(TRIM(sc.tier)) = 'diamond' THEN 1 ELSE 2 END
    `);
    const list = result.rows.map((row) => ({
      company_name: row.company_name || 'Sponsor',
      tier: row.tier || 'gold'
    }));
    return res.json(list);
  } catch (err) {
    console.error('❌ [SPONSORS-OF-THE-WEEK] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch sponsors of the week' });
  }
});

// Get top advertisers by lifetime total donations (public endpoint)
app.get('/api/impact/top-advertisers', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    // Aggregate lifetime donations per advertiser account (email) from Stripe billing records
    // Step 1: Sum billing records per campaign
    // Step 2: Roll up totals per email (account-level) to handle multiple campaigns per advertiser
    const result = await pool.query(`
      WITH campaign_totals AS (
        -- First, aggregate billing records per campaign
        SELECT 
          a.id as campaign_id,
          a.email,
          a.company_name,
          COALESCE(SUM(rbr.amount_billed), 0) + COALESCE(SUM(nrb.amount_billed), 0) as campaign_total
        FROM advertisers a
        LEFT JOIN recurring_billing_records rbr 
          ON rbr.advertiser_id = a.id
        LEFT JOIN non_recurring_billing_records nrb 
          ON nrb.campaign_id = a.id
        WHERE a.payment_completed = TRUE
          AND a.company_name IS NOT NULL
          AND a.company_name != ''
        GROUP BY a.id, a.email, a.company_name
      ),
      advertiser_totals AS (
        -- Then, roll up by email (account-level aggregation)
        SELECT 
          email,
          MAX(company_name) as company_name,
          SUM(campaign_total) as total_donated
        FROM campaign_totals
        GROUP BY email
        HAVING SUM(campaign_total) > 0
      )
      SELECT 
        email,
        company_name,
        total_donated,
        ROW_NUMBER() OVER (ORDER BY total_donated DESC) as rank
      FROM advertiser_totals
      ORDER BY total_donated DESC
      LIMIT 5
    `);

    const advertisers = result.rows.map(row => ({
      rank: parseInt(row.rank),
      companyName: row.company_name,
      totalDonated: parseFloat(row.total_donated)
    }));

    console.log(`✅ [TOP-ADVERTISERS] Returning ${advertisers.length} top advertisers`);

    return res.json({ advertisers });
  } catch (err) {
    console.error('❌ [TOP-ADVERTISERS] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch top advertisers' });
  }
});

// Get top sponsors by total donations (sponsor_donations; refund protection for non-recurring)
app.get('/api/leaderboards/top-sponsors', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    const result = await pool.query(`
      SELECT
        sa.id,
        sa.organization_legal_name,
        SUM(dl.amount) AS total_donated
      FROM donation_ledger dl
      JOIN sponsor_campaigns sc ON dl.source_id = sc.id::text AND dl.source_type = 'sponsor'
      JOIN sponsor_accounts sa ON sc.sponsor_account_id = sa.id
      GROUP BY sa.id, sa.organization_legal_name
      HAVING SUM(dl.amount) > 0
      ORDER BY total_donated DESC
      LIMIT 4
    `);
    const list = result.rows.map(row => ({
      name: row.organization_legal_name || 'Unknown',
      totalDonated: Number(row.total_donated)
    }));
    return res.json(list);
  } catch (err) {
    console.error('❌ [TOP-SPONSORS] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch top sponsors' });
  }
});

// Get top charities by total donations across all weeks (public endpoint)
app.get('/api/impact/top-charities', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database connection not available' });

    const result = await pool.query(`
      SELECT
        ca.charity_name,
        SUM(wca.total_amount) AS total_donated
      FROM weekly_charity_allocation wca
      JOIN charity_applications ca ON ca.id = wca.charity_application_id
      GROUP BY ca.id, ca.charity_name
      ORDER BY total_donated DESC
      LIMIT 5
    `);

    const charities = result.rows.map((row, i) => ({
      rank: i + 1,
      charityName: row.charity_name,
      totalDonated: parseFloat(row.total_donated)
    }));

    return res.json({ charities });
  } catch (err) {
    console.error('❌ [TOP-CHARITIES] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch top charities' });
  }
});

// ===== VIDEO MANAGEMENT ROUTES =====

// Add video to database (admin endpoint)
app.post('/api/admin/add-video', async (req, res) => {
  const { title, video_url, duration } = req.body;
  
  try {
    const [err, video] = await dbHelpers.addVideo(title, video_url, duration);
    
    if (err) {
      console.error('❌ Error adding video:', err);
      return res.status(500).json({ error: 'Failed to add video', details: err.message });
    }
    
    console.log('✅ Video added to database:', video);
    res.json({ success: true, video });
  } catch (error) {
    console.error('❌ Error adding video:', error);
    res.status(500).json({ error: 'Failed to add video', details: error.message });
  }
});

// Get current active video for the player
// Updated to use first video from R2 bucket (matching desktop app behavior)
app.get('/api/videos/current', async (req, res) => {
  try {
    // R2 bucket URL for charity-stream-videos
    const R2_BUCKET_URL = R2_VIDEOS_URL;
    
    // Return first video from R2 bucket as the current/starting video
    const currentVideo = {
      videoId: 1,
      title: 'video_1',
      videoUrl: `${R2_BUCKET_URL}/video_1.mp4`,
      duration: 60
    };
    
    console.log('✅ Serving current video from R2 bucket:', currentVideo.title);
    
    res.json(currentVideo);
  } catch (error) {
    console.error('❌ Error fetching current video:', error);
    res.status(500).json({ error: 'Failed to fetch video', details: error.message });
  }
});

// Get all active videos for looping
// DYNAMIC: Scans charity-stream-videos R2 bucket for all video_X.mp4 files
// Server-side caching for playlist data
const playlistCache = new Map();
const PLAYLIST_CACHE_TTL = 120000; // 2 minutes

/**
 * Engagement-preserving playlist scheduler (local pacing).
 * - Max sponsor streak = 2 (never more than 2 sponsors in a row).
 * - Sliding window: at most MAX_SPONSORS_IN_WINDOW sponsors in last WINDOW_SIZE slots.
 * - Cycles advertiser/sponsor lists when one would run out to avoid sponsor-only tails.
 * - Fallback: no advertisers → sponsors only; no sponsors → advertisers only.
 * @param {Array} advertisers - Array of advertiser video items
 * @param {Array} sponsors - Array of sponsor video items
 * @returns {Array} Merged playlist
 */
function buildEngagementBalancedPlaylist(advertisers, sponsors) {
  if (advertisers.length === 0) {
    return sponsors.slice();
  }
  if (sponsors.length === 0) {
    return advertisers.slice();
  }

  // Tier pools for weighted sponsor selection
  const tierPools = {
    bronze: [],
    silver: [],
    gold: [],
    diamond: []
  };

  sponsors.forEach(s => {
    const t = (s.tier || 'bronze').toLowerCase();
    if (tierPools[t]) tierPools[t].push(s);
    else tierPools.bronze.push(s);
  });

  // Tier rotation schedule: bronze 1x, silver 2x, gold 3x, diamond 4x
  const tierSchedule = [
    'bronze',
    'silver', 'silver',
    'gold', 'gold', 'gold',
    'diamond', 'diamond', 'diamond', 'diamond'
  ];

  const tierIndices = {
    bronze: 0,
    silver: 0,
    gold: 0,
    diamond: 0
  };

  let tierPointer = 0;

  const WINDOW_SIZE = 5;
  const MAX_SPONSORS_IN_WINDOW = 2;
  const merged = [];
  const recentTypes = []; // sliding window: last WINDOW_SIZE item types ('advertiser' | 'sponsor')
  let sponsorStreak = 0;
  let ai = 0;
  let si = 0;
  const MAX_PLAYLIST_LENGTH = Math.max(50, advertisers.length * 3);

  while (merged.length < MAX_PLAYLIST_LENGTH) {
    const mustPlayAdvertiser = sponsorStreak === 2;
    const recentSponsors = recentTypes.filter(t => t === 'sponsor').length;
    const mayPlaySponsor = !mustPlayAdvertiser && recentSponsors < MAX_SPONSORS_IN_WINDOW;

    if (mustPlayAdvertiser || !mayPlaySponsor) {
      merged.push(advertisers[ai % advertisers.length]);
      ai++;
      sponsorStreak = 0;
      recentTypes.push('advertiser');
      if (recentTypes.length > WINDOW_SIZE) recentTypes.shift();
    } else {
      // Tier-weighted sponsor selection
      let selectedSponsor = null;
      let attempts = 0;

      while (!selectedSponsor && attempts < tierSchedule.length) {
        const tier = tierSchedule[tierPointer % tierSchedule.length];
        const pool = tierPools[tier];

        if (pool.length > 0) {
          const idx = tierIndices[tier] % pool.length;
          selectedSponsor = pool[idx];
          tierIndices[tier]++;
          tierPointer++; // advance only when a sponsor is actually selected
        } else {
          tierPointer++; // skip empty tier without consuming weight
        }

        attempts++;
      }

      if (!selectedSponsor) {
        selectedSponsor = sponsors[si % sponsors.length];
        si++;
      }

      merged.push(selectedSponsor);
      sponsorStreak++;
      recentTypes.push('sponsor');
      if (recentTypes.length > WINDOW_SIZE) recentTypes.shift();
    }
  }

  return merged;
}

app.get('/api/videos/playlist', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const cacheKey = 'playlist_all';
    const now = Date.now();
    
    // Check cache first
    const cached = playlistCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < PLAYLIST_CACHE_TTL) {
      console.log(`📊 Returning cached playlist data`);
      return res.json(cached.data);
    }
    
    const R2_BUCKET_URL = R2_VIDEOS_URL;
    const CHARITY_BUCKET = 'charity-stream-videos';
    
    // List all video files from R2 bucket
    const listCommand = new ListObjectsV2Command({
      Bucket: CHARITY_BUCKET
    });
    
    const response = await r2Client.send(listCommand);
    const allFiles = response.Contents || [];
    
    // Filter for new globally unique filename format: video_<advertiserId>_<timestamp>_<uuid>.mp4
    // Exclude archived/ folder and extract advertiserId and timestamp
    const videoFiles = allFiles
      .filter(file => 
        /^video_(\d+)_(\d+)_[a-fA-F0-9-]+\.mp4$/.test(file.Key) &&
        !file.Key.startsWith('archived/')
      )
      .map(file => {
        const match = file.Key.match(/^video_(\d+)_(\d+)_([a-fA-F0-9-]+)\.mp4$/);
        if (!match) return null;
        
        const advertiserId = parseInt(match[1], 10);
        const uploadTimestamp = parseInt(match[2], 10);
        
        return {
          filename: file.Key,
          advertiserId,
          uploadTimestamp,
          size: file.Size
        };
      })
      .filter(file => file !== null) // Remove any files that didn't match the pattern
      .sort((a, b) => a.uploadTimestamp - b.uploadTimestamp); // Sort by upload timestamp (oldest first)
    
    // Debug: Log if any archived files were found and skipped
    const archivedFiles = allFiles.filter(file => file.Key.startsWith('archived/'));
    if (archivedFiles.length > 0) {
      console.log(`📦 [PLAYLIST] Skipped ${archivedFiles.length} archived video(s):`, archivedFiles.map(f => f.Key));
    }
    
    // Get advertiser mappings for videos with video_filename
    const pool = getPool();
    let advertiserMap = new Map();
    let advertiserDataById = new Map();
    // Track filenames that should be blocked (capped, archived, or paused advertisers)
    const blockedFilenames = new Set();
    
    if (pool) {
      try {
        // Query for all advertisers (including archived) to build blockedFilenames
        const advertiserResult = await pool.query(`
          SELECT id, video_filename,
                 current_week_impressions, max_weekly_impressions, capped,
                 status, archived_at, archived_reason, recurring_weekly, is_paused,
                 click_tracking, destination_url, ad_format, campaign_start_date
          FROM advertisers
          WHERE video_filename IS NOT NULL
            AND status = 'active'
        `);
        
        // Process each advertiser: check caps and archive if needed
        for (const ad of advertiserResult.rows) {
          // Debug logging for each advertiser
          console.log(`🧪 [PLAYLIST] Advertiser ${ad.id} status:`, {
            capped: ad.capped,
            status: ad.status,
            video_filename: ad.video_filename,
            current_week_impressions: ad.current_week_impressions,
            max_weekly_impressions: ad.max_weekly_impressions
          });
          
          // Check if impressions >= max_weekly_impressions (cap the advertiser)
          if (ad.max_weekly_impressions !== null && 
              ad.current_week_impressions >= ad.max_weekly_impressions && 
              !ad.capped) {
            console.log(`🛑 Capping advertiser ${ad.id} - impressions (${ad.current_week_impressions}) >= max (${ad.max_weekly_impressions})`);
            
            // Set capped = TRUE when cap is hit (do NOT set is_paused - that's for manual pauses only)
            await pool.query(`
              UPDATE advertisers
              SET capped = TRUE
              WHERE id = $1
            `, [ad.id]);
            
            ad.capped = true;
            // CLEAR PLAYLIST CACHE WHEN AN AD IS CAPPED (clear all entries)
            playlistCache.clear();
            console.log("🧽 [PLAYLIST ENDPOINT] Cache cleared due to advertiser being capped inside playlist endpoint");
          }
          
          // Automatic archiving for non-recurring capped campaigns
          // Non-recurring campaigns have recurring_weekly = FALSE
          // TODO: For non-recurring campaigns, when implementing "time left" logic,
          // we need to account for paused duration so only live time counts toward the 7-day window.
          if (ad.capped === true && 
              ad.recurring_weekly === false && 
              ad.status !== 'archived' &&
              ad.is_paused === false &&
              ad.video_filename) {
            console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} from endpoint=/api/playlist triggeredBy=auto_capped_loop`);
            
            // Safety guard: Double-check archived status right before R2 operations (race condition protection)
            const doubleCheckResult = await pool.query(
              `SELECT status FROM advertisers WHERE id = $1`,
              [ad.id]
            );
            
            if (doubleCheckResult.rows.length === 0) {
              console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - Campaign disappeared during processing, skipping`);
              continue;
            }
            
            if (doubleCheckResult.rows[0].status === 'archived') {
              console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - Already archived (double-check), skipping R2 operations`);
              ad.status = 'archived';
              continue;
            }
            
            try {
              // MOVE FILE IN R2 (copy + delete)
              const CHARITY_BUCKET = 'charity-stream-videos';
              const R2_PUBLIC_URL = R2_VIDEOS_URL;
              const sourceKey = ad.video_filename;
              const destKey = `archived/${ad.video_filename}`;
              
              console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - Starting R2 operations: ${sourceKey} -> ${destKey}`);
              const copyCommand = new CopyObjectCommand({
                Bucket: CHARITY_BUCKET,
                CopySource: `${CHARITY_BUCKET}/${sourceKey}`,
                Key: destKey
              });
              await r2Client.send(copyCommand);
              console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - R2 copy successful: ${sourceKey} -> ${destKey}`);
              
              const deleteCommand = new DeleteObjectCommand({
                Bucket: CHARITY_BUCKET,
                Key: sourceKey
              });
              await r2Client.send(deleteCommand);
              console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - R2 delete successful: ${sourceKey}`);

              // Construct the archived media URL
              const archivedMediaUrl = normalizeBareMediaR2Link(`${R2_PUBLIC_URL}/${destKey}`);
              console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - Updated media_r2_link to archived location: ${archivedMediaUrl}`);
              
              // Update database - use WHERE clause to ensure we only update if not already archived
              // Also update media_r2_link to point to the archived location
              const updateResult = await pool.query(`
                UPDATE advertisers
                SET status = 'archived',
                    archived_at = NOW(),
                    archived_reason = 'Non-recurring campaign capped',
                    media_r2_link = $2
                WHERE id = $1 AND status != 'archived'
                RETURNING id
              `, [ad.id, archivedMediaUrl]);
              
              if (updateResult.rows.length === 0) {
                // Another process may have archived it
                console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - Database update skipped (already archived by another process)`);
                ad.status = 'archived'; // Update local state
              } else {
                console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - Successfully archived`);
                ad.status = 'archived';
              }
              
              // CLEAR PLAYLIST CACHE WHEN A NON-RECURRING AD IS ARCHIVED (clear all entries)
              playlistCache.clear();
              console.log("🧽 [PLAYLIST ENDPOINT] Cache cleared due to non-recurring advertiser being archived");
            } catch (r2Error) {
              console.error(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - R2 error:`, r2Error);
              // Still update database as archived even if R2 move fails - but only if not already archived
              const updateResult = await pool.query(`
                UPDATE advertisers
                SET status = 'archived',
                    archived_at = NOW(),
                    archived_reason = 'Non-recurring campaign capped (R2 archive failed)'
                WHERE id = $1 AND status != 'archived'
                RETURNING id
              `, [ad.id]);
              
              if (updateResult.rows.length > 0) {
                console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - Database marked as archived despite R2 failure`);
                ad.status = 'archived';
              }
            }
          }
          
          // NEW: mark any capped, archived, or paused advertiser's filename as blocked
          if (ad.capped === true || ad.status === 'archived' || ad.is_paused === true) {
            if (ad.video_filename) {
              blockedFilenames.add(ad.video_filename);
              const reason = ad.capped ? 'capped' : ad.status === 'archived' ? 'archived' : 'paused';
              console.log(`🚫 [PLAYLIST] Blocking ${reason} file: ${ad.video_filename} (advertiser ${ad.id})`);
            }
            // Do NOT add to advertiserMap
            continue;
          }
          
          // Non-recurring run window: only include if NOW() >= campaign_start_date AND NOW() < campaign_start_date + 7 days
          if (ad.recurring_weekly === false && ad.campaign_start_date) {
            const start = new Date(ad.campaign_start_date);
            const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
            const now = new Date();
            if (now < start || now >= end) {
              if (ad.video_filename) {
                blockedFilenames.add(ad.video_filename);
                console.log(`🚫 [PLAYLIST] Blocking non-recurring outside run window: ${ad.video_filename} (advertiser ${ad.id})`);
              }
              continue;
            }
          }
          
          // Only add to maps if not capped, not archived, not paused, and (recurring or within run window)
          advertiserMap.set(ad.video_filename, ad.id);
          advertiserDataById.set(ad.id, ad);
        }
        
        // Debug logging: show which advertisers are in the map
        console.log("🧪 [PLAYLIST] Final active advertiserMap keys:", [...advertiserMap.keys()]);
        
        console.log(`📊 Found ${advertiserMap.size} active advertisers with video_filename (${advertiserResult.rows.length - advertiserMap.size} capped/archived/paused excluded)`);
      } catch (adError) {
        console.error('⚠️ Error fetching advertiser mappings (non-critical):', adError.message);
        // Continue without advertiser data - old videos will work fine
      }
    }
    
    // Build playlist with advertiser info (exclude capped/archived videos)
    const rawPlaylist = videoFiles.map(video => {
      // NEW: if this filename is blocked (capped or archived advertiser), skip it completely
      if (blockedFilenames.has(video.filename)) {
        console.log(`⏭️ [PLAYLIST] Skipping blocked video file: ${video.filename}`);
        return null;
      }
      
      // Get advertiserId from map (using full filename as key) or use extracted advertiserId from filename
      const mappedAdvertiserId = advertiserMap.get(video.filename);
      const advertiserId = mappedAdvertiserId || video.advertiserId || null;
      const videoFilename = video.filename;
      
      // Get advertiser data for click tracking fields
      const advertiserData = advertiserDataById.get(advertiserId) || null;
      
      return {
        videoId: video.uploadTimestamp, // Use upload timestamp as unique identifier
      title: video.filename.replace('.mp4', ''),
      videoUrl: `${R2_BUCKET_URL}/${video.filename}`,
        duration: 60,
        advertiserId: advertiserId,
        videoFilename: videoFilename,
        isCapped: false, // Backend already filtered, but include for frontend defensive check
        clickTracking: advertiserData ? (advertiserData.click_tracking === true) : false,
        destinationUrl: advertiserData ? advertiserData.destination_url : null,
        adFormat: advertiserData ? advertiserData.ad_format : null
      };
    });
    
    // Filter out null entries (capped videos)
    const playlist = rawPlaylist.filter(v => v !== null);

    // Query eligible sponsor campaigns (active, generation_completed, video_r2_key set, billing paid)
    // JOIN sponsor_accounts to expose website for sponsor CTA
    let sponsorItems = [];
    if (pool) {
      try {
        const sponsorResult = await pool.query(`
          SELECT sc.id, sc.video_r2_key, sc.tier, sa.website AS sponsor_website
          FROM sponsor_campaigns sc
          JOIN sponsor_billing sb ON sb.sponsor_campaign_id = sc.id
          JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
          WHERE sc.status = 'active'
            AND sc.generation_completed = TRUE
            AND sc.video_r2_key IS NOT NULL
            AND sb.status = 'paid'
            AND sc.start_week <= CURRENT_DATE
            AND (sc.end_at IS NULL OR sc.end_at > CURRENT_DATE)
          ORDER BY sc.id
        `);
        const SPONSOR_VIDEO_BASE_URL = R2_SPONSOR_GENERATED_URL;
        sponsorItems = sponsorResult.rows.map(row => ({
          videoId: `sponsor_${row.id}`,
          title: row.video_r2_key.replace(/\.mp4$/i, '') || row.video_r2_key,
          videoUrl: `${SPONSOR_VIDEO_BASE_URL}/${row.video_r2_key}`,
          duration: 60,
          advertiserId: null,
          videoFilename: row.video_r2_key,
          isCapped: false,
          clickTracking: false,
          destinationUrl: null,
          adFormat: null,
          sponsorCampaignId: row.id,
          sponsorWebsite: row.sponsor_website || null,
          tier: (row.tier || 'bronze').toLowerCase()
        }));
        console.log(`📊 [PLAYLIST] Found ${sponsorItems.length} eligible sponsor campaign(s)`);
      } catch (sponsorErr) {
        console.error('⚠️ Error fetching sponsor campaigns (non-critical):', sponsorErr.message);
      }
    }

    // Engagement-preserving merge: advertiser majority, sponsor streak cap 2, no sponsor-only tail
    const merged = buildEngagementBalancedPlaylist(playlist, sponsorItems);

    const playlistData = {
      videos: merged
    };
    
    // Cache the result
    playlistCache.set(cacheKey, {
      data: playlistData,
      timestamp: now
    });
    
    // Clean up old cache entries
    for (const [key, value] of playlistCache.entries()) {
      if (now - value.timestamp > PLAYLIST_CACHE_TTL) {
        playlistCache.delete(key);
      }
    }
    
    console.log(`✅ Dynamically serving playlist: ${merged.length} videos (${playlist.length} advertiser, ${sponsorItems.length} sponsor)`);
    
    res.json(playlistData);
  } catch (error) {
    console.error('❌ Error fetching playlist:', error);
    
    // Fallback to empty playlist if R2 listing fails
    // No longer using sequential video numbers as fallback
    console.log('⚠️ Using empty fallback playlist due to error');
    res.json({ videos: [] });
  }
});

// ===== POPUP IMAGE ADS ENDPOINT =====
// Returns approved image ads for popup display
app.get('/api/images/popup-ads', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const cacheKey = 'popup_ads_all';
    const now = Date.now();
    
    // Check cache first
    const cached = playlistCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < PLAYLIST_CACHE_TTL) {
      console.log(`📊 Returning cached popup ads data`);
      return res.json(cached.data);
    }
    
    const R2_BUCKET_URL = R2_VIDEOS_URL;
    const CHARITY_BUCKET = 'charity-stream-videos';
    
    // List all files from R2 bucket
    const listCommand = new ListObjectsV2Command({
      Bucket: CHARITY_BUCKET
    });
    
    const response = await r2Client.send(listCommand);
    const allFiles = response.Contents || [];
    
    // Filter for image files: image_{advertiserId}_{timestamp}_{uuid}.{jpg|png|gif|webp}
    // Exclude archived/ folder
    const imageFiles = allFiles
      .filter(file => 
        /^image_(\d+)_(\d+)_[a-fA-F0-9-]+\.(jpg|jpeg|png|gif|webp)$/i.test(file.Key) &&
        !file.Key.startsWith('archived/')
      )
      .map(file => {
        const match = file.Key.match(/^image_(\d+)_(\d+)_([a-fA-F0-9-]+)\.(jpg|jpeg|png|gif|webp)$/i);
        if (!match) return null;
        
        const advertiserId = parseInt(match[1], 10);
        const uploadTimestamp = parseInt(match[2], 10);
        
        return {
          filename: file.Key,
          advertiserId,
          uploadTimestamp,
          size: file.Size
        };
      })
      .filter(file => file !== null)
      .sort((a, b) => a.uploadTimestamp - b.uploadTimestamp); // Sort by upload timestamp (oldest first)
    
    // Get advertiser mappings for images
    const pool = getPool();
    let imageAds = [];
    const blockedFilenames = new Set();
    
    if (pool) {
      try {
        // Query for all image advertisers to check status
        // NOTE: We query all approved/completed ads, then filter by capped/paused/archived in JavaScript
        // This allows us to check both capped AND is_paused separately (they have different meanings)
        const advertiserResult = await pool.query(`
          SELECT id, video_filename,
                 current_week_impressions, max_weekly_impressions, capped,
                 status, archived_at, archived_reason, recurring_weekly, is_paused,
                 click_tracking, destination_url, ad_format
          FROM advertisers
          WHERE video_filename IS NOT NULL
            AND video_filename LIKE 'image_%'
            AND status = 'active'
        `);
        
        // Build map of active advertisers
        const activeAdvertisers = new Map();
        
        for (const ad of advertiserResult.rows) {
          // Check if impressions >= max_weekly_impressions (cap the advertiser)
          if (ad.max_weekly_impressions !== null && 
              ad.current_week_impressions >= ad.max_weekly_impressions && 
              !ad.capped) {
            console.log(`🛑 Capping image advertiser ${ad.id} - impressions (${ad.current_week_impressions}) >= max (${ad.max_weekly_impressions})`);
            
            // Set capped = TRUE when cap is hit (do NOT set is_paused - that's for manual pauses only)
            await pool.query(`
              UPDATE advertisers
              SET capped = TRUE
              WHERE id = $1
            `, [ad.id]);
            
            ad.capped = true;
            playlistCache.clear();
            
            // For non-recurring campaigns, trigger archive when capped
            if (ad.recurring_weekly === false && ad.status === 'active' && ad.video_filename) {
              console.log(`[ARCHIVE ATTEMPT] campaignId=${ad.id} from endpoint=/api/images/popup-ads triggeredBy=cap_hit`);
              // Archive asynchronously (don't block popup serving)
              archiveCampaign(ad.id, 'Non-recurring campaign capped', pool).catch(err => {
                console.error(`[ARCHIVE ATTEMPT] campaignId=${ad.id} - Archive error:`, err);
              });
            }
          }
          
          // Defensive check: Mark blocked filenames (capped, archived, or paused)
          // Even though SQL filters these out, check again for safety (handles race conditions)
          if (ad.capped === true || ad.status === 'archived' || ad.is_paused === true) {
            if (ad.video_filename) {
              blockedFilenames.add(ad.video_filename);
              const reason = ad.capped ? 'capped' : ad.status === 'archived' ? 'archived' : 'paused';
              console.log(`🚫 [POPUP ADS] Blocking ${reason} image file: ${ad.video_filename} (advertiser ${ad.id})`);
            }
            continue;
          }
          
          // Only add to active advertisers map if not blocked
          activeAdvertisers.set(ad.video_filename, ad);
        }
        
        // Build image ads array (exclude blocked AND only include images with matching advertiser records)
        imageAds = imageFiles
          .filter(image => {
            // CRITICAL: Exclude if filename is in blocked list
            if (blockedFilenames.has(image.filename)) {
              console.log(`⏭️ [POPUP ADS] Skipping blocked image file: ${image.filename}`);
              return false;
            }
            
            // CRITICAL: Only include images that have a matching active advertiser record
            // This ensures we never serve images without valid advertiser data
            const advertiser = activeAdvertisers.get(image.filename);
            if (!advertiser) {
              console.log(`⏭️ [POPUP ADS] Skipping image without active advertiser record: ${image.filename}`);
              return false;
            }
            
            return true;
          })
          .map(image => {
            const advertiser = activeAdvertisers.get(image.filename);
            // At this point, advertiser is guaranteed to exist due to filter above
            
            return {
              advertiserId: advertiser.id,
              imageFilename: image.filename,
              imageUrl: `${R2_BUCKET_URL}/${image.filename}`,
              clickTracking: advertiser.click_tracking === true,
              destinationUrl: advertiser.destination_url
            };
          });
        
        console.log(`📊 Found ${imageAds.length} active image ads (${blockedFilenames.size} blocked)`);
      } catch (adError) {
        console.error('⚠️ Error fetching advertiser mappings (non-critical):', adError.message);
        // CRITICAL: If advertiser lookup fails, return empty array for safety
        // We cannot safely serve ads without advertiser data (no way to verify pause/cap status)
        console.log('🚫 [POPUP ADS] Returning empty array due to advertiser lookup failure (safety measure)');
        imageAds = [];
      }
    } else {
      // CRITICAL: If database pool is unavailable, return empty array for safety
      // We cannot safely serve ads without database verification (no way to verify pause/cap status)
      console.log('🚫 [POPUP ADS] Database pool unavailable - returning empty array (safety measure)');
      imageAds = [];
    }
    
    const responseData = {
      images: imageAds,
      count: imageAds.length
    };
    
    // Cache the result
    playlistCache.set(cacheKey, {
      data: responseData,
      timestamp: now
    });
    
    res.json(responseData);
  } catch (error) {
    console.error('❌ Error fetching popup ads:', error);
    res.json({ images: [], count: 0 });
  }
});

// Add simple in-memory cache for advertiser lookups
const advertiserCache = new Map();
const ADVERTISER_CACHE_TTL = 300000; // 5 minutes

// GET endpoint to fetch advertiser info for a specific video
app.get('/api/videos/:videoFilename/advertiser', async (req, res) => {
  try {
    const { videoFilename } = req.params;
    console.log('🔍 Video advertiser endpoint called for:', videoFilename);
    
    // Check cache first
    const cacheKey = `advertiser_${videoFilename}`;
    const cached = advertiserCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ADVERTISER_CACHE_TTL) {
      return res.json(cached.data);
    }
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    const result = await pool.query(`
      SELECT 
        a.id,
        m.video_filename,
        COALESCE(a.company_name, m.company_name) AS company_name,
        COALESCE(a.destination_url, m.website_url) AS destination_url,
        a.click_tracking,
        a.ad_format
      FROM video_advertiser_mappings m
      LEFT JOIN advertisers a ON a.id = m.advertiser_id
      WHERE m.video_filename = $1 AND m.is_active = true
      LIMIT 1
    `, [videoFilename]);
    
    const responseData = result.rows.length > 0 ? {
      hasAdvertiser: true,
      advertiser: result.rows[0]
    } : {
      hasAdvertiser: false,
      advertiser: null
    };
    console.log('📊 Advertiser endpoint returning:', responseData);
    
    // Cache the result
    advertiserCache.set(cacheKey, {
      data: responseData,
      timestamp: Date.now()
    });
    
    res.json(responseData);
  } catch (error) {
    console.error('❌ Error fetching video advertiser:', error);
    res.status(500).json({ error: 'Failed to fetch advertiser information' });
  }
});

// GET endpoint to fetch all active video-advertiser mappings
app.get('/api/videos/advertiser-mappings', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    const result = await pool.query(`
      SELECT video_filename, website_url, company_name
      FROM video_advertiser_mappings 
      WHERE is_active = true
      ORDER BY video_filename
    `);

    res.json({
      mappings: result.rows
    });
  } catch (error) {
    console.error('❌ Error fetching advertiser mappings:', error);
    res.status(500).json({ error: 'Failed to fetch advertiser mappings' });
  }
});

// Delete a specific video (admin endpoint)
app.delete('/api/admin/delete-video/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    // Validate videoId
    if (!videoId || isNaN(parseInt(videoId))) {
      return res.status(400).json({ error: 'Valid video ID is required' });
    }
    
    const [err, result] = await dbHelpers.deleteVideo(parseInt(videoId));
    
    if (err) {
      console.error('❌ Error deleting video:', err);
      return res.status(500).json({ error: 'Failed to delete video', details: err.message });
    }
    
    if (!result || result.rowCount === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    console.log('✅ Video deleted successfully:', { videoId, deletedRows: result.rowCount });
    res.json({ 
      success: true, 
      message: 'Video deleted successfully',
      videoId: parseInt(videoId),
      deletedRows: result.rowCount
    });
  } catch (error) {
    console.error('❌ Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video', details: error.message });
  }
});

// ===== ENHANCED ADMIN ROUTES =====

// Get comprehensive platform analytics
app.get('/api/admin/analytics', authenticateToken, (req, res) => {
  console.log('📊 Admin analytics requested by:', req.user.username);
  
  dbHelpers.getPlatformAnalytics(null, null, (err, analytics) => {
    if (err) {
      console.error('Analytics error:', err);
      return res.status(500).json({ error: 'Failed to get analytics' });
    }
    
    console.log('Analytics data:', analytics);
    res.json({ analytics });
  });
});

// Get event analytics breakdown
app.get('/api/admin/analytics/events', authenticateToken, (req, res) => {
  dbHelpers.getEventAnalytics(null, null, (err, events) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get event analytics' });
    }
    res.json({ events });
  });
});

// Get top watchers with completion rates
app.get('/api/admin/top-watchers', authenticateToken, (req, res) => {
  const limit = req.query.limit || 10;
  
  dbHelpers.getTopWatchers(limit, (err, topWatchers) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get top watchers' });
    }
    res.json({ topWatchers });
  });
});

// Get user-specific analytics
app.get('/api/admin/users/:userId/analytics', authenticateToken, (req, res) => {
  const userId = req.params.userId;
  
  dbHelpers.getUserAnalytics(userId, (err, userAnalytics) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get user analytics' });
    }
    res.json({ userAnalytics });
  });
});

// Get all users (admin only)
app.get('/api/admin/users', authenticateToken, (req, res) => {
  const limit = req.query.limit || 50;
  const offset = req.query.offset || 0;
  
  const query = `
    SELECT 
      id, username, email, created_at, last_login,
      total_minutes_watched, current_month_minutes,
      is_premium, is_active
    FROM users 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `;
  
  dbHelpers.db.all(query, [limit, offset], (err, users) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get users' });
    }

    // Get total count
    dbHelpers.db.get('SELECT COUNT(*) as total FROM users', (err, countResult) => {
      res.json({
        users: users,
        total: countResult ? countResult.total : 0,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
  });
});

// Get user details by ID (admin only)
app.get('/api/admin/users/:userId', authenticateToken, (req, res) => {
  const userId = req.params.userId;
  
  // Get user info
  dbHelpers.getUserById(userId, (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user's watch sessions
    const sessionQuery = `
      SELECT video_name, quality, start_time, duration_seconds, completed
      FROM watch_sessions 
      WHERE user_id = ? 
      ORDER BY start_time DESC 
      LIMIT 20
    `;
    
    dbHelpers.db.all(sessionQuery, [userId], (err, sessions) => {
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          created_at: user.created_at,
          last_login: user.last_login,
          total_minutes_watched: user.total_minutes_watched,
          current_month_minutes: user.current_month_minutes,
          is_premium: user.is_premium || false,
          is_active: user.is_active
        },
        recentSessions: sessions || []
      });
    });
  });
});

// ===== ADVERTISER CHECKOUT ROUTES =====

// ===== PRESIGNED URL ENDPOINT FOR DIRECT R2 UPLOADS =====
// This bypasses Vercel's 4.5MB request body limit by allowing direct browser-to-R2 uploads
app.post('/api/r2/presign-upload', authenticateToken, async (req, res) => {
  try {
    console.log('🔐 ===== PRESIGNED URL GENERATION =====');
    
    const { fileName, contentType, fileSize } = req.body;
    
    if (!fileName || !contentType) {
      console.error('❌ Missing required fields:', { fileName, contentType });
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'fileName and contentType are required' 
      });
    }
    
    // Validate file size (50MB limit)
    const maxSizeBytes = 50 * 1024 * 1024;
    if (fileSize && fileSize > maxSizeBytes) {
      console.error(`❌ File too large: ${fileSize} bytes (max: ${maxSizeBytes} bytes)`);
      return res.status(413).json({
        error: 'File too large',
        message: `File size exceeds maximum allowed size of 50 MB`
      });
    }
    
    // Validate content type
    const allowedMimes = ['video/mp4', 'image/png', 'image/jpeg', 'image/jpg'];
    if (!allowedMimes.includes(contentType)) {
      console.error(`❌ Invalid content type: ${contentType}`);
      return res.status(400).json({
        error: 'Invalid file type',
        message: 'Only MP4 videos and PNG/JPG images are allowed'
      });
    }
    
    // Generate unique key with UUID + original extension
    const crypto = require('crypto');
    const uuid = crypto.randomUUID();
    const fileExtension = fileName.split('.').pop() || 'mp4';
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = Date.now();
    const key = `${timestamp}-${uuid}.${fileExtension}`;
    
    console.log('📝 Generated R2 key:', {
      originalFileName: fileName,
      sanitizedFileName: sanitizedFileName,
      key: key,
      contentType: contentType,
      fileSize: fileSize ? `${(fileSize / (1024 * 1024)).toFixed(2)} MB` : 'unknown'
    });
    
    // Create PutObjectCommand for presigning
    const putCommand = new PutObjectCommand({
      Bucket: 'advertiser-media',
      Key: key,
      ContentType: contentType,
      ...(fileSize && { ContentLength: fileSize })
    });
    
    // Generate presigned URL (expires in 10 minutes)
    const expiresIn = 600; // 10 minutes in seconds
    const uploadUrl = await getSignedUrl(r2Client, putCommand, { expiresIn });
    
    // Generate public URL (for after upload completes)
    const publicUrl = `${R2_ADVERTISER_MEDIA_URL}/${key}`;
    
    console.log('✅ Presigned URL generated:', {
      key: key,
      expiresIn: `${expiresIn} seconds`,
      uploadUrl: uploadUrl.substring(0, 100) + '...',
      publicUrl: publicUrl
    });
    
    res.json({
      success: true,
      uploadUrl: uploadUrl,
      publicUrl: publicUrl,
      key: key,
      expiresIn: expiresIn
    });
    
  } catch (error) {
    console.error('❌ Presigned URL generation error:', {
      message: error.message,
      code: error.code,
      name: error.name,
      stack: error.stack
    });
    res.status(500).json({
      error: 'Failed to generate presigned URL',
      message: error.message || 'An unexpected error occurred'
    });
  }
});

// ===== OLD UPLOAD ENDPOINT (DISABLED - USE PRESIGNED URLS INSTEAD) =====
// This endpoint is kept for backward compatibility but should not be used
// Direct browser-to-R2 uploads via presigned URLs bypass Vercel's 4.5MB limit
app.post('/api/advertiser/upload-file', upload.single('creative'), async (req, res) => {
  console.warn('⚠️ DEPRECATED: /api/advertiser/upload-file called. Use presigned URLs instead.');
  return res.status(410).json({
    error: 'This endpoint is deprecated',
    message: 'Please use /api/r2/presign-upload to get a presigned URL for direct R2 uploads',
    deprecated: true
  });
});

app.post('/api/advertiser/create-checkout-session', async (req, res) => {
  try {
    console.log('🚀 ===== ADVERTISER CHECKOUT SESSION CREATION STARTED =====');
    
    const {
      campaignName,
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
      destinationUrl,
      fileUrl,  // File URL from separate upload endpoint
      fileName  // File name from separate upload endpoint
    } = req.body;
    
    console.log('📝 Campaign data received:', {
      companyName,
      email,
      adFormat,
      weeklyBudget,
      cpmRate,
      expeditedApproval,
      clickTracking,
      destinationUrl,
      fileUrl: fileUrl ? `${fileUrl.substring(0, 50)}...` : 'MISSING',
      fileName: fileName || 'MISSING'
    });
    
    // Validate file URL is provided (from presigned upload)
    if (!fileUrl) {
      console.error('❌ No fileUrl provided - file must be uploaded via presigned URL first');
      return res.status(400).json({
        error: 'Missing file URL',
        message: 'File must be uploaded via presigned URL before creating checkout session'
      });
    }
    
    console.log('✅ File URL validated:', fileUrl);
    
    // Validate required fields
    if (!email || !campaignName || !companyName || !firstName || !lastName) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Campaign name, company name, email, first name, and last name are required'
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
    
    // Create payment_pending advertiser record in database (NO R2 upload yet)
    console.log('💾 Creating payment_pending advertiser record...');
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Get file URL from request body (file should be uploaded separately via /api/advertiser/upload-file)
    // This avoids Vercel's 4.5MB request body limit for serverless functions
    const mediaUrl = normalizeBareMediaR2Link(fileUrl) || null;
    const uploadedFileName = fileName || null;
    
    if (mediaUrl) {
      console.log('📁 Using pre-uploaded file URL:', mediaUrl);
      console.log('📁 File name:', uploadedFileName);
    } else {
      console.log('⚠️ No file URL provided - advertiser will need to upload file later');
    }
    
    // Calculate max_weekly_impressions based on CPM + weekly budget
    let max_weekly_impressions = null;
    const weeklyBudgetNum = weeklyBudget ? parseFloat(weeklyBudget) : null;
    const cpmRateNum = cpmRate ? parseFloat(cpmRate) : null;
    
    if (
      typeof weeklyBudgetNum === "number" &&
      weeklyBudgetNum > 0 &&
      typeof cpmRateNum === "number" &&
      cpmRateNum > 0
    ) {
      max_weekly_impressions = Math.floor((weeklyBudgetNum / cpmRateNum) * 1000);
      console.log(`📊 Calculated max_weekly_impressions: ${max_weekly_impressions} (budget: ${weeklyBudgetNum}, CPM: ${cpmRateNum})`);
    } else {
      console.log('⚠️ max_weekly_impressions set to NULL (invalid budget or CPM rate)');
    }
    
    const advertiserResult = await pool.query(
      `INSERT INTO advertisers (
        campaign_name, company_name, website_url, first_name, last_name, 
        email, title_role, ad_format, weekly_budget_cap, cpm_rate, 
        recurring_weekly, expedited, click_tracking, destination_url,
        media_r2_link, max_weekly_impressions, payment_completed, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, false, 'payment_pending', CURRENT_TIMESTAMP)
      RETURNING id, email, company_name`,
      [
        campaignName || null,
        companyName || null,
        websiteUrl || null,
        firstName || null,
        lastName || null,
        email,
        jobTitle || null,
        databaseAdFormat || null,
        weeklyBudgetNum,
        cpmRateNum,
        isRecurring === 'true' || isRecurring === true,
        expeditedApproval === 'true' || expeditedApproval === true,
        clickTracking === 'true' || clickTracking === true,
        destinationUrl || null,
        mediaUrl, // Store R2 URL immediately
        max_weekly_impressions
      ]
    );
    
    const advertiser = advertiserResult.rows[0];
    console.log('✅ Payment pending advertiser created:', { 
      id: advertiser.id, 
      email: advertiser.email,
      media_r2_link: mediaUrl,
      payment_completed: false
    });
    
    // Create or find advertiser_accounts row (canonical account per email)
    const normalizedEmail = (advertiser.email || '').toLowerCase().trim();
    console.log('💾 Creating/finding advertiser_accounts for email:', normalizedEmail);
    let accountId = null;
    try {
      const accountByEmail = await pool.query(`
        SELECT id, stripe_customer_id FROM advertiser_accounts
        WHERE LOWER(TRIM(email)) = $1
        LIMIT 1
      `, [normalizedEmail]);

      if (accountByEmail.rows.length > 0) {
        accountId = accountByEmail.rows[0].id;
        console.log('ℹ️ [CHECKOUT] Found existing advertiser_accounts id:', accountId);

        // Optionally link advertiser_id if account had none (for portal access)
        await pool.query(`
          UPDATE advertiser_accounts SET advertiser_id = $1
          WHERE id = $2 AND advertiser_id IS NULL
        `, [advertiser.id, accountId]);
      } else {
        const insertResult = await pool.query(`
          INSERT INTO advertiser_accounts (
            advertiser_id, email, password_hash,
            initial_setup_token, initial_setup_expires_at,
            password_reset_token, password_reset_expires_at
          ) VALUES ($1, $2, NULL, NULL, NULL, NULL, NULL)
          RETURNING id
        `, [advertiser.id, advertiser.email]);
        accountId = insertResult.rows[0].id;
        console.log('✅ [CHECKOUT] Created advertiser_accounts row id:', accountId);
      }
    } catch (accountError) {
      console.error('❌ [CHECKOUT] Failed to create/find advertiser_accounts:', accountError.message);
      return res.status(500).json({
        error: 'Account setup failed',
        message: 'Could not create or find advertiser account. Please try again.'
      });
    }

    // Get or create canonical Stripe customer (single customer per advertiser account)
    let canonicalCustomerId = null;
    const accountRow = await pool.query(
      'SELECT id, stripe_customer_id FROM advertiser_accounts WHERE id = $1',
      [accountId]
    );
    let existingStripeCustomerId = accountRow.rows[0]?.stripe_customer_id;

    if (existingStripeCustomerId) {
      try {
        await stripe.customers.retrieve(existingStripeCustomerId);
        canonicalCustomerId = existingStripeCustomerId;
        console.log('✅ [CHECKOUT] Using existing canonical Stripe customer:', canonicalCustomerId);
        // Persist to advertiser_accounts if we used fallback
        if (!accountRow.rows[0]?.stripe_customer_id) {
          await pool.query(
            'UPDATE advertiser_accounts SET stripe_customer_id = $1 WHERE id = $2',
            [canonicalCustomerId, accountId]
          );
          console.log('✅ [CHECKOUT] Backfilled advertiser_accounts.stripe_customer_id');
        }
      } catch (stripeErr) {
        if (stripeErr.code === 'resource_missing' || stripeErr.statusCode === 404) {
          console.warn('⚠️ [CHECKOUT] Stored customer id invalid in Stripe, creating new customer');
        } else {
          throw stripeErr;
        }
      }
    }

    if (!canonicalCustomerId) {
      console.log('👤 [CHECKOUT] Creating new canonical Stripe customer...');
      const customer = await stripe.customers.create({
        email: advertiser.email,
        name: `${firstName || ''} ${lastName || ''}`.trim() || companyName,
        metadata: {
          advertiserId: String(advertiser.id),
          companyName: companyName || '',
          campaignType: 'advertiser',
          accountId: String(accountId)
        }
      });
      canonicalCustomerId = customer.id;
      await pool.query(
        'UPDATE advertiser_accounts SET stripe_customer_id = $1 WHERE id = $2',
        [canonicalCustomerId, accountId]
      );
      console.log('✅ [CHECKOUT] Created and persisted canonical customer:', canonicalCustomerId);
    }

    // Create Stripe Checkout Session in setup mode (uses canonical customer - card attaches to same customer as Billing tab)
    // Setup mode collects and saves payment methods without creating subscriptions or charging
    console.log('🛒 Creating Stripe checkout session (setup mode)...');
    
    // Minimal metadata for setup session
    // Webhook handler will receive checkout.session.setup_completed event
    const sessionMetadata = {
      advertiserId: String(advertiser.id),
      campaignType: 'advertiser'
    };
    const recurringWeekly = isRecurring === 'true' || isRecurring === true;
    if (
      (expeditedApproval === 'true' || expeditedApproval === true) &&
      recurringWeekly
    ) {
      sessionMetadata.expedited = 'true';
    }
    
    console.log('📦 Session metadata prepared:', sessionMetadata);
    
    // Log Stripe mode for debugging
    const stripeKey = process.env.STRIPE_SECRET_KEY || '';
    const isTestMode = stripeKey.startsWith('sk_test_');
    const isLiveMode = stripeKey.startsWith('sk_live_');
    const stripeMode = isTestMode ? 'TEST' : (isLiveMode ? 'LIVE' : 'UNKNOWN');
    console.log('🔑 Stripe Configuration:', {
      mode: stripeMode,
      keyPrefix: stripeKey.substring(0, 7) + '...',
      keyLength: stripeKey.length
    });
    
    // Create checkout session in setup mode
    // This collects and saves a payment method to the canonical customer for future off-session invoicing
    const campaignTypeLabel = recurringWeekly ? 'Recurring Weekly Campaign' : 'One-Time Campaign';
    const descriptionParts = [campaignTypeLabel];
    if (weeklyBudgetNum) descriptionParts.push(`Budget Cap: $${weeklyBudgetNum.toFixed(2)}/wk`);
    if (cpmRateNum) descriptionParts.push(`CPM Rate: $${cpmRateNum.toFixed(2)}`);
    const sessionConfig = {
      customer: canonicalCustomerId,
      payment_method_types: ['card'],
      mode: 'setup', // Setup mode collects payment method without charging or creating subscription
      custom_text: {
        submit: { message: descriptionParts.join(' · ') }
      },
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser.html?payment_success=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser.html`,
      metadata: sessionMetadata
      // Note: No line_items, prices, or subscription_data needed for setup mode
    };
    
    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    console.log('✅ Checkout session created (setup mode):', session.id);
    console.log('🔗 [CHECKOUT] Using canonical customer:', canonicalCustomerId);
    
    console.log('🔍 ===== ADVERTISER CHECKOUT SESSION CREATION COMPLETED =====');
    
    res.json({
      sessionId: session.id,
      checkoutUrl: session.url,
      advertiserId: advertiser.id
      // Note: totalAmount removed - no charges at checkout time
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

// Get advertiser session details for success page
app.get('/api/advertiser/session-details', async (req, res) => {
  try {
    const { session_id } = req.query;
    
    if (!session_id) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    console.log('🔍 Fetching session details for:', session_id);
    
    // Retrieve session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);
    
    if (!session.metadata || session.metadata.campaignType !== 'advertiser') {
      return res.status(404).json({ error: 'Session not found or not an advertiser session' });
    }
    
    // Get advertiser details from database
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    const advertiserResult = await pool.query(
      'SELECT id, company_name, email, expedited, status, created_at FROM advertisers WHERE id = $1',
      [session.metadata.advertiserId]
    );
    
    if (advertiserResult.rows.length === 0) {
      return res.status(404).json({ error: 'Advertiser not found' });
    }
    
    const advertiser = advertiserResult.rows[0];
    
    res.json({
      sessionId: session.id,
      paymentStatus: session.payment_status,
      advertiser: {
        id: advertiser.id,
        companyName: advertiser.company_name,
        email: advertiser.email,
        expedited: advertiser.expedited,
        applicationStatus: advertiser.status,
        createdAt: advertiser.created_at
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching session details:', error);
    res.status(500).json({ error: 'Failed to fetch session details' });
  }
});

// ===== SUBSCRIPTION ROUTES =====

// Create subscription payment intent
app.post('/api/subscribe/create-payment-intent', authenticateToken, async (req, res) => {
  try {
    console.log('🚀 ===== SUBSCRIPTION CREATION STARTED =====');
    console.log('💳 Creating subscription for user:', req.user.userId);
    console.log('📧 User email:', req.user.email);
    console.log('👤 User username:', req.user.username);
    
    // Check if Stripe is properly initialized
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ error: 'Stripe configuration missing' });
    }

    if (!process.env.STRIPE_PRICE_ID) {
      console.error('❌ STRIPE_PRICE_ID environment variable is not set');
      return res.status(500).json({ error: 'Stripe price ID missing' });
    }

    console.log('🔧 Stripe secret key available:', !!process.env.STRIPE_SECRET_KEY);
    console.log('🔧 Stripe secret key starts with:', process.env.STRIPE_SECRET_KEY.substring(0, 7) + '...');
    console.log('🔧 Stripe price ID:', process.env.STRIPE_PRICE_ID);

    // Fix customer lookup to prevent duplicates
    let customer;
    let customerId = null;

    // Check if user already has a Stripe customer ID in database
    console.log('🔍 Checking for existing Stripe customer in database...');
    const [userErr, user] = await dbHelpers.getUserById(req.user.userId);
    if (userErr) {
      console.error('❌ Error fetching user:', userErr);
      return res.status(500).json({ error: 'Failed to fetch user data' });
    }

    console.log('👤 User data retrieved:', {
      id: user.id,
      email: user.email,
      username: user.username,
      stripe_customer_id: user.stripe_customer_id,
      stripe_subscription_id: user.stripe_subscription_id
    });

    // If user has stripe_customer_id, verify it exists in Stripe
    if (user.stripe_customer_id) {
      try {
        console.log('🔍 Verifying existing Stripe customer:', user.stripe_customer_id);
        customer = await stripe.customers.retrieve(user.stripe_customer_id);
        
        // Check if customer is not deleted and matches our user
        if (customer && !customer.deleted) {
        customerId = customer.id;
          console.log('✅ Using verified existing customer:', customerId);
        } else {
          console.log('⚠️ Existing customer was deleted in Stripe, creating new one');
          customerId = null;
        }
      } catch (error) {
        console.log('⚠️ Existing customer not found in Stripe, creating new one. Error:', error.message);
        customerId = null;
      }
    }

    // Create new customer only if none exists
    if (!customerId) {
      try {
        console.log('🔧 Creating new Stripe customer...');
        
        // First, search by email to avoid duplicates
        const existingCustomers = await stripe.customers.list({
          email: req.user.email,
          limit: 1
        });
        
        if (existingCustomers.data.length > 0) {
          // Use existing customer from Stripe search
          customer = existingCustomers.data[0];
          customerId = customer.id;
          console.log('✅ Found existing customer by email:', customerId);
          
          // Update database with the found customer ID
          const [updateErr] = await dbHelpers.updateStripeCustomerId(req.user.userId, customerId);
          if (updateErr) {
            console.error('❌ Failed to save customer ID to database:', updateErr);
          }
        } else {
          // Create brand new customer
        customer = await stripe.customers.create({
          email: req.user.email,
          name: req.user.username,
          metadata: {
            userId: req.user.userId,
            username: req.user.username
          }
        });
        customerId = customer.id;
        console.log('✅ Created new customer:', customerId);

        // Save customer ID to database
        const [updateErr] = await dbHelpers.updateStripeCustomerId(req.user.userId, customerId);
        if (updateErr) {
            console.error('❌ Failed to save customer ID to database:', updateErr);
          } else {
            console.log('✅ Customer ID saved to database');
          }
        }
      } catch (customerError) {
        console.error('❌ Customer creation failed:', customerError);
        return res.status(500).json({ error: 'Failed to create customer', details: customerError.message });
      }
    }

    // If user has a stale stripe_subscription_id, verify it's still active before creating a new one
    if (user.stripe_subscription_id) {
      try {
        const existingSub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
        if (['canceled', 'incomplete_expired', 'unpaid'].includes(existingSub.status)) {
          console.log(`ℹ️ [SUBSCRIBE] Existing subscription ${user.stripe_subscription_id} is ${existingSub.status} — clearing from DB`);
          await dbHelpers.updateStripeSubscriptionId(req.user.userId, null);
        } else if (existingSub.status === 'active' && !existingSub.cancel_at_period_end) {
          // Genuinely active — don't create a duplicate
          console.log(`ℹ️ [SUBSCRIBE] User already has active subscription ${user.stripe_subscription_id}, returning existing`);
          return res.status(400).json({ error: 'You already have an active subscription' });
        }
        // cancel_at_period_end=true means it's winding down — allow re-subscribe
      } catch (subErr) {
        console.log('⚠️ [SUBSCRIBE] Could not retrieve existing subscription, proceeding:', subErr.message);
      }
    }

    console.log('🔧 Creating Stripe subscription...');
    console.log('🔧 Customer ID:', customerId);
    console.log('🔧 Price ID:', process.env.STRIPE_PRICE_ID);

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        userId: req.user.userId,
        username: req.user.username
      }
    });

    console.log('✅ Subscription created successfully!');
    console.log('📋 Subscription ID:', subscription.id);
    console.log('📊 Subscription status:', subscription.status);
    console.log('🔐 Client secret:', subscription.latest_invoice.payment_intent.client_secret);
    console.log('💳 Payment intent ID:', subscription.latest_invoice.payment_intent.id);

    // Save subscription ID to database
    console.log('💾 Saving subscription ID to database...');
    const [subUpdateErr] = await dbHelpers.updateStripeSubscriptionId(req.user.userId, subscription.id);
    if (subUpdateErr) {
      console.error('❌ Failed to save subscription ID:', subUpdateErr);
    } else {
      console.log('✅ Subscription ID saved to database');
    }

    console.log('🚀 ===== SUBSCRIPTION CREATION COMPLETED =====');

    res.json({
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      subscriptionId: subscription.id,
      customerId: customerId
    });
  } catch (error) {
    console.error('❌ ===== SUBSCRIPTION CREATION FAILED =====');
    console.error('❌ Subscription creation failed:', error);
    console.error('❌ Error details:', error.message);
    console.error('❌ Error type:', error.type);
    console.error('❌ Error code:', error.code);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to create subscription',
      details: error.message,
      type: error.type,
      code: error.code
    });
  }
});

// Enhanced subscription status check with user ID verification
app.get('/api/subscribe/status', authenticateToken, async (req, res) => {
  try {
    console.log('🔍 ===== SUBSCRIPTION STATUS CHECK STARTED =====');
    const { subscriptionId } = req.query;
    
    console.log('🔍 Checking subscription status for ID:', subscriptionId);
    console.log('👤 User ID from auth token:', req.user.userId);
    console.log('📧 User email from auth token:', req.user.email);
    
    // 🔍 CRITICAL: Verify the user exists and get their actual database ID
    console.log('🔍 Verifying user existence in database...');
    const [userCheckErr, dbUser] = await dbHelpers.getUserById(req.user.userId);
    if (userCheckErr) {
      console.error('❌ Error fetching user from database:', userCheckErr);
      return res.status(500).json({ error: 'Failed to fetch user data' });
    }
    
    if (!dbUser) {
      console.error('❌ User not found in database with ID:', req.user.userId);
      return res.status(404).json({ error: 'User not found' });
    }
    
    console.log('🔍 Database user found:', {
      dbId: dbUser.id,
      authUserId: req.user.userId,
      email: dbUser.email,
      stripe_customer_id: dbUser.stripe_customer_id,
      stripe_subscription_id: dbUser.stripe_subscription_id,
      is_premium: dbUser.is_premium
    });
    
    // Check if user IDs match
    if (dbUser.id !== req.user.userId) {
      console.error('❌ USER ID MISMATCH DETECTED!');
      console.error('❌ Database ID:', dbUser.id);
      console.error('❌ Auth token ID:', req.user.userId);
      console.error('❌ This explains why premium status is not updating!');
    }
    
    if (!subscriptionId) {
      console.error('❌ Subscription ID is required');
      return res.status(400).json({ error: 'Subscription ID is required' });
    }

    // Retrieve subscription from Stripe
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    console.log('📊 Subscription status:', subscription.status);

    const isActive = subscription.status === 'active' || subscription.status === 'trialing';
    console.log('✅ Is subscription active?', isActive);

    if (isActive) {
      console.log('🎉 Subscription is active! Updating user premium status...');

      // 🔧 USE THE DATABASE ID, NOT THE AUTH TOKEN ID
      const actualUserId = dbUser.id; // Use the verified database ID
      console.log('🔧 Using database user ID for premium update:', actualUserId);

    // Update user's premium status in database
      const [updateErr, updatedUser] = await dbHelpers.updatePremiumStatus(actualUserId, true);
    if (updateErr) {
      console.error('❌ Failed to update premium status:', updateErr);
        // Don't fail the request, just log the error
      } else if (updatedUser) {
        console.log('✅ Premium status updated successfully');
        console.log('✅ Updated user:', {
          id: updatedUser.id,
          email: updatedUser.email,
          is_premium: updatedUser.is_premium,
          premium_since: updatedUser.premium_since
        });

        // Donation accounting — idempotent via RETURNING on ledger insert
        // ON CONFLICT DO NOTHING on donation_ledger prevents double-writes;
        // weekly_donation_pool is only updated if the ledger row was actually new
        try {
          const pool = getPool();
          if (pool) {
            const latestInvoiceId = typeof subscription.latest_invoice === 'string'
              ? subscription.latest_invoice
              : subscription.latest_invoice?.id || subscriptionId;
            const weekStart = _adminThisMonday();
            const ledgerResult = await pool.query(
              `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
               VALUES ('subscription', $1, $2, $3, $4)
               ON CONFLICT (source_id, week_start) DO NOTHING
               RETURNING id`,
              [latestInvoiceId, subscriptionId, 1.00, weekStart]
            );
            if (ledgerResult.rows.length > 0) {
              await pool.query(
                `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total, viewer_total)
                 VALUES ($1, 0, 0, $2)
                 ON CONFLICT (week_start) DO UPDATE
                 SET viewer_total = weekly_donation_pool.viewer_total + EXCLUDED.viewer_total,
                     updated_at = NOW()`,
                [weekStart, 1.00]
              );
              console.log('✅ [SUBSCRIBE/STATUS] Donation ledger and pool updated, week_start:', weekStart, 'invoice:', latestInvoiceId);
            } else {
              console.log('ℹ️ [SUBSCRIBE/STATUS] Invoice already recorded in ledger — pool not double-counted');
            }
          }
        } catch (ledgerErr) {
          console.error('❌ [SUBSCRIBE/STATUS] Donation ledger error:', ledgerErr.message);
        }

        // Send confirmation email
        console.log('📧 Sending subscription confirmation email...');
        console.log('📧 Email service state:', {
          isConfigured: emailService.isConfigured,
          hasTransporter: !!emailService.transporter,
          emailUser: process.env.EMAIL_USER
        });

        if (emailService && emailService.isEmailConfigured()) {
          try {
            console.log('📧 Calling sendSubscriptionConfirmationEmail...');
            const emailResult = await emailService.sendSubscriptionConfirmationEmail(
              req.user.email, 
              req.user.username || req.user.email.split('@')[0]
            );
            
            console.log('📧 Email result:', emailResult);
            
            if (emailResult.success) {
              console.log('✅ Subscription confirmation email sent successfully');
            } else {
              console.error('❌ Failed to send subscription confirmation email:', emailResult);
            }
          } catch (emailError) {
            console.error('❌ Error sending subscription confirmation email:', emailError);
          }
        } else {
          console.log('❌ Email service not available:', {
            serviceExists: !!emailService,
            isConfigured: emailService ? emailService.isEmailConfigured() : 'no service'
          });
        }
      } else {
        console.error('❌ Premium status update returned no user - this indicates the UPDATE failed');
      }
    }

    console.log('🔍 ===== SUBSCRIPTION STATUS CHECK COMPLETED =====');

    res.json({ 
      isPremium: isActive,
      status: subscription.status,
      subscriptionId: subscription.id,
      customerId: subscription.customer
    });
  } catch (error) {
    console.error('❌ ===== SUBSCRIPTION STATUS CHECK FAILED =====');
    console.error('❌ Error details:', error.message);
    res.status(500).json({ 
      error: 'Failed to check subscription status',
      details: error.message
    });
  }
});

// ===== MANUAL WEBHOOK TRIGGER FOR TESTING =====
// This endpoint manually triggers the advertiser subscription webhook for testing
app.post('/trigger-advertiser-webhook', async (req, res) => {
  console.log('🧪 ===== MANUAL WEBHOOK TRIGGER FOR ADVERTISER EMAIL =====');
  
  try {
    const { advertiserId } = req.body;
    
    if (!advertiserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'advertiserId is required' 
      });
    }
    
    console.log('📝 Looking up advertiser ID:', advertiserId);
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ 
        success: false, 
        error: 'Database pool not available' 
      });
    }
    
    const advertiserResult = await pool.query(
      'SELECT * FROM advertisers WHERE id = $1',
      [advertiserId]
    );
    
    if (advertiserResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Advertiser not found' 
      });
    }
    
    const advertiser = advertiserResult.rows[0];
    console.log('📝 Found advertiser:', { id: advertiser.id, email: advertiser.email, status: advertiser.status });
    
    // Build campaign summary
    const campaignSummary = {
      ad_format: advertiser.ad_format,
      cpm_rate: advertiser.cpm_rate,
      weekly_budget_cap: advertiser.weekly_budget_cap,
      expedited: advertiser.expedited,
      click_tracking: advertiser.click_tracking
    };
    
    console.log('📧 Campaign summary:', campaignSummary);
    
    // Send email
    if (emailService && emailService.isEmailConfigured()) {
      console.log('🔍 DEBUG: About to check email service...');
      console.log('🔍 DEBUG: emailService exists:', !!emailService);
      console.log('🔍 DEBUG: emailService.isEmailConfigured:', emailService ? emailService.isEmailConfigured() : 'N/A');
      
      console.log('🔍 DEBUG: Email service is configured, proceeding to send email');
      console.log('🔍 DEBUG: Reached email sending point in manual trigger');
      console.log('📧 Sending advertiser confirmation email to:', advertiser.email);
      console.log('📧 Campaign summary data:', JSON.stringify(campaignSummary, null, 2));
      
      // Generate portal signup token for submission email
      const portalSignupToken = crypto.randomUUID();
      console.log('🔑 [PORTAL SIGNUP] Generated token for advertiser submission (manual):', portalSignupToken.substring(0, 8) + '...');
      
      const emailResult = await emailService.sendAdvertiserConfirmationEmail(
        advertiser.email,
        advertiser.company_name,
        campaignSummary,
        portalSignupToken
      );
      
      if (emailResult.success) {
        console.log('✅ Advertiser confirmation email sent successfully');
        console.log('📧 Email message ID:', emailResult.messageId);
      } else {
        console.error('❌ Failed to send confirmation email:', emailResult);
      }
      
      res.json({ 
        success: emailResult.success, 
        result: emailResult,
        advertiser: {
          id: advertiser.id,
          email: advertiser.email,
          status: advertiser.status
        }
      });
    } else {
      console.warn('⚠️ Email service NOT configured');
      res.json({ 
        success: false, 
        error: 'Email service not configured',
        debug: {
          emailServiceExists: !!emailService,
          isConfigured: emailService ? emailService.isEmailConfigured() : false,
          hasTransporter: emailService ? !!emailService.transporter : false
        }
      });
    }
  } catch (error) {
    console.error('❌ Manual webhook trigger error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack 
    });
  }
});

// ===== TEST ENDPOINT FOR ADVERTISER EMAIL =====
// This endpoint allows manual testing of the advertiser confirmation email
app.post('/test-advertiser-email', async (req, res) => {
  console.log('🧪 ===== TEST ADVERTISER EMAIL ENDPOINT CALLED =====');
  console.log('🧪 Request body:', req.body);
  
  try {
    const { email, companyName } = req.body;
    
    if (!email || !companyName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and companyName are required' 
      });
    }
    
    // Check if email service is available
    console.log('🔍 DEBUG: Testing email service availability...');
    console.log('🔍 DEBUG: emailService exists:', !!emailService);
    
    if (!emailService) {
      console.error('❌ Email service not loaded');
      return res.status(500).json({ 
        success: false, 
        error: 'Email service not loaded - check server startup logs' 
      });
    }
    
    console.log('🔍 DEBUG: emailService.isEmailConfigured:', emailService.isEmailConfigured());
    console.log('🔍 DEBUG: emailService.transporter:', !!emailService.transporter);
    
    if (!emailService.isEmailConfigured()) {
      console.error('❌ Email service not properly configured');
      return res.status(500).json({ 
        success: false, 
        error: 'Email service not configured - check your .env file for EMAIL_* variables' 
      });
    }
    
    // Build test campaign summary
    const campaignSummary = {
      ad_format: 'video',
      cpm_rate: 15.00,
      weekly_budget_cap: 1000,
      expedited: true,
      click_tracking: true
    };
    
    console.log('📧 Attempting to send test email...');
    console.log('📧 To:', email);
    console.log('📧 Company Name:', companyName);
    console.log('📧 Campaign Summary:', campaignSummary);
    
    // For test emails, generate a test token (won't be saved to DB)
    const testToken = crypto.randomUUID();
    console.log('🔑 [PORTAL SIGNUP] Generated test token:', testToken.substring(0, 8) + '...');
    
    const result = await emailService.sendAdvertiserConfirmationEmail(
      email, 
      companyName, 
      campaignSummary,
      testToken
    );
    
    console.log('📧 Email send result:', result);
    
    if (result.success) {
      console.log('✅ Test email sent successfully!');
      console.log('📧 Message ID:', result.messageId);
    } else {
      console.error('❌ Test email failed:', result);
    }
    
    res.json({ 
      success: result.success, 
      result: result,
      debug: {
        emailServiceAvailable: !!emailService,
        emailServiceConfigured: emailService.isEmailConfigured(),
        hasTransporter: !!emailService.transporter
      }
    });
    
  } catch (error) {
    console.error('❌ Test email error:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack 
    });
  }
});

// Cancel user premium subscription
app.post('/api/subscribe/cancel', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const userResult = await pool.query(
      'SELECT id, stripe_subscription_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const { stripe_subscription_id } = userResult.rows[0];
    if (!stripe_subscription_id) return res.status(400).json({ error: 'No active subscription found' });

    // Cancel at period end so user keeps premium until billing cycle ends
    const updatedSub = await stripe.subscriptions.update(stripe_subscription_id, { cancel_at_period_end: true });

    const cancelAt = updatedSub.current_period_end
      ? new Date(updatedSub.current_period_end * 1000)
      : null;

    await pool.query(
      'UPDATE users SET subscription_cancel_at = $1 WHERE id = $2',
      [cancelAt, req.user.userId]
    );

    console.log(`✅ [SUBSCRIBE/CANCEL] Subscription ${stripe_subscription_id} set to cancel at period end for user ${req.user.userId}, ends ${cancelAt}`);
    res.json({ success: true, message: 'Subscription will be cancelled at the end of the current billing period', cancelAt });
  } catch (error) {
    console.error('❌ [SUBSCRIBE/CANCEL] Error:', error.message);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Stripe webhook endpoint - legacy copy retained below for reference only
// Legacy webhook handler removed; see top-level definition near top of file.
// Webhook status endpoint to assist with configuration
app.get('/api/webhook-status', (req, res) => {
  try {
    const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhook`;
    
    // Full list of required webhook events for billing invariant enforcement
    const requiredEvents = [
      'checkout.session.completed',      // For advertiser setup mode (sets default payment method)
      'setup_intent.succeeded',          // For "Add new card" flow (auto-sets default if none exists)
      'customer.subscription.created',   // For legacy subscription-based onboarding
      'invoice.payment_succeeded'        // For payment confirmation
    ];
    
    res.json({
      webhookUrl: webhookUrl,
      status: 'active',
      environment: process.env.NODE_ENV,
      requiredEvents: requiredEvents,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ? 'SET' : 'MISSING',
      stripeApiKeyMode: process.env.STRIPE_SECRET_KEY ? 
        (process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'TEST' : 
         process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'UNKNOWN') : 'MISSING',
      instructions: [
        '1. Go to Stripe Dashboard → Developers → Webhooks',
        '2. Add endpoint: ' + webhookUrl,
        '3. Enable events: ' + requiredEvents.join(', '),
        '4. Copy webhook secret and set as STRIPE_WEBHOOK_SECRET',
        '5. Ensure webhook secret matches your Stripe API key environment (test vs live)',
        '6. For local dev, use Stripe CLI: stripe listen --forward-to localhost:3001/api/webhook'
      ],
      criticalNote: 'setup_intent.succeeded is REQUIRED for billing invariant enforcement. Without it, default payment methods will not be set automatically when users add new cards.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate webhook status', details: err.message });
  }
});

// Donation checkout session endpoint
app.post('/api/donate/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    console.log('💰 Donation checkout session requested for user:', req.user.email);
    const { amount = 300 } = req.body || {};
    
    // Basic validation
    if (typeof amount !== 'number' || isNaN(amount) || amount < 100) {
      return res.status(400).json({ error: 'Minimum donation amount is $1.00' });
    }
    
    // Get database pool
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Create donation record in database BEFORE payment (same pattern as advertiser)
    // amount column stores whole dollars; webhook overwrites from Stripe amount_total
    const amountDollarsPlaceholder = Math.round(Number(amount) / 100);
    console.log('💾 Creating donation record in database...');
    const donationResult = await pool.query(
      `INSERT INTO donations (user_id, amount, customer_email, status, stripe_session_id)
       VALUES ($1, $2, $3, 'pending', NULL)
       RETURNING id`,
      [req.user.userId, amountDollarsPlaceholder, req.user.email]
    );
    
    const donationId = donationResult.rows[0].id;
    console.log('✅ Donation record created:', { 
      donationId: donationId, 
      userId: req.user.userId,
      email: req.user.email,
      amount: amount,
      status: 'pending'
    });
    
    // Create Stripe checkout session with donationId in metadata
    // 🚨 REVERTED: Using payment mode (one-time) since price is one-time type
    const sessionMetadata = {
      donationType: 'direct_donation',
      amount: String(amount),
      userId: String(req.user.userId),
      userEmail: req.user.email, // Store email in metadata as backup
      donationId: String(donationId) // Store donation ID for webhook lookup
    };
    
    console.log('📦 Session metadata prepared:', sessionMetadata);
    console.log('💰 Using payment mode (one-time donation)');
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: 'price_1SNmrt0CutcpJ738Sh6lSLeZ', // One-time price
          quantity: 1,
        },
      ],
      mode: 'payment', // 🚨 REVERTED: Payment mode for one-time donations
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/?donation_success=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/`,
      metadata: sessionMetadata // Metadata at session level for webhook lookup
    });
    
    // Update donation record with session ID
    await pool.query(
      'UPDATE donations SET stripe_session_id = $1 WHERE id = $2',
      [session.id, donationId]
    );
    
    console.log('✅ Donation checkout session created:', session.id);
    console.log('💾 Donation record updated with session ID:', session.id);
    console.log('🔍 Session metadata stored:', {
      donationId: sessionMetadata.donationId,
      userId: sessionMetadata.userId,
      donationType: sessionMetadata.donationType,
      amount: sessionMetadata.amount
    });
    res.json({ url: session.url });
    
  } catch (error) {
    console.error('❌ Donation session creation failed:', error);
    res.status(500).json({ error: 'Failed to create donation session' });
  }
});

// Test endpoint for donation email (for debugging)
app.post('/api/test/donation-email', authenticateToken, async (req, res) => {
  try {
    console.log('🧪 ===== TEST DONATION EMAIL ENDPOINT =====');
    console.log('🧪 Requested by user:', req.user.email);
    
    const testEmail = 'brandengreene03@gmail.com';
    const testUsername = req.user.username || 'branden';
    const testAmount = 300; // $3.00 in cents
    
    // Check email service
    if (!emailService) {
      console.error('❌ Email service not loaded');
      return res.status(500).json({ 
        success: false, 
        error: 'Email service not loaded',
        details: 'emailService is null'
      });
    }
    
    if (!emailService.isEmailConfigured()) {
      console.error('❌ Email service not configured');
      return res.status(500).json({ 
        success: false, 
        error: 'Email service not configured',
        details: 'Check EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS environment variables'
      });
    }
    
    if (!emailService.transporter) {
      console.error('❌ Email transporter not initialized');
      return res.status(500).json({ 
        success: false, 
        error: 'Email transporter not initialized',
        details: 'Transporter creation failed'
      });
    }
    
    // Verify transporter
    console.log('🔍 Verifying email transporter connection...');
    try {
      await emailService.transporter.verify();
      console.log('✅ Email transporter verified');
    } catch (verifyError) {
      console.error('❌ Email transporter verification failed:', verifyError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Email transporter verification failed',
        details: verifyError.message
      });
    }
    
    // Send test email
    console.log('📧 Sending test donation thank you email...');
    console.log('  To:', testEmail);
    console.log('  Username:', testUsername);
    console.log('  Amount:', testAmount);
    
    const result = await emailService.sendDonationThankYouEmail(
      testEmail,
      testUsername,
      testAmount
    );
    
    if (result.success) {
      console.log('✅ Test email sent successfully!');
      console.log('📧 Message ID:', result.messageId);
      return res.json({
        success: true,
        message: 'Test email sent successfully',
        messageId: result.messageId,
        recipient: testEmail
      });
    } else {
      console.error('❌ Test email failed:', result.error);
      return res.status(500).json({
        success: false,
        error: 'Failed to send test email',
        details: result.error
      });
    }
    
  } catch (error) {
    console.error('❌ Test email endpoint error:', error);
    return res.status(500).json({
      success: false,
      error: 'Test email endpoint failed',
      details: error.message,
      stack: error.stack
    });
  }
});

// ============================================================
// ADMIN PORTAL — /admin-cs
// ============================================================

// In-memory rate limiter for admin login (5 attempts per 15 min)
const _adminLoginAttempts = new Map();
function _checkAdminRateLimit(ip) {
  const now = Date.now();
  const LOCKOUT_MS = 15 * 60 * 1000;
  const MAX = 5;
  const entry = _adminLoginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    _adminLoginAttempts.set(ip, { count: 1, resetAt: now + LOCKOUT_MS });
    return { allowed: true };
  }
  if (entry.count >= MAX) {
    return { allowed: false, remainingMs: entry.resetAt - now };
  }
  entry.count++;
  return { allowed: true };
}

function requireAdminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    if (decoded.jwt_type !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function runAdminScript(scriptName, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scripts', scriptName);
    const cmd = `node "${scriptPath}" ${args.join(' ')}`;
    exec(cmd, { env: process.env, maxBuffer: 5 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      console.log(`\n📋 [ADMIN SCRIPT: ${scriptName}] output:\n${output}`);
      if (err) reject(new Error(output || err.message));
      else resolve(output);
    });
  });
}

// Serve admin page
app.get('/admin-cs', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin-cs.html'));
});

// Admin login
app.post('/admin-cs/login', async (req, res) => {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  const { username, password } = req.body || {};
  const check = _checkAdminRateLimit(ip);
  if (!check.allowed) {
    const mins = Math.ceil(check.remainingMs / 60000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${mins} minute(s).` });
  }
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;
  if (!adminUsername || !adminHash) return res.status(500).json({ error: 'Admin credentials not configured' });
  if (!username || !password || username !== adminUsername) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, adminHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  _adminLoginAttempts.delete(ip);
  const token = jwt.sign({ jwt_type: 'admin', username }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// List pending advertisers
app.get('/api/admin/advertisers', requireAdminAuth, async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT id, company_name, expedited, website_url, media_r2_link, click_tracking, destination_url, cpm_rate, weekly_budget_cap
      FROM advertisers
      WHERE status = 'pending_review' AND media_r2_link IS NOT NULL
      ORDER BY created_at ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List pending sponsor campaigns — generates a 1-hour presigned URL for each logo
app.get('/api/admin/sponsors', requireAdminAuth, async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT sc.id, sc.logo_r2_key, sa.organization_legal_name, sa.website, sa.ein_tax_id
      FROM sponsor_campaigns sc
      JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
      WHERE sc.status = 'pending_approval'
      ORDER BY sc.created_at ASC
    `);
    const result = await Promise.all(rows.map(async (row) => {
      let logo_url = null;
      if (row.logo_r2_key) {
        try {
          logo_url = await getSignedUrl(r2Client, new GetObjectCommand({
            Bucket: 'charity-stream-sponsor-uploads',
            Key: row.logo_r2_key
          }), { expiresIn: 3600 });
        } catch (_) { /* non-fatal */ }
      }
      return Object.assign({}, row, { logo_url });
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helpers: next Monday and this Monday (current billing week start) as YYYY-MM-DD in LA time
function _adminNextMonday() {
  const now = new Date();
  const la = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const [y, m, d] = la.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const add = dow === 0 ? 1 : 8 - dow;
  const nm = new Date(Date.UTC(y, m - 1, d + add));
  return `${nm.getUTCFullYear()}-${String(nm.getUTCMonth()+1).padStart(2,'0')}-${String(nm.getUTCDate()).padStart(2,'0')}`;
}
function _adminThisMonday() {
  const now = new Date();
  const la = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const [y, m, d] = la.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const sub = dow === 0 ? 6 : dow - 1;
  const tm = new Date(Date.UTC(y, m - 1, d - sub));
  return `${tm.getUTCFullYear()}-${String(tm.getUTCMonth()+1).padStart(2,'0')}-${String(tm.getUTCDate()).padStart(2,'0')}`;
}

// List pending charity applications — only from the current billing week
app.get('/api/admin/charities', requireAdminAuth, async (req, res) => {
  try {
    const pool = getPool();
    const thisMonday = _adminThisMonday();
    const { rows } = await pool.query(`
      SELECT id, charity_name, federal_ein, contact_email
      FROM charity_applications
      WHERE reviewed_at IS NULL
        AND status = 'pending'
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date >= $1::date
      ORDER BY created_at ASC
    `, [thisMonday]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List charities eligible for winner selection (in charity_week_pool for next Monday)
// Also returns whether a winner is already chosen for that week
app.get('/api/admin/charities/winner-eligible', requireAdminAuth, async (req, res) => {
  try {
    const pool = getPool();
    const nextWeekStart = _adminNextMonday();

    const [eligible, existing] = await Promise.all([
      pool.query(`
        SELECT ca.id, ca.charity_name, ca.federal_ein, ca.contact_email
        FROM charity_week_pool cwp
        JOIN charity_applications ca ON ca.id = cwp.charity_application_id
        WHERE cwp.week_start = $1::date
          AND ca.status = 'approved'
        ORDER BY ca.charity_name ASC
      `, [nextWeekStart]),
      pool.query(
        `SELECT charity_application_id FROM charity_week_winner WHERE week_start = $1::date LIMIT 1`,
        [nextWeekStart]
      )
    ]);

    res.json({
      nextWeekStart,
      winnerId: existing.rows.length ? existing.rows[0].charity_application_id : null,
      charities: eligible.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Select charity as winner for next Monday's week
app.post('/api/admin/charities/:id/select-winner', requireAdminAuth, async (req, res) => {
  try {
    const pool = getPool();
    const nextWeekStart = _adminNextMonday();
    // Guard: winner already selected
    const existing = await pool.query(
      'SELECT 1 FROM charity_week_winner WHERE week_start = $1::date LIMIT 1',
      [nextWeekStart]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: `Winner for ${nextWeekStart} is already selected.` });
    }
    const output = await runAdminScript(
      'select-winner.js',
      [`--charity-id=${req.params.id}`, `--week-start=${nextWeekStart}`],
      2 * 60 * 1000
    );
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve advertiser (routes to expedited or standard script based on flag)
app.post('/api/admin/advertisers/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const pool = getPool();
    const { rows } = await pool.query('SELECT expedited FROM advertisers WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const script = rows[0].expedited ? 'process-expedited-advertisers.js' : 'process-approved-advertisers.js';
    const output = await runAdminScript(script, [`--id=${id}`], 5 * 60 * 1000);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reject advertiser
app.post('/api/admin/advertisers/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const output = await runAdminScript('process-advertiser-rejections.js', [`--id=${id}`], 2 * 60 * 1000);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve sponsor (generates video via FFmpeg — may take several minutes)
app.post('/api/admin/sponsors/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const output = await runAdminScript('generate-sponsor-videos-ffmpeg.js', ['--id', req.params.id], 15 * 60 * 1000);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reject sponsor
app.post('/api/admin/sponsors/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const output = await runAdminScript('process-sponsor-rejections.js', ['--id', req.params.id], 2 * 60 * 1000);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve charity application
app.post('/api/admin/charities/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const output = await runAdminScript('process-charity-approvals.js', [`--id=${req.params.id}`], 2 * 60 * 1000);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reject charity application
app.post('/api/admin/charities/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const output = await runAdminScript('process-charity-rejections.js', [`--id=${req.params.id}`], 2 * 60 * 1000);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// LIVE VIEWER COUNT — in-memory presence, no DB
// ============================================================
const _viewerSessions = new Map(); // sessionId -> lastSeen ms
const VIEWER_TTL_MS = 45000; // consider gone after 45s of no heartbeat

setInterval(function () {
  const cutoff = Date.now() - VIEWER_TTL_MS;
  for (const [id, ts] of _viewerSessions) {
    if (ts < cutoff) _viewerSessions.delete(id);
  }
}, 30000);

// Heartbeat — called by client every 20s while watching
app.post('/api/viewers/heartbeat', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId && typeof sessionId === 'string' && sessionId.length < 64) {
    _viewerSessions.set(sessionId, Date.now());
  }
  res.json({ viewers: _viewerSessions.size });
});

// Leave — called via sendBeacon when tab closes; drops viewer immediately
app.post('/api/viewers/leave', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId && typeof sessionId === 'string') {
    _viewerSessions.delete(sessionId);
  }
  res.status(204).end();
});

// Count — polled by client to refresh display
app.get('/api/viewers/count', (req, res) => {
  res.json({ viewers: _viewerSessions.size });
});

// SPA fallback - serve index.html for any unknown non-API routes
app.get('*', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    return next(); // Let API routes return 404
  }
  
  // Skip routes we've explicitly handled
  const handledRoutes = ['/', '/about', '/advertise', '/impact', '/auth', '/auth.html', '/advertiser', '/charity', '/subscribe', '/admin-cs'];
  if (handledRoutes.includes(req.path)) {
    return next();
  }
  
  // Skip static file extensions (let express.static handle them)
  const staticExtensions = ['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.pdf'];
  if (staticExtensions.some(ext => req.path.toLowerCase().endsWith(ext))) {
    return next();
  }
  
  console.log(`📄 SPA fallback: serving index.html for ${req.path}`);
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Initialize database for all environments (required for Vercel serverless)
initializeDatabase();

// Export the Express app for serverless environments (e.g., Vercel)
module.exports = app;

// Export weekly reset function for Vercel cron and test scripts
module.exports.performWeeklyReset = performWeeklyReset;
module.exports.runWeeklyRecurringBilling = runWeeklyRecurringBilling;
module.exports.runNonRecurringBilling = runNonRecurringBilling;

// Local development server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} (local development)`);
  });
}
