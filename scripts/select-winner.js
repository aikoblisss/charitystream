#!/usr/bin/env node
/**
 * Launcher for manual winner selection. Runs backend/scripts/select-winner.js
 * so backend DB and email dependencies resolve correctly.
 *
 * Usage: node scripts/select-winner.js --charity-id=<uuid> --week-start=YYYY-MM-DD
 *    or: npm run select-winner -- --charity-id=<uuid> --week-start=YYYY-MM-DD
 */
const path = require('path');
const { spawnSync } = require('child_process');

const backendScript = path.join(__dirname, '..', 'backend', 'scripts', 'select-winner.js');
const result = spawnSync(
  process.execPath,
  [backendScript, ...process.argv.slice(2)],
  { cwd: path.join(__dirname, '..', 'backend'), stdio: 'inherit' }
);
process.exit(result.status !== null ? result.status : 1);
