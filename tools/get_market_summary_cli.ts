import getMarketSummary from './get_market_summary.js';

function parseFlags(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v == null ? true : v;
    }
  }
  return flags;
}

async function main() {
  const [marketArg, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const market = (marketArg === 'jpy' ? 'jpy' : 'all') as 'all' | 'jpy';
  const window = flags.window ? parseInt(String(flags.window), 10) : 30;
  const ann = flags.ann ? true : (flags.noann ? false : true);

  const res = await getMarketSummary(market, { window, ann });
  console.log(JSON.stringify(res, null, 2));
  if (!(res as any)?.ok) process.exit(1);
}

main();


