import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import {
  PROFILE_DIR,
  RECEIPTS_DIR,
  ORDERS_URL,
  MONTH_START,
  MONTH_END,
  ADDRESS_MATCH,
  RATE_LIMIT_MS,
  READY_SIGNAL,
} from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTH_LOOKUP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const CURRENCY_MAP = { '₹': 'INR', '$': 'USD', '€': 'EUR', '£': 'GBP' };
const CURRENCY_SYMBOL_PATTERN = Object.keys(CURRENCY_MAP)
  .sort((a, b) => b.length - a.length)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const FARE_REGEX = new RegExp(`(${CURRENCY_SYMBOL_PATTERN})\\s?([\\d,]+(?:\\.\\d{1,2})?)`);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseFare(text) {
  const m = text.match(FARE_REGEX);
  if (!m) return null;
  const symbol = m[1];
  const amount = parseFloat(m[2].replace(/,/g, ''));
  const currency = CURRENCY_MAP[symbol] || symbol;
  return { amount, currency };
}

// List card date comes in a few shapes:
//  "Today, 8:59 am" / "Yesterday, 8:59 am" -- relative, only for very recent orders
//  "29 Aug, 8:42 pm"   -- current-ish year, no explicit year -> use yearState (inferred)
//  "13 Jul 2025"        -- explicit year, no time
function parseListDateTime(text, yearState) {
  const relative = text.match(/\b(Today|Yesterday)\b,?\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (relative) {
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    if (/yesterday/i.test(relative[1])) d.setUTCDate(d.getUTCDate() - 1);
    yearState.year = d.getUTCFullYear();
    yearState.lastMonth = d.getUTCMonth() + 1;
    return d;
  }

  const withYear = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (withYear) {
    const day = parseInt(withYear[1], 10);
    const month = MONTH_LOOKUP[withYear[2].slice(0, 3).toLowerCase()];
    const year = parseInt(withYear[3], 10);
    if (!month) return null;
    yearState.year = year;
    yearState.lastMonth = month;
    return new Date(Date.UTC(year, month - 1, day));
  }

  const noYear = text.match(/(\d{1,2})\s+([A-Za-z]+),?\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (noYear) {
    const day = parseInt(noYear[1], 10);
    const month = MONTH_LOOKUP[noYear[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    if (yearState.lastMonth !== null && month > yearState.lastMonth) {
      yearState.year -= 1;
    }
    yearState.lastMonth = month;
    return new Date(Date.UTC(yearState.year, month - 1, day));
  }

  return null;
}

function parseDetailDate(text) {
  // "placed on Sat, 29 Aug'26, 8:42 PM"
  const m = text.match(/placed on \w+,\s*(\d{1,2})\s+([A-Za-z]+)'(\d{2}),/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTH_LOOKUP[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const year = 2000 + parseInt(m[3], 10);
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

async function waitForLogin(page) {
  const alreadyLoggedIn = await page
    .locator('div[role="button"]:has(> span.icon-right-arrow)')
    .first()
    .waitFor({ state: 'visible', timeout: 6000 })
    .then(() => true)
    .catch(() => false);

  if (alreadyLoggedIn) {
    console.log('[login] existing session detected, continuing without pause.');
    return;
  }

  if (existsSync(READY_SIGNAL)) unlinkSync(READY_SIGNAL);
  console.log('\n=== ACTION NEEDED ===');
  console.log('Log in to Blinkit in the Chromium window and navigate to My Orders.');
  console.log(`Waiting for signal file: ${READY_SIGNAL}\n`);

  const start = Date.now();
  const timeoutMs = 20 * 60 * 1000;
  while (!existsSync(READY_SIGNAL)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for login confirmation.');
    }
    await sleep(1000);
  }
  unlinkSync(READY_SIGNAL);
  console.log('[login] confirmed, continuing.\n');
}

async function collectOrderCards(page) {
  const arrows = page.locator('div[role="button"]:has(> span.icon-right-arrow)');
  const count = await arrows.count();
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const text = await arrows.nth(i).locator('xpath=..').innerText().catch(() => '');
    results.push({ index: i, text });
  }
  return results;
}

async function loadOrdersUntilCutoff(page) {
  const yearState = { year: new Date().getFullYear(), lastMonth: null };
  let oldestSeen = null;
  const MAX_ROUNDS = 100;
  let prevCount = 0;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const cards = await collectOrderCards(page);

    if (cards.length > 0) {
      const lastText = cards[cards.length - 1].text;
      const d = parseListDateTime(lastText, yearState);
      if (d) oldestSeen = d;
    }

    if (oldestSeen && oldestSeen < MONTH_START) {
      console.log(`[scrape] reached orders before target month (oldest so far: ${toDateStr(oldestSeen)}). Stopping scroll.`);
      break;
    }

    if (cards.length === prevCount) {
      console.log('[scrape] no new orders after scroll; reached end of order history.');
      break;
    }
    prevCount = cards.length;
    console.log(`[scrape] loaded ${cards.length} orders so far...`);

    await page.mouse.wheel(0, 3000);
    await page
      .waitForFunction(
        (prev) => document.querySelectorAll('div[role="button"]:has(> span.icon-right-arrow)').length > prev,
        cards.length,
        { timeout: 8000 }
      )
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  return await collectOrderCards(page);
}

// Infinite-scroll state lives only in page memory -- goBack() resets it to
// the initial 30 items. So to reliably reach a given card index we always
// start fresh from ORDERS_URL and scroll up to that index each time.
async function openOrderByIndex(page, targetIndex) {
  await page.goto(ORDERS_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const arrows = () => page.locator('div[role="button"]:has(> span.icon-right-arrow)');
  let count = await arrows().count();
  let rounds = 0;
  while (count <= targetIndex && rounds < 50) {
    await page.mouse.wheel(0, 3000);
    await page
      .waitForFunction(
        (prev) => document.querySelectorAll('div[role="button"]:has(> span.icon-right-arrow)').length > prev,
        count,
        { timeout: 8000 }
      )
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    count = await arrows().count();
    rounds += 1;
  }

  if (count <= targetIndex) {
    throw new Error(`could not scroll far enough to reach index ${targetIndex} (only reached ${count})`);
  }

  const arrow = arrows().nth(targetIndex);
  await arrow.scrollIntoViewIfNeeded();
  // Product thumbnail images are still loading/reflowing right after a
  // scroll batch renders -- settle before clicking or the click coordinates
  // can land on a different (shifted) card.
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  const urlBefore = page.url();
  await arrow.click();
  await page.waitForURL(/\/account\/orders\/\d+\/\d+/, { timeout: 10000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  // The URL updates via client-side routing before the new order's content
  // has necessarily finished rendering -- wait for a reliable content
  // marker, not just the URL/network state, or bodyText reads below can
  // still see the previous order's stale DOM.
  await page.getByText('Order id', { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(300);

  if (page.url() === urlBefore) {
    throw new Error(`click did not navigate away from ${urlBefore}`);
  }
}

async function downloadInvoice(page, context) {
  // No invoice is available for orders placed on this account using this
  // phone number by someone else -- fail fast instead of waiting out a full
  // download timeout for something that will never arrive.
  const hasInvoice = await page.getByText('Download Invoice').first().isVisible().catch(() => false);
  if (!hasInvoice) {
    throw new Error('no "Download Invoice" button on this order (likely placed by someone else using this phone number)');
  }

  // Blinkit now opens the invoice PDF in the same tab (presigned S3 URL)
  // instead of firing a download event, so wait for either and read the PDF
  // from whichever shows up. Both promises are marked handled up front so the
  // loser rejecting on its own timeout never becomes an unhandled rejection.
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  const pdfResponsePromise = page.waitForResponse(
    (r) => /order-merged-invoices\/.*\.pdf/.test(r.url()) && r.status() === 200,
    { timeout: 20000 },
  );
  downloadPromise.catch(() => {});
  pdfResponsePromise.catch(() => {});
  await page.getByText('Download Invoice').click();

  const first = await Promise.any([
    downloadPromise.then((d) => ({ download: d })),
    pdfResponsePromise.then((r) => ({ response: r })),
  ]);
  if (first.download) return first.download.path ? await first.download.path() : null;

  const tmpPath = `${RECEIPTS_DIR}/.invoice-tmp.pdf`;
  // The page's own response body is Chrome's PDF viewer wrapper, so fetch the
  // presigned URL directly for the real bytes.
  const res = await context.request.get(first.response.url());
  const bytes = await res.body();
  if (!res.ok() || bytes.subarray(0, 4).toString() !== '%PDF') {
    throw new Error(`invoice fetch did not return a PDF (status ${res.status()})`);
  }
  await writeFile(tmpPath, bytes);
  return tmpPath;
}

// page.pdf() only works in headless mode, and a separate headless browser
// (even with copied cookies) gets Cloudflare-blocked on this site -- so
// instead of a second browser, screenshot the already-authenticated headed
// page (which Cloudflare has no issue with) and wrap that image in a PDF.
async function fetchInvoiceViaScreenshot(page) {
  const { PDFDocument } = await import('pdf-lib');
  const pngBytes = await page.screenshot({ fullPage: true, type: 'png' });

  const doc = await PDFDocument.create();
  const image = await doc.embedPng(pngBytes);
  const page1 = doc.addPage([image.width, image.height]);
  page1.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return doc.save();
}

export async function runScrape() {
  // Defense in depth: a stray unhandled rejection (e.g. a Playwright wait
  // that outlives the try/catch that was meant to guard it) should never
  // take down the whole run -- log it and keep going, per the "don't abort
  // the whole run on a single trip failure" requirement.
  process.on('unhandledRejection', (reason) => {
    console.error('[scrape] unhandled rejection (ignored, continuing):', reason?.message ?? reason);
  });

  await mkdir(RECEIPTS_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 1000 },
    acceptDownloads: true,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const index = [];
  const failures = [];

  try {
    await page.goto(ORDERS_URL);
    await waitForLogin(page);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    console.log(`[scrape] target month: ${toDateStr(MONTH_START)} to ${toDateStr(MONTH_END)} (exclusive)`);
    const cards = await loadOrdersUntilCutoff(page);
    console.log(`[scrape] total orders loaded: ${cards.length}`);

    const freshYearState = { year: new Date().getFullYear(), lastMonth: null };
    const withDates = cards.map((c) => {
      const listDate = parseListDateTime(c.text, freshYearState);
      const fare = parseFare(c.text);
      return { ...c, listDate, fare };
    });

    const candidates = withDates.filter((c) => {
      if (!c.listDate) {
        console.log(`[scrape] could not parse date for order #${c.index}, skipping. Text: "${c.text.replace(/\n/g, ' | ')}"`);
        return false;
      }
      if (/cancel|refund|failed/i.test(c.text)) {
        console.log(`[scrape] order #${c.index} looks cancelled/refunded/failed, skipping.`);
        return false;
      }
      if (!c.fare || c.fare.amount === 0) {
        console.log(`[scrape] order #${c.index} has no/zero fare, skipping.`);
        return false;
      }
      return c.listDate >= MONTH_START && c.listDate < MONTH_END;
    });

    console.log(`[scrape] ${candidates.length} order(s) fall within the target month.`);

    const seenOrderUrls = new Set();

    const MAX_ATTEMPTS = 3;

    for (const candidate of candidates) {
      let lastErr = null;
      let succeeded = false;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !succeeded; attempt += 1) {
        try {
          console.log(`[scrape] opening order #${candidate.index}${attempt > 1 ? ` (attempt ${attempt})` : ''}...`);
          await openOrderByIndex(page, candidate.index);

          const orderUrl = page.url();
          if (seenOrderUrls.has(orderUrl)) {
            throw new Error(`navigated to an already-processed order URL (${orderUrl}) -- likely a misclick, retrying`);
          }

          const bodyText = await page.locator('body').innerText();

          const detailDate = parseDetailDate(bodyText);
          const finalDate = detailDate ?? candidate.listDate;
          const dateStr = toDateStr(finalDate);

          const orderIdMatch = bodyText.match(/Order id\s*\n?\s*(ORD\S+)/i);
          const orderId = orderIdMatch ? orderIdMatch[1] : `unknown-${candidate.index}`;

          const addressMatch = bodyText.match(/Deliver to\s*\n(.+)/);
          const address = addressMatch ? addressMatch[1].trim() : null;

          const billTotalMatch = bodyText.match(/Bill total\s*\n?\s*([₹$€£][\d,]+(?:\.\d{1,2})?)/i);
          const fare = billTotalMatch ? parseFare(billTotalMatch[1]) : candidate.fare;

          if (ADDRESS_MATCH && !ADDRESS_MATCH.test(address ?? '')) {
            console.log(`[scrape] skipping ${orderId} (address does not match --match: ${address})`);
            seenOrderUrls.add(orderUrl);
            succeeded = true;
            break;
          }

          const filename = `${dateStr}_${orderId}.pdf`;

          const downloadedPath = await downloadInvoice(page, context);

          if (downloadedPath) {
            const { copyFile } = await import('node:fs/promises');
            await copyFile(downloadedPath, `${RECEIPTS_DIR}/${filename}`);
          }

          seenOrderUrls.add(orderUrl);
          index.push({
            date: dateStr,
            address,
            orderId,
            fare: fare ? fare.amount : null,
            currency: fare ? fare.currency : null,
            filename,
          });

          console.log(`[scrape] saved ${filename}`);
          succeeded = true;
        } catch (err) {
          lastErr = err;
          console.log(`[scrape] order #${candidate.index} attempt ${attempt} failed: ${err.message}`);
          await sleep(1000);
        }
      }

      if (!succeeded) {
        console.error(`[scrape] FAILED order #${candidate.index} after ${MAX_ATTEMPTS} attempts: ${lastErr?.message}`);
        failures.push({ index: candidate.index, reason: lastErr?.message ?? 'unknown' });
      }

      await sleep(RATE_LIMIT_MS);
    }
  } finally {
    await writeFile(`${RECEIPTS_DIR}/index.json`, JSON.stringify(index, null, 2));
    await context.close();
  }

  console.log(`\n[scrape] done. ${index.length} receipt(s) saved, ${failures.length} failure(s).`);
  if (failures.length) {
    console.log('[scrape] failures:');
    for (const f of failures) console.log(`  - order #${f.index}: ${f.reason}`);
  }

  return { index, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runScrape().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
