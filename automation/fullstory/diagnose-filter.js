// diagnose-filter.js — inspects the filtered results page to verify that scraped
// play-buttons all belong to the filtered ApplicationID (no false positives).
// Usage: node diagnose-filter.js <applicationId>
const { chromium } = require('playwright');
const path = require('path');
require('dotenv').config();

const ORG_ID     = process.env.FULLSTORY_ORG_ID;
const AUTH_STATE = path.join(__dirname, 'playwright', '.auth', 'user.json');
const PEOPLE_URL = `https://app.fullstory.com/ui/${ORG_ID}/segments/everyone`;

(async () => {
  const applicationId = process.argv[2];
  if (!applicationId) { console.error('Usage: node diagnose-filter.js <applicationId>'); process.exit(1); }

  const browser = await chromium.launch({ headless: false, channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, storageState: AUTH_STATE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await context.newPage();

  try {
    await page.goto(PEOPLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('text=USER FILTERS').waitFor({ state: 'visible', timeout: 30000 });

    // Click the existing condition's property dropdown to select ApplicationID.
    // (Don't click "Add user filter" — that adds a second OR'd condition and matches everyone.)
    await page.getByTestId('search-user-filters').getByTestId('search-first-dropdown-button').click();
    await page.waitForTimeout(400);
    const propInput = page.locator('input[placeholder="Search properties"], input[placeholder*="Search"]').first();
    await propInput.waitFor({ state: 'visible', timeout: 10000 });
    await propInput.fill('ApplicationID');
    await page.waitForTimeout(400);
    await page.getByRole('option', { name: 'ApplicationID (string)' }).getByTestId('flex').nth(1).click();

    const valueInput = page.getByTestId('search-text-input');
    await valueInput.waitFor({ state: 'visible', timeout: 10000 });
    await valueInput.fill(applicationId);

    await page.getByTestId('button-primary-range').click();
    await page.getByText('Past 90 days').click();
    await page.getByTestId('button-on-apply').click();
    await page.locator('[data-testid="button-primary-range"]:has-text("Past 90 days")').waitFor({ state: 'visible', timeout: 15000 });

    const applyBtn = page.getByRole('button', { name: 'Apply Filters' });
    await applyBtn.click();

    await Promise.race([
      page.locator('text=No matches found').waitFor({ state: 'visible', timeout: 30000 }),
      page.locator('a[data-testid="play-button"]').first().waitFor({ state: 'visible', timeout: 30000 }),
    ]);

    // Dump anything that looks like a result/user COUNT and any applied-filter CHIPS,
    // so we can build a gate that confirms the filter actually applied.
    const filterState = await page.evaluate(() => {
      const texts = [...document.querySelectorAll('body *')]
        .map(el => (el.childElementCount === 0 ? (el.innerText || '').trim() : ''))
        .filter(t => /\b(\d[\d,]*)\s+(user|result|person|people|session)/i.test(t));
      const chips = [...document.querySelectorAll('[class*="chip" i], [class*="pill" i], [class*="filter" i][class*="tag" i], [data-testid*="filter" i]')]
        .map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean).slice(0, 20);
      return { counts: [...new Set(texts)].slice(0, 10), chips: [...new Set(chips)] };
    });
    console.log('\nCount-like text on page:', JSON.stringify(filterState.counts, null, 2));
    console.log('Filter chip/pill text   :', JSON.stringify(filterState.chips, null, 2));

    // Poll the play-button count over time to see if results are still loading.
    console.log('\nPlay-button count over time (after Apply):');
    for (let t = 1; t <= 10; t++) {
      await page.waitForTimeout(1000);
      const n = await page.locator('a[data-testid="play-button"]').count();
      console.log(`  +${t}s : ${n} play-button(s)`);
    }

    // For each play button, walk up to its nearest list-row ancestor and capture
    // the visible text — so we can see what context each session sits in.
    const details = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('a[data-testid="play-button"]')];
      return btns.map(btn => {
        const href = btn.getAttribute('href') || '';
        let row = btn;
        for (let i = 0; i < 6 && row.parentElement; i++) {
          row = row.parentElement;
          if (row.getAttribute('role') === 'row' || /row|listItem|user/i.test(row.className)) break;
        }
        const text = (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        return { href, rowText: text };
      });
    });

    console.log(`\nScraped ${details.length} play-button(s):`);
    details.forEach((d, i) => {
      console.log(`  [${i + 1}] session=${d.href.split('/session/')[1] || d.href}`);
      console.log(`       context: ${d.rowText}`);
    });

    const idVisible = await page.locator(`text=${applicationId}`).count();
    console.log(`\nApplicationID value "${applicationId}" appears ${idVisible} time(s) in page text.`);

    console.log('\nLeaving browser open 20s for manual inspection...');
    await page.waitForTimeout(20000);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
