import type { FastifyInstance } from 'fastify';
import { getFeeConfig } from './money.js';
import { getTonNetwork, getUsdtJettonMaster } from './ton.config.js';

function envFlag(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

export async function registerConfigHttp(app: FastifyInstance) {
  app.get('/config', async () => {
    const fee = getFeeConfig();
    return {
      tonNetwork: getTonNetwork(),
      escrowAddress: process.env.ESCROW_ADDRESS ?? null,
      usdtJettonMaster: getUsdtJettonMaster(),
      telegramVault: {
        contactUsername: process.env.TELEGRAM_VAULT_CONTACT_USERNAME ?? null,
        businessGiftsEnabled: Boolean(process.env.TELEGRAM_BUSINESS_CONNECTION_ID?.trim()),
        businessGiftTransferEnabled: envFlag('TELEGRAM_BUSINESS_GIFT_TRANSFER_ENABLED')
      },
      fee: {
        USDT: {
          threshold: fee.USDT.thresholdDisplay,
          minFee: fee.USDT.minFeeDisplay,
          bps: fee.USDT.percentFeeBps,
          decimals: fee.USDT.decimals
        },
        TON: {
          threshold: fee.TON.thresholdDisplay,
          minFee: fee.TON.minFeeDisplay,
          bps: fee.TON.percentFeeBps,
          decimals: fee.TON.decimals
        }
      }
    };
  });
}

