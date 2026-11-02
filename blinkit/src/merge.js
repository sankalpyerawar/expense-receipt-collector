// Builds the final merged PDF: a generated summary page followed by every
// per-order invoice PDF in ./receipts/<account>/, sorted by order date ascending.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile, readdir } from 'node:fs/promises';
import { RECEIPTS_DIR, OUTPUT_PDF, MONTH_TAG } from './config.js';

const PAGE_WIDTH = 595.28; // A4 pt
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

async function buildSummaryPages(doc, orders) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const totalsByCurrency = {};
  for (const o of orders) {
    totalsByCurrency[o.currency] = (totalsByCurrency[o.currency] ?? 0) + (o.fare ?? 0);
  }

  const rowsPerPage = 32;
  const cols = [
    { key: 'date', label: 'Date', x: MARGIN, w: 70 },
    { key: 'orderId', label: 'Order ID', x: MARGIN + 75, w: 100 },
    { key: 'address', label: 'Delivered to', x: MARGIN + 180, w: 240 },
    { key: 'fareStr', label: 'Amount', x: MARGIN + 425, w: 90 },
  ];

  let i = 0;
  let pageNum = 0;
  while (i === 0 || i < orders.length) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;
    pageNum += 1;

    if (pageNum === 1) {
      page.drawText(`Blinkit Order Receipts — ${MONTH_TAG}`, {
        x: MARGIN,
        y,
        size: 18,
        font: bold,
      });
      y -= 26;
      const totalsLine = Object.entries(totalsByCurrency)
        .map(([cur, amt]) => `${amt.toFixed(2)} ${cur}`)
        .join(', ');
      page.drawText(`${orders.length} order${orders.length === 1 ? '' : 's'}  •  Total: ${totalsLine || 'N/A'}`, {
        x: MARGIN,
        y,
        size: 12,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
      y -= 30;
    } else {
      page.drawText(`Blinkit Order Receipts — ${MONTH_TAG} (cont.)`, {
        x: MARGIN,
        y,
        size: 12,
        font: bold,
      });
      y -= 24;
    }

    for (const col of cols) {
      page.drawText(col.label, { x: col.x, y, size: 10, font: bold });
    }
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= 14;

    let rowsOnPage = 0;
    while (i < orders.length && rowsOnPage < rowsPerPage) {
      const o = orders[i];
      const row = {
        date: o.date,
        orderId: truncate(o.orderId, 16),
        address: truncate(o.address, 45),
        fareStr: o.fare != null ? `${o.fare.toFixed(2)} ${o.currency ?? ''}` : 'N/A',
      };
      for (const col of cols) {
        page.drawText(String(row[col.key] ?? ''), { x: col.x, y, size: 9, font });
      }
      y -= 16;
      i += 1;
      rowsOnPage += 1;
    }

    if (i >= orders.length) break;
  }
}

export async function mergeReceipts() {
  const indexRaw = await readFile(`${RECEIPTS_DIR}/index.json`, 'utf-8');
  const orders = JSON.parse(indexRaw).sort((a, b) => a.date.localeCompare(b.date));

  const outDoc = await PDFDocument.create();
  await buildSummaryPages(outDoc, orders);

  const files = new Set(await readdir(RECEIPTS_DIR));
  const missing = [];

  for (const o of orders) {
    if (!files.has(o.filename)) {
      missing.push(o.filename);
      continue;
    }
    const bytes = await readFile(`${RECEIPTS_DIR}/${o.filename}`);
    const srcDoc = await PDFDocument.load(bytes);
    const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    for (const p of copiedPages) outDoc.addPage(p);
  }

  const outBytes = await outDoc.save();
  await (await import('node:fs/promises')).writeFile(OUTPUT_PDF, outBytes);

  console.log(`\nMerged ${orders.length - missing.length}/${orders.length} receipts into ${OUTPUT_PDF}`);
  if (missing.length) {
    console.log('Missing receipt files (listed in index.json but not found on disk):');
    for (const m of missing) console.log(`  - ${m}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mergeReceipts().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
