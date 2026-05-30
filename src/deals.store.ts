import { randomUUID } from 'node:crypto';
import type { Currency, Deal, GiftAsset, ProfileDeposit, ProfileWithdrawal, UserProfile } from './domain.js';
import { loadDealsStoreFromDisk, saveDealsStoreToDisk } from './deals.persistence.js';
import {
  redisDealsEnabled,
  redisGetDeal,
  redisGetProfile,
  redisGetProfileDeposit,
  redisGetProfileWithdrawal,
  redisPutDeal,
  redisPutProfile,
  redisPutProfileDeposit,
  redisPutProfileWithdrawal
} from './redis.deals.js';
import {
  calcFeeBaseUnits,
  formatUnitsToDecimal,
  getFeeConfig,
  parseDecimalToUnits
} from './money.js';
import {
  tonapiGetIncomingNftsToVault,
  tonapiGetNftDepositsToVault,
  tonapiGetOutgoingNftsFromVaultToAddress
} from './tonapi.nft.js';
import {
  telegramCollectBusinessGiftIds,
  parseOwnedGiftItem,
  telegramCollectProfileGiftIds,
  telegramFetchFile,
  telegramGetBotUserId,
  telegramIterateBusinessGifts,
  telegramIterateUserGifts,
  telegramTransferBusinessGift
} from './telegram.gifts.js';
import type { ParsedProfileGift } from './telegram.gifts.js';
import { getTelegramBusinessConnectionId } from './telegram.business.js';

function nowIso(): string {
  return new Date().toISOString();
}

