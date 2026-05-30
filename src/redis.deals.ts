import { Redis } from '@upstash/redis';
import type { Deal, ProfileDeposit, ProfileWithdrawal, UserProfile } from './domain.js';
import { reviveDeal, reviveProfile, reviveProfileDeposit, reviveProfileWithdrawal } from './deals.persistence.js';

export type StoredTelegramBusinessConnection = {
  id: string;
  isEnabled?: boolean;
  user?: {
    id?: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  updatedAt: string;
};

const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

export const redisDealsEnabled = Boolean(url && token);

const client = url && token ? new Redis({ url, token }) : null;

function dealKey(publicId: string): string {
  return `gifthub:deal:v1:${publicId}`;
}

function profileKey(tgId: bigint): string {
  return `gifthub:profile:v1:${tgId.toString()}`;
}

function profileDepositKey(id: string): string {
  return `gifthub:profile-deposit:v1:${id}`;
}

function profileWithdrawalKey(id: string): string {
  return `gifthub:profile-withdrawal:v1:${id}`;
}

function telegramBusinessConnectionKey(): string {
  return 'gifthub:telegram-business-connection:v1';
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export async function redisPutDeal(deal: Deal): Promise<void> {
  if (!client) return;
  await client.set(dealKey(deal.publicId), serialize(deal));
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

export async function redisPutProfile(profile: UserProfile): Promise<void> {
  if (!client) return;
  await client.set(profileKey(profile.tgId), serialize(profile));
}

export async function redisGetProfile(tgId: bigint): Promise<UserProfile | null> {
  if (!client) return null;
  const raw = await client.get<string>(profileKey(tgId));
  if (raw == null || raw === '') return null;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  try {
    return reviveProfile(JSON.parse(s) as UserProfile);
  } catch {
    return null;
  }
}

export async function redisPutProfileDeposit(deposit: ProfileDeposit): Promise<void> {
  if (!client) return;
  await client.set(profileDepositKey(deposit.id), serialize(deposit));
}

export async function redisGetProfileDeposit(id: string): Promise<ProfileDeposit | null> {
  if (!client) return null;
  const raw = await client.get<string>(profileDepositKey(id));
  if (raw == null || raw === '') return null;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  try {
    return reviveProfileDeposit(JSON.parse(s) as ProfileDeposit);
  } catch {
    return null;
  }
}

export async function redisPutProfileWithdrawal(withdrawal: ProfileWithdrawal): Promise<void> {
  if (!client) return;
  await client.set(profileWithdrawalKey(withdrawal.id), serialize(withdrawal));
}

export async function redisGetProfileWithdrawal(id: string): Promise<ProfileWithdrawal | null> {
  if (!client) return null;
  const raw = await client.get<string>(profileWithdrawalKey(id));
  if (raw == null || raw === '') return null;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  try {
    return reviveProfileWithdrawal(JSON.parse(s) as ProfileWithdrawal);
  } catch {
    return null;
  }
}

export async function redisPutTelegramBusinessConnection(state: StoredTelegramBusinessConnection): Promise<void> {
  if (!client) return;
  await client.set(telegramBusinessConnectionKey(), serialize(state));
}

export async function redisGetTelegramBusinessConnection(): Promise<StoredTelegramBusinessConnection | null> {
  if (!client) return null;
  const raw = await client.get<string>(telegramBusinessConnectionKey());
  if (raw == null || raw === '') return null;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  try {
    const parsed = JSON.parse(s) as StoredTelegramBusinessConnection;
    if (!parsed?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}
