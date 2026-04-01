// Neon WebSocket + fetch adapters for Node.js (same as server.js)
const ws = require('ws');
const { fetch } = require('undici');

// Provide globals expected by @neondatabase/serverless
global.WebSocket = ws;
global.fetch = fetch;

// Use Neon WebSocket driver (same as server.js)
const { Pool } = require('@neondatabase/serverless');
const { S3Client, CopyObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load email service for sending approval notifications
// Load environment variables from the correct .env file location
// Go up two levels from scripts/ to reach the charitystream folder
const envPath = path.join(__dirname, '..', '..', '.env');
console.log('🔍 Looking for .env file at:', envPath);

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  console.log('✅ Loaded .env file from:', envPath);
} else {
  // Fallback: try loading from current directory
  require('dotenv').config();
  console.log('⚠️  Using default .env location');
}

// NOW load email service after env vars are available
const emailService = require('../services/emailService');
const { normalizeBareMediaR2Link } = require('../lib/normalizeBareMediaR2Link');

console.log('🔗 DATABASE_URL present:', !!process.env.DATABASE_URL);

// Use the same database configuration as your server.js (Neon WebSocket)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true
});

pool.on('connect', () => {
  console.log('🟢 Neon WebSocket connected');
});

pool.on('error', (err) => {
  console.error('❌ Neon WebSocket error:', err);
});

// Configure Cloudflare R2 client for bucket operations
const R2_CONFIG = {
  accessKeyId: '9eeb17f20eafece615e6b3520faf05c0',
  secretAccessKey: '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4',
  endpoint: 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com',
  accountId: 'e94c5ecbf3e438d402b3fe2ad136c0fc'
};

const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_CONFIG.endpoint,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey
  }
});

// Bucket names
const SOURCE_BUCKET = 'advertiser-media';
const DESTINATION_BUCKET = 'charity-stream-videos';
// Public URL for charity-stream-videos bucket (different from advertiser-media)
const R2_PUBLIC_URL = process.env.R2_VIDEOS_URL || 'https://videos.stream.charity';

/**
 * Monday 00:00 America/Los_Angeles for the billing week containing `date` (same logic as backend/server.js getBillingWeekStart).
 */
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
  parts.forEach((part) => {
    if (part.type !== 'literal') {
      laValues[part.type] = part.value;
    }
  });

  const year = parseInt(laValues.year, 10);
  const month = parseInt(laValues.month, 10);
  const day = parseInt(laValues.day, 10);

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[laValues.weekday] ?? 1;

  const daysToMonday = weekday === 0 ? 6 : weekday - 1;

  const mondayDate = new Date(year, month - 1, day - daysToMonday);

  const mondayYear = mondayDate.getFullYear();
  const mondayMonth = mondayDate.getMonth() + 1;
  const mondayDay = mondayDate.getDate();

  const isDST = mondayMonth >= 3 && mondayMonth <= 11;
  const offsetHours = isDST ? 7 : 8;

  return new Date(Date.UTC(mondayYear, mondayMonth - 1, mondayDay, offsetHours, 0, 0, 0));
}

// Check if file exists in a bucket
async function checkFileExistsInBucket(bucketName, key) {
  try {
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: key
    });
    await r2Client.send(headCommand);
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    // For other errors, throw them
    throw error;
  }
}

// Copy media (video or image) from advertiser-media bucket to charity-stream-videos bucket
async function copyMediaToCharityBucket(sourceKey, destinationFilename) {
  try {
    console.log(`📋 Copying media from ${SOURCE_BUCKET}/${sourceKey} to ${DESTINATION_BUCKET}/${destinationFilename}`);
    
    // Verify source file exists
    const sourceExists = await checkFileExistsInBucket(SOURCE_BUCKET, sourceKey);
    if (!sourceExists) {
      console.error(`❌ Source file not found in ${SOURCE_BUCKET}/${sourceKey}`);
      return { success: false, error: 'Source file not found' };
    }
    
    console.log(`✅ Source file exists in ${SOURCE_BUCKET}`);

    // Copy to destination bucket
    const copyCommand = new CopyObjectCommand({
      Bucket: DESTINATION_BUCKET,
      CopySource: `${SOURCE_BUCKET}/${sourceKey}`,
      Key: destinationFilename
    });

    await r2Client.send(copyCommand);
    console.log(`✅ Media copied successfully to ${DESTINATION_BUCKET}/${destinationFilename}`);
    
    return { 
      success: true, 
      destinationUrl: `${R2_PUBLIC_URL}/${destinationFilename}`
    };
    
  } catch (error) {
    console.error(`❌ Copy failed:`, error.message);
    return { success: false, error: error.message };
  }
}

