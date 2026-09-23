/**
 * The server under test for bench/redirect-loadtest.ts, run in its own process so the
 * load generator doesn't share (and distort) the API's event loop.
 * Prints one JSON line: { port, code, linkId } once it is listening.
 */
import { buildApp } from '../src/app.js';
import { testConfig } from '../src/config.js';
import { setHashCost } from '../src/lib/crypto.js';
import { createMemoryInfrastructure } from '../src/stores/index.js';

setHashCost('fast');
const port = Number(process.env.PORT ?? 3504);
const base = testConfig({ publicBaseUrl: `http://localhost:${port}` });
const config = { ...base, rateLimits: { ...base.rateLimits, enabled: process.env.RATE_LIMITS === 'on' } };
const app = await buildApp({ config, infra: createMemoryInfrastructure(), logger: false, startPipeline: true });
await app.listen({ port, host: '127.0.0.1' });

const user = await app.ctx.auth.signup({ email: 'bench@example.com', password: 'bench-password-1', name: 'Bench' });
const link = await app.ctx.links.create(user.id, { url: 'https://example.com/landing' });
console.log(JSON.stringify({ port, code: link.code, linkId: link.id }));

// Parent asks for the persisted click count, then we exit.
process.stdin.on('data', async (buf) => {
  if (String(buf).trim() === 'count') {
    await app.ctx.pipeline.flush();
    const clicks = (await app.ctx.infra.store.findLinkById(link.id))?.clickCount ?? 0;
    console.log(JSON.stringify({ clicks }));
  }
  if (String(buf).trim() === 'exit') {
    await app.close();
    process.exit(0);
  }
});
