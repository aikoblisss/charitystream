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
const { S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

// Load environment variables from parent directory
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { initializeDatabase, dbHelpers, getPool: getPoolFromDb } = require('./database-postgres');
// Google OAuth - Enabled for production
const passportConfig = require('./config/google-oauth');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// IMPROVED pool configuration with better error handling and increased timeouts
const createPool = () => {
  const newPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20, // Increase max connections
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 30000, // 🚨 INCREASED: 30 seconds (was 10s) for Vercel/serverless cold starts
    maxUses: 7500, // Close and replace a connection after 7500 uses
    // Additional timeout settings for query execution
    query_timeout: 30000, // 30 seconds query timeout
    statement_timeout: 30000, // 30 seconds statement timeout
    // SSL settings for secure connections
    ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? {
      rejectUnauthorized: false
    } : undefined
  });

  // ADD comprehensive error handling for the pool
  newPool.on('error', (err, client) => {
    console.error('❌ Database pool error:', err);
    console.error('❌ Error message:', err.message);
    console.error('❌ Error code:', err.code);
    // Don't crash the server on pool errors
  });

  newPool.on('connect', (client) => {
    console.log('🔌 New database connection established');
  });

  newPool.on('remove', (client) => {
    console.log('🔌 Database connection removed');
  });

  return newPool;
};

let managedPool = null;

// ADD pool health check and recovery with retry logic
const checkPoolHealth = async () => {
  try {
    const pool = getPool();
    if (!pool) {
      console.error('❌ Pool is null, recreating...');
      managedPool = createPool();
      return false;
    }
    
    // Add timeout to health check
    const healthCheckPromise = pool.connect();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Health check timeout')), 10000)
    );
    
    const client = await Promise.race([healthCheckPromise, timeoutPromise]);
    await client.query('SELECT 1');
    client.release();
    console.log('✅ Database pool health check passed');
    return true;
  } catch (error) {
    console.error('❌ Database pool health check failed:', error.message);
    console.error('❌ Error code:', error.code);
    
    // Try to recreate the pool if it's unhealthy
    try {
      if (managedPool) {
        await managedPool.end();
      }
      managedPool = createPool();
      console.log('🔄 Database pool recreated');
    } catch (recreateError) {
      console.error('❌ Failed to recreate database pool:', recreateError);
    }
    
    return false;
  }
};

// Run health check every 30 seconds
setInterval(checkPoolHealth, 30000);

