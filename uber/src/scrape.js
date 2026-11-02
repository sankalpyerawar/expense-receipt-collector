import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import {
  PROFILE_DIR,
  RECEIPTS_DIR,
  TRIPS_URL,
  MONTH_START,
  MONTH_END,
  RATE_LIMIT_MS,
  READY_SIGNAL,
} from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTH_LOOKUP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const CURRENCY_MAP = {
  '₹': 'INR', '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY',
  'R$': 'BRL', 'A$': 'AUD', 'C$': 'CAD', 'MX$': 'MXN', 'CHF': 'CHF',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseListDateTime(text, yearState) {
  // e.g. "1 Sept • 18:20" / "31 Aug • 10:53"
  const m = text.match(/(\d{1,2})\s+([A-Za-z]+)[^\d]*?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthKey = m[2].slice(0, 3).toLowerCase();
  const month = MONTH_LOOKUP[monthKey];
  if (!month) return null;

  if (yearState.lastMonth !== null && month > yearState.lastMonth) {
    yearState.year -= 1;
  }
  yearState.lastMonth = month;

  const date = new Date(Date.UTC(yearState.year, month - 1, day));
  return date;
}

const CURRENCY_SYMBOL_PATTERN = Object.keys(CURRENCY_MAP)
  .sort((a, b) => b.length - a.length)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const FARE_REGEX = new RegExp(`(${CURRENCY_SYMBOL_PATTERN})\\s?([\\d,]+\\.\\d{2})`);

function parseFare(text) {
  const m = text.match(FARE_REGEX);
  if (!m) return null;
  const symbol = m[1];
  const amount = parseFloat(m[2].replace(/,/g, ''));
  const currency = CURRENCY_MAP[symbol] || symbol;
  return { amount, currency };
}

function parseDetailDate(text) {
  // e.g. "18:25, Tuesday September 1 2026 with Badru"
  const m = text.match(/(\d{1,2}):(\d{2}),\s*\w+\s+([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})/);
  if (!m) return null;
  const monthKey = m[3].slice(0, 3).toLowerCase();
  const month = MONTH_LOOKUP[monthKey];
  if (!month) return null;
  const day = parseInt(m[4], 10);
  const year = parseInt(m[5], 10);
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

async function waitForLogin(page) {
  const alreadyLoggedIn = await page
    .locator('div[data-baseweb="message-card"][href*="/trips/"], text=Past')
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
  console.log('Log in to Uber in the Chromium window (complete any OTP/captcha).');
  console.log('Once you are looking at the trips page, tell the operator you are ready.');
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

async function collectTripCards(page) {
  const cards = page.locator('div[data-baseweb="message-card"][href*="/trips/"]');
  const count = await cards.count();
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const href = await card.getAttribute('href');
    const text = await card.innerText();
    results.push({ href, text });
  }
  return results;
}

async function loadTripsUntilCutoff(page) {
  const seen = new Map(); // tripId -> { href, text }
  const yearState = { year: new Date().getFullYear(), lastMonth: null };
  let oldestSeen = null;
  let stagnantRounds = 0;
  const MAX_ROUNDS = 300;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const cards = await collectTripCards(page);
    const before = seen.size;
    for (const { href, text } of cards) {
      if (!href) continue;
      const idMatch = href.match(/\/trips\/([a-f0-9-]+)/i);
      if (!idMatch) continue;
      const tripId = idMatch[1];
      if (!seen.has(tripId)) {
        seen.set(tripId, { href, text, tripId });
      }
    }

    // Determine oldest date parsed so far (cards are DOM-ordered newest -> oldest,
    // so the last card in `cards` this round should be the current oldest).
    if (cards.length > 0) {
      const lastText = cards[cards.length - 1].text;
      const d = parseListDateTime(lastText, yearState);
      if (d) oldestSeen = d;
    }

    if (oldestSeen && oldestSeen < MONTH_START) {
      console.log(`[scrape] reached trips before target month (oldest so far: ${toDateStr(oldestSeen)}). Stopping pagination.`);
      break;
    }

    const moreButton = page.getByRole('button', { name: 'More', exact: true });
    const moreVisible = await moreButton
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (!moreVisible) {
      console.log('[scrape] no more "More" button visible; reached end of trip history.');
      break;
    }

    const domCountBefore = cards.length;
    await moreButton.click().catch(() => {});
    // Wait for the newly-appended batch to actually render before the next
    // round reads the list again -- a flat delay risks reading a
    // partially-rendered DOM and triggering the cutoff prematurely.
    await page
      .waitForFunction(
        (prev) => document.querySelectorAll('div[data-baseweb="message-card"][href*="/trips/"]').length > prev,
        domCountBefore,
        { timeout: 8000 }
      )
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);

    if (seen.size === before) {
      stagnantRounds += 1;
      if (stagnantRounds >= 3) {
        console.log('[scrape] trip count stopped growing after repeated clicks; stopping pagination.');
        break;
      }
    } else {
      stagnantRounds = 0;
      console.log(`[scrape] loaded ${seen.size} trips so far...`);
    }
  }

  return { cards: Array.from(seen.values()), yearState };
}

async function extractDetail(page) {
  const headerText = await page
    .locator('div[data-baseweb="typo-labellarge"]')
    .first()
    .innerText()
    .catch(() => '');
  const detailDate = parseDetailDate(headerText);

  const routeItems = page.locator('h2:has-text("Route") ~ ol li, ol[data-baseweb="progress-steps"] li');
  const routeCount = await routeItems.count().catch(() => 0);
  let pickup = null;
  let dropoff = null;
  if (routeCount > 0) {
    const firstText = await routeItems.first().innerText();
    const lastText = await routeItems.last().innerText();
    const clean = (t) => {
      const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length && /^\d{1,2}:\d{2}$/.test(lines[lines.length - 1])) lines.pop();
      return lines.join(', ');
    };
    pickup = clean(firstText);
    dropoff = clean(lastText);
  }

  let fare = null;
  const tripDetailsText = await page
    .locator('h2:has-text("Trip details")')
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  fare = parseFare(tripDetailsText);
  if (!fare) {
    // fall back: scan whole main content for a currency amount near "Trip details"
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const section = bodyText.split('Trip details')[1]?.split('Route')[0] ?? '';
    fare = parseFare(section);
  }

  return { detailDate, pickup, dropoff, fare };
}

