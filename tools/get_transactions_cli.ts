import getTransactions from './get_transactions.js';

async function main() {
  const [pairArg, limitArg, dateArg] = process.argv.slice(2);
  const pair = (pairArg || 'btc_jpy') as string;
  const limit = limitArg ? parseInt(limitArg, 10) : 100;
  const date = dateArg;

  const res = await getTransactions(pair, limit, date as any);
  console.log(JSON.stringify(res, null, 2));
  if (!res?.ok) process.exit(1);
}

main();



