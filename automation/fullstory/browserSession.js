// browserSession.js — single browser handles both search and recording
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ORG_ID    = process.env.FULLSTORY_ORG_ID;
const AUTH_STATE = path.join(__dirname, 'playwright', '.auth', 'user.json');
const PEOPLE_URL = `https://app.fullstory.com/ui/${ORG_ID}/segments/everyone`;
const TEMP_BASE  = path.join(__dirname, 'temp_recordings');

// ── Helpers ───────────────────────────────────────────────────────────────────


function getBezierPoint(p0, p1, p2, p3, t) {
  return {
    x: Math.pow(1-t,3)*p0.x + 3*Math.pow(1-t,2)*t*p1.x + 3*(1-t)*Math.pow(t,2)*p2.x + Math.pow(t,3)*p3.x,
    y: Math.pow(1-t,3)*p0.y + 3*Math.pow(1-t,2)*t*p1.y + 3*(1-t)*Math.pow(t,2)*p2.y + Math.pow(t,3)*p3.y,
  };
}

async function humanLikeMove(page, x, y) {
  const p0 = { x: 500, y: 500 }, p3 = { x, y };
  const p1 = { x: p0.x + (Math.random()*150-75), y: p0.y + (Math.random()*150-75) };
  const p2 = { x: p3.x + (Math.random()*150-75), y: p3.y + (Math.random()*150-75) };
  for (let i = 0; i <= 25; i++) {
    const pt = getBezierPoint(p0, p1, p2, p3, i/25);
    await page.mouse.move(pt.x, pt.y).catch(() => {});
    await new Promise(r => setTimeout(r, 5 + Math.random()*10));
  }
}

// ── Session search ────────────────────────────────────────────────────────────