async function fetchReceiptPdf(context, tripId) {
  const url = `https://riders.uber.com/trips/${tripId}/receipt?contentType=PDF`;
  const resp = await context.request.get(url);
  if (resp.status() !== 200) {
    throw new Error(`receipt fetch status ${resp.status()}`);
  }
  const contentType = resp.headers()['content-type'] || '';
  if (!contentType.includes('pdf')) {
    throw new Error(`unexpected content-type: ${contentType}`);
  }
  return resp.body();
}

async function fetchReceiptViaPdfRender(page, storageState) {
  const headlessBrowser = await chromium.launch({ headless: true });
  try {
    const headlessContext = await headlessBrowser.newContext({ storageState });
    const headlessPage = await headlessContext.newPage();
    await headlessPage.goto(page.url(), { waitUntil: 'networkidle' });
    const pdfBuffer = await headlessPage.pdf({ format: 'A4' });
    await headlessContext.close();
    return pdfBuffer;
  } finally {
    await headlessBrowser.close();
  }
}

export async function runScrape() {
  await mkdir(RECEIPTS_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 1000 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const index = [];
  const failures = [];

  try {
    await page.goto(TRIPS_URL);
    await waitForLogin(page);
    // The "More" pagination button is attached after client hydration/XHR
    // settles, not present in the initial server-rendered HTML -- wait for
    // network idle rather than a fixed short delay.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    console.log(`[scrape] target month: ${toDateStr(MONTH_START)} to ${toDateStr(MONTH_END)} (exclusive)`);
    const { cards, yearState } = await loadTripsUntilCutoff(page);
    console.log(`[scrape] total unique trips loaded: ${cards.length}`);

    // Re-derive dates for all cards with a fresh, consistent year-inference pass
    // (loadTripsUntilCutoff's yearState was for cutoff detection only).
    const freshYearState = { year: new Date().getFullYear(), lastMonth: null };
    const withDates = cards.map((c) => {
      const listDate = parseListDateTime(c.text, freshYearState);
      const fare = parseFare(c.text);
      return { ...c, listDate, fare };
    });

    const candidates = withDates.filter((c) => {
      if (!c.listDate) {
        console.log(`[scrape] could not parse date for trip ${c.tripId}, skipping. Text: "${c.text.replace(/\n/g, ' | ')}"`);
        failures.push({ tripId: c.tripId, reason: 'unparseable list date' });
        return false;
      }
      if (/cancel|unfulfilled|no.?show/i.test(c.text)) {
        console.log(`[scrape] trip ${c.tripId} looks cancelled/unfulfilled (status text), skipping.`);
        return false;
      }
      if (!c.fare) {
        console.log(`[scrape] trip ${c.tripId} has no parseable fare, skipping.`);
        return false;
      }
      if (c.fare.amount === 0) {
        console.log(`[scrape] trip ${c.tripId} has a zero fare (not a completed/charged ride), skipping.`);
        return false;
      }
      return c.listDate >= MONTH_START && c.listDate < MONTH_END;
    });

    console.log(`[scrape] ${candidates.length} trip(s) fall within the target month.`);

    const storageState = await context.storageState();

    for (const candidate of candidates) {
      try {
        console.log(`[scrape] opening trip ${candidate.tripId}...`);
        await page.goto(candidate.href, { waitUntil: 'networkidle' });
        await page.waitForTimeout(800);

        const { detailDate, pickup, dropoff, fare } = await extractDetail(page);
        const finalDate = detailDate ?? candidate.listDate;
        const finalFare = fare ?? candidate.fare;
        const dateStr = toDateStr(finalDate);
        const filename = `${dateStr}_${candidate.tripId}.pdf`;

        let pdfBytes;
        try {
          pdfBytes = await fetchReceiptPdf(context, candidate.tripId);
        } catch (err) {
          console.log(`[scrape] direct receipt download failed for ${candidate.tripId} (${err.message}), falling back to page.pdf() render.`);
          pdfBytes = await fetchReceiptViaPdfRender(page, storageState);
        }

        await writeFile(`${RECEIPTS_DIR}/${filename}`, pdfBytes);

        index.push({
          date: dateStr,
          pickup: pickup ?? null,
          dropoff: dropoff ?? null,
          fare: finalFare ? finalFare.amount : null,
          currency: finalFare ? finalFare.currency : null,
          filename,
          tripId: candidate.tripId,
        });

        console.log(`[scrape] saved ${filename}`);
      } catch (err) {
        console.error(`[scrape] FAILED trip ${candidate.tripId}: ${err.message}`);
        failures.push({ tripId: candidate.tripId, reason: err.message });
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
    for (const f of failures) console.log(`  - ${f.tripId}: ${f.reason}`);
  }

  return { index, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runScrape().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
