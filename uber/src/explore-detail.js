// One-off: dump a single trip detail page's DOM/screenshot for selector
// design. Session should already be logged in via the persistent profile.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { PROFILE_DIR, DEBUG_DIR } from './config.js';

const tripUrl = process.argv[2];
if (!tripUrl) {
  console.error('Usage: node src/explore-detail.js <trip-detail-url>');
  process.exit(1);
}

async function main() {
  await mkdir(DEBUG_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 1000 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(tripUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  await page.screenshot({ path: `${DEBUG_DIR}/trip-detail.png`, fullPage: true });
  await writeFile(`${DEBUG_DIR}/trip-detail.html`, await page.content());
  console.log(`Wrote ${DEBUG_DIR}/trip-detail.{png,html}`);

  console.log('Clicking "View receipt"...');
  const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  const urlBefore = page.url();
  await page.getByRole('button', { name: 'View receipt' }).click();
  const popup = await popupPromise;

  if (popup) {
    await popup.waitForLoadState('networkidle').catch(() => {});
    await popup.waitForTimeout(1500);
    console.log('Popup opened. URL:', popup.url());
    await popup.screenshot({ path: `${DEBUG_DIR}/receipt-popup.png`, fullPage: true }).catch((e) => console.log('popup screenshot failed', e.message));
    await writeFile(`${DEBUG_DIR}/receipt-popup.html`, await popup.content().catch(() => 'N/A'));
  } else {
    await page.waitForTimeout(2000);
    console.log('No popup. URL after click:', page.url(), '(was:', urlBefore, ')');
    await page.screenshot({ path: `${DEBUG_DIR}/receipt-inline.png`, fullPage: true });
    await writeFile(`${DEBUG_DIR}/receipt-inline.html`, await page.content());
  }

  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
