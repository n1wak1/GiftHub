import type { Currency } from './domain.js';

export type MoneyPolicy = {
  thresholdDisplay: string; // inclusive lower bound for percent fee
  percentFeeBps: number; // 500 = 5%
  minFeeDisplay: string;
  decimals: number;
};

export type FeeConfig = Record<Currency, MoneyPolicy>;

export function getFeeConfig(): FeeConfig {
  return {
    USDT: {
      // If price < threshold => fixed min fee. If price >= threshold => percent fee.
      thresholdDisplay: process.env.FEE_THRESHOLD_USDT ?? '15',
      percentFeeBps: Number(process.env.FEE_BPS_USDT ?? 500),
      minFeeDisplay: process.env.MIN_FEE_USDT ?? '0.2',
      decimals: 6
    },
    TON: {
      thresholdDisplay: process.env.FEE_THRESHOLD_TON ?? '15',
      percentFeeBps: Number(process.env.FEE_BPS_TON ?? 500),
      minFeeDisplay: process.env.MIN_FEE_TON ?? '0.02',
      decimals: 9
    }
  };
}

export function parseDecimalToUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Invalid decimal format');
  }

  const [intPart, fracPartRaw] = trimmed.split('.');
  const fracPart = (fracPartRaw ?? '').padEnd(decimals, '0');
  if (fracPart.length > decimals) {
    throw new Error('Too many decimal places');
  }

  const unitsStr = `${intPart}${fracPart}`;
  const normalized = unitsStr.replace(/^0+/, '') || '0';
  return BigInt(normalized);
}

export function formatUnitsToDecimal(units: bigint, decimals: number): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const s = abs.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, -decimals);
  const fracPart = s.slice(-decimals).replace(/0+$/, '');
  return fracPart.length ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

export function calcFeeBaseUnits(priceBaseUnits: bigint, policy: MoneyPolicy): bigint {
  const thresholdUnits = parseDecimalToUnits(policy.thresholdDisplay, policy.decimals);
  const minFeeUnits = parseDecimalToUnits(policy.minFeeDisplay, policy.decimals);

  if (priceBaseUnits >= thresholdUnits) {
    // fee = price * bps / 10000
    return (priceBaseUnits * BigInt(policy.percentFeeBps)) / 10000n;
  }
  return minFeeUnits;
}