// Generate a globally unique filename based on ad_format
// Videos: video_{advertiserId}_{timestamp}_{uuid}.mp4
// Images: image_{advertiserId}_{timestamp}_{uuid}.{jpg|png|gif|webp}
function generateUniqueFilename(advertiserId, originalFilename, adFormat) {
  const uniqueId = crypto.randomUUID();
  const timestamp = Date.now();
  
  // Determine prefix based on ad_format
  const prefix = (adFormat === 'image' || adFormat === 'static_image') ? 'image' : 'video';
  
  // Extract extension from original filename, with fallback
  const extension = originalFilename.split('.').pop() || 
                    ((adFormat === 'image' || adFormat === 'static_image') ? 'jpg' : 'mp4');
  
  const newFilename = `${prefix}_${advertiserId}_${timestamp}_${uniqueId}.${extension}`;
  return newFilename;
}

/**
 * Parses --id=<n> or --id <n> from process.argv.
 * Invalid/missing value after --id exits the process with code 1.
 * @returns {number|null} campaign id, or null for batch mode
 */
function parseCliCampaignId() {
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--id=')) {
      const raw = arg.slice('--id='.length).trim();
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) {
        console.error('❌ Invalid --id=value: expected a numeric campaign id');
        process.exit(1);
      }
      return n;
    }
    if (arg === '--id') {
      const next = process.argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        console.error('❌ --id requires a numeric value (e.g. --id 314 or --id=314)');
        process.exit(1);
      }
      const n = parseInt(next, 10);
      if (!Number.isFinite(n)) {
        console.error('❌ Invalid --id value: expected a numeric campaign id');
        process.exit(1);
      }
      return n;
    }
  }
  return null;
}

