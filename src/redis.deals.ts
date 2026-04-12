import { Redis } from '@upstash/redis';
import type { Deal } from './domain.js';
import { reviveDeal } from './deals.persistence.js';

const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

export const redisDealsEnabled = Boolean(url && token);

const client = url && token ? new Redis({ url, token }) : null;

function dealKey(publicId: string): string {
  return `gifthub:deal:v1:${publicId}`;
}

export async function redisPutDeal(deal: Deal): Promise<void> {
  if (!client) return;
  const json = JSON.stringify(deal, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  await client.set(dealKey(deal.publicId), json);
}

export async function redisGetDeal(publicId: string): Promise<Deal | null> {
  if (!client) return null;
  const raw = await client.get<string>(dealKey(publicId));
  if (raw == null || raw === '') return null;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  try {
    const obj = JSON.parse(s) as Deal;
    return reviveDeal(obj);
  } catch {
    return null;
  }
}
