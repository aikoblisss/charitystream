const { Pool } = require('pg');
const { S3Client, CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// Load environment variables from the correct .env file location
const envPath = path.join(__dirname, '..', '..', '.env');
console.log('🔍 Looking for .env file at:', envPath);

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  console.log('✅ Loaded .env file from:', envPath);
} else {
  require('dotenv').config();
  console.log('⚠️  Using default .env location');
}

console.log('🔗 DATABASE_URL present:', !!process.env.DATABASE_URL);

// Database configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

// R2 Configuration (same as process-approved-advertisers.js)
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

// Bucket configuration
const CHARITY_BUCKET = 'charity-stream-videos';

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to get user input
function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

// Check if file exists in R2 bucket
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
    throw error;
  }
}

// List all videos in the charity-stream-videos bucket
async function listVideosInBucket() {
  try {
    console.log(`🔍 Scanning ${CHARITY_BUCKET} bucket for videos...`);
    
    const listCommand = new ListObjectsV2Command({
      Bucket: CHARITY_BUCKET
    });
    
    const response = await r2Client.send(listCommand);
    const allFiles = response.Contents || [];
    
    // Filter for video files (video_X.mp4 pattern and other video files)
    const videoFiles = allFiles
      .filter(file => {
        const filename = file.Key;
        // Accept both video_X.mp4 pattern and other video files
        return /^video_\d+\.mp4$/.test(filename) || 
               /\.(mp4|webm|mov|avi|mkv)$/i.test(filename);
      })
      .sort((a, b) => {
        // Sort by filename naturally
        return a.Key.localeCompare(b.Key, undefined, { numeric: true });
      });
    
    console.log(`📊 Found ${videoFiles.length} videos in ${CHARITY_BUCKET} bucket`);
    return videoFiles;
    
  } catch (error) {
    console.error('❌ Error listing bucket contents:', error.message);
    throw error;
  }
}

// Get database mappings for videos
async function getVideoMappings(client) {
  try {
    const result = await client.query(`
      SELECT id, video_filename, website_url, company_name, advertiser_id
      FROM video_advertiser_mappings 
      WHERE is_active = true
      ORDER BY video_filename
    `);
    
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching video mappings:', error.message);
    throw error;
  }
}

// Delete video from R2 bucket
async function deleteVideoFromBucket(videoFilename) {
  try {
    console.log(`🗑️ Deleting ${videoFilename} from R2 bucket...`);
    
    const deleteCommand = new DeleteObjectCommand({
      Bucket: CHARITY_BUCKET,
      Key: videoFilename
    });
    
    await r2Client.send(deleteCommand);
    console.log(`✅ Deleted ${videoFilename} from R2 bucket`);
    return true;
    
  } catch (error) {
    console.error(`❌ Failed to delete ${videoFilename}:`, error.message);
    return false;
  }
}

// Deactivate video mapping in database
async function deactivateVideoMapping(client, videoFilename) {
  try {
    console.log(`📝 Deactivating mapping for ${videoFilename} in database...`);
    
    const result = await client.query(
      'UPDATE video_advertiser_mappings SET is_active = false WHERE video_filename = $1',
      [videoFilename]
    );
    
    if (result.rowCount > 0) {
      console.log(`✅ Deactivated mapping for ${videoFilename}`);
      return true;
    } else {
      console.log(`⚠️ No mapping found for ${videoFilename}`);
      return true; // Not an error, just no mapping to deactivate
    }
    
  } catch (error) {
    console.error(`❌ Failed to deactivate mapping for ${videoFilename}:`, error.message);
    return false;
  }
}

// Renumber remaining videos to maintain sequential order
async function renumberVideos(videos, deletedVideoFilename, client) {
  try {
    console.log(`🔄 Renumbering remaining videos...`);
    
    // Filter out the deleted video
    const remainingVideos = videos.filter(video => video.Key !== deletedVideoFilename);
    
    // Find videos that need renumbering (video_X.mp4 pattern)
    const videoPatternVideos = remainingVideos.filter(video => /^video_\d+\.mp4$/.test(video.Key));
    const nonPatternVideos = remainingVideos.filter(video => !/^video_\d+\.mp4$/.test(video.Key));
    
    console.log(`📊 ${videoPatternVideos.length} videos need renumbering (video_X.mp4 pattern)`);
    console.log(`📊 ${nonPatternVideos.length} videos will keep original names`);
    
    let renumberCount = 0;
    
    // Renumber video_X.mp4 files sequentially
    for (let i = 0; i < videoPatternVideos.length; i++) {
      const currentVideo = videoPatternVideos[i];
      const newFilename = `video_${i + 1}.mp4`;
      
      // Skip if already correctly numbered
      if (currentVideo.Key === newFilename) {
        console.log(`✅ ${currentVideo.Key} already correctly numbered`);
        continue;
      }
      
      console.log(`📝 Renaming: ${currentVideo.Key} → ${newFilename}`);
      
      // Copy to new filename
      const copyCommand = new CopyObjectCommand({
        Bucket: CHARITY_BUCKET,
        CopySource: `${CHARITY_BUCKET}/${currentVideo.Key}`,
        Key: newFilename
      });
      
      await r2Client.send(copyCommand);
      console.log(`✅ Copied ${currentVideo.Key} to ${newFilename}`);
      
      // Delete old file
      const deleteCommand = new DeleteObjectCommand({
        Bucket: CHARITY_BUCKET,
        Key: currentVideo.Key
      });
      
      await r2Client.send(deleteCommand);
      console.log(`✅ Deleted old file ${currentVideo.Key}`);
      
      // Update database mapping
      const mappingResult = await client.query(
        'UPDATE video_advertiser_mappings SET video_filename = $1 WHERE video_filename = $2 AND is_active = true',
        [newFilename, currentVideo.Key]
      );
      
      if (mappingResult.rowCount > 0) {
        console.log(`✅ Updated database mapping: ${currentVideo.Key} → ${newFilename}`);
      }
      
      renumberCount++;
    }
    
    console.log(`🎉 Renumbering complete! ${renumberCount} videos renumbered`);
    return true;
    
  } catch (error) {
    console.error('❌ Error during renumbering:', error.message);
    return false;
  }
}

