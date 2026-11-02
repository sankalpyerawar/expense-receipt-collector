# Foodbook (SmartQ) Order Receipt Collector

Scrapes Foodbook cafeteria order invoices for a given month and merges them
into one PDF with a summary page (date / order ID / restaurant & counter /
amount + order count and total). Sibling project to `../uber` (Uber) and
`../blinkit` — same shape, different site.

Site: https://corporate.foodbook.co.in/foodbook-web/accessCode

## Monthly workflow

1. **Run it** with the month (and account) you want:
   ```bash
   npm start -- --month 10 --year 2026 --account default
   ```
   `--month`/`--year` default to last month and `--account` defaults to
   `default`, so `npm start` alone collects last month for the default
   account. The same values can be set as `MONTH=10 YEAR=2026 ACCOUNT=partner`
   environment variables.

2. **Log in when prompted.** A real Chromium window opens. If the saved
   session is still valid it goes straight to scraping. If not, the terminal
   prints `=== ACTION NEEDED ===`: enter your organisation access code and
   OTP in the window, get to the Orders page, then create the signal file
   (`touch .ready-signal-default`) to let the run continue.

3. **Wait.** It applies the month as a date-range filter, scrolls the list to
   collect every order, then for each one re-opens the list, opens the order
   and clicks **Invoice** to download the real invoice PDF.

4. **Check the output:**
   ```
   output/foodbook-receipts-default-<year>-<month>.pdf
   ```
   Per-order PDFs and metadata live in `receipts/default/` (`index.json` has
   date, time, order ID, restaurant/counter, items, total, filename).

## Useful scripts

```bash
npm start        # full pipeline: scrape + merge
npm run scrape   # scrape only
npm run merge    # merge only (rebuilds output from receipts/default/)
```

Reruns are safe: invoices are overwritten by order ID and `index.json` is
merged with earlier entries, so a partial run can be completed by running
again.

## Notable implementation details (read before changing selectors)

- **The site is a Flutter web app drawn on a `<canvas>`.** There is no normal
  DOM. The scraper clicks the hidden `flt-semantics-placeholder` element to
  turn on Flutter's accessibility tree, then reads `flt-semantics` nodes
  (roles, `aria-label`s, bounding boxes). Order cards are `role="group"`
  nodes whose `aria-label` holds restaurant, status, counter, date, order ID
  and items. The order details page exposes no text, so the total is parsed
  from the downloaded invoice PDF (`pdfjs-dist`) instead.
- **Clicks are by screen coordinates.** The app is a fixed-width column
  centred in a 1280x900 viewport (set in `scrape.js`). The Filter button and
  the Invoice button (top-right of the order page) use fixed positions; list
  cards, calendar days and dialog buttons are located from the accessibility
  tree.
- **The unfiltered order list never loads.** Only after applying a date range
  via the Filter calendar do orders appear (there is no Active/Past tab once
  a filter is on). `applyMonthFilter` drives the calendar: navigate to the
  target month, click day 1, click the last day, click Proceed.
- **The list is virtualized** — only the few cards near the viewport exist in
  the tree, so the scraper scrolls with the mouse wheel and collects cards as
  they appear. To open a specific order it reloads, re-applies the filter and
  scrolls until that card is on screen.
- **First paint is flaky.** Sometimes the page is unresponsive until
  reloaded; `openMonthList` retries with reloads.
- **Each invoice is checked** to mention the expected order ID, so a
  mis-click that opens a different order is reported as a failure rather than
  saved under the wrong name.

## What counts as an order

Everything in the filtered list except orders whose status mentions
cancelled/failed/rejected/refunded.

## What's stored where (and what isn't)

- `.foodbook-profile-default/` holds your browser session only — no
  credentials are logged or written anywhere by this project.
- `.gitignore` excludes the profile, `receipts/`, `output/`, `debug/` and
  `node_modules/`.
