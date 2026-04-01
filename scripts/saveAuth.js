#!/usr/bin/env node
/**
 * Save Charity Stream login session for automation reuse.
 * Usage: node scripts/saveAuth.js
 *
 * 1. Browser opens at http://localhost:3001
 * 2. Log in manually (Google or email)
 * 3. Once logged in, press Enter in terminal
 * 4. Auth state saved to scripts/auth.json
 */

const readline = require('readline');
const path = require('path');

async function main() {
  const { chromium } = require('playwright');

  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const authPath = path.join(__dirname, 'auth.json');

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Navigating to', baseUrl);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    console.log('\nLog in manually (Google or email).');
    console.log('Once logged in, press Enter in this terminal to save auth.\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question('Press Enter when logged in... ', resolve));
    rl.close();

    const hasAuth = await page.evaluate(() => !!localStorage.getItem('authToken'));
    if (!hasAuth) {
      console.warn('⚠️ No authToken found in localStorage. Saving anyway (may not work for fillAdvertiser).');
    } else {
      console.log('✅ authToken found.');
    }

    await context.storageState({ path: authPath });
    console.log('✅ Auth saved to', authPath);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
