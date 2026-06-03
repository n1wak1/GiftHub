import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DealsStore } from './deals.store.js';
import type { Deal, GiftAsset, ProfileDeposit, ProfileWithdrawal, UserProfile } from './domain.js';
import { fetchTelegramUserAvatar } from './telegram.avatar.js';
import { fetchTelegramChatInfo } from './telegram.chat.js';
import { redisDealsEnabled, redisPutDeal } from './redis.deals.js';
import { getTonNetwork, getUsdtJettonMaster } from './ton.config.js';
import { buildJettonTransferPayload, buildTextCommentPayload } from './jetton.js';
import { resolveJettonWalletAddress } from './tonapi.js';
import { sendProfileWithdrawal } from './ton.withdraw.js';
import { getTelegramBusinessConnectionStatus } from './telegram.business.js';
import {
  detectTonPaymentForDeal,
  detectTonProfileDeposit,
  detectUsdtPaymentForDeal,
  detectUsdtProfileDeposit,
  recoverTonProfileDeposits,
  recoverUsdtProfileDeposits
} from './payment.verify.js';
import { formatUnitsToDecimal, getFeeConfig, parseDecimalToUnits } from './money.js';

const TgIdSchema = z.union([z.string(), z.number(), z.bigint()]).transform((v) => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (!/^\d+$/.test(v)) throw new Error('Invalid tg id');
  return BigInt(v);
});

const DEAL_JOIN_CLOSED_MESSAGE = 'В сделку войти нельзя!';

function isDealParticipant(deal: Deal, tgId: bigint): boolean {
  return deal.sellerTgId === tgId || deal.buyerTgId === tgId;
}

function isDealClosedToViewer(deal: Deal, tgId: bigint, join?: 'buyer' | 'seller'): boolean {
  if (isDealParticipant(deal, tgId)) return false;
  if (deal.sellerTgId && deal.buyerTgId) return true;
  if (join === 'buyer' && deal.buyerTgId) return true;
  if (join === 'seller' && deal.sellerTgId) return true;
  return false;
}

function tonConnectNetwork(): '-239' | '-3' {
  return getTonNetwork() === 'mainnet' ? '-239' : '-3';
}

function presentDeal(deal: Deal) {
  return {
    ...deal,
    sellerTgId: deal.sellerTgId?.toString(),
    buyerTgId: deal.buyerTgId?.toString(),
    creatorTgId: deal.creatorTgId?.toString(),
    priceBaseUnits: deal.priceBaseUnits?.toString(),
    feeBaseUnits: deal.feeBaseUnits?.toString(),
    totalBaseUnits: deal.totalBaseUnits?.toString()
  };
}

function presentGift(gift: GiftAsset) {
  return {
    ...gift,
    ownerTgId: gift.ownerTgId.toString(),
    telegramSenderUserId: gift.telegramSenderUserId?.toString()
  };
}

function presentProfile(profile: UserProfile) {
  const fee = getFeeConfig();
  const balances = {
    TON: {
      availableBaseUnits: (profile.balances?.TON?.availableBaseUnits ?? 0n).toString(),
      reservedBaseUnits: (profile.balances?.TON?.reservedBaseUnits ?? 0n).toString(),
      availableDisplay: formatUnitsToDecimal(profile.balances?.TON?.availableBaseUnits ?? 0n, fee.TON.decimals),
      reservedDisplay: formatUnitsToDecimal(profile.balances?.TON?.reservedBaseUnits ?? 0n, fee.TON.decimals)
    },
    USDT: {
      availableBaseUnits: (profile.balances?.USDT?.availableBaseUnits ?? 0n).toString(),
      reservedBaseUnits: (profile.balances?.USDT?.reservedBaseUnits ?? 0n).toString(),
      availableDisplay: formatUnitsToDecimal(profile.balances?.USDT?.availableBaseUnits ?? 0n, fee.USDT.decimals),
      reservedDisplay: formatUnitsToDecimal(profile.balances?.USDT?.reservedBaseUnits ?? 0n, fee.USDT.decimals)
    }
  };
  return {
    tgId: profile.tgId.toString(),
    payoutWalletAddress: profile.payoutWalletAddress,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    balances
  };
}

function presentProfileDeposit(deposit: ProfileDeposit) {
  const policy = getFeeConfig()[deposit.currency];
  return {
    ...deposit,
    tgId: deposit.tgId.toString(),
    amountBaseUnits: deposit.amountBaseUnits.toString(),
    amountDisplay: formatUnitsToDecimal(deposit.amountBaseUnits, policy.decimals)
  };
}

function presentProfileWithdrawal(withdrawal: ProfileWithdrawal) {
  const policy = getFeeConfig()[withdrawal.currency];
  return {
    ...withdrawal,
    tgId: withdrawal.tgId.toString(),
    amountBaseUnits: withdrawal.amountBaseUnits.toString(),
    amountDisplay: formatUnitsToDecimal(withdrawal.amountBaseUnits, policy.decimals)
  };
}