async function findSessions(page, applicationId) {
  console.log(`    Navigating to segment page...`);
  await page.goto(PEOPLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('text=USER FILTERS').waitFor({ state: 'visible', timeout: 30000 });

  // Set the ApplicationID filter by modifying the existing "Any user" condition row.
  // Click its property dropdown (search-first-dropdown-button inside search-user-filters)
  // to change the property to "ApplicationID". Clicking "Add user filter" would OR a
  // second condition with the default row and match the entire org (~90k users).
  // After selecting the property, fill() + Apply reads the value directly — no Enter needed.
  console.log(`    Opening property selector...`);
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

  // Set date range to Past 90 days (after filling the value, matching recording order)
  await page.getByTestId('button-primary-range').click();
  await page.getByText('Past 90 days').click();
  await page.getByTestId('button-on-apply').click();
  await page.locator('[data-testid="button-primary-range"]:has-text("Past 90 days")').waitFor({ state: 'visible', timeout: 15000 });
  console.log(`    Date range: Past 90 days.`);

  const applyBtn = page.getByRole('button', { name: 'Apply Filters' });
  const canApply = await applyBtn.isEnabled({ timeout: 3000 }).catch(() => false);
  if (!canApply) {
    throw new Error('Apply Filters button not enabled after filling value — aborting to avoid unfiltered results.');
  }

  await applyBtn.click();
  console.log(`    Filter applied. Waiting for results...`);

  // Wait a few seconds for FullStory to apply the filter and load results
  await page.waitForTimeout(4000);

  // Safety gate: abort if the filter didn't narrow the population (whole org matched)
  const matchedUsers = await page.evaluate(() => {
    const m = document.body.innerText.match(/([\d,]+)\s+Users?\s+of\s+([\d,]+)/i);
    if (!m) return null;
    return { matched: parseInt(m[1].replace(/,/g, ''), 10), total: parseInt(m[2].replace(/,/g, ''), 10) };
  }).catch(() => null);
  if (matchedUsers && matchedUsers.total > 0) {
    const ratio = matchedUsers.matched / matchedUsers.total;
    console.log(`    Matched ${matchedUsers.matched} of ${matchedUsers.total} users.`);
    if (ratio > 0.5) {
      throw new Error(`Filter did not narrow results (${matchedUsers.matched}/${matchedUsers.total} users) — aborting.`);
    }
  }

  if (await page.locator('text=No matches found').isVisible().catch(() => false)) {
    console.log(`    No sessions found.`);
    return [];
  }

  // Wait for session play buttons to appear then scrape their URLs
  await page.locator('a[data-testid="play-button"]').first().waitFor({ state: 'visible', timeout: 15000 });
  console.log(`    Sessions loaded.`);

  const sessions = [];
  const playButtons = await page.locator('a[data-testid="play-button"]').all();
  for (const btn of playButtons) {
    const href = await btn.getAttribute('href');
    if (!href?.includes('/session/')) continue;
    const fullUrl = href.startsWith('http') ? href : `https://app.fullstory.com${href}`;
    const sessionId = href.split('/session/')[1];
    if (sessionId && !sessions.find(s => s.sessionId === sessionId)) {
      sessions.push({ sessionId, replayUrl: fullUrl });
    }
  }
  console.log(`    Found ${sessions.length} session(s).`);
  return sessions;
}

// ── Session recording ─────────────────────────────────────────────────────────

async function recordSession(context, replayUrl, outputPath, TEMP_DIR) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Open the session in a NEW page within the SAME context (shares all cookies/auth)
  const page = await context.newPage();

  try {
    console.log(`    Loading session player...`);
    await page.goto(replayUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Target only <button> elements — excludes the <a data-testid="play-button"> sidebar link
    const PLAY_SELECTORS = [
      'button[aria-label="Play"]',
      'button[aria-label="play"]',
      'button[title="Play"]',
      'button[data-testid="play-pause-button"]',
      'button[class*="playButton"]',
      'button[class*="play-button"]',
    ].join(', ');

    console.log(`    Waiting for player controls...`);
    await page.locator(PLAY_SELECTORS).first().waitFor({ state: 'visible', timeout: 45000 });
    console.log(`    Player ready.`);

    // Set playback speed to 2x to halve recording time
    try {
      // FullStory shows a speed button in the toolbar (e.g. "1x") — click it then pick 2x
      const speedBtn = page.locator('button:has-text("1x"), [aria-label*="speed" i], [data-testid*="speed"], button:has-text("Speed")').first();
      if (await speedBtn.isVisible({ timeout: 3000 })) {
        await speedBtn.click();
        await page.waitForTimeout(400);
        const speed2x = page.locator('[role="option"]:has-text("2x"), li:has-text("2x"), button:has-text("2x")').first();
        if (await speed2x.isVisible({ timeout: 3000 })) {
          await speed2x.click();
          console.log(`    Playback speed set to 2x.`);
        }
      }
    } catch { /* speed control not found — proceed at 1x */ }

    const PROGRESS_BAR = '[data-testid="timeline-progress-bar"]';
    const readProgress = () => page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? parseFloat(el.getAttribute('aria-valuenow') ?? '0') : 0;
    }, PROGRESS_BAR).catch(() => 0);

    await page.locator(PROGRESS_BAR).waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    // Helper: is playback advancing? Sample progress twice over ~1.5s.
    const isAdvancing = async () => {
      const a = await readProgress();
      await new Promise(r => setTimeout(r, 1500));
      const b = await readProgress();
      return b > a;
    };

    // Best-effort click on the play control. The button may already be a Pause
    // button if the player auto-started, so this NEVER throws fatally.
    const clickPlay = async (force = false) => {
      try {
        const playBtn = page.locator(PLAY_SELECTORS).first();
        if (force) {
          // Re-click the play control directly. Avoid blind keyboard shortcuts
          // (Space/Home) — they can pause playback or trigger navigation.
          await playBtn.click({ force: true, timeout: 2000 }).catch(() => {});
        } else if (await playBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          const box = await playBtn.boundingBox({ timeout: 2000 }).catch(() => null);
          if (box) await humanLikeMove(page, box.x + box.width / 2, box.y + box.height / 2);
          await playBtn.click({ timeout: 2000 }).catch(() => {});
        }
      } catch { /* ignore */ }
    };

    // DO NOT seek backward — that reliably stalls FullStory's player. Sessions that
    // auto-play start at a few %; capturing from there is fine. We only need to make
    // sure playback is actually moving.
    if (!(await isAdvancing())) {
      await clickPlay(false);          // gentle click
      await new Promise(r => setTimeout(r, 1000));
      if (!(await isAdvancing())) {
        console.log(`    Playback not moving — nudging...`);
        await clickPlay(true);         // force re-click the play control
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Enable "Skip Inactivity" to jump over idle periods and shorten recording time
    try {
      const skipBtn = page.locator('button:has-text("Skip Inactivity"), [data-testid="skip-inactivity"], span:has-text("Skip Inactivity")').first();
      if (await skipBtn.isVisible({ timeout: 3000 })) {
        await skipBtn.click();
        console.log(`    Skip Inactivity enabled.`);
      }
    } catch { /* not available for this session */ }

    console.log(`    Playback started (${Math.round(await readProgress())}%).`);

    // Wait for the progress bar to reach 100% — the definitive end-of-session signal.
    // aria-valuenow goes from 0 → 100 as the session plays. Also bail out if progress
    // stays frozen for too long (player error / no further activity).
    const MAX_MS = 30 * 60 * 1000;
    const STALL_MS = 90 * 1000; // give up if no progress change for 90s
    const t0 = Date.now();
    let lastProgress = -1;
    let lastChange = Date.now();
    let consecutiveErrors = 0;

    while (Date.now() - t0 < MAX_MS) {
      if (page.isClosed()) { console.log(`\n    Page closed.`); break; }
      await new Promise(r => setTimeout(r, 2000));
      if (page.isClosed()) break;

      try {
        const progress = await readProgress();
        consecutiveErrors = 0; // a clean read resets the error streak

        if (progress !== lastProgress) {
          process.stdout.write(`\r    Progress: ${Math.round(progress)}%   `);
          lastProgress = progress;
          lastChange = Date.now();
        } else if (Date.now() - lastChange > STALL_MS) {
          console.log(`\n    Progress stalled at ${Math.round(progress)}% for ${STALL_MS/1000}s — stopping.`);
          break;
        }

        if (progress >= 100) {
          console.log(`\n    Playback complete (100%).`);
          await new Promise(r => setTimeout(r, 1500)); // brief pause before closing
          break;
        }
      } catch {
        // A single failed read (transient navigation / context blip) must NOT end the
        // recording — that previously saved near-empty clips. Only give up after several.
        if (++consecutiveErrors >= 5) {
          console.log(`\n    Lost contact with player after ${consecutiveErrors} read errors — stopping.`);
          break;
        }
      }
    }

  } finally {
    // Get the video object reference BEFORE closing (must be done while page is still open)
    const video = page.video();
    // Close the page — this triggers Playwright to finalize and write the video file
    await page.close().catch(() => {});
    // NOW path() resolves, because the video has been committed to disk
    let videoPath = await video?.path().catch(() => null);

    // Find video file
    if (!videoPath || !fs.existsSync(videoPath)) {
      const files = fs.readdirSync(TEMP_DIR)
        .map(f => ({ f, t: fs.statSync(path.join(TEMP_DIR, f)).mtime.getTime() }))
        .sort((a, b) => b.t - a.t);
      if (files.length > 0) videoPath = path.join(TEMP_DIR, files[0].f);
    }

    if (!videoPath || !fs.existsSync(videoPath)) throw new Error('No video file produced.');

    // Windows can keep the .webm locked for a moment after page.close() — retry the
    // move with backoff, then fall back to copy+delete if rename still fails.
    let moved = false;
    for (let attempt = 0; attempt < 8 && !moved; attempt++) {
      try {
        fs.renameSync(videoPath, outputPath);
        moved = true;
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          await new Promise(r => setTimeout(r, 750));
        } else { throw err; }
      }
    }
    if (!moved) {
      // Last resort: copy then best-effort delete the source.
      fs.copyFileSync(videoPath, outputPath);
      try { fs.unlinkSync(videoPath); } catch { /* leftover cleaned below */ }
    }
    console.log(`    Saved: ${outputPath}`);

    try {
      fs.readdirSync(TEMP_DIR)
        .filter(f => f.endsWith('.webm') || f.endsWith('.mp4'))
        .forEach(f => { try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch { /* still locked */ } });
    } catch { /* ignore */ }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Processes one applicationId end-to-end in a single persistent browser session:
 * search → find sessions → record each one.
 */
async function processApplicationId(applicationId, sessions, outputPathFn) {
  if (!fs.existsSync(AUTH_STATE)) {
    throw new Error(`Auth state not found. Run: node authenticate.js`);
  }

  // Each applicationId gets its own temp dir to avoid cross-browser file conflicts
  const TEMP_DIR = path.join(TEMP_BASE, `tmp_${applicationId.slice(0, 8)}_${Date.now()}`);
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },       // full size so all UI elements are reachable
    recordVideo: { dir: TEMP_DIR, size: { width: 854, height: 480 } }, // 480p = faster encode/save
    storageState: AUTH_STATE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const results = { success: [], failed: [] };

  try {
    // Use the first page for search
    const searchPage = await context.newPage();
    const foundSessions = await findSessions(searchPage, applicationId);
    await searchPage.close();

    for (let i = 0; i < foundSessions.length; i++) {
      const session = foundSessions[i];
      const dest = outputPathFn(session);
      console.log(`\n  [${i+1}/${foundSessions.length}] ${session.replayUrl}`);

      if (fs.existsSync(dest)) {
        console.log(`    Already recorded, skipping.`);
        results.failed.push({ ...session, reason: 'Already recorded' });
        continue;
      }

      try {
        await recordSession(context, session.replayUrl, dest, TEMP_DIR);
        results.success.push({ ...session, path: dest });
      } catch (err) {
        console.error(`    Failed: ${err.message}`);
        results.failed.push({ ...session, reason: err.message });
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    // Clean up the per-app temp dir
    try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return results;
}

module.exports = { processApplicationId };
