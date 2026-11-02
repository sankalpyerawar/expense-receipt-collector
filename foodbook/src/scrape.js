import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PROFILE_DIR,
  RECEIPTS_DIR,
  HISTORY_URL,
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

// Screen layout of the (mobile-width, centred) Flutter app, in CSS px at a
// 1280x900 viewport. The app is drawn on a <canvas>, so these are the only
// handles we have besides the accessibility tree.
const VIEWPORT = { width: 1280, height: 900 };
const LIST_CENTER_X = 640;
const LIST_TOP = 200; // below the tabs
const LIST_BOTTOM = 830; // above the bottom nav
const INVOICE_BTN = { x: 812, y: 28 }; // "Invoice" at top-right of order details

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Flutter renders to canvas; real DOM text only exists once the (visually
// hidden) accessibility placeholder is activated.
async function enableSemantics(page) {
  await page
    .waitForSelector('flt-semantics-placeholder', { state: 'attached', timeout: 15000 })
    .catch(() => {});
  await page.evaluate(() => document.querySelector('flt-semantics-placeholder')?.click()).catch(() => {});
  await sleep(800);
}

async function readNodes(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('flt-semantics')].map((n) => {
      const r = n.getBoundingClientRect();
      return {
        role: n.getAttribute('role'),
        label: n.getAttribute('aria-label'),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }),
  );
}

// Order cards are "group" nodes whose aria-label looks like:
//   "<Office name> \n order status is ORDER SERVED \n The Brew House \n
//    Order Date & Time \n 01 Sep 2026 05:05 PM \n Order ID  \n E102D131\n
//    [1 X Pineapple Juice @ ₹38.00]\nOrder Date & Time\nOrder ID"
function parseCard(node) {
  const label = node.label ?? '';
  const id = label.match(/Order ID\s+([A-Z0-9]+)/)?.[1];
  const dt = label.match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!id || !dt) return null;
  const month = MONTH_LOOKUP[dt[2].toLowerCase()];
  if (!month) return null;
  const date = new Date(Date.UTC(parseInt(dt[3], 10), month - 1, parseInt(dt[1], 10)));
  const lines = label.split('\n').map((s) => s.trim());
  const statusIdx = lines.findIndex((l) => /order status is/i.test(l));
  return {
    orderId: id,
    date,
    dateStr: toDateStr(date),
    time: dt[4].toUpperCase(),
    status: statusIdx >= 0 ? lines[statusIdx].replace(/.*order status is\s*/i, '') : '',
    cafe: lines[0] ?? '',
    counter: statusIdx >= 0 ? (lines[statusIdx + 1] ?? '') : '',
    items: [...label.matchAll(/\[(.*?)\]/g)].map((m) => m[1]),
    rect: { x: node.x, y: node.y, w: node.w, h: node.h },
  };
}

async function getCards(page) {
  const nodes = await readNodes(page);
  return nodes
    .filter((n) => n.role === 'group' && /Order ID/.test(n.label ?? ''))
    .map(parseCard)
    .filter(Boolean);
}

async function isLoggedIn(page) {
  const nodes = await readNodes(page).catch(() => []);
  return nodes.some((n) => n.role === 'tab' && /^Orders/.test(n.label ?? ''));
}

