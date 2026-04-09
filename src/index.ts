import Fastify from 'fastify';
import { DealsStore } from './deals.store.js';
import { registerConfigHttp } from './config.http.js';
import { registerHttp } from './http.js';

const app = Fastify({ logger: true });

const deals = new DealsStore();

await registerConfigHttp(app);
await registerHttp(app, { deals });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

await app.listen({ port, host });

