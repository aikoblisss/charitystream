const { Pool } = require('pg');
const { S3Client, CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');

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
    
    // Get all approved advertisers with video format that haven't been completed yet
    const advertisersResult = await client.query(`
      SELECT id, company_name, website_url, media_r2_link, ad_format
      FROM advertisers 
      WHERE approved = true AND ad_format = 'video' AND completed = false
    `);

    console.log(`📊 Found ${advertisersResult.rows.length} approved video advertisers pending processing`);

    let successCount = 0;
    let errorCount = 0;

    // Process each advertiser
    for (const advertiser of advertisersResult.rows) {
      console.log(`\n🔍 Processing advertiser: ${advertiser.company_name}`);
      console.log(`📧 Advertiser ID: ${advertiser.id}`);
      
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
          
          // Check if mapping already exists (by advertiser_id)
          const existingMapping = await client.query(
            'SELECT id, video_filename FROM video_advertiser_mappings WHERE advertiser_id = $1 AND is_active = true',
            [advertiser.id]
          );

          if (existingMapping.rows.length > 0) {
            // UPDATE existing mapping with new standardized filename
            console.log(`🔄 Updating existing mapping with new video filename...`);
            await client.query(
              'UPDATE video_advertiser_mappings SET video_filename = $1 WHERE advertiser_id = $2',
              [standardizedFilename, advertiser.id]
            );
            console.log(`✅ Updated mapping: ${standardizedFilename} → ${advertiser.company_name}`);
          } else {
            // CREATE new mapping
            await client.query(
              `INSERT INTO video_advertiser_mappings 
               (advertiser_id, video_filename, website_url, company_name) 
               VALUES ($1, $2, $3, $4)`,
              [advertiser.id, standardizedFilename, advertiser.website_url, advertiser.company_name]
            );
            console.log(`✅ Added mapping: ${standardizedFilename} → ${advertiser.company_name} (${advertiser.website_url})`);
          }
          
          // NEW: Mark advertiser as completed after successful processing
          await client.query(
            'UPDATE advertisers SET completed = true WHERE id = $1',
            [advertiser.id]
          );
          console.log(`✅ Marked advertiser ${advertiser.company_name} (ID: ${advertiser.id}) as completed`);
          
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

