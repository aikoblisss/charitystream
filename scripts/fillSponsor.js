#!/usr/bin/env node
/**
 * Sponsor form automation for local QA testing (Stripe test mode).
 * Usage: node scripts/fillSponsor.js --tier=gold --type=recurring
 *        node scripts/fillSponsor.js --tier=diamond --type=nonrecurring
 *
 * Requires: npm install playwright && npx playwright install chromium
 * Logo dir: ~/Desktop/logos (random .png used for upload)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { tier: 'gold', type: 'nonrecurring' };
  for (const a of args) {
    if (a.startsWith('--tier=')) {
      const v = a.slice(7).toLowerCase();
      if (['bronze', 'silver', 'gold', 'diamond'].includes(v)) out.tier = v;
    } else if (a.startsWith('--type=')) {
      const v = a.slice(7).toLowerCase();
      if (v === 'recurring' || v === 'nonrecurring') out.type = v;
    }
  }
  return out;
}

function pickRandomPng(logosDir) {
  const dir = path.resolve(logosDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Logo directory not found or not a directory: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'));
  if (files.length === 0) throw new Error(`No .png files in ${dir}`);
  const file = files[Math.floor(Math.random() * files.length)];
  return path.join(dir, file);
}

async function main() {
  const { tier, type } = parseArgs();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const sponsorUrl = `${baseUrl}/advertiser`;
  const logosDir = path.join(__dirname, 'logos');
  const logoPath = pickRandomPng(logosDir);

  // eslint-disable-next-line global-require
  const { chromium } = require('playwright');

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Navigating to sponsor form...');
    await page.goto(sponsorUrl, { waitUntil: 'domcontentloaded' });

    // Open Sponsor tab
    await page.click('#header-sp');
    await page.waitForSelector('#sponsorForm', { state: 'visible' });

    const campaignName = `QA Test ${Date.now()}`;
    const testEmail = 'brandengreene03@gmail.com';
    const testWebsite = 'https://example.com';
    const testEin = '12-3456789';

    console.log('Filling organization & contact...');
    await page.fill('#sp-org', campaignName);
    await page.fill('#sp-email', testEmail);
    await page.fill('#sp-website', testWebsite);
    await page.fill('#sp-ein', testEin);
    await page.fill('#sp-tagline', 'Automated QA sponsorship');

    console.log('Selecting tier:', tier);
    await page.check(`#${tier}`);

    if (tier === 'diamond') {
      await page.fill('#sp-amount', '500');
    }

    console.log('Setting recurring:', type === 'recurring');
    if (type === 'recurring') {
      await page.check('#sp-recurring');
    } else {
      await page.uncheck('#sp-recurring');
    }

    console.log('Uploading logo:', logoPath);
    await page.setInputFiles('#sp-logo', logoPath);

    console.log('Checking agreement...');
    await page.check('#sp-agree');

    console.log('Submitting sponsor form...');
    await Promise.all([
      page.waitForURL((u) => u.hostname.includes('checkout.stripe.com'), { timeout: 30000 }),
      page.click('form#sponsorForm button[type="submit"]'),
    ]);

    console.log('On Stripe Checkout — filling card...');
    await page.waitForLoadState('networkidle');

    // Handle Stripe Link popup if present
    try {
      const linkBypass = page.getByText(/Pay without Link/i);
      if (await linkBypass.count()) {
        console.log('Stripe Link detected — bypassing...');
        await linkBypass.first().click();
        await page.waitForTimeout(1500); // allow checkout UI to refresh
      }
    } catch (e) {
      console.log('No Link prompt detected, continuing...');
    }

    await page.waitForSelector('iframe', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // Stripe Checkout: card fields are in iframes; find by input name in any frame
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

    // Wait for redirect back to our app (success)
    await page.waitForURL((u) => u.pathname.includes('advertiser') && u.search.includes('sponsor_success'), { timeout: 60000 });
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
