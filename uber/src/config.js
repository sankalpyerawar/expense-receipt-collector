// Settings come from command-line flags, then environment variables, then the
// defaults below. Example: npm start -- --month 10 --account partner
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[name.toUpperCase()] ?? fallback;
};

// Defaults to last month, since receipts are usually collected after month end.
const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
export const TARGET_YEAR = Number(arg('year', lastMonth.getFullYear()));
export const TARGET_MONTH = Number(arg('month', lastMonth.getMonth() + 1)); // 1-12
if (!Number.isInteger(TARGET_MONTH) || TARGET_MONTH < 1 || TARGET_MONTH > 12) {
  throw new Error(`--month must be 1-12, got "${TARGET_MONTH}"`);
}

// Use --account <label> to scrape a different Uber account. Each label gets its own
// login profile (own persistent session/cookies) and its own receipts/
// output, so accounts never share state or overwrite each other.
export const ACCOUNT_LABEL = arg('account', 'default');

export const MONTH_START = new Date(Date.UTC(TARGET_YEAR, TARGET_MONTH - 1, 1));
export const MONTH_END = new Date(Date.UTC(TARGET_YEAR, TARGET_MONTH, 1)); // exclusive

const pad = (n) => String(n).padStart(2, '0');
export const MONTH_TAG = `${TARGET_YEAR}-${pad(TARGET_MONTH)}`;

export const PROFILE_DIR = `./.uber-profile-${ACCOUNT_LABEL}`;
export const READY_SIGNAL = `./.ready-signal-${ACCOUNT_LABEL}`;
export const RECEIPTS_DIR = `./receipts/${ACCOUNT_LABEL}`;
export const DEBUG_DIR = './debug';
export const OUTPUT_DIR = './output';
export const OUTPUT_PDF = `${OUTPUT_DIR}/uber-receipts-${ACCOUNT_LABEL}-${MONTH_TAG}.pdf`;
export const TRIPS_URL = 'https://riders.uber.com/trips';

export const RATE_LIMIT_MS = 1500;
