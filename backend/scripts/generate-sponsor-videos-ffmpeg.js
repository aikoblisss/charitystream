// CRITICAL: Load .env FIRST, before any service imports that depend on environment variables
const path = require('path');
const fs = require('fs');

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

// Validation: Confirm EMAIL_HOST is loaded before email service initializes
console.log('🔗 EMAIL_HOST after dotenv:', process.env.EMAIL_HOST ? 'DEFINED' : 'UNDEFINED');
console.log('🔗 DATABASE_URL present:', !!process.env.DATABASE_URL);

// Neon WebSocket + fetch adapters for Node.js (same as server.js)
const ws = require('ws');
const { fetch } = require('undici');

// Provide globals expected by @neondatabase/serverless
global.WebSocket = ws;
global.fetch = fetch;

// Use Neon WebSocket driver (same as server.js)
const { Pool } = require('@neondatabase/serverless');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { exec } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const http = require('http');
const os = require('os');

const execAsync = promisify(exec);
const sharp = require('sharp');

// Rasterize SVG to PNG for FFmpeg (FFmpeg cannot decode SVG)
const SVG_TARGET_WIDTH = 800;

async function rasterizeSvgToPng(svgPath, pngPath) {
  await sharp(svgPath)
    .resize(SVG_TARGET_WIDTH, null, { fit: 'inside' })
    .png()
    .toFile(pngPath);
  return pngPath;
}

function isSvgLogo(logoKey) {
  return path.extname(logoKey).toLowerCase() === '.svg';
}

// Import email service AFTER .env is loaded
let emailService = null;
try {
  emailService = require('../services/emailService');
  console.log('✅ Email service loaded');
} catch (error) {
  console.log('⚠️ Email service not available:', error.message);
}

// Import Stripe AFTER .env is loaded
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe client loaded');
  } else {
    console.log('⚠️ STRIPE_SECRET_KEY not found - Stripe features disabled');
  }
} catch (error) {
  console.log('⚠️ Stripe not available:', error.message);
}

// Helper function to compute the next Monday at midnight (for billing_cycle_anchor)
function getNextMondayMidnight() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  nextMonday.setHours(0, 0, 0, 0);
  return nextMonday;
}

// Next Monday 00:00 America/Los_Angeles (UTC Date), for non-recurring start_week / end_at.
// If today is Monday in LA, returns the following Monday (7 days out).
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

// Helper function to compute the next Monday (local time) - for email display
function getNextMonday() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7;
  
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  nextMonday.setHours(0, 0, 0, 0); // Set to midnight
  
  // Format as "Month Day, Year" (e.g., "January 15, 2024")
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return nextMonday.toLocaleDateString('en-US', options);
}

// Use the same database configuration as server.js (Neon WebSocket)
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

function parseCliSponsorId() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1]) return args[i + 1].trim();
    const match = args[i].match(/^--id=(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

// Configure Cloudflare R2 client
const R2_CONFIG = {
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '9eeb17f20eafece615e6b3520faf05c0',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4',
  endpoint: 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com'
};

const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_CONFIG.endpoint,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey
  }
});

// R2 Bucket Configuration
const UPLOADS_BUCKET = 'charity-stream-sponsor-uploads';
const GENERATED_BUCKET = 'charity-stream-sponsor-generated';
const UPLOADS_PUBLIC_URL = process.env.R2_SPONSOR_UPLOADS_URL || 'https://sponsor-uploads.stream.charity';
const PUBLIC_ASSETS_URL = process.env.R2_PUBLIC_ASSETS_URL || 'https://public.stream.charity';

// Background music — randomly chosen per video, started 60s in (approximate middle of track)
const BACKGROUND_MUSIC_TRACKS = ['song_1.mp3', 'song_2.mp3', 'song_3.mp3'];
const MUSIC_TRIM_SECONDS = 60;

