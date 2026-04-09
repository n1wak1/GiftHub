import { getTonNetwork } from './ton.config.js';

export type TonapiExecGetMethodResponse = {
  decoded?: Record<string, unknown>;
};

function getTonapiBaseUrl(): string {
  return getTonNetwork() === 'testnet' ? 'https://testnet.tonapi.io' : 'https://tonapi.io';
}

export async function tonapiExecGetMethod(params: {
  account: string;
  method: string;
  args: string[];
}): Promise<TonapiExecGetMethodResponse> {
  const baseUrl = getTonapiBaseUrl();
  const url = new URL(`${baseUrl}/v2/blockchain/accounts/${encodeURIComponent(params.account)}/methods/${encodeURIComponent(params.method)}`);
  for (const a of params.args) url.searchParams.append('args', a);

  const headers: Record<string, string> = { accept: 'application/json' };
  const key = process.env.TONAPI_KEY?.trim();
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`tonapi error ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as TonapiExecGetMethodResponse;
}

export async function resolveJettonWalletAddress(params: {
  jettonMaster: string;
  ownerAddress: string;
}): Promise<string> {
  const out = await tonapiExecGetMethod({
    account: params.jettonMaster,
    method: 'get_wallet_address',
    args: [params.ownerAddress]
  });

  const decoded = out.decoded ?? {};
  const v = decoded['jetton_wallet_address'];
  if (typeof v !== 'string' || !v.length) throw new Error('tonapi: missing jetton_wallet_address');
  return v;
}

