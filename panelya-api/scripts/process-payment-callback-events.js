require('dotenv').config();

const db = require('../db');
const { processPendingPaymentCallbackEvents } = require('../services/paymentCallbackEvents');

async function main() {
  const limit = Math.min(Math.max(Number(process.argv[2] || 20), 1), 100);
  const processed = await processPendingPaymentCallbackEvents(limit);
  console.log(`Payment callback queue isledi: ${processed.length}`);
  for (const item of processed) {
    console.log(`- ${item.id}: ${item.status}${item.error ? ` (${item.error})` : ''}`);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
