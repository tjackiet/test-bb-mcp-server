import getFlowMetrics from './get_flow_metrics.js';

async function main() {
  const [pairArg, limitArg, bucketArg, dateArg] = process.argv.slice(2);
  const pair = (pairArg || 'btc_jpy') as string;
  const limit = limitArg ? parseInt(limitArg, 10) : 100;
  const bucketMs = bucketArg ? parseInt(bucketArg, 10) : 60_000;
  const date = dateArg;

  const res = await getFlowMetrics(pair, limit, date as any, bucketMs);
  console.log(JSON.stringify(res, null, 2));
  if (!res?.ok) process.exit(1);
}

main();