// MODIFY getPool function to handle connection issues
function getPool() {
  // Try managed pool first
  if (managedPool) {
    return managedPool;
  }
  
  // Fall back to database-postgres pool
  const dbPool = getPoolFromDb();
  if (dbPool) {
    return dbPool;
  }
  
  // Last resort: create new pool
  console.log('🔄 Creating new database pool...');
  managedPool = createPool();
  return managedPool;
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
  console.log('📦 Headers:', req.headers);
  const bodyLength = Buffer.isBuffer(req.body) ? req.body.length : (req.body ? req.body.length || 'unknown' : 'no body');
  console.log('📦 Body length:', bodyLength);
  console.log('📦 Body type:', Buffer.isBuffer(req.body) ? 'Buffer' : typeof req.body);

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

const processStripeEvent = async (event) => {
  console.log('ðŸ”” ===== STRIPE WEBHOOK PROCESSING =====');
  console.log('ðŸŒ Event type:', event.type);
  console.log('ðŸ”” Event ID:', event.id);
  console.log('ðŸ“¦ Full event object keys:', Object.keys(event.data?.object || {}));

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('ðŸŽ¯ CHECKOUT.SESSION.COMPLETED DETECTED');
    console.log('ðŸŽ¯ Is donation?', session.metadata?.donationType === 'direct_donation');
    console.log('ðŸŽ¯ Session mode:', session.mode);
    console.log('ðŸŽ¯ Has donation metadata?', !!session.metadata?.donationType);
  }

  switch (event.type) {
    case 'customer.subscription.created': {
      const subscription = event.data.object;
      console.log('âœ… ===== SUBSCRIPTION CREATED =====');
      console.log('ðŸ“‹ Subscription ID:', subscription.id);
      console.log('ðŸ‘¤ Customer ID:', subscription.customer);
      console.log('ðŸ·ï¸ Metadata:', subscription.metadata);
      console.log('ðŸ” DEBUG: Full subscription object:', JSON.stringify(subscription, null, 2));

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
            'SELECT id, email, company_name, payment_completed, application_status, stripe_customer_id FROM advertisers WHERE id = $1',
            [advertiserId]
          );

          if (advertiserResult.rows.length === 0) {
            throw new WebhookProcessingError('Advertiser not found', 404);
          }

          const advertiser = advertiserResult.rows[0];

          await pool.query(
            `UPDATE advertisers
             SET payment_completed = TRUE,
                 application_status = 'pending_approval',
                 stripe_customer_id = $1,
                 stripe_subscription_id = $2,
                 updated_at = NOW()
             WHERE id = $3`,
            [subscription.customer, subscription.id, advertiserId]
          );

          console.log('✅ Advertiser payment marked as complete for advertiser ID:', advertiserId);

          if (emailService && emailService.isEmailConfigured()) {
            console.log('📧 ===== WEBHOOK: PREPARING TO SEND EMAIL =====');
            console.log('📧 [WEBHOOK] Advertiser email:', advertiser.email);
            console.log('📧 [WEBHOOK] Company name:', advertiser.company_name);
            console.log('📧 [WEBHOOK] Email service configured:', emailService.isEmailConfigured());

            // Generate portal signup token for submission email
            const portalSignupToken = crypto.randomUUID();
            console.log('🔑 [PORTAL SIGNUP] Generated token for advertiser submission:', portalSignupToken.substring(0, 8) + '...');
            
            // Save token to database
            const pool = getPool();
            if (pool) {
              try {
                await pool.query(`
                  UPDATE advertisers
                  SET portal_signup_token = $1,
                      portal_signup_token_created_at = NOW()
                  WHERE id = $2
                `, [portalSignupToken, advertiserId]);
                console.log('✅ [PORTAL SIGNUP] Token saved to database for advertiser:', advertiserId);
              } catch (tokenError) {
                console.error('❌ [PORTAL SIGNUP] Failed to save token:', tokenError.message);
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
            
            console.log('📧 [WEBHOOK] Campaign summary prepared:', JSON.stringify(campaignSummary, null, 2));
            console.log('📧 [WEBHOOK] About to call sendAdvertiserConfirmationEmail...');

            const emailResult = await emailService.sendAdvertiserConfirmationEmail(
              advertiser.email,
              advertiser.company_name,
              campaignSummary,
              portalSignupToken
            );
            
            console.log('📧 [WEBHOOK] Email send result:', JSON.stringify(emailResult, null, 2));

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

      const isDonation = sessionCompleted.metadata?.donationType === 'direct_donation';

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

              await pool.query(
                `UPDATE donations
                 SET status = 'completed',
                     stripe_payment_intent_id = $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [sessionCompleted.payment_intent || sessionCompleted.id, donationId]
              );

              console.log('âœ… Donation status updated to completed for donation ID:', donationId);

              if (emailService && emailService.isEmailConfigured()) {
                if (!customerEmail) {
                  console.warn('âš ï¸ No customer email available for donation thank you email');
                } else {
                  console.log('ðŸ“§ Sending donation thank you email to:', customerEmail);

                  const emailResult = await emailService.sendDonationThankYouEmail(
                    customerEmail,
                    username,
                    donationAmount || donation.amount,
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
      } else {
        console.log('â„¹ï¸ checkout.session.completed received but not a donation payment - ignoring');
      }
      break;
    }

    default:
      console.log(`â„¹ï¸ Unhandled event type: ${event.type}`);
      break;
  }
};

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('ðŸŽ¯ ===== STRIPE WEBHOOK RECEIVED =====');
  console.log('ðŸŽ¯ Timestamp:', new Date().toISOString());
  console.log('ðŸŽ¯ Headers:', {
    'stripe-signature': req.headers['stripe-signature'] ? 'PRESENT' : 'MISSING',
    'user-agent': req.headers['user-agent'],
    'content-type': req.headers['content-type'],
    'content-length': req.headers['content-length']
  });

  console.log('ðŸŽ¯ Raw body details:', {
    isBuffer: Buffer.isBuffer(req.body),
    bodyType: typeof req.body,
    bodyLength: req.body ? req.body.length : 0,
    bodyPreview: req.body ? req.body.toString().substring(0, 200) + '...' : 'NO BODY'
  });

  try {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    console.log('ðŸŽ¯ Webhook verification:', {
      signaturePresent: !!sig,
      webhookSecretPresent: !!webhookSecret,
      webhookSecretLength: webhookSecret ? webhookSecret.length : 0
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

// Initialize database
initializeDatabase().catch(error => {
  console.error('❌ Database initialization failed:', error);
  console.log('⚠️ Server will continue running without database');
});

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
        "'unsafe-inline'", // Allow inline scripts
        "'unsafe-hashes'", // Allow inline event handlers
        "https://vjs.zencdn.net", // Allow Video.js CDN
        "https://cdnjs.cloudflare.com", // Allow other CDNs if needed
        "https://js.stripe.com" // Allow Stripe.js
      ],
      scriptSrcAttr: ["'unsafe-inline'"], // Specifically allow onclick handlers
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", // Allow inline styles
        "https://vjs.zencdn.net", // Allow Video.js CSS
        "https://fonts.googleapis.com", // Allow Google Fonts
        "https://fonts.gstatic.com", // Allow Google Fonts
        "https://js.stripe.com" // Allow Stripe styles
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
        "https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev", // Charity stream videos R2 bucket (CORRECT)
        "https://pub-83596556bc864db7aa93479e13f45deb.r2.dev"  // Advertiser media R2 bucket
      ],
      connectSrc: [
        "'self'", // Allow API calls to same origin
        "https://api.stripe.com" // Allow Stripe API calls
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
app.use((req, res, next) => {
  if (
    req.path === '/api/webhook' ||
    req.originalUrl === '/api/webhook' ||
    req.path === '/api/webhook/test' ||
    req.originalUrl === '/api/webhook/test'
  ) {
    return next();
  }
  return bodyParser.json()(req, res, next);
});

// TEMPORARY: Video proxy to bypass CORS issues while diagnosing R2
app.get('/proxy-video/:videoName', async (req, res) => {
  try {
    const { videoName } = req.params;
    const R2_URL = `https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev/${videoName}`;
    
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

// Serve charity.html at /charity
app.get('/charity', (req, res) => {
  console.log('📄 Serving charity.html');
  res.sendFile(path.join(__dirname, '../public/charity.html'));
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
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
        subscriptionTier: user.subscription_tier
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
        subscriptionTier: user.subscription_tier
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
        subscriptionTier: user.subscription_tier,
        profilePicture: user.profile_picture,
        emailVerified: user.email_verified,
        authProvider: user.auth_provider,
        isPremium: user.is_premium || false,
        premiumSince: user.premium_since,
        stripeSubscriptionId: user.stripe_subscription_id
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
        subscriptionTier: user.subscription_tier
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
          subscriptionTier: user.subscription_tier,
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
        subscriptionTier: user.subscription_tier,
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
        subscriptionTier: user.subscription_tier
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
    // Accept video and image files
    const allowedMimes = ['video/mp4', 'image/png', 'image/jpeg', 'image/jpg'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4 videos and PNG/JPG images are allowed.'));
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
        mediaUrl = `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${filename}`;
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
    
    // Insert into database
    const result = await pool.query(
      `INSERT INTO advertisers (
        company_name, website_url, first_name, last_name, 
        email, title_role, ad_format, weekly_budget_cap, cpm_rate, 
        media_r2_link, recurring_weekly, max_weekly_impressions, approved, completed, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, false, CURRENT_TIMESTAMP)
      RETURNING id, email, media_r2_link, created_at`,
      [
        companyName || null,
        websiteUrl || null,
        firstName || null,
        lastName || null,
        email,
        jobTitle || null,
        databaseAdFormat || null, // Use mapped value instead of adFormat
        weeklyBudgetNum,
        cpmRateNum,
        mediaUrl,
        isRecurring === 'true' || isRecurring === true,
        max_weekly_impressions
      ]
    );
    
    const inserted = result.rows[0];
    console.log(`✅ Advertiser submission saved:`, inserted);
    
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
    const {
      organization,
      contactEmail,
      website,
      einTaxId,
      sponsorTier
    } = req.body;
    
    // Validate required fields
    if (!organization || !contactEmail) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'organization and contactEmail are required'
      });
    }
    
    // Validate sponsor tier if provided
    const validTiers = ['bronze', 'silver', 'gold', 'diamond'];
    if (sponsorTier && !validTiers.includes(sponsorTier.toLowerCase())) {
      return res.status(400).json({
        error: 'Invalid sponsor tier',
        message: 'sponsorTier must be one of: bronze, silver, gold, diamond'
      });
    }
    
    console.log(`📝 Sponsor submission received from ${organization} (${contactEmail})`);
    
    let logoUrl = null;
    
    // Upload logo to R2 if provided
    if (req.file) {
      try {
        const timestamp = Date.now();
        const filename = `sponsor-${timestamp}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        
        console.log(`📤 Uploading logo to R2: ${filename}`);
        
        const uploadCommand = new PutObjectCommand({
          Bucket: 'advertiser-media',
          Key: filename,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        });
        
        await r2Client.send(uploadCommand);
        
        // Construct public URL using the correct public dev URL
        logoUrl = `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${filename}`;
        console.log(`✅ Logo uploaded successfully: ${logoUrl}`);
        
      } catch (uploadError) {
        console.error('❌ R2 upload error:', uploadError);
        return res.status(500).json({
          error: 'Logo upload failed',
          message: 'Failed to upload logo file to storage'
        });
      }
    }
    
    // Get database pool
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Insert into database
    const result = await pool.query(
      `INSERT INTO sponsors (
        organization, contact_email, website, ein_tax_id, sponsor_tier, 
        logo_r2_link, approved, completed, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, false, false, CURRENT_TIMESTAMP)
      RETURNING id, organization, contact_email, logo_r2_link, created_at`,
      [
        organization,
        contactEmail,
        website || null,
        einTaxId || null,
        sponsorTier ? sponsorTier.toLowerCase() : null,
        logoUrl
      ]
    );
    
    const inserted = result.rows[0];
    console.log(`✅ Sponsor submission saved:`, inserted);
    
    res.status(200).json({
      success: true,
      message: 'Sponsor submission received successfully',
      data: {
        id: inserted.id,
        organization: inserted.organization,
        contactEmail: inserted.contact_email,
        logoUrl: inserted.logo_r2_link,
        createdAt: inserted.created_at
      }
    });
    
  } catch (error) {
    console.error('❌ Error submitting sponsor application:', error);
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to submit sponsor application. Please try again later.'
    });
  }
});


