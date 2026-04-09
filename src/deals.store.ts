import { randomUUID } from 'node:crypto';
import type { Currency, Deal } from './domain.js';
import {
  calcFeeBaseUnits,
  formatUnitsToDecimal,
  getFeeConfig,
  parseDecimalToUnits
} from './money.js';

function nowIso(): string {
  return new Date().toISOString();
}

function makePublicId(): string {
  // Short, URL-safe-ish. Good enough for MVP.
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export class DealsStore {
  private readonly byPublicId = new Map<string, Deal>();

  createDeal(params: { sellerTgId: bigint }): Deal {
    const createdAt = nowIso();
    const deal: Deal = {
      id: randomUUID(),
      publicId: makePublicId(),
      sellerTgId: params.sellerTgId,
      status: 'WAITING_FOR_BUYER',
      escrowAddress: process.env.ESCROW_ADDRESS,
      createdAt,
      updatedAt: createdAt
    };
    this.byPublicId.set(deal.publicId, deal);
    return deal;
  }

  getDeal(publicId: string): Deal | undefined {
    return this.byPublicId.get(publicId);
  }

  joinDeal(params: { publicId: string; buyerTgId: bigint }): Deal {
    const deal = this.mustGet(params.publicId);

    if (deal.buyerTgId && deal.buyerTgId !== params.buyerTgId) {
      throw new Error('Deal already has a buyer');
    }
    if (deal.status !== 'WAITING_FOR_BUYER' && deal.status !== 'WAITING_FOR_PRICE') {
      throw new Error(`Cannot join deal in status ${deal.status}`);
    }

    deal.buyerTgId = params.buyerTgId;
    deal.status = deal.currency && deal.priceLockedAt ? 'WAITING_FOR_PAYMENT' : 'WAITING_FOR_PRICE';
    deal.updatedAt = nowIso();
    return deal;
  }

  lockPrice(params: { publicId: string; sellerTgId: bigint; currency: Currency; priceDisplay: string }): Deal {
    const deal = this.mustGet(params.publicId);

    if (deal.sellerTgId !== params.sellerTgId) {
      throw new Error('Only seller can set price');
    }
    if (deal.priceLockedAt) {
      throw new Error('Price already locked');
    }
    if (deal.status !== 'WAITING_FOR_BUYER' && deal.status !== 'WAITING_FOR_PRICE') {
      throw new Error(`Cannot set price in status ${deal.status}`);
    }

    const policy = getFeeConfig()[params.currency];
    const priceUnits = parseDecimalToUnits(params.priceDisplay, policy.decimals);
    if (priceUnits <= 0n) throw new Error('Price must be > 0');

    const feeUnits = calcFeeBaseUnits(priceUnits, policy);
    const totalUnits = priceUnits + feeUnits;

    deal.currency = params.currency;
    deal.priceDisplay = formatUnitsToDecimal(priceUnits, policy.decimals);
    deal.priceBaseUnits = priceUnits;
    deal.feeDisplay = formatUnitsToDecimal(feeUnits, policy.decimals);
    deal.feeBaseUnits = feeUnits;
    deal.totalDisplay = formatUnitsToDecimal(totalUnits, policy.decimals);
    deal.totalBaseUnits = totalUnits;
    deal.priceLockedAt = nowIso();
    deal.status = deal.buyerTgId ? 'WAITING_FOR_PAYMENT' : 'WAITING_FOR_BUYER';
    deal.updatedAt = nowIso();

    return deal;
  }

  confirmPayment(params: { publicId: string; buyerTgId: bigint; txHash?: string }): Deal {
    const deal = this.mustGet(params.publicId);

    if (!deal.buyerTgId || deal.buyerTgId !== params.buyerTgId) {
      throw new Error('Only buyer can confirm payment');
    }
    if (deal.status !== 'WAITING_FOR_PAYMENT') {
      throw new Error(`Cannot confirm payment in status ${deal.status}`);
    }
    if (!deal.currency || !deal.totalBaseUnits) {
      throw new Error('Price is not locked yet');
    }

    deal.paymentTxHash = params.txHash?.trim() || undefined;
    deal.paymentConfirmedAt = nowIso();
    deal.status = 'PAYMENT_CONFIRMED';
    deal.updatedAt = nowIso();
    return deal;
  }

  private mustGet(publicId: string): Deal {
    const deal = this.byPublicId.get(publicId);
    if (!deal) throw new Error('Deal not found');
    return deal;
  }
}