function pickRandomMusicTrack() {
  const filename = BACKGROUND_MUSIC_TRACKS[Math.floor(Math.random() * BACKGROUND_MUSIC_TRACKS.length)];
  return { url: `${PUBLIC_ASSETS_URL}/${filename}`, filename, trimSeconds: MUSIC_TRIM_SECONDS };
}

// Video specifications
const VIDEO_DURATION = 10; // seconds (static baseline - no timing logic)
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const LOGO_MAX_WIDTH = 800;
const LOGO_MAX_HEIGHT = 400;

// Escape text for FFmpeg drawtext filter (handles quotes, backslashes, special chars)
function escapeFFmpegText(text) {
  if (!text) return '';
  // Escape backslashes first
  let escaped = text.replace(/\\/g, '\\\\');
  // Escape single quotes using the '\'' technique.
  // Inside FFmpeg '...' quoted strings, backslash is literal — \' does NOT escape '.
  // The correct approach: close the quoted string, emit \' at level-0 (which IS a
  // literal '), then reopen. Result: text='hello'\''world' → hello'world.
  escaped = escaped.replace(/'/g, "'\\''");
  // Escape colons (FFmpeg special char)
  escaped = escaped.replace(/:/g, '\\:');
  // Escape square brackets (FFmpeg special chars)
  escaped = escaped.replace(/\[/g, '\\[');
  escaped = escaped.replace(/\]/g, '\\]');
  return escaped;
}

// Download file from URL to local path
async function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const file = fs.createWriteStream(outputPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        fs.unlinkSync(outputPath);
        reject(new Error(`Failed to download file: HTTP ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
      
      file.on('error', (err) => {
        fs.unlinkSync(outputPath);
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlinkSync(outputPath);
      reject(err);
    });
  });
}

// Download logo from R2
async function downloadLogoFromR2(logoKey, outputPath) {
  try {
    const command = new GetObjectCommand({
      Bucket: UPLOADS_BUCKET,
      Key: logoKey
    });
    
    const response = await r2Client.send(command);
    
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(outputPath);
      
      response.Body.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
      
      file.on('error', (err) => {
        fs.unlinkSync(outputPath);
        reject(err);
      });
    });
  } catch (error) {
    throw new Error(`Failed to download logo from R2: ${error.message}`);
  }
}

// Generate video using FFmpeg
// Step 1: Synchronized fade-out for top and bottom text (5.0-6.0s)
// Step 2: Fade-in for second set of text (6.0-7.0s, visible until end)
async function generateVideoWithFFmpeg(logoPath, sponsorName, tier, tagline, outputPath, audioPath, audioTrimSeconds = MUSIC_TRIM_SECONDS) {
  // Capitalize the tier for display
  const capitalizedTier = tier ? tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase() : 'Sponsor';
  
  const escapedInitialTopText = escapeFFmpegText(`Thank You to Our ${capitalizedTier} Sponsor, ${sponsorName}`);
  const escapedInitialBottomText = escapeFFmpegText('For Supporting This Week\'s Charity Stream');
  
  // Second set of text (fades in at 6.0s)
  const escapedSecondTopText = escapeFFmpegText(sponsorName);
  const escapedSecondBottomText = tagline ? escapeFFmpegText(tagline) : null;
  
  // FFmpeg filter complex (with synchronized fade-out and fade-in):
  // 1. Draw orange bars at top and bottom
  // 2. Scale logo preserving aspect ratio (max 800x400) and force rgba format
  // 3. Overlay logo in center (centered horizontally and vertically)
  // 4. Draw first top text (visible 0-5s, fades out 5-6s, invisible 6-10s)
  // 5. Draw first bottom text (visible 0-5s, fades out 5-6s, invisible 6-10s)
  // 6. Draw second top text (invisible 0-6s, fades in 6-7s, visible 7-10s)
  // 7. Draw second bottom text if tagline exists (invisible 0-6s, fades in 6-7s, visible 7-10s)
  // Note: Using default font (no fontfile specified for cross-platform compatibility)
  
  // Orange color: #FF6B35 (RGB: 255, 107, 53) - using hex format for drawbox
  const orangeColor = '0xFF6B35';
  const barHeight = 8; // Height of orange bars in pixels
  
  // Fade-out timing constants (first text)
  const fadeOutStart = 5.0; // Fade-out begins at 5.0 seconds
  const fadeOutEnd = 6.0;   // Fade-out completes at 6.0 seconds
  
  // Fade-in timing constants (second text)
  const fadeInStart = 6.0;  // Fade-in begins at 6.0 seconds
  const fadeInEnd = 7.0;    // Fade-in completes at 7.0 seconds
  
  // Alpha expression for synchronized fade-out (first text)
  // Before 5.0s: alpha = 1 (fully visible)
  // Between 5.0-6.0s: linear fade from 1 to 0
  // After 6.0s: alpha = 0 (invisible)
  const fadeOutAlpha =
    `if(lt(t\\,${fadeOutStart})\\,1\\,` +
    `if(lt(t\\,${fadeOutEnd})\\,${fadeOutEnd}-t\\,0))`;
  
  // Alpha expression for fade-in (second text)
  // Before 6.0s: alpha = 0 (invisible)
  // Between 6.0-7.0s: linear fade from 0 to 1
  // After 7.0s: alpha = 1 (fully visible)
  const fadeInAlpha =
    `if(lt(t\\,${fadeInStart})\\,0\\,` +
    `if(lt(t\\,${fadeInEnd})\\,t-${fadeInStart}\\,1))`;
  
  // Build filter chain
  // Step 1: Scale logo, force rgba format
  let filterChain = `[1:v]scale=${LOGO_MAX_WIDTH}:${LOGO_MAX_HEIGHT}:force_original_aspect_ratio=decrease,format=rgba[logo];`;
  
  // Step 2: Create background with orange bars
  filterChain += `[0:v]drawbox=x=0:y=0:w=${VIDEO_WIDTH}:h=${barHeight}:color=${orangeColor}:t=fill,`;
  filterChain += `drawbox=x=0:y=${VIDEO_HEIGHT - barHeight}:w=${VIDEO_WIDTH}:h=${barHeight}:color=${orangeColor}:t=fill[bg];`;
  
  // Step 3: Overlay logo in center
  filterChain += `[bg][logo]overlay=(W-w)/2:(H-h)/2,`;
  
  // Define consistent Y positions
  const topTextY = 100;
  const bottomTextY = VIDEO_HEIGHT - 150; // 150px from bottom (enough space for 36pt text)
  
  // IMPORTANT: Draw fade-in texts FIRST (they appear in background)
  // Then draw fade-out texts LAST (they appear on top and hide the fade-in text when visible)
  
  // Step 4: Second top text (fade-in 6.0-7.0s, visible until end) - DRAW FIRST
  filterChain += `drawtext=text='${escapedSecondTopText}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=${topTextY}:alpha='${fadeInAlpha}',`;
  
  // Step 5: Second bottom text (only if tagline exists) - DRAW FIRST
  if (escapedSecondBottomText) {
    filterChain += `drawtext=text='${escapedSecondBottomText}':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=${bottomTextY}:alpha='${fadeInAlpha}',`;
  }
  
  // Step 6: First top text (fade-out 5.0-6.0s) - DRAW LAST (on top)
  filterChain += `drawtext=text='${escapedInitialTopText}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=${topTextY}:alpha='${fadeOutAlpha}',`;
  
  // Step 7: First bottom text (fade-out 5.0-6.0s) - DRAW LAST (on top)
  filterChain += `drawtext=text='${escapedInitialBottomText}':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=${bottomTextY}:alpha='${fadeOutAlpha}'[vout]`;

  // Write filter_complex to a temp file to avoid all shell quoting/escaping issues.
  // The filter chain contains single quotes (alpha expressions) and semicolons that
  // conflict with shell argument parsing when passed inline via -filter_complex "...".
  // -filter_complex_script reads the filter directly from disk — no shell involvement.
  const filterScriptPath = path.join(path.dirname(outputPath), `filter-${path.basename(outputPath, '.mp4')}.txt`);
  const audioFilter = `[2:a]asetpts=PTS-STARTPTS,afade=t=out:st=${VIDEO_DURATION - 2}:d=2[aout]`;
  fs.writeFileSync(filterScriptPath, `${filterChain};${audioFilter}`);

  const ffmpegCommand = `ffmpeg -y \
    -f lavfi -i color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:d=${VIDEO_DURATION} \
    -i "${logoPath}" \
    -ss ${audioTrimSeconds} -i "${audioPath}" \
    -/filter_complex "${filterScriptPath}" \
    -map "[vout]" \
    -map "[aout]" \
    -c:v libx264 \
    -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -t ${VIDEO_DURATION} \
    "${outputPath}"`;

  try {
    console.log('🎬 Running FFmpeg command (10s with fade-out 5.0-6.0s, fade-in 6.0-7.0s)...');
    console.log('📝 Animation: First text visible 0-5s, fade-out 5-6s, second text fade-in 6-7s, visible 7-10s');
    console.log(`📝 Tier: ${capitalizedTier}`);
    console.log(`📝 Sponsor Name: ${sponsorName}`);
    console.log(`📝 Tagline: ${tagline || 'NULL'}`);
    console.log(`📝 Filter script: ${filterScriptPath}`);
    const { stdout, stderr } = await execAsync(ffmpegCommand, { maxBuffer: 50 * 1024 * 1024 });
    if (stderr && !stderr.includes('frame=') && !stderr.includes('size=')) {
      // FFmpeg outputs progress to stderr, only log actual errors
      console.log('FFmpeg output:', stderr);
    }
    console.log('✅ FFmpeg video generation complete');
    return outputPath;
  } catch (error) {
    console.error('FFmpeg error:', error.message);
    if (error.stderr) {
      console.error('FFmpeg stderr:', error.stderr);
    }
    throw new Error(`FFmpeg generation failed: ${error.message}`);
  }
}

// Upload video to R2
async function uploadVideoToR2(videoPath, key) {
  try {
    const videoBuffer = fs.readFileSync(videoPath);
    
    const putCommand = new PutObjectCommand({
      Bucket: GENERATED_BUCKET,
      Key: key,
      Body: videoBuffer,
      ContentType: 'video/mp4'
    });
    
    await r2Client.send(putCommand);
    console.log(`✅ Video uploaded to R2: ${GENERATED_BUCKET}/${key}`);
    return { success: true, key };
  } catch (error) {
    console.error(`❌ R2 upload failed:`, error.message);
    return { success: false, error: error.message };
  }
}

// Process a single sponsor campaign
async function processCampaign(campaign, sponsorAccount) {
  let tempDir = null;
  let logoPath = null;
  let videoPath = null;
  
  try {
    console.log(`\n🎬 Processing campaign ${campaign.id} for ${sponsorAccount.organization_legal_name}`);
    
    // Extract campaign data
    const sponsorName = sponsorAccount.organization_legal_name;
    const logoKey = campaign.logo_r2_key;
    const tier = campaign.tier || null;
    const tagline = campaign.tagline || null;
    
    if (!logoKey) {
      throw new Error('Logo R2 key is missing');
    }
    
    // Create temporary directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sponsor-video-'));
    console.log(`📁 Temp directory: ${tempDir}`);
    
    // Download logo from R2
    logoPath = path.join(tempDir, `logo-${campaign.id}${path.extname(logoKey)}`);
    console.log(`⬇️  Downloading logo from R2: ${UPLOADS_BUCKET}/${logoKey}`);
    await downloadLogoFromR2(logoKey, logoPath);
    console.log(`✅ Logo downloaded: ${logoPath}`);

    // FFmpeg cannot decode SVG; rasterize to PNG when needed (PNG/JPG unchanged)
    let logoPathForFfmpeg = logoPath;
    if (isSvgLogo(logoKey)) {
      const rasterizedPath = path.join(tempDir, `logo-${campaign.id}-raster.png`);
      console.log(`🖼️  Rasterizing SVG logo to PNG (${SVG_TARGET_WIDTH}px width)...`);
      await rasterizeSvgToPng(logoPath, rasterizedPath);
      logoPathForFfmpeg = rasterizedPath;
      console.log(`✅ Rasterized logo: ${rasterizedPath}`);
    }

    // Pick and download background music
    const musicTrack = pickRandomMusicTrack();
    const audioPath = path.join(tempDir, `audio-${campaign.id}.mp3`);
    console.log(`🎵 Downloading background music: ${musicTrack.filename} (starting at ${musicTrack.trimSeconds}s)`);
    await downloadFile(musicTrack.url, audioPath);
    console.log(`✅ Music downloaded: ${audioPath}`);

    // Generate video with FFmpeg
    videoPath = path.join(tempDir, `video-${campaign.id}.mp4`);
    console.log(`🎥 Generating video with FFmpeg...`);
    await generateVideoWithFFmpeg(logoPathForFfmpeg, sponsorName, tier, tagline, videoPath, audioPath, musicTrack.trimSeconds);
    console.log(`✅ Video generated: ${videoPath}`);
    
    // Upload video to R2
    const outputKey = `${campaign.id}.mp4`;
    console.log(`☁️  Uploading video to R2: ${GENERATED_BUCKET}/${outputKey}`);
    const uploadResult = await uploadVideoToR2(videoPath, outputKey);
    
    if (!uploadResult.success) {
      throw new Error(`R2 upload failed: ${uploadResult.error}`);
    }
    
    // Mark campaign as generation completed and store R2 key. Status changes are handled by Monday job only.
    if (campaign.is_recurring) {
      // Recurring: only generation_completed and video_r2_key (start_week already set at submission)
      await pool.query(`
        UPDATE sponsor_campaigns
        SET
          generation_completed = TRUE,
          video_r2_key = $2,
          updated_at = NOW()
        WHERE id = $1
      `, [campaign.id, outputKey]);
      console.log(`✅ Campaign ${campaign.id} marked as generation_completed (recurring)`);
    } else {
      // Non-recurring: activate immediately; playlist guards display via start_week/end_at dates
      const startMonday = getNextMondayLA();
      const startWeekStr = startMonday.toISOString().slice(0, 10);
      const endAt = new Date(startMonday);
      endAt.setUTCDate(endAt.getUTCDate() + 7);
      const endAtStr = endAt.toISOString().slice(0, 10);
      await pool.query(`
        UPDATE sponsor_campaigns
        SET
          generation_completed = TRUE,
          video_r2_key = $2,
          updated_at = NOW()
        WHERE id = $1
      `, [campaign.id, outputKey]);
      console.log(`✅ Campaign ${campaign.id} marked as generation_completed (non-recurring); start_week/end_at deferred until payment confirmed`);

      // Charge card at approval (non-recurring only)
      let nonRecurringPaymentFailed = false;
      if (stripe) {
        try {
          const stripeCustomerId = sponsorAccount.stripe_customer_id;
          if (!stripeCustomerId) {
            console.error(`❌ [NON-RECURRING CHARGE] No stripe_customer_id for sponsor account ${sponsorAccount.id}`);
            nonRecurringPaymentFailed = true;
          } else {
            const pmList = await stripe.paymentMethods.list({
              customer: stripeCustomerId,
              type: 'card',
              limit: 1
            });
            const paymentMethodId = pmList.data[0]?.id;
            if (!paymentMethodId) {
              console.error(`❌ [NON-RECURRING CHARGE] No saved card for customer ${stripeCustomerId}`);
              nonRecurringPaymentFailed = true;
            } else {
              const billingRow = await pool.query(
                `SELECT id, amount_cents, stripe_payment_intent_id FROM sponsor_billing WHERE sponsor_campaign_id = $1 AND stripe_mode = 'one_time' LIMIT 1`,
                [campaign.id]
              );
              if (billingRow.rows.length === 0 || billingRow.rows[0].amount_cents == null) {
                console.error(`❌ [NON-RECURRING CHARGE] No sponsor_billing or amount_cents for campaign ${campaign.id}`);
                nonRecurringPaymentFailed = true;
              } else if (billingRow.rows[0].stripe_payment_intent_id != null) {
                console.warn(`Payment already recorded for campaign ${campaign.id}, skipping charge.`);
                return { success: true, campaignId: campaign.id };
              } else {
                const amountCents = parseInt(billingRow.rows[0].amount_cents, 10);
                const paymentIntent = await stripe.paymentIntents.create({
                  amount: amountCents,
                  currency: 'usd',
                  customer: stripeCustomerId,
                  payment_method: paymentMethodId,
                  off_session: true,
                  confirm: true,
                  metadata: {
                    campaignId: campaign.id,
                    sponsorAccountId: campaign.sponsor_account_id,
                    campaignType: 'non-recurring'
                  }
                });
                if (paymentIntent.status !== 'succeeded') {
                  console.error(`❌ [NON-RECURRING CHARGE] PaymentIntent not succeeded: ${paymentIntent.status}`);
                  nonRecurringPaymentFailed = true;
                } else {
                  await pool.query(
                    `UPDATE sponsor_billing SET status = 'paid', stripe_payment_intent_id = $1 WHERE sponsor_campaign_id = $2`,
                    [paymentIntent.id, campaign.id]
                  );
                  // Set status=active, start_week, and end_at now that payment is confirmed.
                  // Playlist is gated by start_week <= CURRENT_DATE so video won't show until Monday.
                  await pool.query(
                    `UPDATE sponsor_campaigns SET status = 'active', start_week = $2::date, end_at = $3::date, updated_at = NOW() WHERE id = $1`,
                    [campaign.id, startWeekStr, endAtStr]
                  );
                  const donResult = await pool.query(
                    `INSERT INTO sponsor_donations (sponsor_account_id, sponsor_campaign_id, stripe_payment_intent_id, amount_cents, source)
                     VALUES ($1, $2, $3, $4, 'one_time_payment')
                     RETURNING id`,
                    [campaign.sponsor_account_id, campaign.id, paymentIntent.id, amountCents]
                  );
                  const donationId = donResult.rows[0].id;
                  const amountDollars = amountCents / 100;
                  const ledgerResult = await pool.query(
                    `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (source_id, week_start) DO NOTHING
                     RETURNING id`,
                    ['sponsor', campaign.id, donationId, amountDollars, startWeekStr]
                  );
                  if (ledgerResult.rows.length === 0) {
                    console.warn(`Donation ledger entry already exists for campaign ${campaign.id}, skipping pool update.`);
                  } else {
                    await pool.query(
                      `INSERT INTO weekly_donation_pool (week_start, sponsor_total, advertiser_total)
                       VALUES ($1::date, $2, 0)
                       ON CONFLICT (week_start) DO UPDATE
                       SET sponsor_total = weekly_donation_pool.sponsor_total + $2,
                           updated_at = NOW()`,
                      [startWeekStr, amountDollars]
                    );
                  }
                  console.log(`✅ [NON-RECURRING CHARGE] Charged $${amountDollars.toFixed(2)} for campaign ${campaign.id}`);
                }
              }
            }
          }
          if (nonRecurringPaymentFailed) {
            await pool.query(
              `UPDATE sponsor_campaigns SET status = 'payment_failed', updated_at = NOW() WHERE id = $1`,
              [campaign.id]
            );
            console.log(`⚠️ [NON-RECURRING] Campaign ${campaign.id} set to payment_failed; skipping approval email`);
          }
        } catch (chargeErr) {
          console.error(`❌ [NON-RECURRING CHARGE] Error for campaign ${campaign.id}:`, chargeErr.message);
          await pool.query(
            `UPDATE sponsor_campaigns SET status = 'payment_failed', updated_at = NOW() WHERE id = $1`,
            [campaign.id]
          );
          nonRecurringPaymentFailed = true;
        }
      } else {
        nonRecurringPaymentFailed = true;
        await pool.query(
          `UPDATE sponsor_campaigns SET status = 'payment_failed', updated_at = NOW() WHERE id = $1`,
          [campaign.id]
        );
      }
      if (nonRecurringPaymentFailed) {
        // Mark sponsor_billing as failed
        try {
          await pool.query(
            `UPDATE sponsor_billing SET status = 'failed' WHERE sponsor_campaign_id = $1 AND stripe_mode = 'one_time'`,
            [campaign.id]
          );
          console.log(`❌ [NON-RECURRING] Marked sponsor_billing.status = 'failed' for campaign ${campaign.id}`);
        } catch (billingErr) {
          console.error(`❌ [NON-RECURRING] Error updating sponsor_billing status:`, billingErr.message);
        }
        // Send payment failure notification email
        if (emailService && emailService.isEmailConfigured()) {
          try {
            await emailService.sendSponsorPaymentFailedEmail(
              sponsorAccount.contact_email,
              sponsorAccount.organization_legal_name
            );
          } catch (emailErr) {
            console.error(`❌ [NON-RECURRING] Error sending payment failed email:`, emailErr.message);
          }
        }
        return { success: true, campaignId: campaign.id };
      }
    }
    
    // For recurring sponsors: Set billing_cycle_anchor after approval to align weekly renewals to Monday
    if (campaign.is_recurring && stripe) {
      try {
        // Get the subscription ID from sponsor_billing
        const billingResult = await pool.query(
          `SELECT stripe_subscription_id
           FROM sponsor_billing
           WHERE sponsor_campaign_id = $1
             AND stripe_subscription_id IS NOT NULL
           LIMIT 1`,
          [campaign.id]
        );
        
        if (billingResult.rows.length > 0 && billingResult.rows[0].stripe_subscription_id) {
          const subscriptionId = billingResult.rows[0].stripe_subscription_id;
          const nextMonday = getNextMondayLA();
          const nextMondayUnix = Math.floor(nextMonday.getTime() / 1000);

          console.log(`📅 [RECURRING SPONSOR] Setting billing_cycle_anchor for subscription ${subscriptionId}`);
          console.log(`📅 [RECURRING SPONSOR] Next Monday for billing alignment:`, nextMonday.toISOString());
          
          // Set billing_cycle_anchor to align weekly renewals to Monday
          // This doesn't charge immediately and doesn't create prorations
          await stripe.subscriptions.update(subscriptionId, {
            billing_cycle_anchor: nextMondayUnix,
            proration_behavior: 'none'
          });
          
          console.log(`✅ [RECURRING SPONSOR] billing_cycle_anchor set for Monday-aligned renewals`);
        } else {
          console.log(`⚠️ [RECURRING SPONSOR] No subscription ID found for campaign ${campaign.id} - skipping billing_cycle_anchor`);
        }
      } catch (stripeError) {
        // Log but don't fail the entire process if Stripe update fails
        console.error(`❌ [RECURRING SPONSOR] Failed to set billing_cycle_anchor:`, stripeError.message);
      }
    }
    
    // Send approval email after successful video generation and campaign activation
    if (emailService && emailService.isEmailConfigured()) {
      try {
        const contactEmail = sponsorAccount.contact_email;
        const nextMondayDate = getNextMonday();
        
        // Build submission summary from campaign data
        const submissionSummary = {
          tier: campaign.tier || null,
          isRecurring: campaign.is_recurring || false,
          tagline: campaign.tagline || null
        };
        
        console.log(`📧 Sending approval email to ${contactEmail} for campaign ${campaign.id}`);
        const emailResult = await emailService.sendSponsorApprovalEmail(
          contactEmail,
          sponsorName,
          submissionSummary,
          nextMondayDate
        );
        
        if (emailResult.success) {
          console.log(`✅ Approval email sent successfully to ${contactEmail}`);
        } else {
          console.error(`❌ Failed to send approval email: ${emailResult.error}`);
          // Don't fail the entire process if email fails
        }
      } catch (emailError) {
        console.error(`❌ Error sending approval email:`, emailError.message);
        // Don't fail the entire process if email fails
      }
    } else {
      console.log('⚠️ Email service not configured - skipping approval email');
    }
    
    return { success: true, campaignId: campaign.id };
    
  } catch (error) {
    console.error(`❌ Error processing campaign ${campaign.id}:`, error.message);
    return { success: false, campaignId: campaign.id, error: error.message };
  } finally {
    // Cleanup temporary files
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`🧹 Cleaned up temp directory: ${tempDir}`);
      } catch (cleanupError) {
        console.warn(`⚠️  Failed to cleanup temp directory: ${cleanupError.message}`);
      }
    }
  }
}