// ===== CHARITY SUBMISSION ROUTE =====

// Submit charity application
app.post('/api/charity/submit', async (req, res) => {
  try {
    const { charityName, federalEin, contactEmail } = req.body;
    
    // Validate required fields
    if (!charityName || !federalEin || !contactEmail) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Please provide charityName, federalEin, and contactEmail' 
      });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(contactEmail)) {
      return res.status(400).json({ 
        error: 'Invalid email format',
        message: 'Please provide a valid email address' 
      });
    }
    
    // Get database pool
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    console.log('📝 Charity submission received:', { charityName, federalEin, contactEmail });
    
    // Insert into database
    const result = await pool.query(
      `INSERT INTO charities (charity_name, federal_ein, contact_email, payment_status, approved, completed, created_at)
       VALUES ($1, $2, $3, 'pending', false, false, CURRENT_TIMESTAMP)
       RETURNING id, charity_name, federal_ein, contact_email, created_at`,
      [charityName, federalEin, contactEmail]
    );
    
    const insertedCharity = result.rows[0];
    console.log('✅ Charity submission saved:', insertedCharity);
    
    res.status(200).json({
      success: true,
      message: 'Charity submission received successfully',
      data: {
        id: insertedCharity.id,
        charityName: insertedCharity.charity_name,
        federalEin: insertedCharity.federal_ein,
        contactEmail: insertedCharity.contact_email,
        createdAt: insertedCharity.created_at
      }
    });
    
  } catch (error) {
    console.error('❌ Error submitting charity application:', error);
    
    // Check for duplicate entry (if you add unique constraints later)
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Duplicate entry',
        message: 'This charity has already been submitted'
      });
    }
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to submit charity application. Please try again later.'
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

// ===== WEEKLY RESET SYSTEM =====

