import 'dotenv/config';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { DealsStore } from './deals.store.js';
import { registerConfigHttp } from './config.http.js';
import { registerHttp } from './http.js';
import { redisDealsEnabled } from './redis.deals.js';
import { registerTelegramBotHttp } from './telegram.bot.js';

const app = Fastify({ logger: true });

app.log.info(
  redisDealsEnabled
    ? '[gifthub] Redis deal sync: enabled (multi-instance / Render)'
    : '[gifthub] Redis deal sync: OFF — задайте UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN на Render',
);

const corsOrigins = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean);
await app.register(cors, {
  origin: corsOrigins?.length ? corsOrigins : true,
});

const deals = new DealsStore();

await registerConfigHttp(app);
await registerHttp(app, { deals });
await registerTelegramBotHttp(app, { deals });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

await app.listen({ port, host });

