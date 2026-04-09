import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DealsStore } from './deals.store.js';
import type { Deal } from './domain.js';
import { getTonNetwork, getUsdtJettonMaster } from './ton.config.js';
import { buildJettonTransferPayload } from './jetton.js';
import { resolveJettonWalletAddress } from './tonapi.js';
import { detectTonPaymentForDeal, detectUsdtPaymentForDeal } from './payment.verify.js';

const TgIdSchema = z.union([z.string(), z.number(), z.bigint()]).transform((v) => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (!/^\d+$/.test(v)) throw new Error('Invalid tg id');
  return BigInt(v);
});

function presentDeal(deal: Deal) {
  return {
    ...deal,
    sellerTgId: deal.sellerTgId.toString(),
    buyerTgId: deal.buyerTgId?.toString(),
    priceBaseUnits: deal.priceBaseUnits?.toString(),
    feeBaseUnits: deal.feeBaseUnits?.toString(),
    totalBaseUnits: deal.totalBaseUnits?.toString()
  };
}

export async function registerHttp(app: FastifyInstance, deps: { deals: DealsStore }) {
  app.get('/health', async () => ({ ok: true }));

  app.post('/deals', async (req, reply) => {
    const body = z.object({ sellerTgId: TgIdSchema }).parse(req.body);
    const deal = deps.deals.createDeal({ sellerTgId: body.sellerTgId });
    return reply.code(201).send({ deal: presentDeal(deal) });
  });

  app.get('/deals/:publicId', async (req) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const deal = deps.deals.getDeal(params.publicId);
    if (!deal) return { deal: null };
    return { deal: presentDeal(deal) };
  });

  app.post('/deals/:publicId/join', async (req, reply) => {
    const params = z.object({ publicId: z.string().min(1) }).parse(req.params);
    const body = z.object({ buyerTgId: TgIdSchema }).parse(req.body);
    try {
      const deal = deps.deals.joinDeal({ publicId: params.publicId, buyerTgId: body.buyerTgId });
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
      // TonConnect expects amount as a decimal string in nanoTON.
      return reply.send({
        tonNetwork: getTonNetwork(),
        currency: 'TON',
        to: deal.escrowAddress,
        totalDisplay: deal.totalDisplay,
        totalNanoTon: deal.totalBaseUnits.toString(),
        tonconnect: {
          validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
          messages: [
            {
              address: deal.escrowAddress,
              amount: deal.totalBaseUnits.toString(),
              payload: `deal:${deal.publicId}`
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
}

