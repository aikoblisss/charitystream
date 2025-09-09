const fs = require('fs');
const path = require('path');

console.log('🔍 LetsWatchAds Setup Check\n');

// Check if config file exists and has been updated
function checkConfig() {
  console.log('📋 Checking configuration...');
  
  try {
    const configPath = path.join(__dirname, 'config.js');
    const configContent = fs.readFileSync(configPath, 'utf8');
    
    const hasPlaceholders = configContent.includes('YOUR_') || 
                           configContent.includes('your-') ||
                           configContent.includes('YOUR_ACTUAL_');
    
    if (hasPlaceholders) {
      console.log('❌ Configuration file still contains placeholder values');
      console.log('   Please update backend/config.js with your actual credentials');
      return false;
    } else {
      console.log('✅ Configuration file appears to be updated');
      return true;
    }
  } catch (error) {
    console.log('❌ Configuration file not found');
    console.log('   Please create backend/config.js from backend/config.example.js');
    return false;
  }
}

// Check if required packages are installed
function checkPackages() {
  console.log('\n📦 Checking packages...');
  
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const requiredPackages = [
      'passport',
      'passport-google-oauth20',
      'passport-jwt',
      'nodemailer',
      'express-session'
    ];
    
    let allInstalled = true;
    requiredPackages.forEach(pkg => {
      if (packageJson.dependencies[pkg]) {
        console.log(`✅ ${pkg} is installed`);
      } else {
        console.log(`❌ ${pkg} is missing`);
        allInstalled = false;
      }
    });
    
    return allInstalled;
  } catch (error) {
    console.log('❌ Could not read package.json');
    return false;
  }
}

// Check if database file exists
function checkDatabase() {
  console.log('\n🗄️  Checking database...');
  
  const dbPath = path.join(__dirname, 'letswatchads.db');
  if (fs.existsSync(dbPath)) {
    console.log('✅ Database file exists');
    return true;
  } else {
    console.log('❌ Database file not found');
    console.log('   The database will be created when you start the server');
    return true; // This is okay, it will be created
  }
}

// Main check
function runSetupCheck() {
  const configOk = checkConfig();
  const packagesOk = checkPackages();
  const databaseOk = checkDatabase();
  
  console.log('\n📊 Setup Summary:');
  console.log(`   Configuration: ${configOk ? '✅' : '❌'}`);
  console.log(`   Packages: ${packagesOk ? '✅' : '❌'}`);
  console.log(`   Database: ${databaseOk ? '✅' : '❌'}`);
  
  if (configOk && packagesOk && databaseOk) {
    console.log('\n🎉 Setup looks good! You can start the server with: npm start');
    console.log('📖 For detailed setup instructions, see SETUP_INSTRUCTIONS.md');
  } else {
    console.log('\n⚠️  Please fix the issues above before starting the server');
    console.log('📖 See SETUP_INSTRUCTIONS.md for detailed setup instructions');
  }
}

runSetupCheck();

