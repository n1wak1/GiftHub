import { randomUUID } from 'node:crypto';
import type { Currency, Deal, GiftAsset, UserProfile } from './domain.js';
import { loadDealsStoreFromDisk, saveDealsStoreToDisk } from './deals.persistence.js';
import { redisDealsEnabled, redisGetDeal, redisPutDeal } from './redis.deals.js';
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
  private readonly giftsById = new Map<string, GiftAsset>();
  private readonly giftsByGiftId = new Map<string, GiftAsset>();
  private readonly profilesByTgId = new Map<bigint, UserProfile>();

  constructor() {
    const loaded = loadDealsStoreFromDisk();
    if (!loaded) return;
    for (const d of loaded.deals) {
      this.byPublicId.set(d.publicId, d);
    }
    for (const g of loaded.gifts) {
      this.giftsById.set(g.id, g);
      this.giftsByGiftId.set(g.giftId, g);
    }
    for (const p of loaded.profiles) {
      this.profilesByTgId.set(p.tgId, p);
    }
  }

  private persist(): void {
    saveDealsStoreToDisk({
      deals: this.byPublicId.values(),
      gifts: this.giftsById.values(),
      profiles: this.profilesByTgId.values(),
    });
  }

  /** Подтянуть сделку из Redis поверх локальной памяти (несколько инстансов Render). */
  async pullDealFromRedis(publicId: string): Promise<void> {
    if (!redisDealsEnabled) return;
    const remote = await redisGetDeal(publicId);
    if (remote) this.byPublicId.set(publicId, remote);
  }

  private pushDealRedis(deal: Deal): void {
    if (!redisDealsEnabled) return;
    void redisPutDeal(deal).catch((e) => console.error('[redisPutDeal]', e));
  }

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
    this.persist();
    this.pushDealRedis(deal);
    return deal;
  }

  getOrCreateProfile(tgId: bigint): UserProfile {
    const existing = this.profilesByTgId.get(tgId);
    if (existing) return existing;
    const now = nowIso();
    const p: UserProfile = { tgId, createdAt: now, updatedAt: now };
    this.profilesByTgId.set(tgId, p);
    return p;
  }

  setPayoutWallet(params: { tgId: bigint; walletAddress: string }): UserProfile {
    const walletAddress = params.walletAddress.trim();
    if (!walletAddress) throw new Error('walletAddress is required');
    const p = this.getOrCreateProfile(params.tgId);
    p.payoutWalletAddress = walletAddress;
    p.updatedAt = nowIso();
    this.persist();
    return p;
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
    this.persist();
    this.pushDealRedis(deal);
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

    this.persist();
    this.pushDealRedis(deal);
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
    deal.status = deal.reservedGiftId ? 'GIFT_RESERVED' : 'PAYMENT_CONFIRMED';
    deal.updatedAt = nowIso();
    this.persist();
    this.pushDealRedis(deal);
    return deal;
  }

  depositGift(params: {
    ownerTgId: bigint;
    giftId: string;
    title?: string;
    model?: string;
    background?: string;
  }): GiftAsset {
    const giftId = params.giftId.trim();
    if (!giftId) throw new Error('giftId is required');
    if (this.giftsByGiftId.has(giftId)) throw new Error('giftId already deposited');

    const createdAt = nowIso();
    const gift: GiftAsset = {
      id: randomUUID(),
      ownerTgId: params.ownerTgId,
      giftId,
      title: params.title?.trim() || undefined,
      model: params.model?.trim() || undefined,
      background: params.background?.trim() || undefined,
      status: 'AVAILABLE',
      createdAt,
      updatedAt: createdAt
    };
    this.giftsById.set(gift.id, gift);
    this.giftsByGiftId.set(gift.giftId, gift);
    this.persist();
    return gift;
  }

  listGiftsByOwner(ownerTgId: bigint): GiftAsset[] {
    return [...this.giftsById.values()].filter((g) => g.ownerTgId === ownerTgId);
  }

  reserveGiftForDeal(params: { publicId: string; sellerTgId: bigint; giftId: string }): { deal: Deal; gift: GiftAsset } {
    const deal = this.mustGet(params.publicId);
    if (deal.sellerTgId !== params.sellerTgId) throw new Error('Only seller can reserve gift');
    if (!deal.paymentConfirmedAt) throw new Error('Payment must be confirmed before reserving gift');
    if (deal.status !== 'PAYMENT_CONFIRMED' && deal.status !== 'GIFT_RESERVED') {
      throw new Error(`Cannot reserve gift in status ${deal.status}`);
    }

    const gift = this.giftsByGiftId.get(params.giftId.trim());
    if (!gift) throw new Error('Gift not found');
    if (gift.ownerTgId !== params.sellerTgId) throw new Error('Seller does not own this gift');

    // If deal already has another reserved gift, release it first.
    if (deal.reservedGiftId && deal.reservedGiftId !== gift.giftId) {
      const prev = this.giftsByGiftId.get(deal.reservedGiftId);
      if (prev) {
        prev.status = 'AVAILABLE';
        prev.reservedDealPublicId = undefined;
        prev.updatedAt = nowIso();
      }
    }

    if (gift.status === 'RESERVED' && gift.reservedDealPublicId !== deal.publicId) {
      throw new Error('Gift is reserved by another deal');
    }

    gift.status = 'RESERVED';
    gift.reservedDealPublicId = deal.publicId;
    gift.updatedAt = nowIso();

    deal.reservedGiftId = gift.giftId;
    deal.giftReservedAt = nowIso();
    deal.status = 'GIFT_RESERVED';
    deal.updatedAt = nowIso();
    this.persist();
    this.pushDealRedis(deal);
    return { deal, gift };
  }

  unreserveGiftForDeal(params: { publicId: string; sellerTgId: bigint }): { deal: Deal; gift: GiftAsset | null } {
    const deal = this.mustGet(params.publicId);
    if (deal.sellerTgId !== params.sellerTgId) throw new Error('Only seller can unreserve gift');
    if (!deal.reservedGiftId) return { deal, gift: null };

    const gift = this.giftsByGiftId.get(deal.reservedGiftId) ?? null;
    if (gift && gift.reservedDealPublicId === deal.publicId) {
      gift.status = 'AVAILABLE';
      gift.reservedDealPublicId = undefined;
      gift.updatedAt = nowIso();
    }

    deal.reservedGiftId = undefined;
    deal.giftReservedAt = undefined;
    deal.status = 'PAYMENT_CONFIRMED';
    deal.updatedAt = nowIso();
    this.persist();
    this.pushDealRedis(deal);
    return { deal, gift };
  }

  releaseDeal(params: {
    publicId: string;
    sellerTgId: bigint;
    feeRecipientAddress?: string;
    payoutTxHash?: string;
    giftTransferTxHash?: string;
  }): { deal: Deal; gift: GiftAsset } {
    const deal = this.mustGet(params.publicId);
    if (deal.sellerTgId !== params.sellerTgId) throw new Error('Only seller can release deal');
    if (deal.status !== 'GIFT_RESERVED') throw new Error(`Cannot release deal in status ${deal.status}`);
    if (!deal.paymentConfirmedAt) throw new Error('Payment is not confirmed');
    if (!deal.reservedGiftId) throw new Error('No reserved gift');
    if (!deal.currency || !deal.priceBaseUnits || !deal.feeBaseUnits) throw new Error('Deal money fields are incomplete');

    const gift = this.giftsByGiftId.get(deal.reservedGiftId);
    if (!gift) throw new Error('Reserved gift not found');
    if (gift.reservedDealPublicId !== deal.publicId) throw new Error('Gift reservation mismatch');
    if (gift.status !== 'RESERVED') throw new Error(`Gift has invalid status ${gift.status}`);

    const sellerProfile = this.getOrCreateProfile(deal.sellerTgId);
    if (!sellerProfile.payoutWalletAddress) {
      throw new Error('Seller payout wallet is not set. Bind wallet in profile first.');
    }

    const feeRecipient = params.feeRecipientAddress?.trim() || process.env.SERVICE_FEE_ADDRESS?.trim();
    if (!feeRecipient) throw new Error('Fee recipient wallet is not configured');

    const policy = getFeeConfig()[deal.currency];
    const sellerPayoutDisplay = formatUnitsToDecimal(deal.priceBaseUnits, policy.decimals);
    const feeDisplay = formatUnitsToDecimal(deal.feeBaseUnits, policy.decimals);

    gift.status = 'SENT';
    gift.updatedAt = nowIso();

    deal.status = 'COMPLETED';
    deal.releasedAt = nowIso();
    deal.sellerPayoutAddress = sellerProfile.payoutWalletAddress;
    deal.sellerPayoutAmountDisplay = sellerPayoutDisplay;
    deal.feeRecipientAddress = feeRecipient;
    deal.feeAmountFinalDisplay = feeDisplay;
    deal.payoutTxHash = params.payoutTxHash?.trim() || undefined;
    deal.giftTransferTxHash = params.giftTransferTxHash?.trim() || undefined;
    deal.updatedAt = nowIso();

    this.persist();
    this.pushDealRedis(deal);
    return { deal, gift };
  }

  private mustGet(publicId: string): Deal {
    const deal = this.byPublicId.get(publicId);
    if (!deal) throw new Error('Deal not found');
    return deal;
  }
}

