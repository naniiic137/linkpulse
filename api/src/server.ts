import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { seedDemo, startDemoTraffic } from './seed/demoData.js';
import { createInfrastructure } from './stores/index.js';

const config = loadConfig();
const pretty = config.env === 'development' && process.stdout.isTTY;

const infra = await createInfrastructure(config, (msg) => console.log(`[infra] ${msg}`));
const app = await buildApp({
  config,
  infra,
  startPipeline: true,
  logger: {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  },
});

if (config.seedDemo) {
  const result = await seedDemo(app.ctx);
  app.log.info(result, 'demo data seeded (login: demo@linkpulse.dev / demo-password-123)');
  if (process.env.DEMO_TRAFFIC !== 'false') startDemoTraffic(app.ctx);
}

await app.listen({ port: config.port, host: config.host });
app.log.info({ backend: infra.kind, docs: `${config.publicBaseUrl}/docs` }, 'LinkPulse API ready');

// Graceful shutdown: flip readiness to 503 (load balancer stops routing), stop accepting
// connections, let in-flight requests finish, drain the analytics queue, close stores.
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    app.log.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
