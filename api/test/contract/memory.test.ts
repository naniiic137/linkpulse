import { createMemoryInfrastructure } from '../../src/stores/index.js';
import { storeContract } from './storeContract.js';

storeContract('memory', async () => createMemoryInfrastructure());