// Perform weekly reset for all approved, completed, non-archived advertisers
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
    const preCheck = await pool.query(`
      SELECT id, current_week_impressions, capped, archived, recurring_weekly
      FROM advertisers
      WHERE approved = TRUE AND completed = TRUE AND archived = FALSE
    `);
    console.log(`📊 [WEEKLY RESET] Pre-reset: Found ${preCheck.rows.length} advertisers to reset`);
    console.log("📊 [WEEKLY RESET] Pre-reset advertiser states:", preCheck.rows.map(ad => ({
      id: ad.id,
      impressions: ad.current_week_impressions,
      capped: ad.capped,
      recurring: ad.recurring_weekly
    })));

    // Reset only approved, completed, NOT archived advertisers
    // Note: weekly_clicks, weekly_charge_amount, last_billing_date may not exist - query will handle gracefully
    const result = await pool.query(`
      UPDATE advertisers
      SET 
        current_week_impressions = 0,
        capped = FALSE,
        current_week_start = NOW(),
        updated_at = NOW()
      WHERE approved = TRUE 
        AND completed = TRUE
        AND (archived IS NULL OR archived = FALSE)
    `);
    
    // Try to reset optional columns if they exist (gracefully handle if they don't)
    try {
      await pool.query(`
        UPDATE advertisers
        SET weekly_clicks = 0
        WHERE approved = TRUE 
          AND completed = TRUE
          AND (archived IS NULL OR archived = FALSE)
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
        WHERE approved = TRUE 
          AND completed = TRUE
          AND (archived IS NULL OR archived = FALSE)
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
        WHERE approved = TRUE 
          AND completed = TRUE
          AND (archived IS NULL OR archived = FALSE)
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
    const postCheck = await pool.query(`
      SELECT id, current_week_impressions, capped, current_week_start
      FROM advertisers
      WHERE approved = TRUE AND completed = TRUE AND (archived IS NULL OR archived = FALSE)
    `);
    console.log("📊 [WEEKLY RESET] Post-reset states:", postCheck.rows.map(ad => ({
      id: ad.id,
      impressions: ad.current_week_impressions,
      capped: ad.capped,
      weekStart: ad.current_week_start
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
    const advertiserResult = await pool.query(
      `SELECT id, video_filename, approved, completed, recurring_weekly, 
              current_week_start, campaign_start_date, current_week_impressions, total_impressions
       FROM advertisers 
       WHERE id = $1`,
      [advertiserId]
    );
    
    if (advertiserResult.rows.length === 0) {
      console.log('⚠️ Advertiser not found:', advertiserId);
      return res.status(200).json({ success: true, message: 'Advertiser not found (ignored)' });
    }
    
    const advertiser = advertiserResult.rows[0];
    
    // Validate advertiser is approved + completed
    if (!advertiser.approved || !advertiser.completed) {
      console.log('⚠️ Advertiser not approved/completed:', advertiserId);
      return res.status(200).json({ success: true, message: 'Advertiser not active (ignored)' });
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
    
    // For non-recurring campaigns, check if campaign has ended
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
    
    await pool.query(
      `UPDATE advertisers SET
        total_impressions = $1,
        current_week_impressions = $2,
        current_week_start = $3,
        updated_at = NOW()
       WHERE id = $4`,
      [totalImpressions, currentWeekImpressions, currentWeekStart, advertiserId]
    );
    
    console.log(`📊 Impression recorded for advertiser ${advertiserId}:`, {
      total: totalImpressions,
      currentWeek: currentWeekImpressions,
      videoFilename: videoFilename
    });
    
    res.json({ 
      success: true,
      totalImpressions: totalImpressions,
      currentWeekImpressions: currentWeekImpressions
    });
    
  } catch (error) {
    console.error('❌ Error recording impression:', error);
    res.status(500).json({ error: 'Internal server error' });
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
             capped, archived, completed, recurring_weekly
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
      // If they're capped and completed, archive them immediately (move to R2 archived/ folder)
      if (ad.recurring_weekly === false && ad.completed === true && !ad.archived && ad.video_filename) {
        console.log(`📦 Archiving non-recurring capped campaign ${advertiserId} - moving video to R2 archived/`);
        
        try {
          // MOVE FILE IN R2 (copy + delete)
          const CHARITY_BUCKET = 'charity-stream-videos';
          const sourceKey = ad.video_filename;
          const destKey = `archived/${ad.video_filename}`;
          
          console.log(`📦 [R2 ARCHIVE] Copying ${sourceKey} to ${destKey}`);
          const copyCommand = new CopyObjectCommand({
            Bucket: CHARITY_BUCKET,
            CopySource: `${CHARITY_BUCKET}/${sourceKey}`,
            Key: destKey
          });
          await r2Client.send(copyCommand);
          console.log(`✅ [R2 ARCHIVE] Successfully copied ${sourceKey} to ${destKey}`);
          
          console.log(`🗑️ [R2 ARCHIVE] Deleting original file: ${sourceKey}`);
          const deleteCommand = new DeleteObjectCommand({
            Bucket: CHARITY_BUCKET,
            Key: sourceKey
          });
          await r2Client.send(deleteCommand);
          console.log(`✅ [R2 ARCHIVE] Successfully deleted original file: ${sourceKey}`);
          
          // Update database
          await pool.query(`
            UPDATE advertisers
            SET archived = TRUE,
                archived_at = NOW(),
                archived_reason = 'Non-recurring campaign capped'
            WHERE id = $1
          `, [advertiserId]);
          
          console.log(`✅ [R2 ARCHIVE] Database updated - advertiser ${advertiserId} archived`);
          
          // CLEAR PLAYLIST CACHE when non-recurring advertiser is archived
          playlistCache.clear();
          console.log("🧽 [CHECK-CAP] Cleared playlist cache because non-recurring advertiser was archived");
        } catch (r2Error) {
          console.error(`❌ [R2 ARCHIVE] Error archiving video for advertiser ${advertiserId}:`, r2Error);
          // Still update database as archived even if R2 move fails
          await pool.query(`
            UPDATE advertisers
            SET archived = TRUE,
                archived_at = NOW(),
                archived_reason = 'Non-recurring campaign capped (R2 archive failed)'
            WHERE id = $1
          `, [advertiserId]);
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
        video_filename: ad.video_filename
      });
      
      return res.json({
        success: true,
        capped: true,
        archived: ad.max_weekly_impressions === null,
        message: 'Advertiser capped'
      });
    }
    
    // Debug logging for non-capped status
    console.log("🧪 [CHECK-CAP] Returned capped:", ad.capped, "archived:", ad.archived);
    
    res.json({
      success: true,
      capped: ad.capped || false,
      archived: ad.archived || false,
      currentImpressions: ad.current_week_impressions,
      maxImpressions: ad.max_weekly_impressions
    });
    
  } catch (error) {
    console.error('❌ Error checking cap:', error);
    res.status(500).json({ error: 'Internal server error' });
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
  
  if (!isVercelCron && !isLocalDev) {
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

// ===== ADVERTISER PORTAL SIGNUP ROUTES =====

// Get signup info for a portal signup token
app.get('/api/advertiser/signup-info', async (req, res) => {
  try {
    const { token } = req.query;
    
    console.log('🔍 [PORTAL SIGNUP] Signup info request for token:', token ? token.substring(0, 8) + '...' : 'MISSING');
    
    if (!token) {
      console.log('❌ [PORTAL SIGNUP] No token provided');
      return res.json({ valid: false });
    }
    
    const pool = getPool();
    if (!pool) {
      console.error('❌ [PORTAL SIGNUP] Database pool not available');
      return res.status(500).json({ valid: false, error: 'Database connection not available' });
    }
    
    // Look up advertiser by token
    const advertiserResult = await pool.query(`
      SELECT id, email, portal_signup_token, portal_signup_token_created_at,
             approved, completed
      FROM advertisers
      WHERE portal_signup_token = $1
    `, [token]);
    
    if (advertiserResult.rows.length === 0) {
      console.log('❌ [PORTAL SIGNUP] Token not found in database');
      return res.json({ valid: false });
    }
    
    const advertiser = advertiserResult.rows[0];
    
    // Validate token age (< 30 days)
    const tokenAge = advertiser.portal_signup_token_created_at 
      ? new Date() - new Date(advertiser.portal_signup_token_created_at)
      : Infinity;
    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
    
    if (tokenAge > thirtyDaysInMs) {
      console.log('❌ [PORTAL SIGNUP] Token expired (age:', Math.floor(tokenAge / (24 * 60 * 60 * 1000)), 'days)');
      return res.json({ valid: false });
    }
    
    console.log('✅ [PORTAL SIGNUP] Token valid for advertiser:', advertiser.id, 'email:', advertiser.email);
    
    // Check if account already exists
    const accountResult = await pool.query(`
      SELECT id, created_from_submission, created_from_approval
      FROM advertiser_accounts
      WHERE email = $1
    `, [advertiser.email]);
    
    if (accountResult.rows.length > 0) {
      console.log('⚠️ [PORTAL SIGNUP] Account already exists for email:', advertiser.email);
      return res.json({
        valid: true,
        accountExists: true
      });
    }
    
    // Determine if this is from submission or approval
    // If approved and completed, it's from approval email
    // Otherwise, it's from submission email
    const createdFromApproval = advertiser.approved === true && advertiser.completed === true;
    const createdFromSubmission = !createdFromApproval;
    
    console.log('📊 [PORTAL SIGNUP] Signup source:', {
      createdFromSubmission,
      createdFromApproval,
      approved: advertiser.approved,
      completed: advertiser.completed
    });
    
    return res.json({
      valid: true,
      email: advertiser.email,
      accountExists: false,
      createdFromSubmission: createdFromSubmission,
      createdFromApproval: createdFromApproval
    });
    
  } catch (error) {
    console.error('❌ [PORTAL SIGNUP] Error in signup-info:', error);
    res.status(500).json({ valid: false, error: 'Internal server error' });
  }
});

// Create advertiser portal account
app.post('/api/advertiser/signup', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    console.log('🔐 [PORTAL SIGNUP] Signup request for token:', token ? token.substring(0, 8) + '...' : 'MISSING');
    
    if (!token || !password) {
      console.log('❌ [PORTAL SIGNUP] Missing token or password');
      return res.status(400).json({ success: false, error: 'Token and password are required' });
    }
    
    if (password.length < 8) {
      console.log('❌ [PORTAL SIGNUP] Password too short');
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    
    const pool = getPool();
    if (!pool) {
      console.error('❌ [PORTAL SIGNUP] Database pool not available');
      return res.status(500).json({ success: false, error: 'Database connection not available' });
    }
    
    // Look up advertiser by token
    const advertiserResult = await pool.query(`
      SELECT id, email, portal_signup_token, portal_signup_token_created_at,
             approved, completed, can_view_dashboard
      FROM advertisers
      WHERE portal_signup_token = $1
    `, [token]);
    
    if (advertiserResult.rows.length === 0) {
      console.log('❌ [PORTAL SIGNUP] Token not found');
      return res.status(400).json({ success: false, error: 'Invalid token' });
    }
    
    const advertiser = advertiserResult.rows[0];
    
    // Validate token age
    const tokenAge = advertiser.portal_signup_token_created_at 
      ? new Date() - new Date(advertiser.portal_signup_token_created_at)
      : Infinity;
    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
    
    if (tokenAge > thirtyDaysInMs) {
      console.log('❌ [PORTAL SIGNUP] Token expired');
      return res.status(400).json({ success: false, error: 'Token has expired' });
    }
    
    // Check if account already exists
    const existingAccount = await pool.query(`
      SELECT id FROM advertiser_accounts WHERE email = $1
    `, [advertiser.email]);
    
    if (existingAccount.rows.length > 0) {
      console.log('❌ [PORTAL SIGNUP] Account already exists for email:', advertiser.email);
      return res.status(400).json({ success: false, error: 'Account already exists for this email' });
    }
    
    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    console.log('✅ [PORTAL SIGNUP] Password hashed');
    
    // Determine if this is from submission or approval
    const createdFromApproval = advertiser.approved === true && advertiser.completed === true;
    const createdFromSubmission = !createdFromApproval;
    
    console.log('📊 [PORTAL SIGNUP] Creating account:', {
      advertiserId: advertiser.id,
      email: advertiser.email,
      createdFromSubmission,
      createdFromApproval
    });
    
    // Create advertiser_accounts row
    const accountResult = await pool.query(`
      INSERT INTO advertiser_accounts (advertiser_id, email, password_hash, created_from_submission, created_from_approval)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [advertiser.id, advertiser.email, passwordHash, createdFromSubmission, createdFromApproval]);
    
    console.log('✅ [PORTAL SIGNUP] Account created with ID:', accountResult.rows[0].id);
    
    // If approval token, set can_view_dashboard = TRUE
    if (createdFromApproval) {
      await pool.query(`
        UPDATE advertisers
        SET can_view_dashboard = TRUE,
            can_view_status = TRUE
        WHERE id = $1
      `, [advertiser.id]);
      console.log('✅ [PORTAL SIGNUP] Dashboard access granted for approved advertiser');
    } else {
      // For submission, just ensure can_view_status is TRUE
      await pool.query(`
        UPDATE advertisers
        SET can_view_status = TRUE
        WHERE id = $1
      `, [advertiser.id]);
      console.log('✅ [PORTAL SIGNUP] Status view access granted for submission');
    }
    
    // Clear token (optional but recommended)
    await pool.query(`
      UPDATE advertisers
      SET portal_signup_token = NULL,
          portal_signup_token_created_at = NULL
      WHERE id = $1
    `, [advertiser.id]);
    console.log('✅ [PORTAL SIGNUP] Token cleared from database');
    
    return res.json({
      success: true,
      createdFromSubmission: createdFromSubmission,
      createdFromApproval: createdFromApproval
    });
    
  } catch (error) {
    console.error('❌ [PORTAL SIGNUP] Error in signup:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
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
    
    // Look up advertiser account by email
    const accountResult = await pool.query(`
      SELECT aa.id, aa.email, aa.password_hash, aa.advertiser_id,
             a.company_name, a.approved, a.completed
      FROM advertiser_accounts aa
      INNER JOIN advertisers a ON aa.advertiser_id = a.id
      WHERE aa.email = $1
    `, [email.toLowerCase().trim()]);
    
    if (accountResult.rows.length === 0) {
      console.log('❌ [PORTAL LOGIN] Account not found for email:', email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    
    const account = accountResult.rows[0];
    
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
    // Use a different token type to distinguish from regular user tokens
    const tokenPayload = {
      type: 'advertiser_portal',
      advertiserAccountId: account.id,
      advertiserId: account.advertiser_id,
      email: account.email
    };
    
    const token = generateJWTToken(tokenPayload, '30d'); // 30 day expiry for portal access
    
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
    const R2_BUCKET_URL = 'https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev';
    
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
    
    const R2_BUCKET_URL = 'https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev';
    const CHARITY_BUCKET = 'charity-stream-videos';
    
    // List all video_X.mp4 files from R2 bucket
    const listCommand = new ListObjectsV2Command({
      Bucket: CHARITY_BUCKET
    });
    
    const response = await r2Client.send(listCommand);
    const allFiles = response.Contents || [];
    
    // Filter for video_X.mp4 pattern (exclude archived/ folder) and sort numerically
    const videoFiles = allFiles
      .filter(file => 
        /^video_\d+\.mp4$/.test(file.Key) &&
        !file.Key.startsWith('archived/')
      )
      .map(file => {
        const match = file.Key.match(/^video_(\d+)\.mp4$/);
        return {
          filename: file.Key,
          number: parseInt(match[1]),
          size: file.Size
        };
      })
      .sort((a, b) => a.number - b.number);
    
    // Debug: Log if any archived files were found and skipped
    const archivedFiles = allFiles.filter(file => file.Key.startsWith('archived/'));
    if (archivedFiles.length > 0) {
      console.log(`📦 [PLAYLIST] Skipped ${archivedFiles.length} archived video(s):`, archivedFiles.map(f => f.Key));
    }
    
    // Get advertiser mappings for videos with video_filename
    const pool = getPool();
    let advertiserMap = new Map();
    let advertiserDataById = new Map();
    // Track filenames that should be blocked (capped or archived advertisers)
    const blockedFilenames = new Set();
    
    if (pool) {
      try {
        // Query for all advertisers (including archived) to build blockedFilenames
        const advertiserResult = await pool.query(`
          SELECT id, video_filename, approved, completed,
                 current_week_impressions, max_weekly_impressions, capped,
                 archived, archived_at, archived_reason, recurring_weekly
          FROM advertisers
          WHERE video_filename IS NOT NULL
            AND approved = true
            AND completed = true
        `);
        
        // Process each advertiser: check caps and archive if needed
        for (const ad of advertiserResult.rows) {
          // Debug logging for each advertiser
          console.log(`🧪 [PLAYLIST] Advertiser ${ad.id} status:`, {
            capped: ad.capped,
            archived: ad.archived,
            video_filename: ad.video_filename,
            current_week_impressions: ad.current_week_impressions,
            max_weekly_impressions: ad.max_weekly_impressions
          });
          
          // Check if impressions >= max_weekly_impressions (cap the advertiser)
          if (ad.max_weekly_impressions !== null && 
              ad.current_week_impressions >= ad.max_weekly_impressions && 
              !ad.capped) {
            console.log(`🛑 Capping advertiser ${ad.id} - impressions (${ad.current_week_impressions}) >= max (${ad.max_weekly_impressions})`);
            
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
          if (ad.capped === true && 
              ad.recurring_weekly === false && 
              ad.archived !== true &&
              ad.video_filename) {
            console.log(`📦 Archiving non-recurring capped campaign ${ad.id} - moving video to R2 archived/`);
            
            try {
              // MOVE FILE IN R2 (copy + delete)
              const CHARITY_BUCKET = 'charity-stream-videos';
              const sourceKey = ad.video_filename;
              const destKey = `archived/${ad.video_filename}`;
              
              console.log(`📦 [R2 ARCHIVE] Copying ${sourceKey} to ${destKey}`);
              const copyCommand = new CopyObjectCommand({
                Bucket: CHARITY_BUCKET,
                CopySource: `${CHARITY_BUCKET}/${sourceKey}`,
                Key: destKey
              });
              await r2Client.send(copyCommand);
              console.log(`✅ [R2 ARCHIVE] Successfully copied ${sourceKey} to ${destKey}`);
              
              console.log(`🗑️ [R2 ARCHIVE] Deleting original file: ${sourceKey}`);
              const deleteCommand = new DeleteObjectCommand({
                Bucket: CHARITY_BUCKET,
                Key: sourceKey
              });
              await r2Client.send(deleteCommand);
              console.log(`✅ [R2 ARCHIVE] Successfully deleted original file: ${sourceKey}`);
              
              // Update database
              await pool.query(`
                UPDATE advertisers
                SET archived = TRUE,
                    archived_at = NOW(),
                    archived_reason = 'Non-recurring campaign capped'
                WHERE id = $1
              `, [ad.id]);
              
              ad.archived = true;
              console.log(`✅ [R2 ARCHIVE] Database updated - advertiser ${ad.id} archived`);
              
              // CLEAR PLAYLIST CACHE WHEN A NON-RECURRING AD IS ARCHIVED (clear all entries)
              playlistCache.clear();
              console.log("🧽 [PLAYLIST ENDPOINT] Cache cleared due to non-recurring advertiser being archived");
            } catch (r2Error) {
              console.error(`❌ [R2 ARCHIVE] Error archiving video for advertiser ${ad.id}:`, r2Error);
              // Still update database as archived even if R2 move fails
              await pool.query(`
                UPDATE advertisers
                SET archived = TRUE,
                    archived_at = NOW(),
                    archived_reason = 'Non-recurring campaign capped (R2 archive failed)'
                WHERE id = $1
              `, [ad.id]);
              ad.archived = true;
            }
          }
          
          // NEW: mark any capped or archived advertiser's filename as blocked
          if (ad.capped === true || ad.archived === true) {
            if (ad.video_filename) {
              blockedFilenames.add(ad.video_filename);
              console.log(`🚫 [PLAYLIST] Blocking capped/archived file: ${ad.video_filename} (advertiser ${ad.id})`);
            }
            // Do NOT add to advertiserMap
            continue;
          }
          
          // Only add to maps if not capped and not archived
          advertiserMap.set(ad.video_filename, ad.id);
          advertiserDataById.set(ad.id, ad);
        }
        
        // Debug logging: show which advertisers are in the map
        console.log("🧪 [PLAYLIST] Final active advertiserMap keys:", [...advertiserMap.keys()]);
        
        console.log(`📊 Found ${advertiserMap.size} active advertisers with video_filename (${advertiserResult.rows.length - advertiserMap.size} capped/archived excluded)`);
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
      
      const advertiserId = advertiserMap.get(video.filename) || null;
      const videoFilename = advertiserId ? video.filename : null;
      
      return {
      videoId: video.number,
      title: video.filename.replace('.mp4', ''),
      videoUrl: `${R2_BUCKET_URL}/${video.filename}`,
        duration: 60,
        advertiserId: advertiserId,
        videoFilename: videoFilename,
        isCapped: false // Backend already filtered, but include for frontend defensive check
      };
    });
    
    // Filter out null entries (capped videos)
    const playlist = rawPlaylist.filter(v => v !== null);
    
    // Debug logging: show which videos are included in final playlist
    console.log("🧪 [PLAYLIST] Final videos included:", playlist.map(v => v.title));
    
    const playlistData = {
      videos: playlist
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
    
    console.log(`✅ Dynamically serving playlist: ${playlist.length} videos from R2 bucket`);
    console.log(`   Videos: ${videoFiles.map(v => v.filename).join(', ')}`);
    
    res.json(playlistData);
  } catch (error) {
    console.error('❌ Error fetching playlist:', error);
    
    // Fallback to static playlist if R2 listing fails
    const R2_BUCKET_URL = 'https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev';
    const fallbackPlaylist = [
      { videoId: 1, title: 'video_1', videoUrl: `${R2_BUCKET_URL}/video_1.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 2, title: 'video_2', videoUrl: `${R2_BUCKET_URL}/video_2.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 3, title: 'video_3', videoUrl: `${R2_BUCKET_URL}/video_3.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 4, title: 'video_4', videoUrl: `${R2_BUCKET_URL}/video_4.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 5, title: 'video_5', videoUrl: `${R2_BUCKET_URL}/video_5.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 6, title: 'video_6', videoUrl: `${R2_BUCKET_URL}/video_6.mp4`, duration: 60, advertiserId: null, videoFilename: null }
    ];
    
    console.log('⚠️ Using fallback playlist (6 videos)');
    res.json({ videos: fallbackPlaylist });
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
        m.video_filename,
        COALESCE(a.company_name, m.company_name) AS company_name,
        COALESCE(a.destination_url, m.website_url) AS destination_url,
        a.click_tracking
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
      subscription_tier, is_active
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
          subscription_tier: user.subscription_tier,
          is_active: user.is_active
        },
        recentSessions: sessions || []
      });
    });
  });
});

// ===== ADVERTISER CHECKOUT ROUTES =====

// Create advertiser checkout session
// Separate endpoint to upload file first (avoids Vercel 4.5MB limit)
app.post('/api/advertiser/upload-file', upload.single('creative'), async (req, res) => {
  try {
    console.log('📤 ===== FILE UPLOAD ENDPOINT =====');
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    console.log('📁 File received:', req.file.originalname);
    console.log('📁 File size:', req.file.size, 'bytes');
    
    // Generate final filename
    const timestamp = Date.now();
    const sanitizedFileName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const finalFileName = `${timestamp}-${sanitizedFileName}`;
    
    console.log(`📤 Uploading file to R2: ${finalFileName}`);
    
    // Upload to R2
    const uploadCommand = new PutObjectCommand({
      Bucket: 'advertiser-media',
      Key: finalFileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });
    
    await r2Client.send(uploadCommand);
    
    // Generate public URL
    const mediaUrl = `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${finalFileName}`;
    
    console.log('✅ File uploaded to R2 successfully:', mediaUrl);
    
    // Return the file URL and filename for use in checkout
    res.json({
      success: true,
      fileUrl: mediaUrl,
      fileName: finalFileName
    });
    
  } catch (error) {
    console.error('❌ File upload error:', error);
    res.status(500).json({
      error: 'File upload failed',
      message: error.message
    });
  }
});

app.post('/api/advertiser/create-checkout-session', async (req, res) => {
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
    
    // Create payment_pending advertiser record in database (NO R2 upload yet)
    console.log('💾 Creating payment_pending advertiser record...');
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Get file URL from request body (file should be uploaded separately via /api/advertiser/upload-file)
    // This avoids Vercel's 4.5MB request body limit for serverless functions
    const mediaUrl = fileUrl || null;
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
        company_name, website_url, first_name, last_name, 
        email, title_role, ad_format, weekly_budget_cap, cpm_rate, 
        recurring_weekly, expedited, click_tracking, destination_url,
        media_r2_link, max_weekly_impressions, payment_completed, application_status, approved, completed, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, false, 'payment_pending', false, false, CURRENT_TIMESTAMP)
      RETURNING id, email, company_name`,
      [
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
    
    // Calculate pricing and line items
    const lineItems = [];
    let totalAmount = 0;
    
    // ALL advertisers get CPM Impressions product (for usage-based billing)
    // Note: This is a metered product, so no quantity needed
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
    
    // Build complete subscription metadata (webhook reads from subscription.metadata)
    // This must include ALL fields needed for the email template
    const subscriptionMetadata = {
      advertiserId: String(advertiser.id),
      campaignType: 'advertiser',
      companyName: companyName,
      hasFile: !!req.file ? 'true' : 'false',
      isRecurring: isRecurring === 'true' || isRecurring === true ? 'true' : 'false',
      // REQUIRED fields for email summary
      weeklyBudget: weeklyBudget || '',
      cpmRate: cpmRate || '',
      clickTracking: clickTracking === 'true' || clickTracking === true ? 'true' : 'false',
      expedited: expeditedApproval === 'true' || expeditedApproval === true ? 'true' : 'false',
      adFormat: adFormat || ''
    };
    
    console.log('📦 Complete subscription metadata prepared for webhook:', subscriptionMetadata);
    
    // Session metadata (also include all fields for consistency)
    const sessionMetadata = {
      advertiserId: String(advertiser.id),
      companyName: companyName,
      campaignType: 'advertiser',
      hasFile: !!req.file ? 'true' : 'false',
      isRecurring: isRecurring === 'true' || isRecurring === true ? 'true' : 'false',
      // REQUIRED fields for email summary
      weeklyBudget: weeklyBudget || '',
      cpmRate: cpmRate || '',
      clickTracking: clickTracking === 'true' || clickTracking === true ? 'true' : 'false',
      expedited: expeditedApproval === 'true' || expeditedApproval === true ? 'true' : 'false',
      adFormat: adFormat || ''
    };
    
    console.log('📦 Complete session metadata prepared:', sessionMetadata);
    
    const sessionConfig = {
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription', // MUST be subscription for usage-based billing
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser.html?payment_success=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser.html`,
      metadata: sessionMetadata,
      subscription_data: {
        metadata: subscriptionMetadata
      },
      line_items: lineItems
    };
    
    // For usage-based billing, we don't need setup_future_usage
    // The subscription mode handles recurring billing automatically
    
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
      'SELECT id, company_name, email, expedited, application_status, created_at FROM advertisers WHERE id = $1',
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
        applicationStatus: advertiser.application_status,
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
    console.log('📝 Found advertiser:', { id: advertiser.id, email: advertiser.email, application_status: advertiser.application_status });
    
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
      
      // Save token to database
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(`
            UPDATE advertisers
            SET portal_signup_token = $1,
                portal_signup_token_created_at = NOW()
            WHERE id = $2
          `, [portalSignupToken, advertiser.id]);
          console.log('✅ [PORTAL SIGNUP] Token saved to database for advertiser:', advertiser.id);
        } catch (tokenError) {
          console.error('❌ [PORTAL SIGNUP] Failed to save token:', tokenError.message);
        }
      }
      
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
          status: advertiser.application_status
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

// Stripe webhook endpoint - legacy copy retained below for reference only
// Legacy webhook handler removed; see top-level definition near top of file.
// Webhook status endpoint to assist with configuration
app.get('/api/webhook-status', (req, res) => {
  try {
    const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhook`;
    res.json({
      webhookUrl: webhookUrl,
      status: 'active',
      environment: process.env.NODE_ENV,
      requiredEvents: ['checkout.session.completed', 'customer.subscription.created', 'invoice.payment_succeeded'],
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ? 'SET' : 'MISSING',
      instructions: [
        '1. Go to Stripe Dashboard → Developers → Webhooks',
        '2. Add endpoint: ' + webhookUrl,
        '3. Enable events: checkout.session.completed, customer.subscription.created, invoice.payment_succeeded',
        '4. Copy webhook secret and set as STRIPE_WEBHOOK_SECRET',
        '5. For local dev, use Stripe CLI: stripe listen --forward-to localhost:3001/api/webhook'
      ]
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
    console.log('💾 Creating donation record in database...');
    const donationResult = await pool.query(
      `INSERT INTO donations (user_id, amount, customer_email, status, stripe_session_id)
       VALUES ($1, $2, $3, 'pending', NULL)
       RETURNING id`,
      [req.user.userId, amount, req.user.email]
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

// SPA fallback - serve index.html for any unknown non-API routes
app.get('*', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    return next(); // Let API routes return 404
  }
  
  // Skip routes we've explicitly handled
  const handledRoutes = ['/', '/about', '/advertise', '/impact', '/auth', '/auth.html', '/advertiser', '/charity'];
  if (handledRoutes.includes(req.path)) {
    return next();
  }
  
  // Skip static file extensions (let express.static handle them)
  const staticExtensions = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.pdf'];
  if (staticExtensions.some(ext => req.path.toLowerCase().endsWith(ext))) {
    return next();
  }
  
  console.log(`📄 SPA fallback: serving index.html for ${req.path}`);
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Export the Express app for serverless environments (e.g., Vercel)
module.exports = app;

// Export weekly reset function for Vercel cron and test scripts
module.exports.performWeeklyReset = performWeeklyReset;

// Optional local development server
if (process.env.NODE_ENV !== 'production' && require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} (local development)`);
  });
}
