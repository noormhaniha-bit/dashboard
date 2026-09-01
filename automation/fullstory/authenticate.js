// authenticate.js
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  // Use a headed browser and standard channel for initial login
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating to FullStory login page...');
  await page.goto('https://app.fullstory.com/login');

  console.log('Please log in manually and complete any multi-factor authentication (MFA).');
  console.log('Once you see the dashboard, press ENTER in this terminal to save session details.');

  await new Promise(resolve => process.stdin.once('data', resolve));

  // Save cookies & local storage
  await context.storageState({ path: './playwright/.auth/user.json' });
  console.log('Authentication state successfully saved to./playwright/.auth/user.json');

  await browser.close();
  process.exit(0);
})();