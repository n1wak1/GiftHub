/** Telegram Bot API: gifts on the bot user profile (getUserGifts). */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

async function telegramApi(botToken: string, method: string, body: object): Promise<unknown> {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (!r.ok || j?.ok === false) throw new Error(j?.description ?? `${r.status} ${r.statusText}`);
  return j.result;
}

let cachedBotUserId: number | null = null;

export async function telegramGetBotUserId(botToken: string): Promise<number> {
  if (cachedBotUserId != null) return cachedBotUserId;
  const me = asRecord(await telegramApi(botToken, 'getMe', {}));
  const id = me?.id;
  if (typeof id !== 'number' || !Number.isFinite(id)) throw new Error('getMe: missing bot id');
  cachedBotUserId = id;
  return id;
}

export type ParsedProfileGift = {
  giftId: string;
  giftType: 'unique' | 'regular';
  ownedGiftId?: string;
  title?: string;
  model?: string;
  background?: string;
  senderUserId?: number;
  sendDate?: number;
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Map one OwnedGift (regular | unique) from getUserGifts into a stable giftId + display fields. */
export function parseOwnedGiftItem(raw: unknown): ParsedProfileGift | null {
  const o = asRecord(raw);
  if (!o) return null;
  const sendDate = num(o.send_date);
  const sender = asRecord(o.sender_user);
  const senderUserId = num(sender?.id);

    const ownedGiftId = str(o.owned_gift_id);

  const t = str(o.type);
  if (t === 'unique') {
    const gift = asRecord(o.gift);
    if (!gift) return null;
    if (gift.is_burned === true) return null;
    const name = str(gift.name);
    if (!name) return null;
    const giftId = ownedGiftId ? `tg:owned:${ownedGiftId}` : `tg:nft:${name}`;
    const model = str(asRecord(gift.model)?.name);
    const backdrop = asRecord(gift.backdrop);
    const background = str(backdrop?.name);
    return { giftId, giftType: 'unique', ownedGiftId, title: name, model, background, senderUserId, sendDate };
  }

  if (t === 'regular') {
    const gift = asRecord(o.gift);
    if (!gift) return null;
    if (o.was_refunded === true) return null;
    const catalogId = str(gift.id);
    if (!catalogId) return null;
    const giftId = ownedGiftId
      ? `tg:owned:${ownedGiftId}`
      : `tg:reg:${catalogId}:${sendDate ?? 0}`;
    const sticker = asRecord(gift.sticker);
    const emoji = str(sticker?.emoji);
    return { giftId, giftType: 'regular', ownedGiftId, title: emoji ?? catalogId, senderUserId, sendDate };
  }

  return null;
}

export async function telegramFetchUserGiftsPage(params: {
  botToken: string;
  userId: number;
  offset: string;
  limit: number;
}): Promise<{ gifts: unknown[]; nextOffset?: string; totalCount?: number }> {
  const result = asRecord(
    await telegramApi(params.botToken, 'getUserGifts', {
      user_id: params.userId,
      offset: params.offset,
      limit: Math.min(100, Math.max(1, params.limit)),
    }),
  );
  if (!result) return { gifts: [] };
  const gifts = result.gifts;
  const list = Array.isArray(gifts) ? gifts : [];
  const nextOffset = str(result.next_offset);
  const totalCount = num(result.total_count);
  return { gifts: list, nextOffset, totalCount };
}

export async function telegramFetchBusinessAccountGiftsPage(params: {
  botToken: string;
  businessConnectionId: string;
  offset: string;
  limit: number;
}): Promise<{ gifts: unknown[]; nextOffset?: string; totalCount?: number }> {
  const result = asRecord(
    await telegramApi(params.botToken, 'getBusinessAccountGifts', {
      business_connection_id: params.businessConnectionId,
      offset: params.offset,
      limit: Math.min(100, Math.max(1, params.limit)),
    }),
  );
  if (!result) return { gifts: [] };
  const gifts = result.gifts;
  const list = Array.isArray(gifts) ? gifts : [];
  const nextOffset = str(result.next_offset);
  const totalCount = num(result.total_count);
  return { gifts: list, nextOffset, totalCount };
}

/**
 * Walk getUserGifts pages until callback returns false, next_offset empty, or maxPages.
 * Newest-by-send-date is the typical default ordering (unless sort_by_price).
 */
export async function telegramIterateUserGifts(params: {
  botToken: string;
  userId: number;
  maxPages?: number;
  pageSize?: number;
  onPage: (items: unknown[], meta: { pageIndex: number; nextOffset?: string }) => boolean | void;
}): Promise<void> {
  const maxPages = Math.max(1, Math.min(500, params.maxPages ?? 40));
  const pageSize = params.pageSize ?? 100;
  let offset = '';
  for (let page = 0; page < maxPages; page += 1) {
    const { gifts, nextOffset } = await telegramFetchUserGiftsPage({
      botToken: params.botToken,
      userId: params.userId,
      offset,
      limit: pageSize,
    });
    const carryOn = params.onPage(gifts, { pageIndex: page, nextOffset });
    if (carryOn === false) return;
    if (!nextOffset || nextOffset === '') return;
    offset = nextOffset;
  }
}

export async function telegramIterateBusinessGifts(params: {
  botToken: string;
  businessConnectionId: string;
  maxPages?: number;
  pageSize?: number;
  onPage: (items: unknown[], meta: { pageIndex: number; nextOffset?: string }) => boolean | void;
}): Promise<void> {
  const maxPages = Math.max(1, Math.min(500, params.maxPages ?? 40));
  const pageSize = params.pageSize ?? 100;
  let offset = '';
  for (let page = 0; page < maxPages; page += 1) {
    const { gifts, nextOffset } = await telegramFetchBusinessAccountGiftsPage({
      botToken: params.botToken,
      businessConnectionId: params.businessConnectionId,
      offset,
      limit: pageSize,
    });
    const carryOn = params.onPage(gifts, { pageIndex: page, nextOffset });
    if (carryOn === false) return;
    if (!nextOffset || nextOffset === '') return;
    offset = nextOffset;
  }
}

/** Build a set of giftIds currently on the bot profile (bounded scan). */
export async function telegramCollectProfileGiftIds(params: {
  botToken: string;
  userId: number;
  maxPages?: number;
}): Promise<Set<string>> {
  const ids = new Set<string>();
  await telegramIterateUserGifts({
    botToken: params.botToken,
    userId: params.userId,
    maxPages: params.maxPages ?? 40,
    onPage: (items) => {
      for (const raw of items) {
        const p = parseOwnedGiftItem(raw);
        if (p) ids.add(p.giftId);
      }
    },
  });
  return ids;
}

export async function telegramCollectBusinessGiftIds(params: {
  botToken: string;
  businessConnectionId: string;
  maxPages?: number;
}): Promise<Set<string>> {
  const ids = new Set<string>();
  await telegramIterateBusinessGifts({
    botToken: params.botToken,
    businessConnectionId: params.businessConnectionId,
    maxPages: params.maxPages ?? 40,
    onPage: (items) => {
      for (const raw of items) {
        const p = parseOwnedGiftItem(raw);
        if (p) ids.add(p.giftId);
      }
    },
  });
  return ids;
}

export async function telegramTransferBusinessGift(params: {
  botToken: string;
  businessConnectionId: string;
  ownedGiftId: string;
  newOwnerChatId: bigint;
  starCount?: number;
}): Promise<void> {
  const newOwner = Number(params.newOwnerChatId);
  if (!Number.isSafeInteger(newOwner)) throw new Error('Telegram user id is too large for JSON number');
  await telegramApi(params.botToken, 'transferGift', {
    business_connection_id: params.businessConnectionId,
    owned_gift_id: params.ownedGiftId,
    new_owner_chat_id: newOwner,
    star_count: params.starCount,
  });
}
