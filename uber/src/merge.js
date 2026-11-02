// Builds the final merged PDF: a generated summary page followed by every
// per-trip receipt PDF in ./receipts/, sorted by trip date ascending.
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

async function buildSummaryPages(doc, trips) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const totalsByCurrency = {};
  for (const t of trips) {
    totalsByCurrency[t.currency] = (totalsByCurrency[t.currency] ?? 0) + (t.fare ?? 0);
  }

  const rowsPerPage = 32;
  const cols = [
    { key: 'date', label: 'Date', x: MARGIN, w: 70 },
    { key: 'route', label: 'Route', x: MARGIN + 75, w: 330 },
    { key: 'fareStr', label: 'Fare', x: MARGIN + 415, w: 100 },
  ];

  let i = 0;
  let pageNum = 0;
  while (i === 0 || i < trips.length) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;
    pageNum += 1;

    if (pageNum === 1) {
      page.drawText(`Uber Ride Receipts — ${MONTH_TAG}`, {
        x: MARGIN,
        y,
        size: 18,
        font: bold,
      });
      y -= 26;
      const totalsLine = Object.entries(totalsByCurrency)
        .map(([cur, amt]) => `${amt.toFixed(2)} ${cur}`)
        .join(', ');
      page.drawText(`${trips.length} trip${trips.length === 1 ? '' : 's'}  •  Total: ${totalsLine || 'N/A'}`, {
        x: MARGIN,
        y,
        size: 12,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
      y -= 30;
    } else {
      page.drawText(`Uber Ride Receipts — ${MONTH_TAG} (cont.)`, {
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
    while (i < trips.length && rowsOnPage < rowsPerPage) {
      const t = trips[i];
      const route = truncate(`${t.pickup ?? '?'} -> ${t.dropoff ?? '?'}`, 62);
      const fareStr = t.fare != null ? `${t.fare.toFixed(2)} ${t.currency ?? ''}` : 'N/A';
      const row = { date: t.date, route, fareStr };
      for (const col of cols) {
        page.drawText(String(row[col.key] ?? ''), { x: col.x, y, size: 9, font });
      }
      y -= 16;
      i += 1;
      rowsOnPage += 1;
    }

    if (i >= trips.length) break;
  }
}

export async function mergeReceipts() {
  const indexRaw = await readFile(`${RECEIPTS_DIR}/index.json`, 'utf-8');
  const trips = JSON.parse(indexRaw).sort((a, b) => a.date.localeCompare(b.date));

  const outDoc = await PDFDocument.create();
  await buildSummaryPages(outDoc, trips);

  const files = new Set(await readdir(RECEIPTS_DIR));
  const missing = [];

  for (const t of trips) {
    if (!files.has(t.filename)) {
      missing.push(t.filename);
      continue;
    }
    const bytes = await readFile(`${RECEIPTS_DIR}/${t.filename}`);
    const srcDoc = await PDFDocument.load(bytes);
    const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    for (const p of copiedPages) outDoc.addPage(p);
  }

  const outBytes = await outDoc.save();
  await (await import('node:fs/promises')).writeFile(OUTPUT_PDF, outBytes);

  console.log(`\nMerged ${trips.length - missing.length}/${trips.length} receipts into ${OUTPUT_PDF}`);
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
