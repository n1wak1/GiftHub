import { Cell } from '@ton/core';
import type { Deal } from './domain.js';

type ToncenterMessageData = {
  '@type'?: string;
  text?: string;
};

type ToncenterMessage = {
  value?: string;
  message?: string;
  msg_data?: ToncenterMessageData;
  source?: string;
};

type ToncenterTx = {
  transaction_id?: {
    hash?: string;
  };
  utime?: number;
  in_msg?: ToncenterMessage;
};

type ToncenterGetTransactionsResponse = {
  ok?: boolean;
  result?: ToncenterTx[];
};

type ToncenterV3JettonTransfer = {
  amount?: string;
  destination?: string;
  jetton_master?: string;
  transaction_hash?: string;
  forward_payload?: string;
  transaction_aborted?: boolean;
};

type ToncenterV3JettonTransfersResponse = {
  jetton_transfers?: ToncenterV3JettonTransfer[];
};

function toncenterBaseUrl(): string {
  const net = (process.env.TON_NETWORK ?? 'testnet').toLowerCase();
  return net === 'mainnet' ? 'https://toncenter.com/api/v2' : 'https://testnet.toncenter.com/api/v2';
}

function readComment(inMsg?: ToncenterMessage): string | undefined {
  if (!inMsg) return undefined;
  if (typeof inMsg.message === 'string' && inMsg.message.length) return inMsg.message;
  const msgData = inMsg.msg_data;
  if (!msgData) return undefined;
  if (typeof msgData.text === 'string' && msgData.text.length) return msgData.text;
  return undefined;
}

function toncenterV3BaseUrl(): string {
  const net = (process.env.TON_NETWORK ?? 'testnet').toLowerCase();
  return net === 'mainnet' ? 'https://toncenter.com/api/v3' : 'https://testnet.toncenter.com/api/v3';
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function readCellComment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const attempts: Buffer[] = [];
  try {
    attempts.push(Buffer.from(value, 'base64'));
  } catch {
    /* ignore */
  }
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    try {
      attempts.push(Buffer.from(value, 'hex'));
    } catch {
      /* ignore */
    }
  }

  for (const bytes of attempts) {
    try {
      const [cell] = Cell.fromBoc(bytes);
      const slice = cell.beginParse();
      if (slice.remainingBits < 32) continue;
      const op = slice.loadUint(32);
      if (op !== 0) continue;
      return slice.loadStringTail();
    } catch {
      /* try next encoding */
    }
  }
  return undefined;
}

export type DetectedDepositTx = {
  txHash: string;
  amountBaseUnits: bigint;
  comment: string;
};

export async function detectTonPaymentForDeal(params: { deal: Deal; limit?: number }): Promise<string | null> {
  const { deal } = params;
  if (!deal.escrowAddress) throw new Error('ESCROW_ADDRESS is not configured');
  if (deal.currency !== 'TON') return null;
  if (!deal.totalBaseUnits) return null;

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const url = new URL(`${toncenterBaseUrl()}/getTransactions`);
  url.searchParams.set('address', deal.escrowAddress);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('archival', 'true');

  const apiKey = process.env.TONCENTER_API_KEY?.trim();
  if (apiKey) url.searchParams.set('api_key', apiKey);

  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`toncenter error ${res.status}: ${text || res.statusText}`);
  }
  const out = (await res.json()) as ToncenterGetTransactionsResponse;
  const txs = out.result ?? [];

  const expectedValue = deal.totalBaseUnits.toString();
  const expectedComment = `deal:${deal.publicId}`;
  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    const value = inMsg.value;
    const comment = readComment(inMsg);
    if (value === expectedValue && comment === expectedComment) {
      const h = tx.transaction_id?.hash;
      return typeof h === 'string' && h.length ? h : 'matched-without-hash';
    }
  }

  return null;
}

async function fetchTonIncomingTransactions(address: string, limit: number): Promise<ToncenterTx[]> {
  const url = new URL(`${toncenterBaseUrl()}/getTransactions`);
  url.searchParams.set('address', address);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('archival', 'true');

  const apiKey = process.env.TONCENTER_API_KEY?.trim();
  if (apiKey) url.searchParams.set('api_key', apiKey);

  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`toncenter error ${res.status}: ${text || res.statusText}`);
  }
  const out = (await res.json()) as ToncenterGetTransactionsResponse;
  return out.result ?? [];
}

export async function detectTonProfileDeposit(params: {
  escrowAddress: string;
  amountBaseUnits: bigint;
  comment: string;
  limit?: number;
}): Promise<DetectedDepositTx | null> {
  const limit = Math.min(Math.max(params.limit ?? 40, 1), 100);
  const txs = await fetchTonIncomingTransactions(params.escrowAddress, limit);
  const expectedValue = params.amountBaseUnits.toString();

  for (const tx of txs) {
    const inMsg = tx.in_msg;
    const comment = readComment(inMsg);
    if (!inMsg || inMsg.value !== expectedValue || comment !== params.comment) continue;
    const h = tx.transaction_id?.hash;
    if (!h) continue;
    return { txHash: h, amountBaseUnits: BigInt(inMsg.value), comment };
  }
  return null;
}

export async function recoverTonProfileDeposits(params: {
  escrowAddress: string;
  tgId: bigint;
  limit?: number;
}): Promise<DetectedDepositTx[]> {
  const limit = Math.min(Math.max(params.limit ?? 80, 1), 100);
  const txs = await fetchTonIncomingTransactions(params.escrowAddress, limit);
  const tgId = params.tgId.toString();
  const out: DetectedDepositTx[] = [];

  for (const tx of txs) {
    const inMsg = tx.in_msg;
    const comment = readComment(inMsg);
    const h = tx.transaction_id?.hash;
    if (!inMsg?.value || !comment || !h) continue;
    const parts = comment.split(':');
    if (parts[0] !== 'profile-deposit') continue;
    const belongsToUser =
      (parts.length >= 3 && parts[1] === tgId) ||
      (parts.length >= 3 && parts[2] === tgId);
    if (!belongsToUser) continue;
    out.push({ txHash: h, amountBaseUnits: BigInt(inMsg.value), comment });
  }
  return out;
}

