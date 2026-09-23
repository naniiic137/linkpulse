/**
 * Seed the fictional demo account into whichever backend STORE points at:
 *   STORE=postgres npm run seed
 * Idempotent: does nothing if the demo user already exists.
 */
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemo } from '../seed/demoData.js';
import { createInfrastructure } from '../stores/index.js';

const config = loadConfig();
const infra = await createInfrastructure(config, (m) => console.log(m));
const app = await buildApp({ config, infra, logger: false });
try {
  const result = await seedDemo(app.ctx);
  console.log(result.links ? `seeded ${result.links} links / ${result.clicks} clicks` : 'demo data already present');
  console.log(`login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
} finally {
  await app.close();
}
