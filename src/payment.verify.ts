import type { Deal } from './domain.js';

type ToncenterMessageData = {
  '@type'?: string;
  text?: string;
};

type ToncenterMessage = {
  value?: string;
  message?: string;
  msg_data?: ToncenterMessageData;
};

type ToncenterTx = {
  transaction_id?: {
    hash?: string;
  };
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

