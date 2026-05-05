import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DealsStore } from './deals.store.js';
import { presentDealForMiniappInvite } from './telegram.invite.js';

type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number };
  };
};

const StartPayloadSchema = z.object({
  deal: z.string().min(1),
  join: z.enum(['buyer', 'seller'])
});

function parseStartPayload(payload: string | undefined): { deal: string; join: 'buyer' | 'seller' } | null {
  if (!payload) return null;
  // Format: deal.<publicId>.<role>
  // Example: deal.88c2d39a2124.buyer
  const m = /^deal\.([a-zA-Z0-9_-]{6,64})\.(buyer|seller)$/.exec(payload.trim());
  if (!m) return null;
  try {
    return StartPayloadSchema.parse({ deal: m[1], join: m[2] });
  } catch {
    return null;
  }
}

async function tgApi(botToken: string, method: string, body: unknown): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || j?.ok === false) throw new Error(j?.description ?? `${r.status} ${r.statusText}`);
  return j;
}

async function sendOpenAppButton(params: {
  botToken: string;
  chatId: number;
  text: string;
  webAppUrl: string;
}): Promise<void> {
  await tgApi(params.botToken, 'sendMessage', {
    chat_id: params.chatId,
    text: params.text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Open App',
            web_app: { url: params.webAppUrl }
          }
        ]
      ]
    }
  });
}

export async function registerTelegramBotHttp(app: FastifyInstance, deps: { deals: DealsStore }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const miniappUrl = process.env.MINIAPP_URL?.trim().replace(/\/$/, '');
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  if (!botToken) {
    app.log.warn('[gifthub] Telegram bot: TELEGRAM_BOT_TOKEN is not set; /telegram/* routes disabled');
    return;
  }
  if (!miniappUrl) {
    app.log.warn('[gifthub] Telegram bot: MINIAPP_URL is not set; deep links will not work');
  }

  app.post('/telegram/webhook', async (req, reply) => {
    if (secret) {
      const hdr = (req.headers['x-telegram-bot-api-secret-token'] as string | undefined)?.trim();
      if (!hdr || hdr !== secret) return reply.code(401).send({ ok: false });
    }

    const upd = req.body as TgUpdate;
    const text = upd?.message?.text?.trim() ?? '';
    const chatId = upd?.message?.chat?.id;

    if (!chatId) return reply.send({ ok: true });
    if (!text.startsWith('/start')) return reply.send({ ok: true });

    const payload = text.split(' ').slice(1).join(' ').trim() || undefined;
    const parsed = parseStartPayload(payload);

    if (!miniappUrl) {
      await tgApi(botToken, 'sendMessage', {
        chat_id: chatId,
        text: 'Mini App URL is not configured on server (MINIAPP_URL).'
      });
      return reply.send({ ok: true });
    }

    if (!parsed) {
      await sendOpenAppButton({
        botToken,
        chatId,
        text: 'Откройте Mini App.',
        webAppUrl: miniappUrl
      });
      return reply.send({ ok: true });
    }

    // Validate deal exists; pull from Redis is done in http endpoints, here we just best-effort check.
    const deal = deps.deals.getDeal(parsed.deal);
    const webAppUrl = presentDealForMiniappInvite({
      miniappUrl,
      dealPublicId: parsed.deal,
      join: parsed.join
    });

    await sendOpenAppButton({
      botToken,
      chatId,
      text: deal ? `Сделка #${deal.publicId}. Нажмите Open App, чтобы присоединиться.` : 'Нажмите Open App, чтобы открыть сделку.',
      webAppUrl
    });

    return reply.send({ ok: true });
  });

  /** Одноразовая настройка webhook (вызвать вручную после деплоя). */
  app.get('/telegram/set-webhook', async (req, reply) => {
    const url = (req.query as any)?.url as string | undefined;
    if (!url) return reply.code(400).send({ error: 'url query is required' });
    const webhookUrl = url.trim();

    const out = await tgApi(botToken, 'setWebhook', {
      url: webhookUrl,
      secret_token: secret || undefined,
      allowed_updates: ['message']
    });
    return reply.send({ ok: true, telegram: out });
  });
}