// Main function
async function generateSponsorVideosFFmpeg(onlyId) {
  let client;
  try {
    console.log('🚀 Starting FFmpeg-based sponsor video generation script...');
    console.log(`📦 Uploads bucket: ${UPLOADS_BUCKET}`);
    console.log(`🎯 Generated bucket: ${GENERATED_BUCKET}`);
    
    // Check if FFmpeg is available
    try {
      await execAsync('ffmpeg -version');
      console.log('✅ FFmpeg is available');
    } catch (error) {
      throw new Error('FFmpeg is not installed or not in PATH. Please install FFmpeg to use this script.');
    }
    
    // Test database connection
    client = await pool.connect();
    console.log('✅ Database connection established');

    await client.query(
      `UPDATE sponsor_campaigns SET status = 'approved' WHERE id = $1::uuid AND status = 'pending_approval'`,
      [onlyId]
    );
    
    // Query approved campaigns that haven't been generated
    // Include tier and tagline columns for video generation
    const campaignsResult = await client.query(`
      SELECT sc.*
      FROM sponsor_campaigns sc
      WHERE sc.status = 'approved'
        AND sc.generation_completed = FALSE
        AND sc.id = $1::uuid
      ORDER BY sc.id
    `, [onlyId]);
    
    console.log(`📊 Found ${campaignsResult.rows.length} approved campaigns pending video generation`);
    
    if (campaignsResult.rows.length === 0) {
      console.log('ℹ️ No matching sponsor campaign to process for this --id (not pending→approved, or already generated, or not found). Nothing to do.');
      return;
    }
    
    let successCount = 0;
    let errorCount = 0;
    
    // Process each campaign
    for (const campaign of campaignsResult.rows) {
      // Join with sponsor_accounts to get account details (including email for approval notification)
      const accountResult = await client.query(`
        SELECT id, organization_legal_name, contact_email, stripe_customer_id
        FROM sponsor_accounts
        WHERE id = $1
      `, [campaign.sponsor_account_id]);
      
      if (accountResult.rows.length === 0) {
        console.error(`❌ Sponsor account not found for campaign ${campaign.id}`);
        errorCount++;
        continue;
      }
      
      const sponsorAccount = accountResult.rows[0];
      const result = await processCampaign(campaign, sponsorAccount);
      
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    }
    
    console.log(`\n📊 Summary:`);
    console.log(`✅ Successful: ${successCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📦 Total processed: ${successCount + errorCount}`);
    
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}

// Run script if called directly
if (require.main === module) {
  const onlyId = parseCliSponsorId();
  if (!onlyId) {
    console.error('❌ --id is required. Usage: node generate-sponsor-videos-ffmpeg.js --id <sponsor_campaign_id>');
    process.exit(1);
  }
  generateSponsorVideosFFmpeg(onlyId).then(() => {
    process.exit(0);
  }).catch(error => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
}

module.exports = { generateSponsorVideosFFmpeg };