// Main video deletion function
async function deleteVideo() {
  let client;
  
  try {
    console.log('\n🎬 Video Management Console');
    console.log('================================\n');
    
    // Test database connection
    client = await pool.connect();
    console.log('✅ Database connection established');
    
    // List all videos in bucket
    const videos = await listVideosInBucket();
    
    if (videos.length === 0) {
      console.log('📭 No videos found in bucket');
      return;
    }
    
    // Display videos with numbers
    console.log('\n📊 Available videos:');
    videos.forEach((video, index) => {
      console.log(`${index + 1}. ${video.Key}`);
    });
    
    // Get video mappings for context
    const mappings = await getVideoMappings(client);
    console.log(`\n📝 Database mappings: ${mappings.length} active mappings found`);
    
    // Get user input for video to delete
    const userInput = await askQuestion('\n❓ Enter the number or filename of video to delete: ');
    
    let selectedVideo = null;
    
    // Parse user input
    const inputNumber = parseInt(userInput);
    if (!isNaN(inputNumber) && inputNumber >= 1 && inputNumber <= videos.length) {
      selectedVideo = videos[inputNumber - 1];
    } else {
      // Try to find by filename
      selectedVideo = videos.find(video => video.Key === userInput);
    }
    
    if (!selectedVideo) {
      console.log('❌ Invalid selection. Please try again.');
      return;
    }
    
    const videoFilename = selectedVideo.Key;
    console.log(`\n🎯 Selected video: ${videoFilename}`);
    
    // Check if video has active mapping
    const videoMapping = mappings.find(mapping => mapping.video_filename === videoFilename);
    if (videoMapping) {
      console.log(`📝 This video is mapped to: ${videoMapping.company_name} (${videoMapping.website_url})`);
    }
    
    // Confirm deletion
    const confirmDelete = await askQuestion(`\n✅ Are you sure you want to delete ${videoFilename}? (y/n): `);
    
    if (confirmDelete.toLowerCase() !== 'y' && confirmDelete.toLowerCase() !== 'yes') {
      console.log('❌ Deletion cancelled');
      return;
    }
    
    console.log('\n🔄 Processing deletion...');
    
    // Step 1: Deactivate database mapping
    const mappingSuccess = await deactivateVideoMapping(client, videoFilename);
    if (!mappingSuccess) {
      console.log('❌ Failed to deactivate mapping. Aborting deletion.');
      return;
    }
    
    // Step 2: Delete from R2 bucket
    const deleteSuccess = await deleteVideoFromBucket(videoFilename);
    if (!deleteSuccess) {
      console.log('❌ Failed to delete from R2. Mapping already deactivated.');
      return;
    }
    
    // Step 3: Renumber remaining videos
    const renumberSuccess = await renumberVideos(videos, videoFilename, client);
    if (!renumberSuccess) {
      console.log('⚠️ Video deleted but renumbering failed. Check bucket manually.');
    }
    
    // Final status
    const remainingVideos = videos.length - 1;
    console.log(`\n🎉 Deletion complete! ${remainingVideos} videos remaining.`);
    console.log('🔄 Dynamic video looping will automatically detect changes.');
    console.log('🌐 No server restart required - changes take effect immediately.');
    
  } catch (error) {
    console.error('\n❌ Error during video deletion:', error);
    if (error.code === 'ECONNREFUSED') {
      console.error('💡 Database connection refused. Check your DATABASE_URL');
    } else if (error.name === 'NoSuchBucket') {
      console.error('💡 R2 bucket not found. Check bucket name:', CHARITY_BUCKET);
    } else if (error.name === 'CredentialsProviderError') {
      console.error('💡 R2 credentials error. Check your R2_CONFIG credentials');
    }
  } finally {
    if (client) {
      client.release();
    }
    rl.close();
    await pool.end();
  }
}

// Error handling for unhandled promise rejections
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
  deleteVideo();
}

module.exports = { deleteVideo, listVideosInBucket, renumberVideos };