async function processExpeditedAdvertisers() {
  let client;
  try {
    const onlyId = parseCliCampaignId();
    console.log('🔄 Processing expedited advertisers (recurring, $5 fee path)...');
    if (onlyId != null) {
      console.log('🎯 Single campaign mode: id =', onlyId);
    }
    console.log('📦 Source bucket:', SOURCE_BUCKET);
    console.log('🎯 Destination bucket:', DESTINATION_BUCKET);
    
    // Test connection first
    client = await pool.connect();
    console.log('✅ Database connection established');
    
    // Batch: pending_review, not paused (script sets status = active after copy)
    const selectParams = [];
    let idClause = '';
    if (onlyId != null) {
      selectParams.push(onlyId);
      idClause = ` AND id = $${selectParams.length}`;
    }
    const advertisersResult = await client.query(
      `
      SELECT id, company_name, email, website_url, media_r2_link, ad_format, 
             click_tracking, destination_url, cpm_rate, weekly_budget_cap, expedited,
             is_paused, recurring_weekly, campaign_start_date
      FROM advertisers 
      WHERE status = 'pending_review'
        AND expedited = TRUE
        AND is_paused = false
        AND ad_format IN ('video', 'image', 'static_image')
        AND media_r2_link IS NOT NULL
        ${idClause}
    `,
      selectParams
    );

    if (onlyId != null && advertisersResult.rows.length === 0) {
      console.error(
        `❌ Campaign ${onlyId} not found or not eligible for processing. ` +
          `Requires: status = 'pending_review', expedited = TRUE, is_paused = false, ` +
          `ad_format IN ('video', 'image', 'static_image'), and media_r2_link IS NOT NULL.`
      );
      client.release();
      client = null;
      await pool.end();
      process.exit(1);
    }

    console.log(`📊 Found ${advertisersResult.rows.length} advertiser campaign(s) pending activation`);

    let successCount = 0;
    let errorCount = 0;

    // Process each advertiser
    for (const advertiser of advertisersResult.rows) {
      console.log(`\n🔍 Processing advertiser: ${advertiser.company_name}`);
      console.log(`📧 Advertiser ID: ${advertiser.id}`);
      console.log(`📧 Email: ${advertiser.email}`);

      const rawMediaLink = advertiser.media_r2_link;
      const cleanedMediaLink = normalizeBareMediaR2Link(rawMediaLink);
      if (cleanedMediaLink != null && cleanedMediaLink !== rawMediaLink) {
        await client.query(
          `UPDATE advertisers SET media_r2_link = $1 WHERE id = $2`,
          [cleanedMediaLink, advertiser.id]
        );
        advertiser.media_r2_link = cleanedMediaLink;
        console.log(`🧹 Normalized media_r2_link for id=${advertiser.id}`);
      }
      
      // Log click tracking status for existing icon system
      console.log(`🔗 Click tracking enabled: ${advertiser.click_tracking ? 'YES' : 'NO'}`);
      if (advertiser.click_tracking && advertiser.destination_url) {
        console.log(`🔗 Destination URL: ${advertiser.destination_url} (will be used by existing icon system)`);
      } else if (advertiser.click_tracking && !advertiser.destination_url) {
        console.log(`⚠️ Click tracking enabled but no destination_url - icon may not work properly`);
      }
      
      // Extract media filename from R2 link or use video_filename if available
      // For creative replacements, media_r2_link points to advertiser-media bucket
      // The filename is stored in video_filename or can be extracted from media_r2_link
      let originalMediaFilename = advertiser.video_filename;
      
      // If video_filename is not set, try to extract from media_r2_link
      if (!originalMediaFilename && advertiser.media_r2_link) {
        originalMediaFilename = extractMediaFilename(advertiser.media_r2_link, advertiser.ad_format);
      }
      
      // If still no filename, try to extract just the filename from the URL
      if (!originalMediaFilename && advertiser.media_r2_link) {
        // Handle both full URLs and just filenames
        const urlParts = advertiser.media_r2_link.split('/');
        const lastPart = urlParts[urlParts.length - 1];
        // Support both video and image extensions
        const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const allExtensions = [...videoExtensions, ...imageExtensions];
        if (lastPart && allExtensions.some(ext => lastPart.toLowerCase().endsWith(ext))) {
          originalMediaFilename = lastPart;
        }
      }
      
      if (!originalMediaFilename) {
        console.log(`❌ Could not determine media filename from media_r2_link: ${advertiser.media_r2_link}`);
        errorCount++;
        continue;
      }

      const mediaType = advertiser.ad_format === 'image' || advertiser.ad_format === 'static_image' ? 'image' : 'video';
      console.log(`📹 Original ${mediaType}: ${originalMediaFilename}`);
      
      // Generate a globally unique filename based on ad_format
      // Videos: video_{id}_{timestamp}_{uuid}.mp4
      // Images: image_{id}_{timestamp}_{uuid}.{ext}
      const standardizedFilename = generateUniqueFilename(advertiser.id, originalMediaFilename, advertiser.ad_format);
      console.log(`🎯 Unique filename: ${standardizedFilename}`);
      
      try {
        // CRITICAL FIX: Check if media exists in SOURCE bucket before copying
        console.log(`📦 Checking if source media exists in ${SOURCE_BUCKET} bucket...`);
        
        const sourceExists = await checkFileExistsInBucket(SOURCE_BUCKET, originalMediaFilename);
        if (!sourceExists) {
          console.log(`❌ Source media not found in ${SOURCE_BUCKET} bucket: ${originalMediaFilename}`);
          errorCount++;
          continue;
        }
        
        console.log(`✅ Source media found, copying to ${DESTINATION_BUCKET}...`);
        
        // Copy the media from advertiser-media to charity-stream-videos with standardized name
        const copyResult = await copyMediaToCharityBucket(originalMediaFilename, standardizedFilename);
        
        if (copyResult.success) {
          // Delete the original file from advertiser-media bucket after successful copy
          try {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: SOURCE_BUCKET,
              Key: originalMediaFilename
            });
            await r2Client.send(deleteCommand);
            console.log(`✅ Deleted original file from ${SOURCE_BUCKET}: ${originalMediaFilename}`);
          } catch (deleteError) {
            console.error(`⚠️ Failed to delete original file from ${SOURCE_BUCKET} (non-critical):`, deleteError.message);
            // Continue even if delete fails - the file is already copied
          }
          console.log(`✅ Media copied successfully!`);
          console.log(`🔗 New media URL: ${copyResult.destinationUrl}`);
          
          // Update advertiser record with all required fields
          console.log(`💾 Updating advertiser record with approval status...`);
          
          // Build update query with all required columns
          // After approval, video is in charity-stream-videos bucket, so media_r2_link must point there
          // Generate full public URL for the standardized filename in charity-stream-videos bucket
          const fullPublicUrl = normalizeBareMediaR2Link(`${R2_PUBLIC_URL}/${standardizedFilename}`);
          
          // Expedited recurring: Monday that started the current billing week (LA).
          const lastMonday = getBillingWeekStart(new Date());
          const startDate = lastMonday;
          console.log(`📅 Expedited campaign: go-live set to billing week Monday (LA): ${startDate.toISOString()}`);
          
          // Always update media_r2_link and video_filename after approval (both new and replacement)
          // The video is now in charity-stream-videos, so media_r2_link must point there
          const updateQuery = `
            UPDATE advertisers SET
              status = 'active',
              video_filename = $2,
              media_r2_link = $3,
              is_paused = false,
              current_week_start = $4,
              campaign_start_date = $5,
              approved_at = COALESCE(approved_at, NOW()),
              updated_at = NOW()
            WHERE id = $1
          `;
          
          try {
            await client.query(updateQuery, [advertiser.id, standardizedFilename, fullPublicUrl, startDate, startDate]);
            console.log(`✅ Advertiser record updated: ${advertiser.company_name} (ID: ${advertiser.id})`);
            console.log(`📹 Media filename set: ${standardizedFilename}`);
            console.log(`🎉 Updated media_r2_link → ${fullPublicUrl}`);
            
            // Verification: ensure click tracking data saved correctly
            const verifyResult = await client.query(
              `SELECT click_tracking, destination_url, status 
               FROM advertisers WHERE id = $1`,
              [advertiser.id]
            );
            const saved = verifyResult.rows[0] || {};
            console.log('✅ Verification - Saved data:', {
              click_tracking: saved.click_tracking,
              destination_url: saved.destination_url,
              status: saved.status
            });
          } catch (updateError) {
            // If some columns don't exist, try a simpler update
            console.log(`⚠️ Full update failed, trying simplified update...`);
            console.log(`⚠️ Error: ${updateError.message}`);
            try {
              // Generate full public URL for the standardized filename in charity-stream-videos bucket
              const fullPublicUrl = normalizeBareMediaR2Link(`${R2_PUBLIC_URL}/${standardizedFilename}`);
              
              // Simplified update - same start date as main path (billing week Monday LA)
              const simpleUpdateQuery = `
                UPDATE advertisers SET 
                  status = 'active',
                  video_filename = $2,
                  media_r2_link = $3,
                  is_paused = false,
                  current_week_start = $4,
                  campaign_start_date = $5,
                  updated_at = NOW() 
                WHERE id = $1
              `;
              
              await client.query(simpleUpdateQuery, [advertiser.id, standardizedFilename, fullPublicUrl, startDate, startDate]);
              console.log(`✅ Advertiser record updated (simplified): ${advertiser.company_name}`);
              console.log(`📹 Video filename set: ${standardizedFilename}`);
              console.log(`🎉 Updated media_r2_link → ${fullPublicUrl}`);
              
              // Verification for simplified path
              const verifyResult = await client.query(
                `SELECT click_tracking, destination_url, status 
                 FROM advertisers WHERE id = $1`,
                [advertiser.id]
              );
              const saved = verifyResult.rows[0] || {};
              console.log('✅ Verification - Saved data (simplified):', {
                click_tracking: saved.click_tracking,
                destination_url: saved.destination_url,
                status: saved.status
              });
            } catch (simpleError) {
              console.error(`❌ Database update failed:`, simpleError.message);
              throw simpleError;
            }
          }
          
          // Send approval email to advertiser
          if (emailService && emailService.isEmailConfigured()) {
            try {
              console.log(`📧 Sending approval email to: ${advertiser.email}`);
              
              // Generate initial setup token for approval email
              // Campaign approval email (Email #2) does NOT generate tokens
              // Approval email only links to advertiser-login.html
              let rawInitialSetupToken = null; // Always null for approval emails
              
              // Build campaign summary for email
              const campaignSummary = {
                ad_format: advertiser.ad_format,
                cpm_rate: advertiser.cpm_rate,
                weekly_budget_cap: advertiser.weekly_budget_cap,
                expedited: advertiser.expedited,
                click_tracking: advertiser.click_tracking
              };
              
              // Use the new approval email function (distinct content)
              const emailResult = await emailService.sendAdvertiserApprovalEmail(
                advertiser.email,
                advertiser.company_name,
                campaignSummary,
                rawInitialSetupToken
              );
              
              if (emailResult.success) {
                console.log(`✅ Approval email sent successfully to ${advertiser.email}`);
              } else {
                console.error(`❌ Failed to send approval email:`, emailResult.error);
                // Don't fail the entire process if email fails
              }
            } catch (emailError) {
              console.error(`❌ Error sending approval email:`, emailError.message);
              // Don't fail the entire process if email fails
            }
          } else {
            console.log(`⚠️ Email service not configured - skipping approval email`);
          }
          
          successCount++;
        } else {
          console.log(`❌ Failed to copy media for ${advertiser.company_name}: ${copyResult.error}`);
          errorCount++;
        }
        
      } catch (error) {
        console.error(`❌ Error processing ${advertiser.company_name}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n🎉 Processing complete!');
    console.log(`✅ Successful: ${successCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    
    if (successCount > 0) {
      console.log('\n📢 IMPORTANT: Media (videos and images) have been copied to charity-stream-videos bucket');
      console.log('📢 Media have been assigned unique filenames to prevent collisions');
      console.log('📢 Videos will AUTOMATICALLY appear in video playlist rotation');
      console.log('📢 Images will AUTOMATICALLY appear in popup ad rotation');
      console.log('📢 No code changes needed - dynamic discovery is enabled!');
      console.log('📢 Just refresh the website/app to see new media');
    }
    
  } catch (error) {
    console.error('\n❌ Error processing expedited advertisers:', error);
    if (error.code === 'ECONNREFUSED') {
      console.error('💡 Database connection refused. Check your DATABASE_URL:');
      console.error('💡 Current DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'Not set');
    } else if (error.code === 'NoSuchBucket') {
      console.error('💡 R2 bucket not found. Check your bucket names:');
      console.error('💡 Source bucket:', SOURCE_BUCKET);
      console.error('💡 Destination bucket:', DESTINATION_BUCKET);
    } else if (error.name === 'CredentialsProviderError') {
      console.error('💡 R2 credentials error. Check your R2_CONFIG credentials');
    }
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}

function extractMediaFilename(r2Url, adFormat) {
  if (!r2Url) return null;
  
  // Extract filename from R2 URL
  // Example: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4
  // Example: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/image_1.jpg
  const urlParts = r2Url.split('/');
  const filename = urlParts[urlParts.length - 1];
  
  if (!filename) return null;
  
  // Validate it matches the expected format
  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const allExtensions = [...videoExtensions, ...imageExtensions];
  const isValidMedia = allExtensions.some(ext => filename.toLowerCase().endsWith(ext));
  
  if (filename && isValidMedia) {
    return filename;
  }
  
  return null;
}

// Add better error handling for database connection
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled promise rejection:', err);
  process.exit(1);
});

// Run if called directly
if (require.main === module) {
  // Check if DATABASE_URL is set
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is not set');
    console.error('💡 Current directory:', __dirname);
    console.error('💡 Tried to load .env from:', envPath);
    console.error('💡 Make sure you have a .env file in the charitystream folder');
    process.exit(1);
  }
  
  console.log('🔗 Database URL loaded successfully');
  processExpeditedAdvertisers();
}

module.exports = { processExpeditedAdvertisers, extractMediaFilename };