function makePublicId(): string {
  // Short, URL-safe-ish. Good enough for MVP.
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function envFlag(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

function telegramBusinessGiftTransferEnabled(): boolean {
  return envFlag('TELEGRAM_BUSINESS_GIFT_TRANSFER_ENABLED');
}

function telegramBusinessGiftScanMaxPages(envName: string, fallback: number): number {
  return Math.min(200, Math.max(1, Number.parseInt(process.env[envName] ?? String(fallback), 10) || fallback));
}

export class DealsStore {
  private readonly byPublicId = new Map<string, Deal>();
  private readonly giftsById = new Map<string, GiftAsset>();
  private readonly giftsByGiftId = new Map<string, GiftAsset>();
  private readonly profilesByTgId = new Map<bigint, UserProfile>();
  private readonly profileDepositsById = new Map<string, ProfileDeposit>();
  private readonly profileWithdrawalsById = new Map<string, ProfileWithdrawal>();
  private readonly giftDepositSessions = new Map<bigint, { startedAtMs: number; expiresAtMs: number }>();

  async fetchTelegramGiftFile(fileId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured on server');
    return telegramFetchFile({ botToken, fileId });
  }

  private applyParsedGiftVisuals(gift: GiftAsset, parsed: ParsedProfileGift): boolean {
    let changed = false;
    const setString = (key: keyof GiftAsset, value: string | undefined) => {
      if (!value || gift[key] === value) return;
      (gift as Record<string, unknown>)[key] = value;
      changed = true;
    };
    const setNumber = (key: keyof GiftAsset, value: number | undefined) => {
      if (value == null || gift[key] === value) return;
      (gift as Record<string, unknown>)[key] = value;
      changed = true;
    };

    setString('title', parsed.title);
    setString('model', parsed.model);
    setString('background', parsed.background);
    setString('telegramGiftName', parsed.uniqueName);
    setNumber('telegramGiftNumber', parsed.number);
    setString('telegramImageFileId', parsed.imageFileId);
    setString('telegramImageFileKind', parsed.imageFileKind);
    setString('telegramSymbol', parsed.symbol);
    setString('telegramSymbolFileId', parsed.symbolFileId);
    setString('backdropCenterColor', parsed.backdropCenterColor);
    setString('backdropEdgeColor', parsed.backdropEdgeColor);
    setString('backdropSymbolColor', parsed.backdropSymbolColor);
    setString('backdropTextColor', parsed.backdropTextColor);
    return changed;
  }

  private async syncTelegramBusinessGiftsForOwner(params: {
    ownerTgId: bigint;
    startedAtMs?: number;
    maxPages?: number;
  }): Promise<{ configured: boolean; added: number }> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const businessConnectionId = await getTelegramBusinessConnectionId();
    if (!botToken || !businessConnectionId) return { configured: false, added: 0 };

    let added = 0;
    await telegramIterateBusinessGifts({
      botToken,
      businessConnectionId,
      maxPages: params.maxPages ?? telegramBusinessGiftScanMaxPages('TELEGRAM_GIFTS_CLAIM_MAX_PAGES', 35),
      pageSize: 100,
      onPage: (items) => {
        for (const raw of items) {
          const p = parseOwnedGiftItem(raw);
          if (!p) continue;
          if (p.giftType !== 'unique') continue;
          if (!p.senderUserId || BigInt(p.senderUserId) !== params.ownerTgId) continue;
          const opMs = (p.sendDate ?? 0) * 1000;
          if (params.startedAtMs && opMs && opMs + 2 * 60 * 1000 < params.startedAtMs) continue;
          const existing = this.giftsByGiftId.get(p.giftId);
          if (existing) {
            if (this.applyParsedGiftVisuals(existing, p)) {
              existing.updatedAt = nowIso();
              this.persist();
            }
            continue;
          }
          try {
            this.depositGift({
              ownerTgId: params.ownerTgId,
              giftId: p.giftId,
              title: p.title,
              model: p.model,
              background: p.background,
              telegramGiftName: p.uniqueName,
              telegramGiftNumber: p.number,
              telegramImageFileId: p.imageFileId,
              telegramImageFileKind: p.imageFileKind,
              telegramSymbol: p.symbol,
              telegramSymbolFileId: p.symbolFileId,
              backdropCenterColor: p.backdropCenterColor,
              backdropEdgeColor: p.backdropEdgeColor,
              backdropSymbolColor: p.backdropSymbolColor,
              backdropTextColor: p.backdropTextColor,
              source: 'TELEGRAM_BUSINESS',
              telegramOwnedGiftId: p.ownedGiftId,
              telegramGiftType: p.giftType,
              telegramSenderUserId: BigInt(p.senderUserId),
            });
            added += 1;
          } catch {
            /* ignore duplicates / bad input */
          }
        }
      },
    });

    return { configured: true, added };
  }

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
    for (const d of loaded.profileDeposits ?? []) {
      this.profileDepositsById.set(d.id, d);
    }
    for (const w of loaded.profileWithdrawals ?? []) {
      this.profileWithdrawalsById.set(w.id, w);
    }
  }

  private persist(): void {
    saveDealsStoreToDisk({
      deals: this.byPublicId.values(),
      gifts: this.giftsById.values(),
      profiles: this.profilesByTgId.values(),
      profileDeposits: this.profileDepositsById.values(),
      profileWithdrawals: this.profileWithdrawalsById.values(),
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

  async pullProfileFromRedis(tgId: bigint): Promise<void> {
    if (!redisDealsEnabled) return;
    const remote = await redisGetProfile(tgId);
    if (remote) this.profilesByTgId.set(tgId, remote);
  }

  async pullProfileDepositFromRedis(id: string): Promise<void> {
    if (!redisDealsEnabled) return;
    const remote = await redisGetProfileDeposit(id);
    if (remote) this.profileDepositsById.set(id, remote);
  }

  async pullProfileWithdrawalFromRedis(id: string): Promise<void> {
    if (!redisDealsEnabled) return;
    const remote = await redisGetProfileWithdrawal(id);
    if (remote) this.profileWithdrawalsById.set(id, remote);
  }

  private pushProfileRedis(profile: UserProfile): void {
    if (!redisDealsEnabled) return;
    void redisPutProfile(profile).catch((e) => console.error('[redisPutProfile]', e));
  }

  private pushProfileDepositRedis(deposit: ProfileDeposit): void {
    if (!redisDealsEnabled) return;
    void redisPutProfileDeposit(deposit).catch((e) => console.error('[redisPutProfileDeposit]', e));
  }

  private pushProfileWithdrawalRedis(withdrawal: ProfileWithdrawal): void {
    if (!redisDealsEnabled) return;
    void redisPutProfileWithdrawal(withdrawal).catch((e) => console.error('[redisPutProfileWithdrawal]', e));
  }

  createDeal(params: {
    tgId: bigint;
    role: 'seller' | 'buyer';
    telegram?: { firstName?: string; lastName?: string; username?: string; photoUrl?: string };
  }): Deal {
    const createdAt = nowIso();
    const deal: Deal = {
      id: randomUUID(),
      publicId: makePublicId(),
      sellerTgId: params.role === 'seller' ? params.tgId : undefined,
      buyerTgId: params.role === 'buyer' ? params.tgId : undefined,
      sellerTelegram: params.role === 'seller' ? params.telegram : undefined,
      buyerTelegram: params.role === 'buyer' ? params.telegram : undefined,
      status: params.role === 'buyer' ? 'WAITING_FOR_SELLER' : 'WAITING_FOR_BUYER',
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
    if (existing) {
      this.ensureProfileBalances(existing);
      return existing;
    }
    const now = nowIso();
    const p: UserProfile = {
      tgId,
      balances: {
        TON: { availableBaseUnits: 0n, reservedBaseUnits: 0n },
        USDT: { availableBaseUnits: 0n, reservedBaseUnits: 0n },
      },
      createdAt: now,
      updatedAt: now,
    };
    this.profilesByTgId.set(tgId, p);
    this.persist();
    this.pushProfileRedis(p);
    return p;
  }

  private ensureProfileBalances(profile: UserProfile): void {
    profile.balances ??= {};
    profile.balances.TON ??= { availableBaseUnits: 0n, reservedBaseUnits: 0n };
    profile.balances.USDT ??= { availableBaseUnits: 0n, reservedBaseUnits: 0n };
    profile.creditedDepositTxHashes ??= [];
  }

  private creditProfileBalance(profile: UserProfile, currency: Currency, amountBaseUnits: bigint): void {
    this.ensureProfileBalances(profile);
    const balance = profile.balances?.[currency];
    if (!balance) throw new Error(`Profile balance is not initialized for ${currency}`);
    balance.availableBaseUnits += amountBaseUnits;
    profile.updatedAt = nowIso();
  }

  private reserveProfileBalance(profile: UserProfile, currency: Currency, amountBaseUnits: bigint): void {
    if (amountBaseUnits <= 0n) throw new Error('Reserve amount must be > 0');
    this.ensureProfileBalances(profile);
    const balance = profile.balances?.[currency];
    if (!balance) throw new Error(`Profile balance is not initialized for ${currency}`);
    if (balance.availableBaseUnits < amountBaseUnits) {
      throw new Error('Not enough available profile balance');
    }
    balance.availableBaseUnits -= amountBaseUnits;
    balance.reservedBaseUnits += amountBaseUnits;
    profile.updatedAt = nowIso();
  }

  private assertProfileBalanceReserved(profile: UserProfile, currency: Currency, amountBaseUnits: bigint): void {
    this.ensureProfileBalances(profile);
    const balance = profile.balances?.[currency];
    if (!balance) throw new Error(`Profile balance is not initialized for ${currency}`);
    if (balance.reservedBaseUnits < amountBaseUnits) {
      throw new Error('Not enough reserved profile balance');
    }
  }

  private consumeReservedProfileBalance(profile: UserProfile, currency: Currency, amountBaseUnits: bigint): void {
    this.assertProfileBalanceReserved(profile, currency, amountBaseUnits);
    const balance = profile.balances?.[currency];
    if (!balance) throw new Error(`Profile balance is not initialized for ${currency}`);
    balance.reservedBaseUnits -= amountBaseUnits;
    profile.updatedAt = nowIso();
  }

  private assertBuyerProfilePaymentReserved(deal: Deal): UserProfile | null {
    if (deal.paymentSource !== 'PROFILE_BALANCE') return null;
    if (!deal.buyerTgId) throw new Error('Buyer is missing');
    if (!deal.currency || !deal.totalBaseUnits) throw new Error('Deal money fields are incomplete');
    const buyerProfile = this.getOrCreateProfile(deal.buyerTgId);
    this.assertProfileBalanceReserved(buyerProfile, deal.currency, deal.totalBaseUnits);
    return buyerProfile;
  }

  private settleBuyerProfilePayment(deal: Deal): UserProfile | null {
    const buyerProfile = this.assertBuyerProfilePaymentReserved(deal);
    if (!buyerProfile) return null;
    if (!deal.currency || !deal.totalBaseUnits) throw new Error('Deal money fields are incomplete');
    this.consumeReservedProfileBalance(buyerProfile, deal.currency, deal.totalBaseUnits);
    return buyerProfile;
  }

  private profileHasConfirmedDepositTx(txHash: string): boolean {
    for (const d of this.profileDepositsById.values()) {
      if (d.status === 'CONFIRMED' && d.txHash === txHash) return true;
    }
    for (const p of this.profilesByTgId.values()) {
      if (p.creditedDepositTxHashes?.includes(txHash)) return true;
    }
    return false;
  }

  private markProfileDepositTx(profile: UserProfile, txHash: string): void {
    profile.creditedDepositTxHashes ??= [];
    if (!profile.creditedDepositTxHashes.includes(txHash)) profile.creditedDepositTxHashes.push(txHash);
  }

  createProfileDeposit(params: {
    tgId: bigint;
    currency: Currency;
    amountBaseUnits: bigint;
    walletAddress?: string;
    escrowAddress: string;
  }): ProfileDeposit {
    if (params.amountBaseUnits <= 0n) throw new Error('Deposit amount must be > 0');
    const id = makePublicId();
    const now = nowIso();
    const deposit: ProfileDeposit = {
      id,
      tgId: params.tgId,
      currency: params.currency,
      amountBaseUnits: params.amountBaseUnits,
      walletAddress: params.walletAddress?.trim() || undefined,
      escrowAddress: params.escrowAddress.trim(),
      comment: `profile-deposit:${id}:${params.tgId.toString()}`,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    this.getOrCreateProfile(params.tgId);
    this.profileDepositsById.set(id, deposit);
    this.persist();
    this.pushProfileDepositRedis(deposit);
    return deposit;
  }

  getProfileDeposit(id: string): ProfileDeposit | null {
    return this.profileDepositsById.get(id) ?? null;
  }

  getProfileWithdrawal(id: string): ProfileWithdrawal | null {
    return this.profileWithdrawalsById.get(id) ?? null;
  }

  confirmProfileDeposit(params: { depositId: string; txHash: string }): { profile: UserProfile; deposit: ProfileDeposit; credited: boolean } {
    const deposit = this.profileDepositsById.get(params.depositId);
    if (!deposit) throw new Error('Deposit not found');

    const profile = this.getOrCreateProfile(deposit.tgId);
    if (deposit.status === 'CONFIRMED') return { profile, deposit, credited: false };
    if (this.profileHasConfirmedDepositTx(params.txHash)) throw new Error('This transaction is already credited');

    const now = nowIso();
    this.creditProfileBalance(profile, deposit.currency, deposit.amountBaseUnits);
    this.markProfileDepositTx(profile, params.txHash);
    deposit.status = 'CONFIRMED';
    deposit.txHash = params.txHash;
    deposit.confirmedAt = now;
    deposit.updatedAt = now;

    this.persist();
    this.pushProfileRedis(profile);
    this.pushProfileDepositRedis(deposit);
    return { profile, deposit, credited: true };
  }

  recoverConfirmedProfileDeposit(params: {
    tgId: bigint;
    currency: Currency;
    amountBaseUnits: bigint;
    txHash: string;
    comment: string;
    escrowAddress: string;
  }): { profile: UserProfile; deposit: ProfileDeposit; credited: boolean } {
    const existing = [...this.profileDepositsById.values()].find((d) => d.txHash === params.txHash);
    if (existing) {
      const profile = this.getOrCreateProfile(existing.tgId);
      return { profile, deposit: existing, credited: false };
    }

    const now = nowIso();
    const id = makePublicId();
    const deposit: ProfileDeposit = {
      id,
      tgId: params.tgId,
      currency: params.currency,
      amountBaseUnits: params.amountBaseUnits,
      escrowAddress: params.escrowAddress,
      comment: params.comment,
      status: 'CONFIRMED',
      txHash: params.txHash,
      createdAt: now,
      updatedAt: now,
      confirmedAt: now,
    };
    const profile = this.getOrCreateProfile(params.tgId);
    if (this.profileHasConfirmedDepositTx(params.txHash)) {
      this.profileDepositsById.set(id, deposit);
      this.persist();
      this.pushProfileDepositRedis(deposit);
      return { profile, deposit, credited: false };
    }
    this.creditProfileBalance(profile, params.currency, params.amountBaseUnits);
    this.markProfileDepositTx(profile, params.txHash);
    this.profileDepositsById.set(id, deposit);
    this.persist();
    this.pushProfileRedis(profile);
    this.pushProfileDepositRedis(deposit);
    return { profile, deposit, credited: true };
  }

  setPayoutWallet(params: { tgId: bigint; walletAddress: string }): UserProfile {
    const walletAddress = params.walletAddress.trim();
    if (!walletAddress) throw new Error('walletAddress is required');
    const p = this.getOrCreateProfile(params.tgId);
    p.payoutWalletAddress = walletAddress;
    p.updatedAt = nowIso();
    this.persist();
    this.pushProfileRedis(p);
    return p;
  }

  requestProfileBalanceWithdrawal(params: {
    tgId: bigint;
    currency: Currency;
    amountBaseUnits: bigint;
    walletAddress: string;
  }): { profile: UserProfile; withdrawal: ProfileWithdrawal } {
    const walletAddress = params.walletAddress.trim();
    if (!walletAddress) throw new Error('walletAddress is required');
    if (params.amountBaseUnits <= 0n) throw new Error('Withdrawal amount must be > 0');

    const profile = this.getOrCreateProfile(params.tgId);
    this.reserveProfileBalance(profile, params.currency, params.amountBaseUnits);
    profile.payoutWalletAddress = walletAddress;
    const now = nowIso();
    profile.updatedAt = now;
    const withdrawal: ProfileWithdrawal = {
      id: makePublicId(),
      tgId: params.tgId,
      currency: params.currency,
      amountBaseUnits: params.amountBaseUnits,
      walletAddress,
      status: 'REQUESTED',
      createdAt: now,
      updatedAt: now,
    };
    this.profileWithdrawalsById.set(withdrawal.id, withdrawal);
    this.persist();
    this.pushProfileRedis(profile);
    this.pushProfileWithdrawalRedis(withdrawal);
    return { profile, withdrawal };
  }

  confirmProfileBalanceWithdrawal(params: { withdrawalId: string; txHash?: string }): { profile: UserProfile; withdrawal: ProfileWithdrawal } {
    const withdrawal = this.profileWithdrawalsById.get(params.withdrawalId);
    if (!withdrawal) throw new Error('Withdrawal not found');
    if (withdrawal.status === 'CONFIRMED') {
      return { profile: this.getOrCreateProfile(withdrawal.tgId), withdrawal };
    }
    if (withdrawal.status !== 'REQUESTED') {
      throw new Error(`Cannot confirm withdrawal in status ${withdrawal.status}`);
    }

    const profile = this.getOrCreateProfile(withdrawal.tgId);
    this.ensureProfileBalances(profile);
    const balance = profile.balances?.[withdrawal.currency];
    if (!balance) throw new Error(`Profile balance is not initialized for ${withdrawal.currency}`);
    if (balance.reservedBaseUnits < withdrawal.amountBaseUnits) {
      throw new Error('Not enough reserved profile balance');
    }

    const now = nowIso();
    balance.reservedBaseUnits -= withdrawal.amountBaseUnits;
    profile.updatedAt = now;
    withdrawal.status = 'CONFIRMED';
    withdrawal.txHash = params.txHash?.trim() || undefined;
    withdrawal.confirmedAt = now;
    withdrawal.updatedAt = now;
    this.persist();
    this.pushProfileRedis(profile);
    this.pushProfileWithdrawalRedis(withdrawal);
    return { profile, withdrawal };
  }

  failProfileBalanceWithdrawal(params: { withdrawalId: string; reason?: string }): { profile: UserProfile; withdrawal: ProfileWithdrawal } {
    const withdrawal = this.profileWithdrawalsById.get(params.withdrawalId);
    if (!withdrawal) throw new Error('Withdrawal not found');
    const profile = this.getOrCreateProfile(withdrawal.tgId);

    if (withdrawal.status === 'CONFIRMED') {
      return { profile, withdrawal };
    }

    this.ensureProfileBalances(profile);
    const balance = profile.balances?.[withdrawal.currency];
    if (!balance) throw new Error(`Profile balance is not initialized for ${withdrawal.currency}`);

    if (withdrawal.status === 'REQUESTED') {
      const amountToRelease = balance.reservedBaseUnits < withdrawal.amountBaseUnits ? balance.reservedBaseUnits : withdrawal.amountBaseUnits;
      balance.reservedBaseUnits -= amountToRelease;
      balance.availableBaseUnits += amountToRelease;
    }

    const now = nowIso();
    profile.updatedAt = now;
    withdrawal.status = 'FAILED';
    withdrawal.failureReason = params.reason?.trim() || undefined;
    withdrawal.updatedAt = now;

    this.persist();
    this.pushProfileRedis(profile);
    this.pushProfileWithdrawalRedis(withdrawal);
    return { profile, withdrawal };
  }

  /** Sync deposited gifts from Telegram Business vault and/or on-chain NFT vault. */
  async syncDepositedNfts(params: { ownerTgId: bigint; limit?: number }): Promise<{ added: number; gifts: GiftAsset[] }> {
    let added = 0;

    const business = await this.syncTelegramBusinessGiftsForOwner({
      ownerTgId: params.ownerTgId,
      maxPages: telegramBusinessGiftScanMaxPages('TELEGRAM_GIFTS_SYNC_MAX_PAGES', 35),
    });
    added += business.added;

    const vault = process.env.GIFT_VAULT_ADDRESS?.trim();
    if (!vault) {
      if (!business.configured) throw new Error('Configure Telegram Business vault or GIFT_VAULT_ADDRESS');
      return { added, gifts: this.listGiftsByOwner(params.ownerTgId) };
    }

    const profile = this.getOrCreateProfile(params.ownerTgId);
    const wallet = profile.payoutWalletAddress?.trim();
    if (!wallet) {
      if (business.configured) return { added, gifts: this.listGiftsByOwner(params.ownerTgId) };
      throw new Error('Bind your TON wallet first (profile payout wallet)');
    }

    const hits = await tonapiGetNftDepositsToVault({
      vaultAddress: vault,
      fromWalletAddress: wallet,
      limit: params.limit ?? 80,
    });

    for (const h of hits) {
      if (this.giftsByGiftId.has(h.nftAddress)) continue;
      try {
        this.depositGift({
          ownerTgId: params.ownerTgId,
          giftId: h.nftAddress,
          title: h.title,
        });
        added += 1;
      } catch {
        // ignore duplicates / bad input
      }
    }

    return { added, gifts: this.listGiftsByOwner(params.ownerTgId) };
  }

  startGiftTransferSession(params: { ownerTgId: bigint; ttlSec?: number }): { expiresAtMs: number } {
    const ttlSec = Math.max(30, Math.min(900, params.ttlSec ?? 600));
    const startedAtMs = Date.now();
    const expiresAtMs = startedAtMs + ttlSec * 1000;
    this.giftDepositSessions.set(params.ownerTgId, { startedAtMs, expiresAtMs });
    return { expiresAtMs };
  }

  async claimGiftTransferSession(params: { ownerTgId: bigint; limit?: number }): Promise<{ added: number; gifts: GiftAsset[] }> {
    const s = this.giftDepositSessions.get(params.ownerTgId);
    if (!s) throw new Error('Deposit session is not started');
    if (Date.now() > s.expiresAtMs) {
      this.giftDepositSessions.delete(params.ownerTgId);
      throw new Error('Deposit session expired. Start a new one.');
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const businessConnectionId = await getTelegramBusinessConnectionId();
    const vault = process.env.GIFT_VAULT_ADDRESS?.trim();
    if (!botToken && !vault) {
      throw new Error('Configure TELEGRAM_BUSINESS_CONNECTION_ID + TELEGRAM_BOT_TOKEN or GIFT_VAULT_ADDRESS');
    }

    let added = 0;

    if (botToken && businessConnectionId) {
      const business = await this.syncTelegramBusinessGiftsForOwner({
        ownerTgId: params.ownerTgId,
        startedAtMs: s.startedAtMs,
        maxPages: telegramBusinessGiftScanMaxPages('TELEGRAM_GIFTS_CLAIM_MAX_PAGES', 35),
      });
      added += business.added;
    } else if (botToken) {
      const botUserId = await telegramGetBotUserId(botToken);
      const maxPages = telegramBusinessGiftScanMaxPages('TELEGRAM_GIFTS_CLAIM_MAX_PAGES', 35);
      await telegramIterateUserGifts({
        botToken,
        userId: botUserId,
        maxPages,
        pageSize: 100,
        onPage: (items) => {
          for (const raw of items) {
            const p = parseOwnedGiftItem(raw);
            if (!p) continue;
            if (!p.senderUserId || BigInt(p.senderUserId) !== params.ownerTgId) continue;
            const opMs = (p.sendDate ?? 0) * 1000;
            if (opMs && opMs + 2 * 60 * 1000 < s.startedAtMs) continue;
            const existing = this.giftsByGiftId.get(p.giftId);
            if (existing) {
              if (this.applyParsedGiftVisuals(existing, p)) {
                existing.updatedAt = nowIso();
                this.persist();
              }
              continue;
            }
            try {
              this.depositGift({
                ownerTgId: params.ownerTgId,
                giftId: p.giftId,
                title: p.title,
                model: p.model,
                background: p.background,
                telegramGiftName: p.uniqueName,
                telegramGiftNumber: p.number,
                telegramImageFileId: p.imageFileId,
                telegramImageFileKind: p.imageFileKind,
                telegramSymbol: p.symbol,
                telegramSymbolFileId: p.symbolFileId,
                backdropCenterColor: p.backdropCenterColor,
                backdropEdgeColor: p.backdropEdgeColor,
                backdropSymbolColor: p.backdropSymbolColor,
                backdropTextColor: p.backdropTextColor,
                source: 'TELEGRAM_BOT_PROFILE',
                telegramOwnedGiftId: p.ownedGiftId,
                telegramGiftType: p.giftType,
                telegramSenderUserId: p.senderUserId ? BigInt(p.senderUserId) : undefined,
              });
              added += 1;
            } catch {
              /* ignore */
            }
          }
        },
      });
    }

    if (vault) {
      const incoming = await tonapiGetIncomingNftsToVault({ vaultAddress: vault, limit: params.limit ?? 80 });
      for (const h of incoming) {
        const opMs = (h.utime ?? 0) * 1000;
        if (opMs && opMs + 2 * 60 * 1000 < s.startedAtMs) continue;
        if (this.giftsByGiftId.has(h.nftAddress)) continue;
        try {
          this.depositGift({
            ownerTgId: params.ownerTgId,
            giftId: h.nftAddress,
            title: h.title,
            source: 'ONCHAIN_VAULT',
          });
          added += 1;
        } catch {
          /* ignore */
        }
      }
    }

    return { added, gifts: this.listGiftsByOwner(params.ownerTgId) };
  }

  getDeal(publicId: string): Deal | undefined {
    return this.byPublicId.get(publicId);
  }

  joinDeal(params: {
    publicId: string;
    tgId: bigint;
    role: 'seller' | 'buyer';
    telegram?: { firstName?: string; lastName?: string; username?: string; photoUrl?: string };
  }): Deal {
    const deal = this.mustGet(params.publicId);
    const bothParticipantsPresent = Boolean(deal.sellerTgId && deal.buyerTgId);
    if (bothParticipantsPresent) {
      throw new Error('Deal already has two participants. Join is closed.');
    }

    if (params.role === 'buyer') {
      if (deal.sellerTgId && deal.sellerTgId === params.tgId) {
        throw new Error('You are already seller in this deal');
      }
      if (deal.buyerTgId && deal.buyerTgId !== params.tgId) {
        throw new Error('Deal already has a buyer');
      }
      if (!['WAITING_FOR_BUYER', 'WAITING_FOR_SELLER', 'WAITING_FOR_PRICE'].includes(deal.status)) {
        throw new Error(`Cannot join deal in status ${deal.status}`);
      }
      deal.buyerTgId = params.tgId;
      if (params.telegram) deal.buyerTelegram = params.telegram;
    } else {
      if (deal.buyerTgId && deal.buyerTgId === params.tgId) {
        throw new Error('You are already buyer in this deal');
      }
      if (deal.sellerTgId && deal.sellerTgId !== params.tgId) {
        throw new Error('Deal already has a seller');
      }
      if (!['WAITING_FOR_BUYER', 'WAITING_FOR_SELLER', 'WAITING_FOR_PRICE'].includes(deal.status)) {
        throw new Error(`Cannot join deal in status ${deal.status}`);
      }
      deal.sellerTgId = params.tgId;
      if (params.telegram) deal.sellerTelegram = params.telegram;
    }

    if (!deal.sellerTgId) deal.status = 'WAITING_FOR_SELLER';
    else if (!deal.buyerTgId) deal.status = 'WAITING_FOR_BUYER';
    else deal.status = deal.currency && deal.priceLockedAt ? 'WAITING_FOR_PAYMENT' : 'WAITING_FOR_PRICE';
    deal.updatedAt = nowIso();
    this.persist();
    this.pushDealRedis(deal);
    return deal;
  }

  lockPrice(params: { publicId: string; sellerTgId: bigint; currency: Currency; priceDisplay: string }): Deal {
    const deal = this.mustGet(params.publicId);

    if (!deal.sellerTgId) {
      throw new Error('Seller has not joined yet');
    }
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
    if (!deal.sellerTgId) {
      throw new Error('Seller has not joined yet');
    }
    if (deal.status !== 'WAITING_FOR_PAYMENT') {
      throw new Error(`Cannot confirm payment in status ${deal.status}`);
    }
    if (!deal.currency || !deal.totalBaseUnits) {
      throw new Error('Price is not locked yet');
    }

    deal.paymentTxHash = params.txHash?.trim() || undefined;
    deal.paymentSource = 'ONCHAIN';
    deal.paymentConfirmedAt = nowIso();
    deal.status = deal.reservedGiftId ? 'GIFT_RESERVED' : 'PAYMENT_CONFIRMED';
    deal.updatedAt = nowIso();
    this.persist();
    this.pushDealRedis(deal);
    return deal;
  }

  payDealFromProfileBalance(params: { publicId: string; buyerTgId: bigint }): { deal: Deal; profile: UserProfile } {
    const deal = this.mustGet(params.publicId);

    if (!deal.buyerTgId || deal.buyerTgId !== params.buyerTgId) {
      throw new Error('Only buyer can pay from profile balance');
    }
    if (!deal.sellerTgId) {
      throw new Error('Seller has not joined yet');
    }
    if (deal.status !== 'WAITING_FOR_PAYMENT') {
      throw new Error(`Cannot pay in status ${deal.status}`);
    }
    if (!deal.currency || !deal.totalBaseUnits) {
      throw new Error('Price is not locked yet');
    }

    const profile = this.getOrCreateProfile(params.buyerTgId);
    this.reserveProfileBalance(profile, deal.currency, deal.totalBaseUnits);

    deal.paymentTxHash = `internal-balance:${params.buyerTgId.toString()}:${deal.currency}:${deal.totalBaseUnits.toString()}:${deal.publicId}`;
    deal.paymentSource = 'PROFILE_BALANCE';
    deal.paymentConfirmedAt = nowIso();
    deal.status = deal.reservedGiftId ? 'GIFT_RESERVED' : 'PAYMENT_CONFIRMED';
    deal.updatedAt = nowIso();

    this.persist();
    this.pushProfileRedis(profile);
    this.pushDealRedis(deal);
    return { deal, profile };
  }

  depositGift(params: {
    ownerTgId: bigint;
    giftId: string;
    title?: string;
    model?: string;
    background?: string;
    telegramGiftName?: string;
    telegramGiftNumber?: number;
    telegramImageFileId?: string;
    telegramImageFileKind?: GiftAsset['telegramImageFileKind'];
    telegramSymbol?: string;
    telegramSymbolFileId?: string;
    backdropCenterColor?: string;
    backdropEdgeColor?: string;
    backdropSymbolColor?: string;
    backdropTextColor?: string;
    source?: GiftAsset['source'];
    telegramOwnedGiftId?: string;
    telegramGiftType?: GiftAsset['telegramGiftType'];
    telegramSenderUserId?: bigint;
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
      telegramGiftName: params.telegramGiftName?.trim() || undefined,
      telegramGiftNumber: params.telegramGiftNumber,
      telegramImageFileId: params.telegramImageFileId?.trim() || undefined,
      telegramImageFileKind: params.telegramImageFileKind,
      telegramSymbol: params.telegramSymbol?.trim() || undefined,
      telegramSymbolFileId: params.telegramSymbolFileId?.trim() || undefined,
      backdropCenterColor: params.backdropCenterColor?.trim() || undefined,
      backdropEdgeColor: params.backdropEdgeColor?.trim() || undefined,
      backdropSymbolColor: params.backdropSymbolColor?.trim() || undefined,
      backdropTextColor: params.backdropTextColor?.trim() || undefined,
      source: params.source ?? 'MANUAL',
      telegramOwnedGiftId: params.telegramOwnedGiftId?.trim() || undefined,
      telegramGiftType: params.telegramGiftType,
      telegramSenderUserId: params.telegramSenderUserId,
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
    if (!deal.sellerTgId) throw new Error('Seller has not joined yet');
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
    if (!deal.sellerTgId) throw new Error('Seller has not joined yet');
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

  requestGiftWithdraw(params: { ownerTgId: bigint; giftId: string }): GiftAsset {
    const gift = this.giftsByGiftId.get(params.giftId.trim());
    if (!gift) throw new Error('Gift not found');
    if (gift.ownerTgId !== params.ownerTgId) throw new Error('You do not own this gift');
    if (gift.status === 'RESERVED') throw new Error('Gift is reserved in a deal, unreserve first');
    if (gift.status === 'SENT' || gift.status === 'WITHDRAWN') throw new Error(`Cannot withdraw gift in status ${gift.status}`);

    gift.status = 'WITHDRAW_PENDING';
    gift.withdrawRequestedAt = nowIso();
    gift.updatedAt = nowIso();
    this.persist();
    return gift;
  }

  async confirmGiftWithdraw(params: { ownerTgId: bigint; giftId: string; limit?: number }): Promise<GiftAsset> {
    const gift = this.giftsByGiftId.get(params.giftId.trim());
    if (!gift) throw new Error('Gift not found');
    if (gift.ownerTgId !== params.ownerTgId) throw new Error('You do not own this gift');
    if (gift.status !== 'WITHDRAW_PENDING') throw new Error('Gift is not in withdraw pending state');

    const vault = process.env.GIFT_VAULT_ADDRESS?.trim();
    const isTelegramGiftId = gift.giftId.startsWith('tg:');

    if (isTelegramGiftId) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
      if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured on server');
      const businessConnectionId = await getTelegramBusinessConnectionId();
      if (businessConnectionId && gift.telegramOwnedGiftId && gift.source === 'TELEGRAM_BUSINESS') {
        if (!telegramBusinessGiftTransferEnabled()) {
          throw new Error(
            'Manual gift transfer is required. Send the gift from the vault contact, then confirm it via admin endpoint.',
          );
        }
        await telegramTransferBusinessGift({
          botToken,
          businessConnectionId,
          ownedGiftId: gift.telegramOwnedGiftId,
          newOwnerChatId: params.ownerTgId,
        });
        gift.status = 'WITHDRAWN';
        gift.withdrawnAt = nowIso();
        gift.updatedAt = nowIso();
        this.persist();
        return gift;
      }

      const botUserId = await telegramGetBotUserId(botToken);
      const maxPages = Math.min(
        200,
        Math.max(1, Number.parseInt(process.env.TELEGRAM_GIFTS_WITHDRAW_SCAN_MAX_PAGES ?? '60', 10) || 60),
      );
      const onProfile = await telegramCollectProfileGiftIds({
        botToken,
        userId: botUserId,
        maxPages,
      });
      if (onProfile.has(gift.giftId)) {
        throw new Error(
          'Подарок всё ещё в профиле бота. Откройте профиль бота → Подарки, сделайте Transfer себе, затем снова «Подтвердить вывод».',
        );
      }
      gift.status = 'WITHDRAWN';
      gift.withdrawnAt = nowIso();
      gift.updatedAt = nowIso();
      this.persist();
      return gift;
    }

    if (!vault) throw new Error('GIFT_VAULT_ADDRESS is not configured on server');

    const profile = this.getOrCreateProfile(params.ownerTgId);
    const wallet = profile.payoutWalletAddress?.trim();
    if (!wallet) throw new Error('Bind your TON wallet first (profile payout wallet)');

    const outgoing = await tonapiGetOutgoingNftsFromVaultToAddress({
      vaultAddress: vault,
      destinationAddress: wallet,
      limit: params.limit ?? 80
    });
    const requestedAtMs = gift.withdrawRequestedAt ? Date.parse(gift.withdrawRequestedAt) : 0;
    const matched = outgoing.find((o) => {
      if (o.nftAddress.trim() !== gift.giftId) return false;
      const opMs = (o.utime ?? 0) * 1000;
      if (!opMs || !requestedAtMs) return true;
      return opMs >= requestedAtMs - 2 * 60 * 1000;
    });
    if (!matched) throw new Error('Withdraw transfer not found yet. Send gift back from bot profile first.');

    gift.status = 'WITHDRAWN';
    gift.withdrawnAt = nowIso();
    gift.updatedAt = nowIso();
    this.persist();
    return gift;
  }

  async releaseDeal(params: {
    publicId: string;
    sellerTgId: bigint;
    feeRecipientAddress?: string;
    payoutTxHash?: string;
    giftTransferTxHash?: string;
  }): Promise<{ deal: Deal; gift: GiftAsset }> {
    const deal = this.mustGet(params.publicId);
    if (!deal.sellerTgId) throw new Error('Seller has not joined yet');
    if (deal.sellerTgId !== params.sellerTgId) throw new Error('Only seller can release deal');
    if (deal.status !== 'GIFT_RESERVED') throw new Error(`Cannot release deal in status ${deal.status}`);
    if (!deal.paymentConfirmedAt) throw new Error('Payment is not confirmed');
    if (!deal.reservedGiftId) throw new Error('No reserved gift');
    if (!deal.currency || !deal.priceBaseUnits || !deal.feeBaseUnits) throw new Error('Deal money fields are incomplete');
    this.assertBuyerProfilePaymentReserved(deal);

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

    let giftTransferTxHash = params.giftTransferTxHash?.trim() || undefined;
    if (gift.source === 'TELEGRAM_BUSINESS' && gift.telegramOwnedGiftId) {
      if (!deal.buyerTgId) throw new Error('Buyer is missing');
      const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
      const businessConnectionId = await getTelegramBusinessConnectionId();
      if (!botToken || !businessConnectionId) {
        throw new Error('Telegram Business vault is not configured for gift transfer');
      }
      if (!telegramBusinessGiftTransferEnabled()) {
        const requestedAt = nowIso();
        gift.status = 'TRANSFER_PENDING';
        gift.updatedAt = requestedAt;

        deal.status = 'WAITING_FOR_MANUAL_GIFT_TRANSFER';
        deal.manualGiftTransferRequestedAt = requestedAt;
        deal.sellerPayoutAddress = sellerProfile.payoutWalletAddress;
        deal.sellerPayoutAmountDisplay = sellerPayoutDisplay;
        deal.feeRecipientAddress = feeRecipient;
        deal.feeAmountFinalDisplay = feeDisplay;
        deal.updatedAt = requestedAt;

        this.persist();
        this.pushDealRedis(deal);
        return { deal, gift };
      }
      await telegramTransferBusinessGift({
        botToken,
        businessConnectionId,
        ownedGiftId: gift.telegramOwnedGiftId,
        newOwnerChatId: deal.buyerTgId,
      });
      giftTransferTxHash = `telegram-business:${gift.telegramOwnedGiftId}`;
    }

    const buyerProfile = this.settleBuyerProfilePayment(deal);
    this.creditProfileBalance(sellerProfile, deal.currency, deal.priceBaseUnits);

    gift.status = 'SENT';
    gift.updatedAt = nowIso();

    deal.status = 'COMPLETED';
    deal.releasedAt = nowIso();
    deal.giftTransferConfirmedAt = deal.releasedAt;
    deal.sellerPayoutAddress = sellerProfile.payoutWalletAddress;
    deal.sellerPayoutAmountDisplay = sellerPayoutDisplay;
    deal.feeRecipientAddress = feeRecipient;
    deal.feeAmountFinalDisplay = feeDisplay;
    deal.payoutTxHash = params.payoutTxHash?.trim() || `internal-balance:${deal.currency}:${deal.priceBaseUnits.toString()}`;
    deal.giftTransferTxHash = giftTransferTxHash;
    deal.updatedAt = nowIso();

    this.persist();
    if (buyerProfile) this.pushProfileRedis(buyerProfile);
    this.pushProfileRedis(sellerProfile);
    this.pushDealRedis(deal);
    return { deal, gift };
  }

  confirmManualGiftTransfer(params: { publicId: string; giftTransferTxHash?: string }): { deal: Deal; gift: GiftAsset } {
    const deal = this.mustGet(params.publicId);
    if (deal.status !== 'WAITING_FOR_MANUAL_GIFT_TRANSFER') {
      throw new Error(`Cannot confirm manual gift transfer in status ${deal.status}`);
    }
    if (!deal.sellerTgId) throw new Error('Seller has not joined yet');
    if (!deal.reservedGiftId) throw new Error('No reserved gift');
    if (!deal.currency || !deal.priceBaseUnits || !deal.feeBaseUnits) throw new Error('Deal money fields are incomplete');
    this.assertBuyerProfilePaymentReserved(deal);

    const gift = this.giftsByGiftId.get(deal.reservedGiftId);
    if (!gift) throw new Error('Reserved gift not found');
    if (gift.reservedDealPublicId !== deal.publicId) throw new Error('Gift reservation mismatch');
    if (gift.status !== 'TRANSFER_PENDING') throw new Error(`Gift has invalid status ${gift.status}`);

    const sellerProfile = this.getOrCreateProfile(deal.sellerTgId);
    if (!sellerProfile.payoutWalletAddress) {
      throw new Error('Seller payout wallet is not set. Bind wallet in profile first.');
    }

    const feeRecipient = deal.feeRecipientAddress || process.env.SERVICE_FEE_ADDRESS?.trim();
    if (!feeRecipient) throw new Error('Fee recipient wallet is not configured');

    const policy = getFeeConfig()[deal.currency];
    const sellerPayoutDisplay = formatUnitsToDecimal(deal.priceBaseUnits, policy.decimals);
    const feeDisplay = formatUnitsToDecimal(deal.feeBaseUnits, policy.decimals);
    const releasedAt = nowIso();

    const buyerProfile = this.settleBuyerProfilePayment(deal);
    this.creditProfileBalance(sellerProfile, deal.currency, deal.priceBaseUnits);

    gift.status = 'SENT';
    gift.updatedAt = releasedAt;

    deal.status = 'COMPLETED';
    deal.releasedAt = releasedAt;
    deal.giftTransferConfirmedAt = releasedAt;
    deal.sellerPayoutAddress = sellerProfile.payoutWalletAddress;
    deal.sellerPayoutAmountDisplay = sellerPayoutDisplay;
    deal.feeRecipientAddress = feeRecipient;
    deal.feeAmountFinalDisplay = feeDisplay;
    deal.payoutTxHash = deal.payoutTxHash || `internal-balance:${deal.currency}:${deal.priceBaseUnits.toString()}`;
    deal.giftTransferTxHash = params.giftTransferTxHash?.trim() || `manual-transfer:${gift.giftId}`;
    deal.updatedAt = releasedAt;

    this.persist();
    if (buyerProfile) this.pushProfileRedis(buyerProfile);
    this.pushProfileRedis(sellerProfile);
    this.pushDealRedis(deal);
    return { deal, gift };
  }

  confirmManualGiftWithdraw(params: { ownerTgId: bigint; giftId: string }): GiftAsset {
    const gift = this.giftsByGiftId.get(params.giftId.trim());
    if (!gift) throw new Error('Gift not found');
    if (gift.ownerTgId !== params.ownerTgId) throw new Error('You do not own this gift');
    if (gift.status !== 'WITHDRAW_PENDING') throw new Error('Gift is not in withdraw pending state');

    gift.status = 'WITHDRAWN';
    gift.withdrawnAt = nowIso();
    gift.updatedAt = nowIso();
    this.persist();
    return gift;
  }

  private mustGet(publicId: string): Deal {
    const deal = this.byPublicId.get(publicId);
    if (!deal) throw new Error('Deal not found');
    return deal;
  }
}
