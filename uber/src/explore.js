// One-off inspection tool. Launches the persistent profile, waits for you to
// log in, then dumps the trips-page DOM/screenshot/a11y tree to ./debug/ so
// real selectors can be written against them instead of guessed.
//
// Run with: node src/explore.js
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { PROFILE_DIR, DEBUG_DIR, TRIPS_URL, READY_SIGNAL } from './config.js';

async function waitForSignal(message, timeoutMs = 20 * 60 * 1000) {
  console.log(message);
  const start = Date.now();
  while (!existsSync(READY_SIGNAL)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${READY_SIGNAL}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  unlinkSync(READY_SIGNAL);
}

async function dump(page, tag) {
  await page.screenshot({ path: `${DEBUG_DIR}/${tag}.png`, fullPage: true });
  const html = await page.content();
  await (await import('node:fs/promises')).writeFile(`${DEBUG_DIR}/${tag}.html`, html);
  const snapshot = await page.locator('body').ariaSnapshot();
  await (await import('node:fs/promises')).writeFile(`${DEBUG_DIR}/${tag}.a11y.yaml`, snapshot);
  console.log(`[dump] wrote ${DEBUG_DIR}/${tag}.{png,html,a11y.json}`);
}

async function main() {
  await mkdir(DEBUG_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 1000 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto(TRIPS_URL);

  console.log('\n=== ACTION NEEDED ===');
  console.log('A Chromium window has opened. Log in (and complete any OTP/captcha)');
  console.log('yourself, then make sure you are looking at the trips list page.');
  console.log(`Waiting for signal file: ${READY_SIGNAL}\n`);
  await waitForSignal('Waiting for you to log in...');

  // Give any client-side rendering a moment to settle.
  await page.waitForTimeout(2000);
  await dump(page, 'trips-list');

  console.log('\nNow attempting to open the first trip in the list (best-effort).');
  console.log('If this fails, that is fine -- the trips-list dump is what matters most.');

  // Best-effort: try a handful of generic strategies to find a clickable trip
  // row, without assuming a specific class name.
  const candidateSelectors = [
    '[role="link"]',
    '[role="button"]',
    'a[href*="trips"]',
    'li',
  ];

  let opened = false;
  for (const sel of candidateSelectors) {
    const locator = page.locator(sel).filter({ hasText: /\$/ });
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      console.log(`[explore] trying selector "${sel}" (${count} matches with a $ amount)`);
      try {
        await locator.first().click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        opened = true;
        break;
      } catch (err) {
        console.log(`[explore] click failed for "${sel}": ${err.message}`);
      }
    }
  }

  if (opened) {
    await dump(page, 'trip-detail');
  } else {
    console.log('[explore] could not auto-open a trip detail page. Dump only the list.');
  }

  console.log('\nDone. Leaving the browser open -- close it manually when ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
