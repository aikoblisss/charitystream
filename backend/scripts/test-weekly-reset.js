// Test script for weekly reset functionality
// Run with: npm run test-reset

// Load environment variables
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { performWeeklyReset } = require("../server.js");

(async () => {
  console.log("🧪 ===== TEST WEEKLY RESET ===== ");
  console.log("🧪 Starting test weekly reset...");
  console.log("🧪 Time:", new Date().toISOString());
  console.log("🧪 ==============================");
  
  try {
    const result = await performWeeklyReset();
    
    if (result.success) {
      console.log("✅ Test reset completed successfully!");
      console.log(`✅ Advertisers reset: ${result.advertisersReset}`);
      console.log("✅ Timestamp:", result.timestamp);
    } else {
      console.error("❌ Test reset failed:", result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Test reset error:", error);
    console.error("❌ Error stack:", error.stack);
    process.exit(1);
  }
  
  console.log("🧪 ==============================");
  console.log("✅ Test reset finished.");
  process.exit(0);
})();

