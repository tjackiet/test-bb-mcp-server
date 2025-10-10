import getVolatilityMetrics from './get_volatility_metrics.js';

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
  const [pairArg, typeArg, limitArg, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const pair = (pairArg || 'btc_jpy') as string;
  const type = (typeArg || '1day') as string;
  const limit = limitArg ? parseInt(limitArg, 10) : 200;

  const windows = typeof flags.windows === 'string' ? (String(flags.windows).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 2)) : undefined;
  const useLogReturns = flags.log ? true : (flags.linear ? false : undefined);
  const annualize = flags.ann ? true : (flags.noann ? false : undefined);

  const res = await getVolatilityMetrics(pair, type, limit, windows || [14, 20, 30], { useLogReturns, annualize });
  console.log(JSON.stringify(res, null, 2));
  if (!(res as any)?.ok) process.exit(1);
}

main();


