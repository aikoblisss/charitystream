#!/usr/bin/env node

// Test script to verify .env file is working
require('dotenv').config({ path: '../.env' });

console.log('🔍 Testing .env file...');
console.log('DATABASE_URL found:', !!process.env.DATABASE_URL);

if (process.env.DATABASE_URL) {
  console.log('✅ DATABASE_URL is set!');
  console.log('URL starts with:', process.env.DATABASE_URL.substring(0, 20) + '...');
} else {
  console.log('❌ DATABASE_URL is not set!');
  console.log('Make sure you have a .env file in the project root with:');
  console.log('DATABASE_URL=postgresql://your-database-url-here');
}