async function waitForLogin(page) {
  await page.goto(HISTORY_URL, { waitUntil: 'domcontentloaded' });
  await enableSemantics(page);
  await sleep(2500);
  if (!page.url().includes('accessCode') && (await isLoggedIn(page))) {
    console.log('[login] existing session detected, continuing without pause.');
    return;
  }

  if (existsSync(READY_SIGNAL)) unlinkSync(READY_SIGNAL);
  console.log('\n=== ACTION NEEDED ===');
  console.log('Log in to Foodbook in the Chromium window (access code + OTP).');
  console.log('Once you can see your Orders page, tell the operator you are ready.');
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

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const FILTER_BTN = { x: 817, y: 28 };

async function clickNode(page, n) {
  await page.mouse.click(n.x + n.w / 2, n.y + n.h / 2);
}

// Applies the app's date-range filter for the target month via its calendar
// dialog (the unfiltered list never populates). Returns once the dialog is
// closed; throws if the dialog can't be driven.
async function applyMonthFilter(page) {
  await page.mouse.click(FILTER_BTN.x, FILTER_BTN.y);
  await sleep(1500);

  const targetIdx = MONTH_START.getUTCFullYear() * 12 + MONTH_START.getUTCMonth();
  for (let step = 0; step < 36; step += 1) {
    const nodes = await readNodes(page);
    // the month header is an unlabelled text node; read it from the DOM text
    const text = await page.evaluate(() =>
      [...document.querySelectorAll('flt-semantics')]
        .map((n) => n.textContent?.trim() ?? '')
        .find((t) => /^[A-Za-z]+ \d{4}$/.test(t)) ?? '',
    );
    const m = text.match(/^([A-Za-z]+) (\d{4})$/);
    if (!m) throw new Error('Calendar dialog did not open');
    const shownIdx = parseInt(m[2], 10) * 12 + MONTH_NAMES.indexOf(m[1].toLowerCase());
    if (shownIdx === targetIdx) break;
    // arrow buttons sit on the header row: previous on the left, next on the right
    const arrows = nodes
      .filter((n) => n.role === 'button' && n.w === 40 && n.h === 40 && !/^\d+$/.test(n.label ?? ''))
      .sort((a, b) => a.x - b.x);
    if (arrows.length < 2) throw new Error('Calendar month arrows not found');
    await clickNode(page, shownIdx > targetIdx ? arrows[0] : arrows[arrows.length - 1]);
    await sleep(500);
  }

  const lastDay = new Date(Date.UTC(MONTH_START.getUTCFullYear(), MONTH_START.getUTCMonth() + 1, 0)).getUTCDate();
  for (const day of [1, lastDay]) {
    const btn = await page.evaluate((d) => {
      const el = [...document.querySelectorAll('flt-semantics[role="button"]')].find((n) => n.textContent?.trim() === String(d));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, day);
    if (!btn) throw new Error(`Calendar day ${day} not found`);
    await clickNode(page, btn);
    await sleep(500);
  }
  const buttons = (await readNodes(page)).filter((n) => n.label === 'calendarDialog').sort((a, b) => a.x - b.x);
  if (buttons.length < 2) throw new Error('Calendar Proceed button not found');
  await clickNode(page, buttons[buttons.length - 1]);
}

// Loads the order history filtered to the target month. The app is sometimes
// unresponsive on first paint (page has to be reloaded), so retry with
// reloads until order cards show up.
async function openMonthList(page) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await page.goto(HISTORY_URL, { waitUntil: 'domcontentloaded' });
      await enableSemantics(page);
      await sleep(2500);
      await applyMonthFilter(page);
      for (let i = 0; i < 10; i += 1) {
        await sleep(1000);
        if ((await getCards(page)).length > 0) return;
      }
      console.log(`[list] no orders after applying filter (attempt ${attempt}), reloading...`);
    } catch (err) {
      console.log(`[list] ${err.message} (attempt ${attempt}), reloading...`);
    }
  }
  throw new Error('Could not load the filtered orders list.');
}

async function scrollList(page, dy) {
  await page.mouse.move(LIST_CENTER_X, 500);
  await page.mouse.wheel(0, dy);
  await sleep(700);
}

// Scrolls the list top-to-bottom collecting every card (the list is
// virtualized, so only a few cards exist in the tree at a time). Stops once
// it has passed the start of the target month.
async function collectUntilCutoff(page) {
  const seen = new Map();
  let stale = 0;
  while (stale < 5) {
    const before = seen.size;
    for (const c of await getCards(page)) if (!seen.has(c.orderId)) seen.set(c.orderId, c);
    const oldest = Math.min(...[...seen.values()].map((c) => c.date.getTime()));
    if (seen.size && oldest < MONTH_START.getTime()) {
      console.log(`[scrape] reached orders before target month (oldest: ${toDateStr(new Date(oldest))}). Stopping scroll.`);
      break;
    }
    stale = seen.size === before ? stale + 1 : 0;
    await scrollList(page, 450);
  }
  console.log(`[scrape] total orders seen: ${seen.size}`);
  return [...seen.values()];
}

