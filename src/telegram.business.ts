import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  redisGetTelegramBusinessConnection,
  redisPutTelegramBusinessConnection,
  type StoredTelegramBusinessConnection
} from './redis.deals.js';

export type TelegramBusinessConnectionStatus = {
  active: StoredTelegramBusinessConnection | null;
  envConfigured: boolean;
  stored: StoredTelegramBusinessConnection | null;
  source: 'env' | 'stored' | null;
};

function businessConnectionPath(): string {
  const dir = process.env.DATA_DIR?.trim() || join(process.cwd(), 'data');
  return join(dir, 'telegram-business-connection.json');
}

function readDiskConnection(): StoredTelegramBusinessConnection | null {
  const path = businessConnectionPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoredTelegramBusinessConnection;
    if (!parsed?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskConnection(state: StoredTelegramBusinessConnection): void {
  const path = businessConnectionPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function envConnection(): StoredTelegramBusinessConnection | null {
  const id = process.env.TELEGRAM_BUSINESS_CONNECTION_ID?.trim();
  if (!id) return null;
  return {
    id,
    isEnabled: true,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function saveTelegramBusinessConnection(update: {
  id: string;
  isEnabled?: boolean;
  user?: StoredTelegramBusinessConnection['user'];
}): Promise<StoredTelegramBusinessConnection> {
  const state: StoredTelegramBusinessConnection = {
    id: update.id.trim(),
    isEnabled: update.isEnabled,
    user: update.user,
    updatedAt: new Date().toISOString(),
  };
  if (!state.id) throw new Error('Business connection id is empty');
  writeDiskConnection(state);
  await redisPutTelegramBusinessConnection(state);
  return state;
}

export async function getStoredTelegramBusinessConnection(): Promise<StoredTelegramBusinessConnection | null> {
  const redisState = await redisGetTelegramBusinessConnection();
  if (redisState) return redisState;
  return readDiskConnection();
}

export async function getTelegramBusinessConnectionStatus(): Promise<TelegramBusinessConnectionStatus> {
  const envState = envConnection();
  const stored = await getStoredTelegramBusinessConnection();
  if (envState) {
    return { active: envState, envConfigured: true, stored, source: 'env' };
  }
  if (stored?.id && stored.isEnabled !== false) {
    return { active: stored, envConfigured: false, stored, source: 'stored' };
  }
  return { active: null, envConfigured: false, stored, source: null };
}

export async function getTelegramBusinessConnectionId(): Promise<string | null> {
  const status = await getTelegramBusinessConnectionStatus();
  return status.active?.id ?? null;
}
