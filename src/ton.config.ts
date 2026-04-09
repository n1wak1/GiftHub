export type TonNetwork = 'testnet' | 'mainnet';

export function getTonNetwork(): TonNetwork {
  const raw = (process.env.TON_NETWORK ?? 'testnet').toLowerCase();
  if (raw === 'mainnet' || raw === 'testnet') return raw;
  return 'testnet';
}

// Known USDT Jetton masters (as of 2026). You can always override via env.
// - Mainnet: EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs
// - Testnet: kQD0GKBM8ZbryVk2aESmzfU6b9b_8era_IkvBSELujFZPsyy
export function getUsdtJettonMaster(): string | null {
  const env = process.env.USDT_JETTON_MASTER;
  if (env && env.trim().length) return env.trim();

  const net = getTonNetwork();
  if (net === 'testnet') return 'kQD0GKBM8ZbryVk2aESmzfU6b9b_8era_IkvBSELujFZPsyy';
  return 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
}

