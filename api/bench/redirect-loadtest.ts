/**
 * Redirect hot-path load test (autocannon).
 *
 *   npm run loadtest            # 10 s per scenario, 50 connections
 *   DURATION=30 CONNECTIONS=100 npm run loadtest
 *
 * Starts the real Fastify app in a separate process (bench/target.ts) with the
 * IN-MEMORY backend, creates a link, warms up for 2 s, then hammers GET /:code.
 * The analytics flusher runs inside the server, so every redirect also pays for
 * queueing + batched persistence. Numbers are local and in-memory: they measure
 * the application code path, not Redis/PostgreSQL/network latency.
 */
import autocannon, { type Result } from 'autocannon';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { createInterface } from 'node:readline';

const PORT = Number(process.env.PORT ?? 3504);
const DURATION = Number(process.env.DURATION ?? 10);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function startTarget(rateLimits: boolean) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'bench/target.ts'], {
    env: { ...process.env, PORT: String(PORT), RATE_LIMITS: rateLimits ? 'on' : 'off', NODE_ENV: 'test' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout! });
  const next = () => new Promise<Record<string, unknown>>((resolve) => lines.once('line', (l) => resolve(JSON.parse(l))));
  const info = (await next()) as { code: string };
  return {
    code: info.code,
    count: async () => {
      child.stdin!.write('count\n');
      return Number((await next()).clicks);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.stdin!.write('exit\n');
      }),
  };
}

async function scenario(name: string, opts: { rateLimits: boolean; path: (code: string) => string }) {
  const target = await startTarget(opts.rateLimits);
  const req = {
    url: `http://127.0.0.1:${PORT}${opts.path(target.code)}`,
    connections: CONNECTIONS,
    headers: { 'user-agent': UA, referer: 'https://www.linkedin.com/' },
  };
  await autocannon({ ...req, duration: 2 }); // warm-up: let the JIT compile the hot path
  const before = await target.count();
  const result: Result = await autocannon({ ...req, duration: DURATION });
  const persisted = (await target.count()) - before;
  await target.stop();
  await new Promise((r) => setTimeout(r, 2000)); // let sockets drain between scenarios

  const statuses = Object.entries(result.statusCodeStats ?? {})
    .map(([code, s]) => `${code}×${(s as { count: number }).count}`)
    .join(' ');
  return {
    scenario: name,
    'req/s': Math.round(result.requests.average),
    'p50 ms': result.latency.p50,
    'p99 ms': result.latency.p99,
    'max ms': result.latency.max,
    requests: result.requests.total,
    statuses,
    errors: result.errors + result.timeouts,
    'clicks persisted': persisted,
  };
}

const rows = [
  await scenario('302 redirect, cache hit', { rateLimits: false, path: (c) => `/${c}` }),
  await scenario('404 unknown code, negative cache', { rateLimits: false, path: () => '/doesNotExist1' }),
  await scenario('429 one IP over its redirect limit', { rateLimits: true, path: (c) => `/${c}` }),
];

console.log(`\nLinkPulse redirect load test · in-memory backend · ${CONNECTIONS} connections · ${DURATION}s per scenario (after 2s warm-up)`);
console.log(`Node ${process.version} · ${process.platform}/${process.arch} · ${cpus()[0]?.model.trim()} × ${cpus().length}\n`);
console.table(rows);
