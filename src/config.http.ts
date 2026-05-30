import type { FastifyInstance } from 'fastify';
import { getFeeConfig } from './money.js';
import { getTonNetwork, getUsdtJettonMaster } from './ton.config.js';
import { getEscrowWithdrawalConfigStatus } from './ton.withdraw.js';
import { getTelegramBusinessConnectionStatus } from './telegram.business.js';

function envFlag(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

export async function registerConfigHttp(app: FastifyInstance) {
  app.get('/config', async () => {
    const fee = getFeeConfig();
    const withdrawal = await getEscrowWithdrawalConfigStatus();
    const business = await getTelegramBusinessConnectionStatus();
    return {
      tonNetwork: getTonNetwork(),
      escrowAddress: process.env.ESCROW_ADDRESS ?? null,
      usdtJettonMaster: getUsdtJettonMaster(),
      withdrawal,
      telegramVault: {
        contactUsername: process.env.TELEGRAM_VAULT_CONTACT_USERNAME ?? null,
        businessGiftsEnabled: Boolean(business.active?.id),
        businessGiftTransferEnabled: envFlag('TELEGRAM_BUSINESS_GIFT_TRANSFER_ENABLED'),
        businessConnectionSource: business.source,
        businessAccountUsername: business.active?.user?.username ?? null,
        businessAccountTgId: business.active?.user?.id ?? null,
        storedBusinessConnectionEnabled: business.stored?.isEnabled ?? null
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

