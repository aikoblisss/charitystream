const { Pool } = require('pg');
const { S3Client, CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');

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

console.log('🔗 DATABASE_URL present:', !!process.env.DATABASE_URL);

// Use the same database configuration as your server.js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Add connection timeout and retry settings
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
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
const R2_PUBLIC_URL = 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev';

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

// Copy video from advertiser-media bucket to charity-stream-videos bucket
async function copyVideoToCharityBucket(sourceKey, destinationFilename) {
  try {
    console.log(`📋 Copying video from ${SOURCE_BUCKET}/${sourceKey} to ${DESTINATION_BUCKET}/${destinationFilename}`);
    
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
    console.log(`✅ Video copied successfully to ${DESTINATION_BUCKET}/${destinationFilename}`);
    
    return { 
      success: true, 
      destinationUrl: `${R2_PUBLIC_URL}/${destinationFilename}`
    };
    
  } catch (error) {
    console.error(`❌ Copy failed:`, error.message);
    return { success: false, error: error.message };
  }
}

// Get next available video number by scanning charity-stream-videos bucket
async function getNextVideoNumber() {
  try {
    console.log(`🔍 Scanning ${DESTINATION_BUCKET} bucket for existing videos...`);
    
    const listCommand = new ListObjectsV2Command({
      Bucket: DESTINATION_BUCKET
    });
    
    const response = await r2Client.send(listCommand);
    const videoFiles = response.Contents || [];
    
    console.log(`📊 Found ${videoFiles.length} total files in bucket`);
    
    // Find highest video number from video_X.mp4 pattern
    let maxNumber = 0;
    videoFiles.forEach(file => {
      const match = file.Key.match(/^video_(\d+)\.mp4$/);
      if (match) {
        const num = parseInt(match[1]);
        console.log(`   Found: video_${num}.mp4`);
        if (num > maxNumber) maxNumber = num;
      }
    });
    
    const nextNumber = maxNumber + 1;
    console.log(`🎯 Next available video number: ${nextNumber}`);
    return nextNumber;
  } catch (error) {
    console.error('❌ Error listing bucket contents:', error.message);
    // Default to 6 if we can't list the bucket
    console.log('⚠️ Defaulting to video number 6');
    return 6;
  }
}

async function processApprovedAdvertisers() {
  let client;
  try {
    console.log('🔄 Processing approved advertisers...');
    console.log('📦 Source bucket:', SOURCE_BUCKET);
    console.log('🎯 Destination bucket:', DESTINATION_BUCKET);
    
    // Test connection first
    client = await pool.connect();
    console.log('✅ Database connection established');
    
    // Get all approved video advertisers that haven't been completed yet
    // ONLY process video ads (not images)
    const advertisersResult = await client.query(`
      SELECT id, company_name, email, website_url, media_r2_link, ad_format, 
             click_tracking, destination_url, cpm_rate, weekly_budget_cap, expedited
      FROM advertisers 
      WHERE approved = true 
        AND completed = false 
        AND ad_format = 'video'
        AND media_r2_link IS NOT NULL
    `);

    console.log(`📊 Found ${advertisersResult.rows.length} approved video advertisers pending processing`);

    let successCount = 0;
    let errorCount = 0;

    // Process each advertiser
    for (const advertiser of advertisersResult.rows) {
      console.log(`\n🔍 Processing advertiser: ${advertiser.company_name}`);
      console.log(`📧 Advertiser ID: ${advertiser.id}`);
      console.log(`📧 Email: ${advertiser.email}`);
      
      // Log click tracking status for existing icon system
      console.log(`🔗 Click tracking enabled: ${advertiser.click_tracking ? 'YES' : 'NO'}`);
      if (advertiser.click_tracking && advertiser.destination_url) {
        console.log(`🔗 Destination URL: ${advertiser.destination_url} (will be used by existing icon system)`);
      } else if (advertiser.click_tracking && !advertiser.destination_url) {
        console.log(`⚠️ Click tracking enabled but no destination_url - icon may not work properly`);
      }
      
      // Extract video filename from R2 link
      const originalVideoFilename = extractVideoFilename(advertiser.media_r2_link);
      
      if (!originalVideoFilename) {
        console.log(`❌ Could not extract video filename from: ${advertiser.media_r2_link}`);
        errorCount++;
        continue;
      }

      console.log(`📹 Original video: ${originalVideoFilename}`);
      
      // Get next available video number to follow video_X.mp4 pattern
      const nextVideoNumber = await getNextVideoNumber();
      const standardizedFilename = `video_${nextVideoNumber}.mp4`;
      console.log(`🎯 Standardized filename: ${standardizedFilename} (auto-numbered)`);
      
      try {
        // CRITICAL FIX: Check if video exists in SOURCE bucket before copying
        console.log(`📦 Checking if source video exists in ${SOURCE_BUCKET} bucket...`);
        
        const sourceExists = await checkFileExistsInBucket(SOURCE_BUCKET, originalVideoFilename);
        if (!sourceExists) {
          console.log(`❌ Source video not found in ${SOURCE_BUCKET} bucket: ${originalVideoFilename}`);
          errorCount++;
          continue;
        }
        
        console.log(`✅ Source video found, copying to ${DESTINATION_BUCKET}...`);
        
        // Copy the video from advertiser-media to charity-stream-videos with standardized name
        const copyResult = await copyVideoToCharityBucket(originalVideoFilename, standardizedFilename);
        
        if (copyResult.success) {
          console.log(`✅ Video copied successfully!`);
          console.log(`🔗 New video URL: ${copyResult.destinationUrl}`);
          
          // Update advertiser record with all required fields
          console.log(`💾 Updating advertiser record with approval status...`);
          
          // Build update query with all required columns
          // Note: Some columns may not exist - PostgreSQL will ignore them gracefully
          // IMPORTANT: Only set video_filename if it's NULL (don't overwrite existing values)
          const updateQuery = `
            UPDATE advertisers SET
              completed = true,
              application_status = 'approved',
              video_filename = COALESCE(video_filename, $2),
              current_week_start = COALESCE(current_week_start, NOW()),
              campaign_start_date = COALESCE(campaign_start_date, NOW()),
              approved_at = COALESCE(approved_at, NOW()),
              updated_at = NOW()
            WHERE id = $1
          `;
          
          try {
            await client.query(updateQuery, [advertiser.id, standardizedFilename]);
            console.log(`✅ Advertiser record updated: ${advertiser.company_name} (ID: ${advertiser.id})`);
            console.log(`📹 Video filename set: ${standardizedFilename}`);
            
            // Verification: ensure click tracking data saved correctly
            const verifyResult = await client.query(
              `SELECT click_tracking, destination_url, application_status, completed 
               FROM advertisers WHERE id = $1`,
              [advertiser.id]
            );
            const saved = verifyResult.rows[0] || {};
            console.log('✅ Verification - Saved data:', {
              click_tracking: saved.click_tracking,
              destination_url: saved.destination_url,
              application_status: saved.application_status,
              completed: saved.completed
            });
          } catch (updateError) {
            // If some columns don't exist, try a simpler update
            console.log(`⚠️ Full update failed, trying simplified update...`);
            console.log(`⚠️ Error: ${updateError.message}`);
            try {
              // Still try to set video_filename in simplified update
              await client.query(
                `UPDATE advertisers SET 
                  completed = true, 
                  application_status = 'approved', 
                  video_filename = COALESCE(video_filename, $2),
                  updated_at = NOW() 
                WHERE id = $1`,
                [advertiser.id, standardizedFilename]
              );
              console.log(`✅ Advertiser record updated (simplified): ${advertiser.company_name}`);
              console.log(`📹 Video filename set: ${standardizedFilename}`);
              
              // Verification for simplified path
              const verifyResult = await client.query(
                `SELECT click_tracking, destination_url, application_status, completed 
                 FROM advertisers WHERE id = $1`,
                [advertiser.id]
              );
              const saved = verifyResult.rows[0] || {};
              console.log('✅ Verification - Saved data (simplified):', {
                click_tracking: saved.click_tracking,
                destination_url: saved.destination_url,
                application_status: saved.application_status,
                completed: saved.completed
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
              
              // Generate portal signup token for approval email
              const crypto = require('crypto');
              const portalSignupToken = crypto.randomUUID();
              console.log(`🔑 [PORTAL SIGNUP] Generated token for advertiser approval: ${portalSignupToken.substring(0, 8)}...`);
              
              // Save token to database
              try {
                await client.query(`
                  UPDATE advertisers
                  SET portal_signup_token = $1,
                      portal_signup_token_created_at = NOW()
                  WHERE id = $2
                `, [portalSignupToken, advertiser.id]);
                console.log(`✅ [PORTAL SIGNUP] Token saved to database for advertiser: ${advertiser.id}`);
              } catch (tokenError) {
                console.error(`❌ [PORTAL SIGNUP] Failed to save token:`, tokenError.message);
              }
              
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
                portalSignupToken
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
          console.log(`❌ Failed to copy video for ${advertiser.company_name}: ${copyResult.error}`);
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
      console.log('\n📢 IMPORTANT: Videos have been copied to charity-stream-videos bucket');
      console.log('📢 Videos have been auto-numbered following the video_X.mp4 pattern');
      console.log('📢 These videos will AUTOMATICALLY appear in website/app rotation');
      console.log('📢 No code changes needed - dynamic discovery is enabled!');
      console.log('📢 Just refresh the website/app to see new videos');
    }
    
  } catch (error) {
    console.error('\n❌ Error processing approved advertisers:', error);
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

function extractVideoFilename(r2Url) {
  if (!r2Url) return null;
  
  // Extract filename from R2 URL
  // Example: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4
  const urlParts = r2Url.split('/');
  const filename = urlParts[urlParts.length - 1];
  
  // Validate it's a video file
  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
  const isVideo = videoExtensions.some(ext => filename.toLowerCase().endsWith(ext));
  
  if (filename && isVideo) {
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
  processApprovedAdvertisers();
}

module.exports = { processApprovedAdvertisers, extractVideoFilename };