function assertAdminSecret(secret: string | undefined): void {
  const expected = process.env.ADMIN_SECRET?.trim();
  if (!expected) throw new Error('ADMIN_SECRET is not configured on server');
  if (!secret || secret !== expected) throw new Error('Invalid admin secret');
}

function envFlag(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

function giftNeedsManualBusinessTransfer(gift: GiftAsset): boolean {
  return gift.source === 'TELEGRAM_BUSINESS' && Boolean(gift.telegramOwnedGiftId) && !envFlag('TELEGRAM_BUSINESS_GIFT_TRANSFER_ENABLED');
}

async function recoverProfileDepositsForUser(deals: DealsStore, tgId: bigint): Promise<{ recovered: number }> {
  const escrowAddress = process.env.ESCROW_ADDRESS?.trim();
  if (!escrowAddress) return { recovered: 0 };

  let recovered = 0;
  const tonHits = await recoverTonProfileDeposits({ escrowAddress, tgId, limit: 100 });
  for (const hit of tonHits) {
    const out = deals.recoverConfirmedProfileDeposit({
      tgId,
      currency: 'TON',
      amountBaseUnits: hit.amountBaseUnits,
      txHash: hit.txHash,
      comment: hit.comment,
      escrowAddress
    });
    if (out.credited) recovered += 1;
  }

  const usdtJettonMaster = getUsdtJettonMaster();
  if (usdtJettonMaster) {
    const usdtHits = await recoverUsdtProfileDeposits({ escrowAddress, usdtJettonMaster, tgId, limit: 100 });
    for (const hit of usdtHits) {
      const out = deals.recoverConfirmedProfileDeposit({
        tgId,
        currency: 'USDT',
        amountBaseUnits: hit.amountBaseUnits,
        txHash: hit.txHash,
        comment: hit.comment,
        escrowAddress
      });
      if (out.credited) recovered += 1;
    }
  }

  return { recovered };
}

export async function registerHttp(app: FastifyInstance, deps: { deals: DealsStore }) {
  app.get('/health', async () => ({ ok: true }));

  app.post('/profiles/wallet', async (req, reply) => {
    const body = z
      .object({
        tgId: TgIdSchema,
        walletAddress: z.string().min(1)
      })
      .parse(req.body);
    try {
      const profile = deps.deals.setPayoutWallet({
        tgId: body.tgId,
        walletAddress: body.walletAddress
      });
      return reply.send({ profile: presentProfile(profile) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/profiles/:tgId/telegram', async (req, reply) => {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) return reply.send({ telegram: null });

    const params = z.object({ tgId: TgIdSchema }).parse(req.params);
    try {
      const telegram = await fetchTelegramChatInfo(token, params.tgId.toString());
      return reply.send({ telegram });
    } catch {
      return reply.send({ telegram: null });
    }
  });

  app.get('/profiles/:tgId/avatar', async (req, reply) => {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) return reply.code(404).send();

    const params = z.object({ tgId: TgIdSchema }).parse(req.params);
    const userId = params.tgId.toString();
    try {
      const out = await fetchTelegramUserAvatar(token, userId);
      if (!out) return reply.code(404).send();
      return reply.type(out.contentType).header('Cache-Control', 'private, max-age=3600').send(out.buffer);
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/profiles/:tgId/snapshot', async (req, reply) => {
    const params = z.object({ tgId: TgIdSchema }).parse(req.params);
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    await deps.deals.pullProfileFromRedis(params.tgId);
    await deps.deals.pullOwnerGiftsFromRedis(params.tgId);
    const profile = deps.deals.getOrCreateProfile(params.tgId);
    const gifts = deps.deals.listGiftsByOwner(params.tgId).map(presentGift);
    return reply.send({ profile: presentProfile(profile), gifts });
  });

  app.get('/profiles/:tgId', async (req, reply) => {
    const params = z.object({ tgId: TgIdSchema }).parse(req.params);
    const query = z.object({ recover: z.string().optional() }).parse(req.query);
    await deps.deals.pullProfileFromRedis(params.tgId);
    if (['1', 'true', 'yes', 'on'].includes((query.recover ?? '').trim().toLowerCase())) {
      await recoverProfileDepositsForUser(deps.deals, params.tgId).catch((e) => {
        req.log.warn({ err: e }, 'profile deposit recovery failed');
      });
    }
    const profile = deps.deals.getOrCreateProfile(params.tgId);
    return reply.send({ profile: presentProfile(profile) });
  });

  app.post('/profiles/:tgId/deposits/recover', async (req, reply) => {
    const params = z.object({ tgId: TgIdSchema }).parse(req.params);
    await deps.deals.pullProfileFromRedis(params.tgId);
    try {
      const out = await recoverProfileDepositsForUser(deps.deals, params.tgId);
      const profile = deps.deals.getOrCreateProfile(params.tgId);
      return reply.send({ ...out, profile: presentProfile(profile) });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/profiles/:tgId/deposit/pay-request', async (req, reply) => {
    const params = z.object({ tgId: TgIdSchema }).parse(req.params);
    const body = z
      .object({
        currency: z.enum(['TON', 'USDT']),
        amount: z.string().min(1),
        walletAddress: z.string().optional()
      })
      .parse(req.body);

    const escrowAddress = process.env.ESCROW_ADDRESS?.trim();
    if (!escrowAddress) return reply.code(500).send({ error: 'ESCROW_ADDRESS is not configured on server' });

    const policy = getFeeConfig()[body.currency];
    let amountBaseUnits: bigint;
    try {
      amountBaseUnits = parseDecimalToUnits(body.amount, policy.decimals);
    } catch {
      return reply.code(400).send({ error: 'Invalid amount' });
    }
    if (amountBaseUnits <= 0n) return reply.code(400).send({ error: 'Amount must be > 0' });

    const totalDisplay = formatUnitsToDecimal(amountBaseUnits, policy.decimals);
    await deps.deals.pullProfileFromRedis(params.tgId);
    const deposit = deps.deals.createProfileDeposit({
      tgId: params.tgId,
      currency: body.currency,
      amountBaseUnits,
      walletAddress: body.walletAddress,
      escrowAddress
    });
    const comment = deposit.comment;

    if (body.currency === 'TON') {
      return reply.send({
        tonNetwork: getTonNetwork(),
        currency: 'TON',
        totalDisplay,
        deposit: presentProfileDeposit(deposit),
        depositId: deposit.id,
        to: escrowAddress,
        totalNanoTon: amountBaseUnits.toString(),
        tonconnect: {
          validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
          network: tonConnectNetwork(),
          from: body.walletAddress,
          messages: [
            {
              address: escrowAddress,
              amount: amountBaseUnits.toString(),
              payload: buildTextCommentPayload(comment)
            }
          ]
        }
      });
    }

    const usdtJettonMaster = getUsdtJettonMaster();
    if (!usdtJettonMaster) {
      return reply.code(500).send({ error: 'USDT_JETTON_MASTER is not configured on server' });
    }
    if (!body.walletAddress) {
      return reply.code(400).send({ error: 'walletAddress is required for USDT deposits' });
    }

    try {
      const buyerJettonWallet = await resolveJettonWalletAddress({
        jettonMaster: usdtJettonMaster,
        ownerAddress: body.walletAddress
      });
      const gas = BigInt(process.env.USDT_GAS_NANOTON ?? '50000000');
      const forwardTon = BigInt(process.env.USDT_FORWARD_NANOTON ?? '1');
      const payload = buildJettonTransferPayload({
        jettonAmount: amountBaseUnits,
        recipient: escrowAddress,
        responseDestination: body.walletAddress,
        forwardTonAmount: forwardTon,
        comment
      });
      return reply.send({
        tonNetwork: getTonNetwork(),
        currency: 'USDT',
        totalDisplay,
        deposit: presentProfileDeposit(deposit),
        depositId: deposit.id,
        tonconnect: {
          validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
          network: tonConnectNetwork(),
          from: body.walletAddress,
          messages: [
            {
              address: buyerJettonWallet,
              amount: gas.toString(),
              payload
            }
          ]
        }
      });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/profiles/:tgId/deposits/:depositId/confirm', async (req, reply) => {
    const params = z.object({ tgId: TgIdSchema, depositId: z.string().min(1) }).parse(req.params);
    const body = z.object({ scanLimit: z.number().int().min(1).max(100).optional() }).parse(req.body ?? {});

    await deps.deals.pullProfileFromRedis(params.tgId);
    await deps.deals.pullProfileDepositFromRedis(params.depositId);

    const deposit = deps.deals.getProfileDeposit(params.depositId);
    if (!deposit) return reply.code(404).send({ error: 'Deposit not found' });
    if (deposit.tgId !== params.tgId) return reply.code(403).send({ error: 'Deposit belongs to another user' });

    if (deposit.status === 'CONFIRMED') {
      const profile = deps.deals.getOrCreateProfile(params.tgId);
      return reply.send({ matched: true, credited: false, deposit: presentProfileDeposit(deposit), profile: presentProfile(profile) });
    }

    try {
      let hit: { txHash: string } | null = null;
      if (deposit.currency === 'TON') {
        hit = await detectTonProfileDeposit({
          escrowAddress: deposit.escrowAddress,
          amountBaseUnits: deposit.amountBaseUnits,
          comment: deposit.comment,
          limit: body.scanLimit
        });
      } else {
        const usdtJettonMaster = getUsdtJettonMaster();
        if (!usdtJettonMaster) return reply.code(500).send({ error: 'USDT_JETTON_MASTER is not configured on server' });
        hit = await detectUsdtProfileDeposit({
          escrowAddress: deposit.escrowAddress,
          usdtJettonMaster,
          amountBaseUnits: deposit.amountBaseUnits,
          comment: deposit.comment,
          limit: body.scanLimit
        });
      }

      if (!hit) {
        const profile = deps.deals.getOrCreateProfile(params.tgId);
        return reply.send({
          matched: false,
          credited: false,
          reason: 'Deposit transaction is not visible on-chain yet',
          deposit: presentProfileDeposit(deposit),
          profile: presentProfile(profile)
        });
      }

      const out = deps.deals.confirmProfileDeposit({ depositId: deposit.id, txHash: hit.txHash });
      return reply.send({
        matched: true,
        credited: out.credited,
        deposit: presentProfileDeposit(out.deposit),
        profile: presentProfile(out.profile)
      });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/profiles/:tgId/withdraw/request', async (req, reply) => {
    const params = z.object({ tgId: TgIdSchema }).parse(req.params);
    const body = z
      .object({
        currency: z.enum(['TON', 'USDT']),
        amount: z.string().min(1),
        walletAddress: z.string().min(1)
      })
      .parse(req.body);

    const policy = getFeeConfig()[body.currency];
    let amountBaseUnits: bigint;
    try {
      amountBaseUnits = parseDecimalToUnits(body.amount, policy.decimals);
    } catch {
      return reply.code(400).send({ error: 'Invalid amount' });
    }

    try {
      await deps.deals.pullProfileFromRedis(params.tgId);
      const out = deps.deals.requestProfileBalanceWithdrawal({
        tgId: params.tgId,
        currency: body.currency,
        amountBaseUnits,
        walletAddress: body.walletAddress
      });
      try {
        const sent = await sendProfileWithdrawal({
          withdrawalId: out.withdrawal.id,
          currency: body.currency,
          amountBaseUnits,
          destinationWallet: body.walletAddress
        });
        const confirmed = deps.deals.confirmProfileBalanceWithdrawal({
          withdrawalId: out.withdrawal.id,
          txHash: sent.txHash
        });
        return reply.send({
          currency: body.currency,
          amountDisplay: formatUnitsToDecimal(amountBaseUnits, policy.decimals),
          destinationWallet: body.walletAddress,
          withdrawalId: confirmed.withdrawal.id,
          withdrawal: presentProfileWithdrawal(confirmed.withdrawal),
          manualWithdrawalRequired: false,
          txHash: sent.txHash,
          escrowWalletAddress: sent.escrowWalletAddress,
          walletVersion: sent.walletVersion,
          profile: presentProfile(confirmed.profile)
        });
      } catch (sendError) {
        const failed = deps.deals.failProfileBalanceWithdrawal({
          withdrawalId: out.withdrawal.id,
          reason: (sendError as Error).message
        });
        return reply.code(502).send({
          error: (sendError as Error).message,
          withdrawalId: failed.withdrawal.id,
          withdrawal: presentProfileWithdrawal(failed.withdrawal),
          profile: presentProfile(failed.profile)
        });
      }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/gifts/deposit', async (req, reply) => {
    const body = z
      .object({
        ownerTgId: TgIdSchema,
        giftId: z.string().min(1),
        title: z.string().optional(),
        model: z.string().optional(),
        background: z.string().optional()
      })
      .parse(req.body);
    try {
      const gift = deps.deals.depositGift(body);
      return reply.code(201).send({ gift: presentGift(gift) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/gifts/sync', async (req, reply) => {
    const body = z
      .object({
        ownerTgId: TgIdSchema,
        limit: z.number().int().min(1).max(300).optional()
      })
      .parse(req.body);
    try {
      await deps.deals.pullOwnerGiftsFromRedis(body.ownerTgId);
      const out = await deps.deals.syncDepositedNfts({ ownerTgId: body.ownerTgId, limit: body.limit });
      return reply.send({ added: out.added, gifts: out.gifts.map(presentGift), vaultAddress: process.env.GIFT_VAULT_ADDRESS ?? null });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/gifts/deposit/session/start', async (req, reply) => {
    const body = z
      .object({
        ownerTgId: TgIdSchema,
        ttlSec: z.number().int().min(30).max(900).optional()
      })
      .parse(req.body);
    try {
      const out = deps.deals.startGiftTransferSession({ ownerTgId: body.ownerTgId, ttlSec: body.ttlSec });
      const business = await getTelegramBusinessConnectionStatus();
      return reply.send({
        ok: true,
        expiresAtMs: out.expiresAtMs,
        botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null,
        vaultContactUsername: business.active?.user?.username ?? process.env.TELEGRAM_VAULT_CONTACT_USERNAME ?? null,
        configuredVaultContactUsername: process.env.TELEGRAM_VAULT_CONTACT_USERNAME ?? null,
        businessAccountUsername: business.active?.user?.username ?? null,
        businessGiftsEnabled: Boolean(business.active?.id),
        businessGiftTransferEnabled: envFlag('TELEGRAM_BUSINESS_GIFT_TRANSFER_ENABLED')
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/gifts/deposit/session/claim', async (req, reply) => {
    const body = z
      .object({
        ownerTgId: TgIdSchema,
        limit: z.number().int().min(1).max(300).optional()
      })
      .parse(req.body);
    try {
      const out = await deps.deals.claimGiftTransferSession({ ownerTgId: body.ownerTgId, limit: body.limit });
      return reply.send({ added: out.added, gifts: out.gifts.map(presentGift) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/gifts/:ownerTgId', async (req, reply) => {
    const params = z.object({ ownerTgId: TgIdSchema }).parse(req.params);
    await deps.deals.pullOwnerGiftsFromRedis(params.ownerTgId);
    const gifts = deps.deals.listGiftsByOwner(params.ownerTgId).map(presentGift);
    return reply.send({ gifts });
  });

  app.get('/telegram/file', async (req, reply) => {
    const query = z.object({ fileId: z.string().min(1) }).parse(req.query);
    try {
      const file = await deps.deals.fetchTelegramGiftFile(query.fileId);
      return reply
        .header('cache-control', 'public, max-age=604800, immutable')
        .type(file.contentType)
        .send(Readable.from(Buffer.from(file.bytes)));
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post('/gifts/withdraw/request', async (req, reply) => {
    const body = z
      .object({
        ownerTgId: TgIdSchema,
        giftId: z.string().min(1)
      })
      .parse(req.body);
    try {
      const gift = deps.deals.requestGiftWithdraw({ ownerTgId: body.ownerTgId, giftId: body.giftId });
      const business = await getTelegramBusinessConnectionStatus();
      return reply.send({
        gift: presentGift(gift),
        botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null,
        vaultContactUsername: business.active?.user?.username ?? process.env.TELEGRAM_VAULT_CONTACT_USERNAME ?? null,
        configuredVaultContactUsername: process.env.TELEGRAM_VAULT_CONTACT_USERNAME ?? null,
        businessAccountUsername: business.active?.user?.username ?? null,
        businessGiftsEnabled: Boolean(business.active?.id),
        businessGiftTransferEnabled: envFlag('TELEGRAM_BUSINESS_GIFT_TRANSFER_ENABLED'),
        manualTransferRequired: giftNeedsManualBusinessTransfer(gift)
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/gifts/withdraw/confirm', async (req, reply) => {
    const body = z
      .object({
        ownerTgId: TgIdSchema,
        giftId: z.string().min(1),
        limit: z.number().int().min(1).max(300).optional()
      })
      .parse(req.body);
    try {
      const gift = await deps.deals.confirmGiftWithdraw({
        ownerTgId: body.ownerTgId,
        giftId: body.giftId,
        limit: body.limit
      });
      return reply.send({ gift: presentGift(gift) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/admin/gifts/withdraw/manual-confirm', async (req, reply) => {
    const body = z
      .object({
        adminSecret: z.string().min(1).optional(),
        ownerTgId: TgIdSchema,
        giftId: z.string().min(1)
      })
      .parse(req.body);
    try {
      assertAdminSecret(body.adminSecret);
      const gift = deps.deals.confirmManualGiftWithdraw({
        ownerTgId: body.ownerTgId,
        giftId: body.giftId
      });
      return reply.send({ gift: presentGift(gift) });
    } catch (e) {
      return reply.code(403).send({ error: (e as Error).message });
    }
  });

  app.post('/admin/profiles/:tgId/withdraw/manual-confirm', async (req, reply) => {
    const params = z.object({ tgId: TgIdSchema }).parse(req.params);
    const body = z
      .object({
        adminSecret: z.string().min(1).optional(),
        withdrawalId: z.string().min(1),
        txHash: z.string().optional()
      })
      .parse(req.body);
    try {
      assertAdminSecret(body.adminSecret);
      await deps.deals.pullProfileFromRedis(params.tgId);
      await deps.deals.pullProfileWithdrawalFromRedis(body.withdrawalId);
      const existing = deps.deals.getProfileWithdrawal(body.withdrawalId);
      if (!existing) throw new Error('Withdrawal not found');
      if (existing.tgId !== params.tgId) throw new Error('Withdrawal belongs to another user');
      const out = deps.deals.confirmProfileBalanceWithdrawal({ withdrawalId: body.withdrawalId, txHash: body.txHash });
      return reply.send({
        ok: true,
        withdrawal: presentProfileWithdrawal(out.withdrawal),
        profile: presentProfile(out.profile)
      });
    } catch (e) {
      return reply.code(403).send({ error: (e as Error).message });
    }
  });

  app.post('/deals', async (req, reply) => {
    const body = z
      .object({
        tgId: TgIdSchema,
        role: z.enum(['seller', 'buyer']),
        telegram: z
          .object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            username: z.string().optional(),
            photoUrl: z.string().optional()
          })
          .optional()
      })
      .parse(req.body);
    const deal = deps.deals.createDeal({ tgId: body.tgId, role: body.role, telegram: body.telegram });
    if (redisDealsEnabled) await redisPutDeal(deal);
    return reply.code(201).send({ deal: presentDeal(deal) });
  });

  app.get('/deals/:publicId', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const query = z
      .object({
        tgId: TgIdSchema.optional(),
        join: z.enum(['buyer', 'seller']).optional()
      })
      .parse(req.query);
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    await deps.deals.pullDealFromRedis(params.publicId);
    const deal = deps.deals.getDeal(params.publicId);
    if (!deal) return reply.send({ deal: null });
    if (query.tgId && isDealClosedToViewer(deal, query.tgId, query.join)) {
      return reply.code(403).send({ error: DEAL_JOIN_CLOSED_MESSAGE });
    }
    return reply.send({ deal: presentDeal(deal) });
  });

  /** SSE: сервер пушит новое состояние сделки при изменении (лобби + этапы escrow). */
  app.get('/deals/:publicId/stream', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const query = z.object({ tgId: TgIdSchema.optional() }).parse(req.query);

    reply.header('Content-Type', 'text/event-stream; charset=utf-8');
    reply.header('Cache-Control', 'no-cache, no-transform');
    reply.header('Connection', 'keep-alive');
    reply.header('X-Accel-Buffering', 'no');

    const stream = new Readable({
      read() {
        /* pull-driven via intervals */
      },
    });

    let lastSig = '';
    const pushIfChanged = async () => {
      await deps.deals.pullDealFromRedis(params.publicId);
      const deal = deps.deals.getDeal(params.publicId);
      if (deal && query.tgId && isDealClosedToViewer(deal, query.tgId)) {
        const payload = JSON.stringify({ deal: null, error: DEAL_JOIN_CLOSED_MESSAGE });
        if (payload === lastSig) return;
        lastSig = payload;
        stream.push(`data: ${payload}\n\n`);
        return;
      }
      const payload = deal ? JSON.stringify({ deal: presentDeal(deal) }) : JSON.stringify({ deal: null });
      const sig = `${payload}:${deal?.updatedAt ?? ''}`;
      if (sig === lastSig) return;
      lastSig = sig;
      stream.push(`data: ${payload}\n\n`);
    };

    await pushIfChanged();
    const pollInterval = setInterval(() => void pushIfChanged(), 350);
    const heartbeat = setInterval(() => {
      stream.push(': ping\n\n');
    }, 20000);

    const cleanup = () => {
      clearInterval(pollInterval);
      clearInterval(heartbeat);
      stream.push(null);
    };

    req.raw.on('close', cleanup);
    req.raw.on('aborted', cleanup);

    return reply.send(stream);
  });

  app.post('/deals/:publicId/join', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        tgId: TgIdSchema,
        role: z.enum(['buyer', 'seller']),
        telegram: z
          .object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            username: z.string().optional(),
            photoUrl: z.string().optional()
          })
          .optional()
      })
      .parse(req.body);
    try {
      await deps.deals.pullDealFromRedis(params.publicId);
      const deal = deps.deals.joinDeal({ publicId: params.publicId, tgId: body.tgId, role: body.role, telegram: body.telegram });
      if (redisDealsEnabled) await redisPutDeal(deal);
      return reply.send({ deal: presentDeal(deal) });
    } catch (e) {
      const message = (e as Error).message;
      return reply.code(message === DEAL_JOIN_CLOSED_MESSAGE ? 403 : 400).send({ error: message });
    }
  });

  app.post('/deals/:publicId/start', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z.object({ tgId: TgIdSchema }).parse(req.body);
    try {
      await deps.deals.pullDealFromRedis(params.publicId);
      const deal = deps.deals.startDealEscrow({ publicId: params.publicId, tgId: body.tgId });
      if (redisDealsEnabled) await redisPutDeal(deal);
      return reply.send({ deal: presentDeal(deal) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/deals/:publicId/price', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        sellerTgId: TgIdSchema,
        currency: z.enum(['TON', 'USDT']),
        price: z.string().min(1)
      })
      .parse(req.body);
    try {
      await deps.deals.pullDealFromRedis(params.publicId);
      const deal = deps.deals.lockPrice({
        publicId: params.publicId,
        sellerTgId: body.sellerTgId,
        currency: body.currency,
        priceDisplay: body.price
      });
      return reply.send({ deal: presentDeal(deal) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Payment request for TonConnect (buyer clicks "Pay")
  app.post('/deals/:publicId/pay-request', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        buyerTgId: TgIdSchema,
        // Required for USDT: owner's TON address from TonConnect wallet.
        buyerWalletAddress: z.string().optional()
      })
      .parse(req.body);

    await deps.deals.pullDealFromRedis(params.publicId);
    const deal = deps.deals.getDeal(params.publicId);
    if (!deal) return reply.code(404).send({ error: 'Deal not found' });

    if (!deal.buyerTgId || deal.buyerTgId !== body.buyerTgId) {
      return reply.code(403).send({ error: 'Only buyer can request payment' });
    }
    if (deal.status !== 'WAITING_FOR_PAYMENT') {
      return reply.code(400).send({ error: `Cannot pay in status ${deal.status}` });
    }
    if (!deal.currency || !deal.totalBaseUnits || !deal.totalDisplay) {
      return reply.code(400).send({ error: 'Price is not locked yet' });
    }
    if (!deal.escrowAddress) {
      return reply.code(500).send({ error: 'ESCROW_ADDRESS is not configured on server' });
    }

    if (deal.currency === 'TON') {
      const payload = buildTextCommentPayload(`deal:${deal.publicId}`);
      // TonConnect expects amount as a decimal string in nanoTON.
      return reply.send({
        tonNetwork: getTonNetwork(),
        currency: 'TON',
        to: deal.escrowAddress,
        totalDisplay: deal.totalDisplay,
        totalNanoTon: deal.totalBaseUnits.toString(),
        tonconnect: {
          validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
          network: tonConnectNetwork(),
          from: body.buyerWalletAddress,
          messages: [
            {
              address: deal.escrowAddress,
              amount: deal.totalBaseUnits.toString(),
              payload
            }
          ]
        }
      });
    }

    // USDT (Jetton) payment:
    // For Jettons, the actual transfer is sent to the buyer's *Jetton Wallet* contract,
    // which is derived from (master, owner). We'll return the master and recipient so
    // the Mini App can build a correct transaction (next step: compute wallet server-side).
    const usdtJettonMaster = getUsdtJettonMaster();
    if (!usdtJettonMaster) {
      return reply.code(500).send({ error: 'USDT_JETTON_MASTER is not configured on server' });
    }

    if (!body.buyerWalletAddress) {
      return reply.code(400).send({ error: 'buyerWalletAddress is required for USDT payments' });
    }

    try {
      const buyerJettonWallet = await resolveJettonWalletAddress({
        jettonMaster: usdtJettonMaster,
        ownerAddress: body.buyerWalletAddress
      });

      const gas = BigInt(process.env.USDT_GAS_NANOTON ?? '50000000'); // 0.05 TON by default
      const forwardTon = BigInt(process.env.USDT_FORWARD_NANOTON ?? '1'); // minimal forward value

      const payloadBase64 = buildJettonTransferPayload({
        jettonAmount: deal.totalBaseUnits,
        recipient: deal.escrowAddress,
        responseDestination: body.buyerWalletAddress,
        forwardTonAmount: forwardTon,
        comment: `deal:${deal.publicId}`
      });

      return reply.send({
        tonNetwork: getTonNetwork(),
        currency: 'USDT',
        totalDisplay: deal.totalDisplay,
        totalUsdtBaseUnits: deal.totalBaseUnits.toString(),
        tonconnect: {
          validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
          network: tonConnectNetwork(),
          from: body.buyerWalletAddress,
          messages: [
            {
              address: buyerJettonWallet,
              amount: gas.toString(),
              payload: payloadBase64
            }
          ]
        },
        debug: {
          jettonMaster: usdtJettonMaster,
          buyerWalletAddress: body.buyerWalletAddress,
          buyerJettonWallet
        }
      });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/deals/:publicId/payment/from-balance', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z.object({ buyerTgId: TgIdSchema }).parse(req.body);

    try {
      await deps.deals.pullDealFromRedis(params.publicId);
      await deps.deals.pullProfileFromRedis(body.buyerTgId);
      await recoverProfileDepositsForUser(deps.deals, body.buyerTgId).catch((e) => {
        req.log.warn({ err: e }, 'profile deposit recovery before balance payment failed');
      });
      const out = deps.deals.payDealFromProfileBalance({
        publicId: params.publicId,
        buyerTgId: body.buyerTgId
      });
      return reply.send({ deal: presentDeal(out.deal), profile: presentProfile(out.profile) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Manual confirmation for MVP testing (later replaced by on-chain verification)
  app.post('/deals/:publicId/payment/confirm', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        buyerTgId: TgIdSchema,
        txHash: z.string().min(1).optional()
      })
      .parse(req.body);

    try {
      await deps.deals.pullDealFromRedis(params.publicId);
      const deal = deps.deals.confirmPayment({
        publicId: params.publicId,
        buyerTgId: body.buyerTgId,
        txHash: body.txHash
      });
      return reply.send({ deal: presentDeal(deal) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Auto-check payment on-chain (currently TON only)
  app.post('/deals/:publicId/payment/auto-confirm', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        buyerTgId: TgIdSchema,
        scanLimit: z.number().int().min(1).max(100).optional()
      })
      .parse(req.body);

    await deps.deals.pullDealFromRedis(params.publicId);
    const deal = deps.deals.getDeal(params.publicId);
    if (!deal) return reply.code(404).send({ error: 'Deal not found' });
    if (!deal.buyerTgId || deal.buyerTgId !== body.buyerTgId) {
      return reply.code(403).send({ error: 'Only buyer can auto-confirm payment' });
    }
    if (deal.status !== 'WAITING_FOR_PAYMENT') {
      return reply.code(400).send({ error: `Cannot auto-confirm payment in status ${deal.status}` });
    }
    if (!deal.currency) {
      return reply.code(400).send({ error: 'Price is not locked yet' });
    }
    try {
      let txHash: string | null = null;
      if (deal.currency === 'TON') {
        txHash = await detectTonPaymentForDeal({ deal, limit: body.scanLimit });
      } else if (deal.currency === 'USDT') {
        const master = getUsdtJettonMaster();
        if (!master) return reply.code(500).send({ error: 'USDT_JETTON_MASTER is not configured on server' });
        txHash = await detectUsdtPaymentForDeal({
          deal,
          usdtJettonMaster: master,
          limit: body.scanLimit
        });
      }

      if (!txHash) return reply.code(202).send({ matched: false, reason: 'No matching transaction found yet' });

      const updated = deps.deals.confirmPayment({
        publicId: params.publicId,
        buyerTgId: body.buyerTgId,
        txHash
      });
      return reply.send({ matched: true, deal: presentDeal(updated) });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/deals/:publicId/gift/reserve', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        sellerTgId: TgIdSchema,
        giftId: z.string().min(1)
      })
      .parse(req.body);
    try {
      await deps.deals.pullDealFromRedis(params.publicId);
      const out = deps.deals.reserveGiftForDeal({
        publicId: params.publicId,
        sellerTgId: body.sellerTgId,
        giftId: body.giftId
      });
      return reply.send({ deal: presentDeal(out.deal), gift: presentGift(out.gift) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/deals/:publicId/gift/unreserve', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z.object({ sellerTgId: TgIdSchema }).parse(req.body);
    try {
      await deps.deals.pullDealFromRedis(params.publicId);
      const out = deps.deals.unreserveGiftForDeal({
        publicId: params.publicId,
        sellerTgId: body.sellerTgId
      });
      return reply.send({ deal: presentDeal(out.deal), gift: out.gift ? presentGift(out.gift) : null });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/deals/:publicId/release', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        sellerTgId: TgIdSchema,
        feeRecipientAddress: z.string().optional(),
        payoutTxHash: z.string().optional(),
        giftTransferTxHash: z.string().optional()
      })
      .parse(req.body);
    try {
      await deps.deals.pullDealFromRedis(params.publicId);
      const dealBeforeRelease = deps.deals.getDeal(params.publicId);
      if (dealBeforeRelease?.buyerTgId) await deps.deals.pullProfileFromRedis(dealBeforeRelease.buyerTgId);
      if (dealBeforeRelease?.sellerTgId) await deps.deals.pullProfileFromRedis(dealBeforeRelease.sellerTgId);
      const out = await deps.deals.releaseDeal({
        publicId: params.publicId,
        sellerTgId: body.sellerTgId,
        feeRecipientAddress: body.feeRecipientAddress,
        payoutTxHash: body.payoutTxHash,
        giftTransferTxHash: body.giftTransferTxHash
      });
      return reply.send({ deal: presentDeal(out.deal), gift: presentGift(out.gift) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/admin/deals/:publicId/gift-transfer/confirm', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        adminSecret: z.string().min(1).optional(),
        giftTransferTxHash: z.string().optional()
      })
      .parse(req.body);
    try {
      assertAdminSecret(body.adminSecret);
      await deps.deals.pullDealFromRedis(params.publicId);
      const dealBeforeConfirm = deps.deals.getDeal(params.publicId);
      if (dealBeforeConfirm?.buyerTgId) await deps.deals.pullProfileFromRedis(dealBeforeConfirm.buyerTgId);
      if (dealBeforeConfirm?.sellerTgId) await deps.deals.pullProfileFromRedis(dealBeforeConfirm.sellerTgId);
      const out = deps.deals.confirmManualGiftTransfer({
        publicId: params.publicId,
        giftTransferTxHash: body.giftTransferTxHash
      });
      return reply.send({ deal: presentDeal(out.deal), gift: presentGift(out.gift) });
    } catch (e) {
      return reply.code(403).send({ error: (e as Error).message });
    }
  });
}
