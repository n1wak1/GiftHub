import type { FastifyInstance } from 'fastify';
import { getFeeConfig } from './money.js';
import { getTonNetwork, getUsdtJettonMaster } from './ton.config.js';

export async function registerConfigHttp(app: FastifyInstance) {
  app.get('/config', async () => {
    const fee = getFeeConfig();
    return {
      tonNetwork: getTonNetwork(),
      escrowAddress: process.env.ESCROW_ADDRESS ?? null,
      usdtJettonMaster: getUsdtJettonMaster(),
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

