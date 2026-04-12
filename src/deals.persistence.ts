import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Deal, GiftAsset, UserProfile } from './domain.js';

type PersistedFile = {
  version: 1;
  deals: Deal[];
  gifts: GiftAsset[];
  profiles: UserProfile[];
};

function persistencePath(): string {
  const dir = process.env.DATA_DIR?.trim() || join(process.cwd(), 'data');
  return join(dir, 'deals-store.json');
}

/** Восстановление Deal после JSON (файл / Redis). */
export function reviveDeal(o: Deal): Deal {
  return {
    ...o,
    sellerTgId: BigInt(String(o.sellerTgId)),
    buyerTgId: o.buyerTgId != null ? BigInt(String(o.buyerTgId)) : undefined,
    priceBaseUnits: o.priceBaseUnits != null ? BigInt(String(o.priceBaseUnits)) : undefined,
    feeBaseUnits: o.feeBaseUnits != null ? BigInt(String(o.feeBaseUnits)) : undefined,
    totalBaseUnits: o.totalBaseUnits != null ? BigInt(String(o.totalBaseUnits)) : undefined,
  };
}

function reviveGift(o: GiftAsset): GiftAsset {
  return {
    ...o,
    ownerTgId: BigInt(String(o.ownerTgId)),
  };
}

function reviveProfile(o: UserProfile): UserProfile {
  return {
    ...o,
    tgId: BigInt(String(o.tgId)),
  };
}

export function loadDealsStoreFromDisk(): PersistedFile | null {
  const path = persistencePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.deals)) return null;
    return {
      version: 1,
      deals: parsed.deals.map(reviveDeal),
      gifts: (parsed.gifts ?? []).map(reviveGift),
      profiles: (parsed.profiles ?? []).map(reviveProfile),
    };
  } catch {
    return null;
  }
}

export function saveDealsStoreToDisk(payload: {
  deals: Iterable<Deal>;
  gifts: Iterable<GiftAsset>;
  profiles: Iterable<UserProfile>;
}): void {
  const path = persistencePath();
  mkdirSync(dirname(path), { recursive: true });
  const file: PersistedFile = {
    version: 1,
    deals: [...payload.deals],
    gifts: [...payload.gifts],
    profiles: [...payload.profiles],
  };
  const json = JSON.stringify(file, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  writeFileSync(path, json, 'utf-8');
}
