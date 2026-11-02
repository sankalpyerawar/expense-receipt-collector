import { runScrape } from './scrape.js';
import { mergeReceipts } from './merge.js';

async function main() {
  await runScrape();
  await mergeReceipts();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
