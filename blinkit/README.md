# Blinkit Order Receipt Collector

Scrapes Blinkit order invoices for a given month and merges them into one
PDF with a summary page (date / order ID / delivered-to / amount + order
count and total). Sibling project to `../uber` (the Uber version) — same
shape, different site.

## Monthly workflow

1. **Run it** with the month (and account) you want:
   ```bash
   npm start -- --month 10 --year 2026 --account default
   ```
   `--month`/`--year` default to last month and `--account` defaults to
   `default`, so `npm start` alone collects last month for the default
   account. The same values can be set as `MONTH=10 YEAR=2026 ACCOUNT=partner`
   environment variables.

2. **Log in when prompted.** A real Chromium window opens at
   `blinkit.com/account/orders`. If the saved session for that
   `ACCOUNT_LABEL` is still valid, it skips straight to scraping. If not,
   log in yourself (OTP etc.), then signal readiness the same way as the
   Uber project (a `.ready-signal-<account>` file gets created once you
   confirm you're logged in and on the orders page).

3. **Wait.** It infinite-scrolls the order list back to the start of the
   target month, then for each matching order: re-navigates fresh and
   scrolls back to that order's position (Blinkit's list state resets on
   back-navigation, so this is the reliable way in), opens it, downloads the
   real invoice PDF, and rate-limits itself between orders. Expect a few
   minutes for ~20 orders.

4. **Check the output:**
   ```
   output/blinkit-receipts-<account>-<year>-<month>.pdf
   ```
   Per-order PDFs and metadata live in `receipts/<account>/` (`index.json`
   has date, delivery address, order ID, amount, currency, filename).

## Multiple accounts

Same pattern as the Uber project — pass `--account <label>` with a new name and rerun;
each label gets its own `.blinkit-profile-<label>/`
session and its own `receipts/<label>/` + output file.

## What counts as an order

- Completed orders with a nonzero bill total.
- Cancelled/refunded/failed orders are skipped.
- **Orders placed by someone else using your phone number** (visible in
  your order history, but you're not the account that paid) have no
  invoice available. These are still included in the output — the receipt
  page is a full-page screenshot of the order summary instead of the real
  invoice PDF, since Blinkit doesn't expose an invoice to a delivery
  contact who isn't the ordering account.

## Useful scripts

```bash
npm start        # full pipeline: scrape + merge
npm run scrape    # scrape only
npm run merge     # merge only (rebuilds output from whatever's in receipts/<account>/)
```

## Notable implementation details (read before changing selectors)

- **Order cards match their selector 3x each.** Every order row has three
  nested elements matching `div[role="button"]:has(...)` (an outer card
  wrapper, an inner content wrapper, and the actual arrow icon button) —
  only the innermost one is unique per order. The selectors use
  `:has(> span.icon-right-arrow)` (direct-child combinator) specifically to
  avoid matching all three. If you see order counts that look like exact
  multiples of the real count, this is almost certainly why.
- **List state resets on `goBack()`.** Blinkit's infinite scroll is kept in
  page memory only; navigating back to the list resets it to the initial
  30-ish items regardless of how far you'd scrolled. `scrape.js` handles
  this by always doing a fresh `goto` + re-scroll to reach a given order's
  index rather than going back and forward.
- **No invoice download link in the DOM.** "Download Invoice" is a
  click-triggered download (presigned S3 URL generated on click), not a
  static href — must be driven via `page.waitForEvent('download')`, not a
  direct fetch.
- **The PDF-render fallback must stay in the headed browser.** A separate
  headless browser (even with copied session cookies) gets Cloudflare-
  blocked on this site and returns an "access denied" page instead of real
  content. The fallback for orders without an invoice link is a full-page
  *screenshot* of the already-authenticated headed page, wrapped in a
  single-page PDF via `pdf-lib`, not a second browser/`page.pdf()`.
- **List dates omit the year for anything recent-ish**, e.g. `29 Aug, 8:42
  pm`, but older entries show it explicitly, e.g. `13 Jul 2025`. The parser
  handles both; the year on the no-year format is inferred by walking the
  list top-to-bottom and decrementing whenever the month number increases
  (a Jan-after-Dec rollover). The order detail page's `placed on Sat, 29
  Aug'26, 8:42 PM` line is authoritative when available and used to
  override the list-inferred date.

## What's stored where (and what isn't)

- `.blinkit-profile-<account>/` holds your browser session/cookies only —
  no credentials are ever logged or written anywhere by this project.
- `.gitignore` excludes all profile/receipts/output/node_modules dirs —
  none of this is meant to be committed.

## Only some deliveries (`--match`)

Pass `--match "<regex>"` to collect only orders whose delivery address matches
(case-insensitive), e.g. `npm start -- --month 10 --match "hyderabad|gachibowli"`.
Non-matching orders are skipped without downloading an invoice.
