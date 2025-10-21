import getTickersJpy from './get_tickers_jpy.js';

async function main() {
  const res = await getTickersJpy();
  console.log(JSON.stringify(res, null, 2));
  if (!(res as any)?.ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });


