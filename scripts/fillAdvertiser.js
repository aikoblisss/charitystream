#!/usr/bin/env node
/**
 * Advertiser form automation for local QA testing (Stripe test mode).
 * Usage: node scripts/fillAdvertiser.js --type=recurring
 *        node scripts/fillAdvertiser.js --type=nonrecurring
 *
 * Requires: npm install playwright && npx playwright install chromium
 * Video dir: scripts/vids (random .mp4 used for upload)
 * Note: User must be logged in (authToken in localStorage) before running.
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { type: 'nonrecurring' };
  for (const a of args) {
    if (a.startsWith('--type=')) {
      const v = a.slice(7).toLowerCase();
      if (v === 'recurring' || v === 'nonrecurring') out.type = v;
    }
  }
  return out;
}

function pickRandomVideo(vidsDir) {
  const dir = path.resolve(vidsDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Video directory not found or not a directory: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => {
    const lower = f.toLowerCase();
    return lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm');
  });
  if (files.length === 0) throw new Error(`No video files (.mp4, .mov, .webm) in ${dir}`);
  const file = files[Math.floor(Math.random() * files.length)];
  return path.join(dir, file);
}

async function main() {
  const { type } = parseArgs();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const advertiserUrl = `${baseUrl}/advertiser`;
  const vidsDir = path.join(__dirname, 'vids');
  const videoPath = pickRandomVideo(vidsDir);

  const { chromium } = require('playwright');

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const authPath = path.join(__dirname, 'auth.json');
  const storageState = fs.existsSync(authPath) ? authPath : undefined;
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();

  try {
    await context.addInitScript((token) => {
      window.localStorage.setItem('authToken', token);
    }, process.env.AUTH_TOKEN);

    console.log('Navigating to advertiser form...');
    await page.goto(advertiserUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#advertiserForm', { state: 'visible' });

    const hasAuth = await page.evaluate(() => !!localStorage.getItem('authToken'));
    if (!hasAuth) {
      console.warn('⚠️ No auth token found. Log in first for checkout to succeed.');
    }

    const campaignName = `QA Advertiser ${Date.now()}`;
    const testEmail = 'brandengreene03@gmail.com';

    console.log('Filling advertiser information...');
    await page.fill('#campaignName', campaignName);
    await page.fill('#companyName', campaignName);
    await page.fill('#websiteUrl', 'https://example.com');
    await page.fill('#firstName', 'QA');
    await page.fill('#lastName', 'Tester');
    await page.fill('#email', testEmail);
    await page.fill('#jobTitle', 'QA Engineer');

    console.log('Selecting Video format...');
    await page.check('input[name="adFormat"][value="video"]');
    await page.waitForTimeout(300);

    console.log('Setting weekly budget...');
    await page.fill('#budget', '100');

    console.log('Selecting Custom CPM ($100)...');
    await page.check('#custom');
    await page.waitForSelector('#customSlider.active', { state: 'visible', timeout: 3000 }).catch(() => {});
    await page.locator('#cpmSlider').evaluate((el) => {
      el.value = '100';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    console.log('Uploading video:', videoPath);
    await page.setInputFiles('#fileUpload', videoPath);

    console.log('Setting recurring:', type === 'recurring');
    if (type === 'recurring') {
      await page.check('#recurringSpend');
    } else {
      await page.uncheck('#recurringSpend');
    }

    console.log('Checking terms...');
    await page.check('#terms');

    console.log('Submitting advertiser form...');
    await page.click('form#advertiserForm button[type="submit"]');

    console.log('Waiting for enhancement modal...');
    await page.getByRole('button', { name: /Proceed to checkout/i }).waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(500);

    console.log('Clicking Proceed to checkout...');
    await Promise.all([
      page.waitForURL((u) => u.hostname.includes('checkout.stripe.com'), { timeout: 90000 }),
      page.getByRole('button', { name: /Proceed to checkout/i }).click(),
    ]);

    console.log('On Stripe Checkout — filling card...');
    await page.waitForLoadState('networkidle');

    // Handle Stripe Link popup if present
    try {
      const linkBypass = page.getByText(/Pay without Link/i);
      if (await linkBypass.count()) {
        console.log('Stripe Link detected — bypassing...');
        await linkBypass.first().click();
        await page.waitForTimeout(1500);
      }
    } catch (e) {
      console.log('No Link prompt detected, continuing...');
    }

    await page.waitForSelector('iframe', { timeout: 10000 });
    await page.waitForTimeout(1000);

    const frames = page.frames();
    const fillInFrame = async (name, value) => {
      for (const frame of frames) {
        const input = frame.locator(`input[name="${name}"]`);
        if ((await input.count()) > 0) {
          await input.first().fill(value);
          await page.waitForTimeout(200);
          return true;
        }
      }
      return false;
    };

    await fillInFrame('cardnumber', '4242424242424242');
    await page.waitForTimeout(500);
    await fillInFrame('exp-date', '12/34');
    await fillInFrame('cvc', '123');
    await fillInFrame('postal', '12345');

    console.log('Submitting Stripe Checkout...');
    await page.getByRole('button', { name: /Pay|Subscribe|Submit/ }).click();

    await page.waitForURL((u) => u.pathname.includes('advertiser') && u.search.includes('payment_success'), { timeout: 60000 });
    console.log('Done. Redirected to success URL.');
  } catch (err) {
    console.error('Error:', err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
