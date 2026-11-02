// One-off inspection tool. Launches the persistent profile, waits for login,
// then dumps the page DOM/screenshot so real selectors can be written
// against them instead of guessed.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { PROFILE_DIR, DEBUG_DIR, READY_SIGNAL } from './config.js';

const startUrl = process.argv[2] || 'https://blinkit.com/';
const dumpTag = process.argv[3] || 'page';

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
  await writeFile(`${DEBUG_DIR}/${tag}.html`, await page.content());
  console.log(`[dump] wrote ${DEBUG_DIR}/${tag}.{png,html}  (url: ${page.url()})`);
}

async function main() {
  await mkdir(DEBUG_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 1000 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  const alreadySettled = await page.waitForTimeout(2000).then(() => false);
  if (!alreadySettled && !existsSync(READY_SIGNAL)) {
    console.log('\n=== ACTION NEEDED ===');
    console.log(`A Chromium window has opened at ${startUrl}.`);
    console.log('Do whatever is needed (log in, navigate, etc.), then signal readiness.');
    console.log(`Waiting for signal file: ${READY_SIGNAL}\n`);
    await waitForSignal('Waiting for you...');
  }

  await page.waitForTimeout(1500);
  await dump(page, dumpTag);

  console.log('\nDone. Leaving the browser open -- close it manually when ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
