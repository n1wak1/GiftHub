import { getTonNetwork } from './ton.config.js';

function tonapiBaseUrl(): string {
  return getTonNetwork() === 'testnet' ? 'https://testnet.tonapi.io' : 'https://tonapi.io';
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

type TonapiAccountAddress = { address?: string };

type TonapiNftItem = {
  address?: string;
  metadata?: Record<string, unknown>;
  previews?: Array<{ url?: string }>;
  collection?: { name?: string };
};

type TonapiNftOperation = {
  operation?: string;
  utime?: number;
  transaction_hash?: string;
  source?: TonapiAccountAddress;
  destination?: TonapiAccountAddress;
  item?: TonapiNftItem;
};

type TonapiNftOperations = {
  operations?: TonapiNftOperation[];
  next_from?: string | number;
};

export type NftDepositHit = {
  nftAddress: string;
  title?: string;
  previewUrl?: string;
  txHash?: string;
  utime?: number;
  source?: string;
};

export async function tonapiGetNftDepositsToVault(params: {
  vaultAddress: string;
  fromWalletAddress: string;
  limit?: number;
}): Promise<NftDepositHit[]> {
  const baseUrl = tonapiBaseUrl();
  const url = new URL(
    `${baseUrl}/v2/accounts/${encodeURIComponent(params.vaultAddress)}/nfts/history`,
  );
  url.searchParams.set('limit', String(params.limit ?? 50));

  const headers: Record<string, string> = { accept: 'application/json' };
  const key = process.env.TONAPI_KEY?.trim();
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`tonapi nft history error ${res.status}: ${text || res.statusText}`);
  }
  const out = (await res.json()) as TonapiNftOperations;

  const vaultNorm = normalizeAddress(params.vaultAddress);
  const fromNorm = normalizeAddress(params.fromWalletAddress);

  const ops = out.operations ?? [];
  const hits: NftDepositHit[] = [];
  for (const op of ops) {
    if (op.operation !== 'transfer') continue;
    const dest = op.destination?.address ? normalizeAddress(op.destination.address) : '';
    const src = op.source?.address ? normalizeAddress(op.source.address) : '';
    if (!dest || dest !== vaultNorm) continue;
    if (!src || src !== fromNorm) continue;

    const itemAddr = op.item?.address?.trim() || '';
    if (!itemAddr) continue;

    const md = op.item?.metadata ?? {};
    const mdName = typeof md['name'] === 'string' ? (md['name'] as string).trim() : '';
    const title =
      mdName ||
      (typeof op.item?.collection?.name === 'string' ? op.item?.collection?.name : undefined);
    const previewUrl = op.item?.previews?.[0]?.url?.trim() || undefined;

    hits.push({
      nftAddress: itemAddr,
      title: title || undefined,
      previewUrl,
      txHash: op.transaction_hash,
      utime: op.utime,
      source: op.source?.address,
    });
  }
  return hits;
}

export async function tonapiGetIncomingNftsToVault(params: {
  vaultAddress: string;
  limit?: number;
}): Promise<NftDepositHit[]> {
  const baseUrl = tonapiBaseUrl();
  const url = new URL(
    `${baseUrl}/v2/accounts/${encodeURIComponent(params.vaultAddress)}/nfts/history`,
  );
  url.searchParams.set('limit', String(params.limit ?? 80));

  const headers: Record<string, string> = { accept: 'application/json' };
  const key = process.env.TONAPI_KEY?.trim();
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`tonapi nft history error ${res.status}: ${text || res.statusText}`);
  }
  const out = (await res.json()) as TonapiNftOperations;

  const vaultNorm = normalizeAddress(params.vaultAddress);
  const ops = out.operations ?? [];
  const hits: NftDepositHit[] = [];
  for (const op of ops) {
    if (op.operation !== 'transfer') continue;
    const dest = op.destination?.address ? normalizeAddress(op.destination.address) : '';
    if (!dest || dest !== vaultNorm) continue;
    const itemAddr = op.item?.address?.trim() || '';
    if (!itemAddr) continue;
    const md = op.item?.metadata ?? {};
    const mdName = typeof md['name'] === 'string' ? (md['name'] as string).trim() : '';
    const title =
      mdName ||
      (typeof op.item?.collection?.name === 'string' ? op.item?.collection?.name : undefined);
    const previewUrl = op.item?.previews?.[0]?.url?.trim() || undefined;
    hits.push({
      nftAddress: itemAddr,
      title: title || undefined,
      previewUrl,
      txHash: op.transaction_hash,
      utime: op.utime,
      source: op.source?.address,
    });
  }
  return hits;
}

export async function tonapiGetOutgoingNftsFromVaultToAddress(params: {
  vaultAddress: string;
  destinationAddress: string;
  limit?: number;
}): Promise<NftDepositHit[]> {
  const baseUrl = tonapiBaseUrl();
  const url = new URL(
    `${baseUrl}/v2/accounts/${encodeURIComponent(params.vaultAddress)}/nfts/history`,
  );
  url.searchParams.set('limit', String(params.limit ?? 80));

  const headers: Record<string, string> = { accept: 'application/json' };
  const key = process.env.TONAPI_KEY?.trim();
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`tonapi nft history error ${res.status}: ${text || res.statusText}`);
  }
  const out = (await res.json()) as TonapiNftOperations;

  const vaultNorm = normalizeAddress(params.vaultAddress);
  const destNorm = normalizeAddress(params.destinationAddress);
  const ops = out.operations ?? [];
  const hits: NftDepositHit[] = [];

  for (const op of ops) {
    if (op.operation !== 'transfer') continue;
    const src = op.source?.address ? normalizeAddress(op.source.address) : '';
    const dest = op.destination?.address ? normalizeAddress(op.destination.address) : '';
    if (!src || src !== vaultNorm) continue;
    if (!dest || dest !== destNorm) continue;
    const itemAddr = op.item?.address?.trim() || '';
    if (!itemAddr) continue;

    const md = op.item?.metadata ?? {};
    const mdName = typeof md['name'] === 'string' ? (md['name'] as string).trim() : '';
    const title =
      mdName ||
      (typeof op.item?.collection?.name === 'string' ? op.item?.collection?.name : undefined);
    const previewUrl = op.item?.previews?.[0]?.url?.trim() || undefined;

    hits.push({
      nftAddress: itemAddr,
      title: title || undefined,
      previewUrl,
      txHash: op.transaction_hash,
      utime: op.utime,
      source: op.source?.address,
    });
  }
  return hits;
}

