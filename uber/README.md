# Uber Receipt Collector

Scrapes Uber ride receipts for a given month and merges them into one PDF
with a summary page (date / route / fare + trip count and total).

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
   session for that `ACCOUNT_LABEL` is still valid, it skips straight to
   scraping. If not, the terminal prints:
   ```
   === ACTION NEEDED ===
   Log in to Uber in the Chromium window (complete any OTP/captcha).
   ```
   Log in in that window (handle OTP/captcha yourself), then tell whoever is
   running the script that you're logged in and ready — the script polls for
   a `.ready-signal-<account>` file, which gets created for you at that
   point and the run continues automatically.

3. **Wait.** It paginates through trip history back to the start of the
   target month, opens each matching trip's detail page, downloads the real
   receipt PDF, and rate-limits itself (~1.5s between trips). For ~40 trips,
   expect roughly 1-2 minutes.

4. **Check the output:**
   ```
   output/uber-receipts-<account>-<year>-<month>.pdf
   ```
   This is the summary page(s) followed by every individual receipt PDF,
   sorted by date. Per-trip PDFs and metadata also live in
   `receipts/<account>/` (`index.json` has date, pickup, dropoff, fare,
   currency, filename per trip).

## Multiple accounts

Each `ACCOUNT_LABEL` gets its own isolated login session and its own
receipts/output, so different accounts never mix or overwrite each other:

| ACCOUNT_LABEL | Login profile | Receipts | Output |
|---|---|---|---|
| `default` | `.uber-profile-default/` | `receipts/default/` | `output/uber-receipts-default-<month>.pdf` |
| `partner` | `.uber-profile-partner/` | `receipts/partner/` | `output/uber-receipts-partner-<month>.pdf` |

To add a new account, just pass `--account <name>` with a new name:
`npm start -- --account <name>` — since there's no saved session yet, it'll prompt for login the
same way.

To rerun an existing account/month (e.g. a trip's receipt failed and Uber
has since fixed itself), just run `npm start` again — files are overwritten
by trip ID, so it's safe to rerun.

## What counts as a trip

- Only completed rides with a nonzero fare are included.
- Cancelled and "Unfulfilled" trips (₹0.00, no real receipt) are
  automatically skipped.
- Uber Eats orders and Parcel deliveries don't appear on the rider trips
  page this scrapes, so they're never included.

## Useful scripts

```bash
npm start   # full pipeline: scrape + merge
npm run scrape  # scrape only (writes receipts/<account>/*.pdf + index.json)
npm run merge   # merge only (rebuilds output PDF from whatever's already in receipts/<account>/)
```

`npm run merge` is handy if you want to tweak the summary page or re-merge
without re-scraping.

## Troubleshooting

- **Stuck on "waiting for you to log in"**: the `.ready-signal-<account>`
  file needs to be created after login. If you're driving this yourself
  (not through an assistant), you can create it manually:
  `touch .ready-signal-<account>` from the project directory.
- **Trip count looks low**: Uber's trip list lazy-loads via a "More" button
  that only appears after the page fully hydrates. If a run seems to stop
  pagination too early, just rerun it — this has been fixed to wait
  properly, but flaky networks can still occasionally cause a premature
  stop, and `npm start` is always safe to rerun.
- **A specific trip failed**: failures are logged and listed at the end of
  the run but don't abort the rest. Just rerun `npm start` — successful
  trips are skipped/overwritten harmlessly, and the failed one gets another
  attempt.

## What's stored where (and what isn't)

- `.uber-profile-<account>/` holds your browser session/cookies only — no
  credentials are ever logged or written anywhere by this project.
- `debug/` holds one-off page dumps from initial development (safe to
  delete, not used by the scraper).
- `.gitignore` excludes all of the above plus `receipts/`, `output/`, and
  `node_modules/` — none of this is meant to be committed.
