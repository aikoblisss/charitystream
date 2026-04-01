#!/usr/bin/env node
/**
 * Launcher for Saturday fallback winner job. Runs backend/scripts/fallback-winner-job.js
 * so backend DB and email dependencies resolve correctly.
 *
 * Usage: node scripts/fallback-winner-job.js
 *    or: npm run fallback-winner-job
 *
 * Schedule: cron every Saturday 12:00 PM PT (e.g. 0 12 * * 6 with TZ=America/Los_Angeles).
 */
const path = require('path');
const { spawnSync } = require('child_process');

const backendScript = path.join(__dirname, '..', 'backend', 'scripts', 'fallback-winner-job.js');
const result = spawnSync(
  process.execPath,
  [backendScript, ...process.argv.slice(2)],
  { cwd: path.join(__dirname, '..', 'backend'), stdio: 'inherit' }
);
process.exit(result.status !== null ? result.status : 1);
