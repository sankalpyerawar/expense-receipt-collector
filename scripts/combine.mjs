// Combines the receipts already collected by uber/, blinkit/ and foodbook/ into
// one PDF per service: a summary page followed by every receipt, for all
// accounts, sorted by date. Reads each project's receipts/<account>/index.json.
//
//   node scripts/combine.mjs --month 10 --match "hyderabad|gachibowli"
//
// Flags (all optional):
//   --month 1-12        default: last month
//   --year  YYYY        default: year of last month
//   --services a,b      default: uber,blinkit   (also: foodbook)
//   --match <regex>     keep only receipts whose location text matches
//   --out <dir>         default: combined
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
const year = Number(arg('year', lastMonth.getFullYear()));
const month = Number(arg('month', lastMonth.getMonth() + 1));
const tag = `${year}-${String(month).padStart(2, '0')}`;
const services = arg('services', 'uber,blinkit').split(',');
const match = arg('match', '') ? new RegExp(arg('match'), 'i') : null;
const outDir = join(root, arg('out', 'combined'));

// How to read a service's index.json entry: location text used by --match, and
// the one-line description shown on the summary page.
const SERVICES = {
  uber: {
    title: 'Uber',
    unit: 'trips',
    where: (r) => `${r.pickup} ${r.dropoff}`,
    describe: (r) => `${(r.pickup ?? '').split(',')[0]} -> ${(r.dropoff ?? '').split(',')[0]}`,
  },
  blinkit: {
    title: 'Blinkit',
    unit: 'orders',
    where: (r) => r.address ?? '',
    describe: (r) => r.orderId,
  },
  foodbook: {
    title: 'Foodbook',
    unit: 'orders',
    where: (r) => r.place ?? '',
    describe: (r) => `${r.orderId}  ${r.place ?? ''}`,
  },
};

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function combine(service) {
  const cfg = SERVICES[service];
  if (!cfg) throw new Error(`unknown service "${service}" (use: ${Object.keys(SERVICES).join(', ')})`);

  const receiptsRoot = join(root, service, 'receipts');
  const accounts = existsSync(receiptsRoot) ? readdirSync(receiptsRoot) : [];
  const rows = [];
  for (const account of accounts) {
    const dir = join(receiptsRoot, account);
    if (!existsSync(join(dir, 'index.json'))) continue;
    for (const r of JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))) {
      if (!r.date.startsWith(tag)) continue;
      if (match && !match.test(cfg.where(r))) continue;
      const path = join(dir, r.filename);
      if (!existsSync(path)) {
        console.warn(`  missing file, skipped: ${path}`);
        continue;
      }
      rows.push({ ...r, account, path });
    }
  }
  if (!rows.length) {
    console.log(`${cfg.title}: nothing found for ${tag}${match ? ` matching ${match}` : ''}`);
    return;
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const total = rows.reduce((sum, r) => sum + Number(r.fare ?? 0), 0);

  let page;
  let y;
  const header = (cont) => {
    page = doc.addPage([595.28, 841.89]);
    y = 800;
    page.drawText(`${cfg.title} receipts - ${tag}${match ? ` - ${trunc(String(match.source), 30)}` : ''}${cont ? ' (cont.)' : ''}`,
      { x: 40, y, size: 15, font: bold });
    y -= 22;
    if (!cont) {
      page.drawText(`${rows.length} ${cfg.unit}  |  Total ${rows[0].currency ?? 'INR'} ${total.toFixed(2)}  |  accounts: ${[...new Set(rows.map((r) => r.account))].join(', ')}`,
        { x: 40, y, size: 10, font });
      y -= 24;
    }
    for (const [t, x] of [['Date', 40], ['Account', 110], ['Details', 170], ['Amount', 500]]) page.drawText(t, { x, y, size: 9, font: bold });
    y -= 14;
  };
  header(false);
  for (const r of rows) {
    if (y < 50) header(true);
    page.drawText(r.date.slice(0, 10), { x: 40, y, size: 8.5, font });
    page.drawText(trunc(r.account, 10), { x: 110, y, size: 8.5, font });
    page.drawText(trunc(cfg.describe(r), 60), { x: 170, y, size: 8.5, font });
    page.drawText(Number(r.fare ?? 0).toFixed(2), { x: 500, y, size: 8.5, font });
    y -= 13;
  }
  for (const r of rows) {
    const src = await PDFDocument.load(readFileSync(r.path));
    for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
  }

  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${service}-${tag}${match ? '-filtered' : ''}.pdf`);
  writeFileSync(out, await doc.save());
  console.log(`${cfg.title}: ${rows.length} ${cfg.unit}, ${total.toFixed(2)} -> ${out} (${doc.getPageCount()} pages)`);
}

for (const s of services) await combine(s);