export async function detectUsdtPaymentForDeal(params: {
  deal: Deal;
  usdtJettonMaster: string;
  limit?: number;
}): Promise<string | null> {
  const { deal, usdtJettonMaster } = params;
  if (!deal.escrowAddress) throw new Error('ESCROW_ADDRESS is not configured');
  if (deal.currency !== 'USDT') return null;
  if (!deal.totalBaseUnits) return null;

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const url = new URL(`${toncenterV3BaseUrl()}/jetton/transfers`);
  url.searchParams.set('owner_address', deal.escrowAddress);
  url.searchParams.set('direction', 'in');
  url.searchParams.set('jetton_master', usdtJettonMaster);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('sort', 'desc');

  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = process.env.TONCENTER_API_KEY?.trim();
  if (apiKey) headers['X-API-Key'] = apiKey;

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`toncenter v3 error ${res.status}: ${text || res.statusText}`);
  }

  const out = (await res.json()) as ToncenterV3JettonTransfersResponse;
  const transfers = out.jetton_transfers ?? [];
  const expectedAmount = deal.totalBaseUnits.toString();
  const escrowNorm = normalizeAddress(deal.escrowAddress);
  const masterNorm = normalizeAddress(usdtJettonMaster);

  for (const t of transfers) {
    if (t.transaction_aborted) continue;
    if (!t.amount || !t.destination || !t.jetton_master) continue;
    if (t.amount !== expectedAmount) continue;
    if (normalizeAddress(t.destination) !== escrowNorm) continue;
    if (normalizeAddress(t.jetton_master) !== masterNorm) continue;
    if (typeof t.transaction_hash === 'string' && t.transaction_hash.length) return t.transaction_hash;
    return 'matched-usdt-without-hash';
  }

  return null;
}

async function fetchUsdtIncomingTransfers(params: {
  escrowAddress: string;
  usdtJettonMaster: string;
  limit?: number;
}): Promise<ToncenterV3JettonTransfer[]> {
  const limit = Math.min(Math.max(params.limit ?? 40, 1), 100);
  const url = new URL(`${toncenterV3BaseUrl()}/jetton/transfers`);
  url.searchParams.set('owner_address', params.escrowAddress);
  url.searchParams.set('direction', 'in');
  url.searchParams.set('jetton_master', params.usdtJettonMaster);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('sort', 'desc');

  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = process.env.TONCENTER_API_KEY?.trim();
  if (apiKey) headers['X-API-Key'] = apiKey;

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`toncenter v3 error ${res.status}: ${text || res.statusText}`);
  }
  const out = (await res.json()) as ToncenterV3JettonTransfersResponse;
  return out.jetton_transfers ?? [];
}

export async function detectUsdtProfileDeposit(params: {
  escrowAddress: string;
  usdtJettonMaster: string;
  amountBaseUnits: bigint;
  comment: string;
  limit?: number;
}): Promise<DetectedDepositTx | null> {
  const transfers = await fetchUsdtIncomingTransfers({
    escrowAddress: params.escrowAddress,
    usdtJettonMaster: params.usdtJettonMaster,
    limit: params.limit
  });
  const expectedAmount = params.amountBaseUnits.toString();
  const escrowNorm = normalizeAddress(params.escrowAddress);
  const masterNorm = normalizeAddress(params.usdtJettonMaster);

  for (const t of transfers) {
    if (t.transaction_aborted) continue;
    if (!t.amount || !t.destination || !t.jetton_master) continue;
    if (t.amount !== expectedAmount) continue;
    if (normalizeAddress(t.destination) !== escrowNorm) continue;
    if (normalizeAddress(t.jetton_master) !== masterNorm) continue;
    if (readCellComment(t.forward_payload) !== params.comment) continue;
    const h = t.transaction_hash;
    if (!h) continue;
    return { txHash: h, amountBaseUnits: BigInt(t.amount), comment: params.comment };
  }
  return null;
}

export async function recoverUsdtProfileDeposits(params: {
  escrowAddress: string;
  usdtJettonMaster: string;
  tgId: bigint;
  limit?: number;
}): Promise<DetectedDepositTx[]> {
  const transfers = await fetchUsdtIncomingTransfers({
    escrowAddress: params.escrowAddress,
    usdtJettonMaster: params.usdtJettonMaster,
    limit: params.limit
  });
  const escrowNorm = normalizeAddress(params.escrowAddress);
  const masterNorm = normalizeAddress(params.usdtJettonMaster);
  const tgId = params.tgId.toString();
  const out: DetectedDepositTx[] = [];

  for (const t of transfers) {
    if (t.transaction_aborted) continue;
    if (!t.amount || !t.destination || !t.jetton_master || !t.transaction_hash) continue;
    if (normalizeAddress(t.destination) !== escrowNorm) continue;
    if (normalizeAddress(t.jetton_master) !== masterNorm) continue;
    const comment = readCellComment(t.forward_payload);
    if (!comment) continue;
    const parts = comment.split(':');
    if (parts[0] !== 'profile-deposit') continue;
    const belongsToUser =
      (parts.length >= 3 && parts[1] === tgId) ||
      (parts.length >= 3 && parts[2] === tgId);
    if (!belongsToUser) continue;
    out.push({ txHash: t.transaction_hash, amountBaseUnits: BigInt(t.amount), comment });
  }
  return out;
}

