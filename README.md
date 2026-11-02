# expense-receipt-collector

Collect your monthly **Uber**, **Blinkit** and **Foodbook** (SmartQ cafeteria)
receipts as real invoice PDFs and merge them into one PDF per service, ready to
attach to an expense claim. Each service is a small
[Playwright](https://playwright.dev) script: it opens a real Chromium window,
uses your own logged-in session, downloads each invoice for the month and
merges them (with a summary page of date / details / amount / total).

Nothing is sent anywhere. Everything stays on your machine.

| Folder | Site | Details |
|---|---|---|
| [`uber/`](uber/README.md) | riders.uber.com | trip receipts |
| [`blinkit/`](blinkit/README.md) | blinkit.com | order invoices |
| [`foodbook/`](foodbook/README.md) | corporate.foodbook.co.in | cafeteria invoices |

## Setup (once)

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone <this repo> && cd expense-receipt-collector
npm run setup        # installs dependencies and the Chromium browser
```

## Collect a month

```bash
cd uber              # or blinkit / foodbook
npm start -- --month 10 --year 2026 --account default
```

- `--month` / `--year` default to **last month**; `--account` defaults to
  `default`. Use a different `--account` name for each person or login
  (e.g. `--account partner`); each gets its own saved session and output.
- A Chromium window opens. **The first time (or when your session expires) log
  in yourself in that window** (OTP / captcha / access code). When you can see
  your trips/orders page, create the signal file the script tells you about,
  e.g. `touch .ready-signal-default`, and it carries on.
- Results: `output/<service>-receipts-<account>-<year>-<month>.pdf`. The
  individual invoices and an `index.json` are in `receipts/<account>/`.
- Reruns are safe and overwrite the same files.

Blinkit can limit to certain deliveries: `--match "hyderabad|gachibowli"`.

## Combine accounts / filter by city

After collecting each account, build one PDF per service across **all**
accounts, optionally filtered by location text:

```bash
# from the repo root
npm run combine -- --month 10 --year 2026
npm run combine -- --month 10 --services uber,blinkit,foodbook --match "hyderabad|gachibowli"
```

Output goes to `combined/` (`<service>-<year>-<month>[-filtered].pdf`). `--match`
is a case-insensitive regex tested on the Uber pickup/dropoff, Blinkit delivery
address, or Foodbook office/counter.

## Privacy and security

- **No credentials are ever stored or logged by these scripts.** You log in in
  the browser window yourself.
- The browser keeps your logged-in session (cookies) in
  `.<service>-profile-<account>/`. **Treat these folders like passwords** and
  never share or commit them.
- `.gitignore` excludes sessions, downloaded receipts, merged PDFs, debug
  files, logs and `*.pdf`/`*.png`, so a normal `git add .` cannot commit your
  personal data. Don't force-add them.
- Check your employer's expense policy and each site's terms before automating.

## Known limitations

- The scripts drive the live sites, so they break when a site changes its
  layout. Each folder's README lists the selectors and quirks to check first.
- Foodbook treats any page with an "Orders" tab as logged in, so an expired
  session can look valid and the run then fails to load orders. If Foodbook
  fails or reports no orders, open the portal, log in again, and retry.
- Only one run per service at a time (each uses a headed browser window).