// Scrolls a freshly-opened list until the given order is fully on screen,
// then clicks it (away from the Rate/Reorder buttons at the card bottom).
async function openOrder(page, orderId) {
  await openMonthList(page);
  let dir = 1; // 1 = scrolling down, -1 = back up after hitting the end of the list
  let stale = 0;
  let lastKey = '';
  for (let i = 0; i < 120; i += 1) {
    const cards = await getCards(page);
    const card = cards.find((c) => c.orderId === orderId);
    if (card) {
      const clickY = card.rect.y + 60;
      // the newest card's top edge sits under the date chip at scroll 0, so
      // judge visibility by the click point rather than the whole card
      if (clickY >= LIST_TOP + 10 && clickY <= LIST_BOTTOM) {
        await page.mouse.click(LIST_CENTER_X, clickY);
        await page.waitForURL(/order_success/, { timeout: 15000 });
        await sleep(2500);
        return;
      }
      await scrollList(page, card.rect.y - 260);
      continue;
    }
    // not built yet: keep scrolling; reverse once the list stops moving
    const key = cards.map((c) => c.orderId).join(',');
    stale = key === lastKey ? stale + 1 : 0;
    lastKey = key;
    if (stale >= 3) {
      if (dir === -1) break; // hit both ends
      dir = -1;
      stale = 0;
    }
    await scrollList(page, 300 * dir);
  }
  throw new Error(`Order ${orderId} not found in list`);
}

async function readPdfText(path) {
  const doc = await getDocument({ data: new Uint8Array(await readFile(path)) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((t) => t.str).join(' ') + '\n';
  }
  return text;
}

function parseInvoice(text) {
  const total =
    text.match(/Balance Amount Payable[\s|]*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1] ??
    text.match(/Rs\.?\s*([\d,]+\.\d{2})/)?.[1];
  return { total: total ? parseFloat(total.replace(/,/g, '')) : null, text };
}

async function downloadInvoice(page, outPath) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.mouse.click(INVOICE_BTN.x, INVOICE_BTN.y),
  ]);
  await download.saveAs(outPath);
}

export async function runScrape() {
  await mkdir(RECEIPTS_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: VIEWPORT,
    acceptDownloads: true,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const failures = [];
  try {
    await waitForLogin(page);

    console.log(`[scrape] target month: ${toDateStr(MONTH_START)} to ${toDateStr(MONTH_END)} (exclusive)`);
    await openMonthList(page);
    const all = await collectUntilCutoff(page);

    const inMonth = all
      .filter((c) => c.date >= MONTH_START && c.date < MONTH_END)
      .sort((a, b) => b.date - a.date || b.time.localeCompare(a.time));
    const targets = [];
    for (const c of inMonth) {
      if (/cancel|fail|reject|refund/i.test(c.status)) {
        console.log(`[scrape] ${c.orderId} is "${c.status}", skipping.`);
        continue;
      }
      targets.push(c);
    }
    console.log(`[scrape] ${targets.length} order(s) fall within the target month.`);

    const indexEntries = [];
    for (const [i, order] of targets.entries()) {
      console.log(`[scrape] (${i + 1}/${targets.length}) opening ${order.orderId} (${order.dateStr}, ${order.cafe})...`);
      try {
        await openOrder(page, order.orderId);
        const filename = `${order.dateStr}_${order.orderId}.pdf`;
        const outPath = `${RECEIPTS_DIR}/${filename}`;
        await downloadInvoice(page, outPath);
        const inv = parseInvoice(await readPdfText(outPath));
        if (!inv.text.includes(order.orderId)) {
          throw new Error(`invoice does not mention order ID ${order.orderId} (wrong order opened?)`);
        }
        indexEntries.push({
          date: order.dateStr,
          time: order.time,
          orderId: order.orderId,
          place: [order.cafe, order.counter].filter(Boolean).join(' / '),
          items: order.items,
          fare: inv.total,
          currency: 'INR',
          filename,
        });
        console.log(`[scrape] saved ${filename} (${inv.total ?? 'total not found'})`);
      } catch (err) {
        console.error(`[scrape] FAILED ${order.orderId}: ${err.message.split('\n')[0]}`);
        failures.push({ orderId: order.orderId, error: err.message.split('\n')[0] });
      }
      await sleep(RATE_LIMIT_MS);
    }

    // Merge with any earlier run so a partial rerun doesn't drop receipts.
    const indexPath = `${RECEIPTS_DIR}/index.json`;
    const previous = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, 'utf-8')) : [];
    const byId = new Map(previous.map((e) => [e.orderId, e]));
    for (const e of indexEntries) byId.set(e.orderId, e);
    const merged = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    await writeFile(indexPath, JSON.stringify(merged, null, 2));
    console.log(`\n[scrape] done. ${indexEntries.length} receipt(s) saved, ${failures.length} failure(s).`);
    if (failures.length) {
      console.log('[scrape] failures:');
      for (const f of failures) console.log(`- ${f.orderId}: ${f.error}`);
    }
  } finally {
    await context.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runScrape().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
