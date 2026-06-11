import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import WebApp from '@twa-dev/sdk'
import { TonConnectButton, useTonAddress, useTonWallet, useTonConnectUI } from '@tonconnect/ui-react'
import './App.css'
import gifthubLogoUrl from './assets/gifthub-logo.svg'

type Role = 'seller' | 'buyer'
type DealCurrency = 'TON' | 'USDT'
type DealStatus =
  | 'WAITING_FOR_BUYER'
  | 'WAITING_FOR_SELLER'
  | 'WAITING_FOR_PRICE'
  | 'WAITING_FOR_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'GIFT_RESERVED'
  | 'WAITING_FOR_MANUAL_GIFT_TRANSFER'
  | 'COMPLETED'
  | string

type Deal = {
  publicId: string
  status: DealStatus
  sellerTgId?: string
  buyerTgId?: string
  creatorTgId?: string
  sellerTelegram?: { firstName?: string; lastName?: string; username?: string; photoUrl?: string }
  buyerTelegram?: { firstName?: string; lastName?: string; username?: string; photoUrl?: string }
  currency?: DealCurrency
  priceDisplay?: string
  feeDisplay?: string
  totalBaseUnits?: string
  totalDisplay?: string
  paymentSource?: 'ONCHAIN' | 'PROFILE_BALANCE'
  paymentConfirmedAt?: string
  reservedGiftId?: string
  releasedAt?: string
  escrowStartedAt?: string
}

type Gift = {
  id: string
  giftId: string
  title?: string
  model?: string
  background?: string
  telegramGiftName?: string
  telegramGiftNumber?: number
  telegramImageFileId?: string
  telegramImageFileKind?: 'image' | 'video' | 'thumbnail'
  telegramSymbol?: string
  telegramSymbolFileId?: string
  backdropCenterColor?: string
  backdropEdgeColor?: string
  backdropSymbolColor?: string
  backdropTextColor?: string
  source?: 'MANUAL' | 'TELEGRAM_BUSINESS' | 'TELEGRAM_BOT_PROFILE' | 'ONCHAIN_VAULT'
  telegramGiftType?: 'unique' | 'regular'
  status: 'AVAILABLE' | 'RESERVED' | 'TRANSFER_PENDING' | 'SENT' | 'WITHDRAW_PENDING' | 'WITHDRAWN'
  createdAt?: string
  updatedAt?: string
  withdrawRequestedAt?: string
  withdrawnAt?: string
}

type Profile = {
  payoutWalletAddress?: string
  balances?: Record<DealCurrency, { availableDisplay: string; reservedDisplay: string; availableBaseUnits: string; reservedBaseUnits: string }>
}
type ProfileSnapshot = { profile: Profile; gifts: Gift[] }
type DealHistoryItem = { publicId: string; myRole: Role; updatedAt: string; deal?: Deal }
type AppPage = 'deal' | 'profile' | 'deposit' | 'withdraw'

type TonConnectTx = {
  validUntil: number
  network?: string
  from?: string
  messages: Array<{ address: string; amount: string; payload?: string }>
}

type PayRequestTon = {
  tonconnect: TonConnectTx
}

type PayRequestUsdt = {
  tonconnect: TonConnectTx
}

type DepositPayRequest = {
  currency: DealCurrency
  totalDisplay: string
  depositId: string
  deposit: ProfileDeposit
  tonconnect: TonConnectTx
}

type ProfileDeposit = {
  id: string
  currency: DealCurrency
  amountDisplay: string
  status: 'PENDING' | 'CONFIRMED'
  txHash?: string
}

type DepositConfirmResponse = {
  matched: boolean
  credited: boolean
  reason?: string
  deposit: ProfileDeposit
  profile: Profile
}

type WithdrawBalanceRequest = {
  currency: DealCurrency
  amountDisplay: string
  destinationWallet: string
  withdrawalId: string
  manualWithdrawalRequired: boolean
  txHash?: string
  profile: Profile
}

type BalancePaymentResponse = {
  deal: Deal
  profile: Profile
}

type GiftDepositSessionStart = {
  ok: boolean
  expiresAtMs: number
  botUsername?: string | null
  vaultContactUsername?: string | null
  configuredVaultContactUsername?: string | null
  businessAccountUsername?: string | null
  businessGiftsEnabled?: boolean
  businessGiftTransferEnabled?: boolean
}

type TelegramWebAppBridge = {
  Telegram?: {
    WebApp?: {
      openTelegramLink?: (url: string, options?: { force_request?: boolean }) => void
      showPopup?: (params: { title?: string; message: string; buttons?: Array<{ type?: string; text?: string; id?: string }> }) => void
      showAlert?: (message: string) => void
    }
  }
  TelegramWebviewProxy?: {
    postEvent?: (eventType: string, eventData: string) => void
  }
  external?: {
    notify?: (payload: string) => void
  }
}

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '')
/** Прямая ссылка на Mini App из BotFather: https://t.me/BotUser/webapp_short_name (без Query). Покупатель откроет её внутри Telegram, появится TG ID. */
const telegramMiniAppLinkBase =
  (import.meta.env.VITE_TELEGRAM_MINI_APP_LINK as string | undefined)?.trim().replace(/\/$/, '') ?? ''
/** Username бота (без @). Если задан — инвайт идёт через бота, который отдаёт кнопку Open App. */
const telegramBotUsername = (import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string | undefined)?.trim().replace(/^@/, '') ?? ''

/** Best-effort link to Mini App in Telegram: https://t.me/<bot>/<bot>. */
const inferredMiniAppLinkBase = telegramBotUsername ? `https://t.me/${telegramBotUsername}/${telegramBotUsername}` : ''
const INTRO_STORAGE_KEY = 'gifthub_intro_seen_v1'
const DEAL_JOIN_CLOSED_MESSAGE = 'В сделку войти нельзя!'
const PROFILE_BACKGROUND_SYNC_MIN_GAP_MS = 45_000
const SELLER_GIFT_SYNC_MIN_GAP_MS = 45_000
const PROFILE_SNAPSHOT_CACHE_PREFIX = 'gifthub_profile_snapshot_v2:'
const PROFILE_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function telegramFileUrl(fileId: string | undefined): string {
  return fileId ? `${apiBase}/telegram/file?fileId=${encodeURIComponent(fileId)}` : ''
}

function profileSnapshotCacheKey(tgId: string): string {
  return `${PROFILE_SNAPSHOT_CACHE_PREFIX}${tgId}`
}

function readCachedProfileSnapshot(tgId: string | null | undefined): ProfileSnapshot | null {
  if (!tgId || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(profileSnapshotCacheKey(tgId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { cachedAt?: number; profile?: Profile; gifts?: Gift[] }
    if (!parsed?.profile || !Array.isArray(parsed.gifts)) return null
    if (!parsed.cachedAt || Date.now() - parsed.cachedAt > PROFILE_SNAPSHOT_CACHE_TTL_MS) return null
    return { profile: parsed.profile, gifts: parsed.gifts }
  } catch {
    return null
  }
}

function writeCachedProfileSnapshot(tgId: string | null | undefined, snapshot: ProfileSnapshot): void {
  if (!tgId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      profileSnapshotCacheKey(tgId),
      JSON.stringify({ cachedAt: Date.now(), profile: snapshot.profile, gifts: snapshot.gifts }),
    )
  } catch {
    /* ignore */
  }
}

function mergeCachedProfileSnapshot(tgId: string | null | undefined, partial: Partial<ProfileSnapshot>): void {
  if (!tgId || typeof window === 'undefined') return
  const current = readCachedProfileSnapshot(tgId) ?? { profile: {}, gifts: [] }
  writeCachedProfileSnapshot(tgId, {
    profile: partial.profile ?? current.profile,
    gifts: partial.gifts ?? current.gifts,
  })
}

function openTelegramShare(inviteUrl: string): boolean {
  const shareUrl = `https://t.me/share/url?${new URLSearchParams({
    url: inviteUrl,
    text: 'Безопасные сделки в Telegram',
  }).toString()}`
  const bridge = window as unknown as TelegramWebAppBridge
  const sdkWebApp = WebApp as unknown as {
    openTelegramLink?: (url: string, options?: { force_request?: boolean }) => void
  }

  if (typeof sdkWebApp.openTelegramLink === 'function') {
    sdkWebApp.openTelegramLink(shareUrl, { force_request: true })
    return true
  }

  if (typeof bridge.Telegram?.WebApp?.openTelegramLink === 'function') {
    bridge.Telegram.WebApp.openTelegramLink(shareUrl, { force_request: true })
    return true
  }

  return false
}

function openTelegramInternalLink(link: string): boolean {
  const bridge = window as unknown as TelegramWebAppBridge
  const sdkWebApp = WebApp as unknown as {
    openTelegramLink?: (url: string, options?: { force_request?: boolean }) => void
  }

  if (typeof sdkWebApp.openTelegramLink === 'function') {
    sdkWebApp.openTelegramLink(link, { force_request: true })
    return true
  }

  if (typeof bridge.Telegram?.WebApp?.openTelegramLink === 'function') {
    bridge.Telegram.WebApp.openTelegramLink(link, { force_request: true })
    return true
  }

  const pathFull = (() => {
    try {
      const url = new URL(link)
      if (url.hostname !== 't.me') return null
      return `${url.pathname}${url.search}`
    } catch {
      return null
    }
  })()
  if (!pathFull) return false

  const eventData = { path_full: pathFull, force_request: true }
  if (typeof bridge.TelegramWebviewProxy?.postEvent === 'function') {
    bridge.TelegramWebviewProxy.postEvent('web_app_open_tg_link', JSON.stringify(eventData))
    return true
  }

  if (typeof bridge.external?.notify === 'function') {
    bridge.external.notify(JSON.stringify({ eventType: 'web_app_open_tg_link', eventData }))
    return true
  }

  return false
}

function showTelegramShareUnavailable() {
  const bridge = window as unknown as TelegramWebAppBridge
  const message = 'Telegram не открыл выбор чата. Откройте Mini App внутри Telegram и попробуйте еще раз.'
  try {
    bridge.Telegram?.WebApp?.showPopup?.({ title: 'Не удалось поделиться', message, buttons: [{ type: 'ok' }] })
  } catch {
    try {
      bridge.Telegram?.WebApp?.showAlert?.(message)
    } catch {
      window.alert(message)
    }
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, { cache: 'no-store' })
  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, { method: 'DELETE' })
  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

function dealReadPath(publicId: string, query?: { tgId?: string | null; join?: Role | null }): string {
  const params = new URLSearchParams()
  if (query?.tgId) params.set('tgId', query.tgId)
  if (query?.join) params.set('join', query.join)
  const qs = params.toString()
  return `/deals/${encodeURIComponent(publicId)}${qs ? `?${qs}` : ''}`
}

function dealStreamPath(publicId: string, tgId?: string | null): string {
  const params = new URLSearchParams()
  if (tgId) params.set('tgId', tgId)
  const qs = params.toString()
  return `/deals/${encodeURIComponent(publicId)}/stream${qs ? `?${qs}` : ''}`
}

/** User as Telegram passes it in initData / initDataUnsafe */
type TgWebUser = {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  photo_url?: string
}

function parseUserFromInitData(initData: string | undefined | null): TgWebUser | null {
  if (!initData || typeof initData !== 'string') return null
  try {
    const sp = new URLSearchParams(initData)
    const raw = sp.get('user')
    if (!raw) return null
    try {
      return JSON.parse(decodeURIComponent(raw)) as TgWebUser
    } catch {
      return JSON.parse(raw) as TgWebUser
    }
  } catch {
    return null
  }
}

/** Init data иногда лежит в hash/query как tgWebAppData (до/после инициализации WebApp). */
function tryParseInitDataFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const { hash, search } = window.location
    const h = hash.startsWith('#') ? hash.slice(1) : hash
    let params = new URLSearchParams(h)
    let raw = params.get('tgWebAppData')
    if (!raw) {
      const q = search.startsWith('?') ? search.slice(1) : search
      params = new URLSearchParams(q)
      raw = params.get('tgWebAppData')
    }
    if (!raw) return null
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  } catch {
    return null
  }
}

type WebAppLike = {
  initDataUnsafe?: { user?: unknown }
  initData?: string
}

function readUserFromWebApp(app: WebAppLike | null | undefined): TgWebUser | null {
  if (!app) return null
  try {
    const unsafe = app.initDataUnsafe?.user as TgWebUser | undefined
    if (unsafe && typeof unsafe.id === 'number') return unsafe
  } catch {
    /* ignore */
  }
  return parseUserFromInitData(app.initData)
}

/** initDataUnsafe / initData / tgWebAppData в URL — всё пробуем; также window.Telegram.WebApp. */
function getTelegramUser(): TgWebUser | null {
  const globalApp =
    typeof window !== 'undefined'
      ? (window as unknown as { Telegram?: { WebApp?: WebAppLike } }).Telegram?.WebApp
      : undefined
  const fromGlobal = readUserFromWebApp(globalApp)
  if (fromGlobal) return fromGlobal
  const fromSdk = readUserFromWebApp(WebApp as WebAppLike)
  if (fromSdk) return fromSdk
  return parseUserFromInitData(tryParseInitDataFromUrl())
}

function getTelegramUserId(): string | null {
  const u = getTelegramUser()
  return u?.id != null ? String(u.id) : null
}

function formatTelegramDisplayName(u: TgWebUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  if (u.username) return name ? `${name} (@${u.username})` : `@${u.username}`
  return name || `id ${u.id}`
}

function getTelegramHandle(u: TgWebUser | null): string {
  if (!u) return '@GiftHub'
  if (u.username) return `@${u.username}`
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return name || `ID ${u.id}`
}

function getTelegramInitial(u: TgWebUser | null): string {
  return (u?.first_name?.[0] ?? u?.username?.[0] ?? 'G').toUpperCase()
}

function shortAddress(address: string | undefined | null): string {
  const a = address?.trim()
  if (!a) return 'Wallet'
  if (a.length <= 12) return a
  return `${a.slice(0, 4)}...${a.slice(-4)}`
}

function hasEnoughProfileBalance(profile: Profile | null, currency: DealCurrency | undefined, totalBaseUnits: string | undefined): boolean | null {
  if (!currency || !totalBaseUnits) return null
  const available = profile?.balances?.[currency]?.availableBaseUnits
  if (!available) return null
  try {
    return BigInt(available) >= BigInt(totalBaseUnits)
  } catch {
    return null
  }
}

function walletErrorMessage(e: unknown, currency: DealCurrency): string {
  const raw = String((e as Error | undefined)?.message ?? e)
  if (/No enough funds/i.test(raw)) {
    return currency === 'USDT'
      ? 'На кошельке недостаточно средств: для USDT нужен баланс USDT и немного TON на комиссию сети.'
      : 'На кошельке недостаточно TON для этой суммы и комиссии сети. Попробуйте сумму меньше баланса кошелька.'
  }
  if (/Request to the wallet contains errors/i.test(raw)) {
    return `Кошелек отклонил запрос: ${raw}`
  }
  return raw
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

const PENDING_INVITE_STORAGE_KEY = 'gifthub_pending_invite_v1'

function parseInviteFromQueryString(raw: string): { deal: string; join: Role } | null {
  const trimmed = raw.startsWith('?') || raw.startsWith('#') ? raw.slice(1) : raw
  if (!trimmed) return null
  try {
    const params = new URLSearchParams(trimmed)
    const deal = params.get('deal')
    const join = params.get('join')
    if (!deal || (join !== 'seller' && join !== 'buyer')) return null
    return { deal: decodeURIComponent(deal), join }
  } catch {
    return null
  }
}

/** Инвайт в query, в hash (рядом с #tgWebAppData) или в sessionStorage после первого чтения. */
function readPendingInviteFromLocation(): { deal: string; join: Role } | null {
  if (typeof window === 'undefined') return null
  try {
    if (window.location.search) {
      const fromSearch = parseInviteFromQueryString(window.location.search)
      if (fromSearch) {
        try {
          sessionStorage.setItem(PENDING_INVITE_STORAGE_KEY, JSON.stringify(fromSearch))
        } catch {
          /* ignore */
        }
        return fromSearch
      }
    }
    const h = window.location.hash
    if (h.length > 1) {
      const fromHash = parseInviteFromQueryString(h.slice(1))
      if (fromHash) {
        try {
          sessionStorage.setItem(PENDING_INVITE_STORAGE_KEY, JSON.stringify(fromHash))
        } catch {
          /* ignore */
        }
        return fromHash
      }
    }
    const stored = sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY)
    if (stored) {
      const o = JSON.parse(stored) as { deal?: string; join?: string }
      if (o.deal && (o.join === 'buyer' || o.join === 'seller')) {
        return { deal: o.deal, join: o.join }
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Параметр startapp из Direct Link Mini App (Telegram ограничивает символы, поэтому используем _ вместо .):
 * b_<dealPublicId> = приглашён покупатель, s_<id> = приглашён продавец
 */
function parseStartAppInvite(startParam: string | undefined | null): { deal: string; join: Role } | null {
  if (!startParam || typeof startParam !== 'string') return null
  const m = /^([bs])_(.+)$/.exec(startParam.trim())
  if (!m?.[2]) return null
  const join: Role = m[1] === 'b' ? 'buyer' : 'seller'
  return { deal: m[2], join }
}

function readStartParamInvite(): { deal: string; join: Role } | null {
  try {
    const unsafe = (WebApp as { initDataUnsafe?: { start_param?: string } }).initDataUnsafe
    const fromSdk = parseStartAppInvite(unsafe?.start_param)
    if (fromSdk) return fromSdk
    const globalApp =
      typeof window !== 'undefined'
        ? (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } } }).Telegram
            ?.WebApp
        : undefined
    return parseStartAppInvite(globalApp?.initDataUnsafe?.start_param)
  } catch {
    return null
  }
}

function readInviteOnce(): { deal: string; join: Role } | null {
  const fromUrl = readPendingInviteFromLocation()
  if (fromUrl) return fromUrl
  return readStartParamInvite()
}

function stripInviteParamsFromUrl(): void {
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('deal')
    url.searchParams.delete('join')
    let h = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    if (h) {
      const p = new URLSearchParams(h)
      p.delete('deal')
      p.delete('join')
      const next = p.toString()
      url.hash = next ? `#${next}` : ''
    }
    const path = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState({}, document.title, path || '/')
  } catch {
    /* ignore */
  }
}

type TgPublicInfo = { firstName?: string; lastName?: string; username?: string }

function formatCounterpartyName(info: TgPublicInfo | null): string | null {
  if (!info) return null
  const name = [info.firstName, info.lastName].filter(Boolean).join(' ').trim()
  if (info.username) return name ? `${name} (@${info.username})` : `@${info.username}`
  return name || null
}

type TgPublicInfoWithPhoto = TgPublicInfo & { photoUrl?: string }

function getMyTelegramPublic(): TgPublicInfoWithPhoto | null {
  const u = getTelegramUser()
  if (!u) return null
  return {
    firstName: u.first_name,
    lastName: u.last_name,
    username: u.username,
    photoUrl: u.photo_url,
  }
}

function CounterpartyAvatar({ tgId, photoUrl, letter }: { tgId: string; photoUrl?: string; letter: string }) {
  const [fall, setFall] = useState(false)
  if (fall) {
    return <div className="tabAvatarPh">{letter}</div>
  }
  return (
    <img
      className="tabAvatar"
      src={photoUrl?.trim() ? photoUrl.trim() : `${apiBase}/profiles/${tgId}/avatar`}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFall(true)}
    />
  )
}

function CounterpartyCard({
  tgId,
  roleLabel,
  letter,
  initial,
}: {
  tgId: string
  roleLabel: string
  letter: string
  initial?: TgPublicInfoWithPhoto | null
}) {
  const [info, setInfo] = useState<TgPublicInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const out = await apiGet<{ telegram: TgPublicInfo | null }>(`/profiles/${tgId}/telegram`)
        if (!cancelled) setInfo(out.telegram ?? null)
      } catch {
        if (!cancelled) setInfo(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tgId])
  const nameLine = formatCounterpartyName(info)
  const initialLine = formatCounterpartyName(initial ?? null)
  const username = (info?.username ?? initial?.username)?.trim() || ''
  const handleUsernameClick = () => {
    if (!username) return
    try {
      void navigator.clipboard.writeText(`@${username}`)
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="tabInner">
      <CounterpartyAvatar tgId={tgId} photoUrl={initial?.photoUrl} letter={letter} />
      <div className="tabName">
        <div className="tabNameMain">{roleLabel}</div>
        {(nameLine || initialLine) && <div className="tabNameSub">{nameLine ?? initialLine}</div>}
        {username && (
          <div className="tabNameSub">
            <button type="button" className="usernameLink" onClick={handleUsernameClick} title="Скопировать @username">
              @{username}
            </button>
          </div>
        )}
        <div className="tabNameSub mono">ID {tgId}</div>
      </div>
    </div>
  )
}

function TelegramAvatar({ user }: { user: TgWebUser }) {
  const [stage, setStage] = useState<'unsafe' | 'proxy' | 'fall'>(() => (user.photo_url ? 'unsafe' : 'proxy'))
  if (stage === 'fall') {
    return <div className="tabAvatarPh">{user.first_name?.[0] ?? '?'}</div>
  }
  const src = stage === 'unsafe' ? user.photo_url! : `${apiBase}/profiles/${user.id}/avatar`
  return (
    <img
      className="tabAvatar"
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setStage((s) => (s === 'unsafe' ? 'proxy' : 'fall'))}
    />
  )
}

function ProfileAvatar({ user }: { user: TgWebUser | null }) {
  const [stage, setStage] = useState<'unsafe' | 'proxy' | 'fall'>(() => (user?.photo_url ? 'unsafe' : 'proxy'))
  if (!user || stage === 'fall') {
    return <div className="profileAvatarFallback">{getTelegramInitial(user)}</div>
  }
  const src = stage === 'unsafe' ? user.photo_url! : `${apiBase}/profiles/${user.id}/avatar`
  return (
    <img
      className="profileAvatar"
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setStage((s) => (s === 'unsafe' ? 'proxy' : 'fall'))}
    />
  )
}

function HandshakeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.5 12.2 10 9.8a2.4 2.4 0 0 1 3.2-.2l.8.7" />
      <path d="m14 10.3 2.4-2.1a2 2 0 0 1 2.7.1l1.4 1.4-4.6 5.5" />
      <path d="m3.5 9.7 1.4-1.4a2 2 0 0 1 2.7-.1l2.2 1.9" />
      <path d="m8.6 13.2 4.2 4.1a2 2 0 0 0 2.8 0l.4-.4a1.4 1.4 0 0 0 0-2l-2.9-2.8" />
      <path d="m6 14.4 2.2 2.2" />
      <path d="m4.2 11.6 3.9 4" />
      <path d="m17.8 11.7-3.1 3.1" />
    </svg>
  )
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </svg>
  )
}

function getStatusLabel(status?: DealStatus): string {
  switch (status) {
    case 'WAITING_FOR_BUYER':
      return 'Ожидаем второго участника'
    case 'WAITING_FOR_SELLER':
      return 'Ожидаем продавца'
    case 'WAITING_FOR_PRICE':
      return 'Ожидаем цену от продавца'
    case 'WAITING_FOR_PAYMENT':
      return 'Ожидаем оплату покупателя'
    case 'PAYMENT_CONFIRMED':
      return 'Оплата подтверждена. Ожидаем выбор подарка'
    case 'GIFT_RESERVED':
      return 'Подарок выбран. Можно завершать сделку'
    case 'WAITING_FOR_MANUAL_GIFT_TRANSFER':
      return 'Ожидаем ручной Transfer подарка'
    case 'COMPLETED':
      return 'Сделка завершена'
    default:
      return status ?? '-'
  }
}

function giftStatusLabel(status: Gift['status']): string {
  switch (status) {
    case 'AVAILABLE':
      return 'В инвентаре'
    case 'RESERVED':
      return 'Зарезервирован'
    case 'TRANSFER_PENDING':
      return 'Ожидает ручной Transfer'
    case 'WITHDRAW_PENDING':
      return 'Вывод: ожидаем transfer'
    case 'WITHDRAWN':
      return 'Выведен'
    case 'SENT':
      return 'Отправлен'
    default:
      return status
  }
}

function giftNumberLabel(gift: Gift): string {
  if (gift.telegramGiftNumber != null) return `#${gift.telegramGiftNumber}`
  const m = /(?:-|#)(\d{3,})$/.exec(gift.telegramGiftName ?? gift.title ?? gift.giftId)
  return m ? `#${m[1]}` : shortAddress(gift.giftId)
}

function giftCardStyle(gift: Gift): CSSProperties {
  return {
    '--gift-center': gift.backdropCenterColor || '#3aa8d8',
    '--gift-edge': gift.backdropEdgeColor || '#c05288',
    '--gift-symbol': gift.backdropSymbolColor || 'rgba(255, 255, 255, 0.18)',
    '--gift-text': gift.backdropTextColor || '#ffffff',
  } as CSSProperties
}

function GiftArtwork({ gift }: { gift: Gift }) {
  const imageSrc = telegramFileUrl(gift.telegramImageFileId)
  const fallback = (gift.title || gift.model || '?').trim().slice(0, 1).toUpperCase()
  return (
    <div className="giftArtwork" style={giftCardStyle(gift)}>
      <div className="giftArtworkPattern" />
      {imageSrc && gift.telegramImageFileKind === 'video' ? (
        <video className="giftArtworkImage" src={imageSrc} autoPlay muted loop playsInline />
      ) : imageSrc ? (
        <img className="giftArtworkImage" src={imageSrc} alt="" loading="lazy" />
      ) : (
        <div className="giftArtworkFallback">{fallback}</div>
      )}
      <div className="giftArtworkCaption">
        <div>{gift.title || gift.telegramGiftName || 'Telegram Gift'}</div>
        <span>{giftNumberLabel(gift)}</span>
      </div>
    </div>
  )
}

function App() {
  const wallet = useTonWallet()
  const walletFriendlyAddress = useTonAddress(true)
  const [tonConnectUI] = useTonConnectUI()

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [stepWalletOk, setStepWalletOk] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(INTRO_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [stepRolePicked, setStepRolePicked] = useState(false)
  const [role, setRole] = useState<Role>('seller')
  const [activePage, setActivePage] = useState<AppPage>('deal')

  const [pendingInvite, setPendingInvite] = useState<{ deal: string; join: Role } | null>(() =>
    typeof window !== 'undefined' ? readInviteOnce() : null,
  )
  const [sellerTgId, setSellerTgId] = useState('')
  const [buyerTgId, setBuyerTgId] = useState('')
  const [deal, setDeal] = useState<Deal | null>(null)
  const [tgUserState, setTgUserState] = useState<TgWebUser | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const [tgTick, setTgTick] = useState(0)
  const [dealHistory, setDealHistory] = useState<DealHistoryItem[]>([])

  const [currency, setCurrency] = useState<DealCurrency>('TON')
  const [price, setPrice] = useState('10')

  const [profile, setProfile] = useState<Profile | null>(null)
  const [depositCurrency, setDepositCurrency] = useState<DealCurrency>('TON')
  const [depositAmount, setDepositAmount] = useState('0')
  const [lastDepositId, setLastDepositId] = useState('')

  const [sellerGifts, setSellerGifts] = useState<Gift[]>([])
  const [profileGifts, setProfileGifts] = useState<Gift[]>([])
  const [selectedGiftId, setSelectedGiftId] = useState('')
  const [transferSessionExpiresAt, setTransferSessionExpiresAt] = useState<number | null>(null)
  const [giftDetails, setGiftDetails] = useState<Gift | null>(null)
  const profileSnapshotInFlightRef = useRef<Record<string, Promise<ProfileSnapshot> | undefined>>({})
  const profileSyncLastAtRef = useRef<Record<string, number>>({})
  const profileSyncInFlightRef = useRef<Record<string, Promise<void> | undefined>>({})
  const sellerGiftSyncLastAtRef = useRef<Record<string, number>>({})
  const sellerGiftSyncInFlightRef = useRef<Record<string, Promise<void> | undefined>>({})

  const buyerWalletAddress = wallet?.account?.address
  const currentDealId = deal?.publicId ?? ''
  const currentProfileTgId = getTelegramUserId() ?? (role === 'seller' ? sellerTgId : buyerTgId)
  const isSeller = role === 'seller'
  const isBuyer = role === 'buyer'
  const counterpartJoined = Boolean(deal && (isSeller ? deal.buyerTgId : deal.sellerTgId))
  const currentUserIsDealCreator = Boolean(deal?.creatorTgId && currentProfileTgId && deal.creatorTgId === currentProfileTgId)
  const buyerDealBalanceDisplay = deal?.currency ? (profile?.balances?.[deal.currency]?.availableDisplay ?? null) : null
  const buyerDealBalanceEnough = hasEnoughProfileBalance(profile, deal?.currency, deal?.totalBaseUnits)

  const inviteUrl = useMemo(() => {
    const id = deal?.publicId
    if (!id || typeof window === 'undefined') return ''
    const inviteeRole: Role = isSeller ? 'buyer' : 'seller'
    const startAppPayload = `${inviteeRole === 'buyer' ? 'b' : 's'}_${id}`
    if (telegramMiniAppLinkBase) {
      const q = telegramMiniAppLinkBase.includes('?') ? '&' : '?'
      return `${telegramMiniAppLinkBase}${q}startapp=${encodeURIComponent(startAppPayload)}`
    }
    if (inferredMiniAppLinkBase) {
      const q = inferredMiniAppLinkBase.includes('?') ? '&' : '?'
      return `${inferredMiniAppLinkBase}${q}startapp=${encodeURIComponent(startAppPayload)}`
    }
    // Fallback: open bot chat (will require user action: Start / Open App).
    if (telegramBotUsername) {
      const payload = `${inviteeRole === 'buyer' ? 'b' : 's'}_${id}`
      return `https://t.me/${telegramBotUsername}?start=${encodeURIComponent(payload)}`
    }
    const path = window.location.pathname || '/'
    const base = `${window.location.origin}${path === '/' ? '' : path}`.replace(/\/$/, '') || window.location.origin
    return `${base}/?deal=${encodeURIComponent(id)}&join=${inviteeRole}`
  }, [deal?.publicId, isSeller])

  const showDealWorkspace = useMemo(
    () => Boolean(deal && counterpartJoined && deal.escrowStartedAt),
    [deal, counterpartJoined],
  )

  const dealGiftOptions = useMemo(
    () => sellerGifts.filter((g) => g.status === 'AVAILABLE' || g.giftId === deal?.reservedGiftId),
    [sellerGifts, deal?.reservedGiftId],
  )
  const reservedDealGift = useMemo(
    () => (deal?.reservedGiftId ? sellerGifts.find((g) => g.giftId === deal.reservedGiftId) ?? null : null),
    [sellerGifts, deal?.reservedGiftId],
  )

  async function refreshDealHistory(tgId = currentProfileTgId) {
    if (!tgId) return
    const out = await apiGet<{ deals: DealHistoryItem[] }>(`/profiles/${encodeURIComponent(tgId)}/deals`)
    setDealHistory(out.deals.filter((x) => x?.publicId && (x.myRole === 'seller' || x.myRole === 'buyer')))
  }

  async function saveDealToHistory(publicId: string, myRole: Role) {
    if (!publicId) return
    const tgId = getTelegramUserId() ?? currentProfileTgId
    const now = new Date().toISOString()
    setDealHistory((prev) => [{ publicId, myRole, updatedAt: now }, ...prev.filter((d) => d.publicId !== publicId)].slice(0, 20))
    if (tgId) await refreshDealHistory(tgId)
  }

  async function removeDealFromHistory(item: DealHistoryItem) {
    const tgId = getTelegramUserId() ?? currentProfileTgId
    if (!tgId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
    const ok = window.confirm('Вы действительно хотите удалить сделку?')
    if (!ok) return
    const out = await apiDelete<{ ok: boolean; deals: DealHistoryItem[] }>(
      `/profiles/${encodeURIComponent(tgId)}/deals/${encodeURIComponent(item.publicId)}`,
    )
    setDealHistory(out.deals.filter((x) => x?.publicId && (x.myRole === 'seller' || x.myRole === 'buyer')))
    if (deal?.publicId === item.publicId) {
      setDeal(null)
      setStepRolePicked(false)
    }
  }

  useEffect(() => {
    if (!stepWalletOk || !currentProfileTgId) return
    void refreshDealHistory(currentProfileTgId).catch(() => undefined)
  }, [stepWalletOk, currentProfileTgId])

  /** Live-синхронизация сделки: SSE с бэкенда; при обрыве — polling (два клиента видят лобби почти сразу). */
  useEffect(() => {
    if (!deal?.publicId) return

    const id = deal.publicId
    const viewerTgId = currentProfileTgId
    let cancelled = false

    const applyRemote = (d: Deal | null | undefined) => {
      if (cancelled || !d) return
      setDeal(d)
    }
    const closeInaccessibleDeal = (message: string) => {
      if (cancelled) return
      setDeal(null)
      setError(message)
    }

    const pullOnce = async () => {
      try {
        const out = await apiGet<{ deal: Deal | null }>(dealReadPath(id, { tgId: viewerTgId }))
        applyRemote(out.deal ?? null)
      } catch (e) {
        const message = String((e as Error)?.message ?? e)
        if (message === DEAL_JOIN_CLOSED_MESSAGE) closeInaccessibleDeal(message)
      }
    }

    let pollTimer: number | null = null
    const stopPoll = () => {
      if (pollTimer != null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
    }
    const startPoll = () => {
      if (pollTimer != null) return
      void pullOnce()
      pollTimer = window.setInterval(() => void pullOnce(), 750)
    }

    let es: EventSource | null = null
    try {
      es = new EventSource(`${apiBase}${dealStreamPath(id, viewerTgId)}`)
      es.onopen = () => stopPoll()
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { deal: Deal | null; error?: string }
          if (msg.error) {
            closeInaccessibleDeal(msg.error)
            return
          }
          applyRemote(msg.deal ?? null)
        } catch {
          /* ignore */
        }
      }
      es.onerror = () => startPoll()
    } catch {
      startPoll()
    }

    const connectWatch = window.setTimeout(() => {
      if (cancelled || !es) return
      if (es.readyState !== EventSource.OPEN) startPoll()
    }, 2800)

    void pullOnce()

    const onVis = () => {
      if (document.visibilityState === 'visible') void pullOnce()
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      cancelled = true
      window.clearTimeout(connectWatch)
      document.removeEventListener('visibilitychange', onVis)
      es?.close()
      stopPoll()
    }
  }, [deal?.publicId, currentProfileTgId])

  useEffect(() => {
    try {
      WebApp.expand()
    } catch {
      // local browser mode
    }
  }, [])

  /** Подставить реальный TG ID после появления initData и прохождения шагов */
  useEffect(() => {
    const id = getTelegramUserId()
    if (!id || !stepWalletOk || !stepRolePicked) return
    if (role === 'seller') setSellerTgId(id)
    else setBuyerTgId(id)
  }, [stepWalletOk, stepRolePicked, role])

  /** Кэш профиля Telegram для UI (обновляем при тиках — initData может прийти позже). */
  useEffect(() => {
    setTgUserState(getTelegramUser())
  }, [tgTick, stepWalletOk, stepRolePicked])

  /** initData / startapp приходят к Telegram позже первого кадра — подхватываем инвайт с задержкой */
  useEffect(() => {
    const inv = readStartParamInvite()
    if (!inv) return
    try {
      sessionStorage.setItem(PENDING_INVITE_STORAGE_KEY, JSON.stringify(inv))
    } catch {
      /* ignore */
    }
    setPendingInvite((prev) => prev ?? inv)
  }, [tgTick])

  useEffect(() => {
    const t1 = window.requestAnimationFrame(() => setTgTick((n) => n + 1))
    const t2 = window.setTimeout(() => setTgTick((n) => n + 1), 50)
    const t3 = window.setTimeout(() => setTgTick((n) => n + 1), 200)
    const t4 = window.setTimeout(() => setTgTick((n) => n + 1), 500)
    const t5 = window.setTimeout(() => setTgTick((n) => n + 1), 1200)
    return () => {
      window.cancelAnimationFrame(t1)
      window.clearTimeout(t2)
      window.clearTimeout(t3)
      window.clearTimeout(t4)
      window.clearTimeout(t5)
    }
  }, [])

  async function withBusy(fn: () => Promise<void>) {
    try {
      setError(null)
      setBusy(true)
      await fn()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function loadDealByPublicId(
    publicId: string,
    options?: { tgId?: string | null; join?: Role | null; commit?: boolean },
  ): Promise<Deal | null> {
    const out = await apiGet<{ deal: Deal | null }>(dealReadPath(publicId, { tgId: options?.tgId, join: options?.join }))
    if (options?.commit !== false) setDeal(out.deal)
    return out.deal
  }

  async function loadProfileSnapshot(tgId: string): Promise<ProfileSnapshot> {
    const existing = profileSnapshotInFlightRef.current[tgId]
    if (existing) return existing
    const task = apiGet<ProfileSnapshot>(`/profiles/${tgId}/snapshot`).finally(() => {
      if (profileSnapshotInFlightRef.current[tgId] === task) delete profileSnapshotInFlightRef.current[tgId]
    })
    profileSnapshotInFlightRef.current[tgId] = task
    return task
  }

  function applyMyProfileSnapshot(snapshot: ProfileSnapshot, tgId: string, opts?: { cache?: boolean }) {
    setProfile(snapshot.profile)
    setProfileGifts(snapshot.gifts)
    if (opts?.cache !== false) writeCachedProfileSnapshot(tgId, snapshot)
    if (role === 'seller' && sellerTgId === tgId) {
      setSellerGifts(snapshot.gifts)
    }
  }

  function startProfileBackgroundSync(tgId: string, opts?: { force?: boolean }): Promise<void> | undefined {
    const now = Date.now()
    const lastAt = profileSyncLastAtRef.current[tgId] ?? 0
    if (!opts?.force && now - lastAt < PROFILE_BACKGROUND_SYNC_MIN_GAP_MS) return profileSyncInFlightRef.current[tgId]
    const existing = profileSyncInFlightRef.current[tgId]
    if (existing) return existing

    profileSyncLastAtRef.current[tgId] = now
    const task = (async () => {
      const [recoverOut, syncOut] = await Promise.all([
        apiPost<{ recovered: number; profile: Profile }>(`/profiles/${tgId}/deposits/recover`, {}).catch(() => null),
        apiPost<{ added: number; gifts: Gift[]; vaultAddress: string | null }>('/gifts/sync', { ownerTgId: tgId, limit: 80 }).catch(() => null),
      ])

      if (recoverOut?.profile) {
        setProfile(recoverOut.profile)
        mergeCachedProfileSnapshot(tgId, { profile: recoverOut.profile })
      }
      if (syncOut?.gifts) {
        setProfileGifts(syncOut.gifts)
        mergeCachedProfileSnapshot(tgId, { gifts: syncOut.gifts })
      }
      if (role === 'seller' && sellerTgId === tgId) {
        if (syncOut?.gifts) setSellerGifts(syncOut.gifts)
      }
    })().finally(() => {
      if (profileSyncInFlightRef.current[tgId] === task) delete profileSyncInFlightRef.current[tgId]
    })
    profileSyncInFlightRef.current[tgId] = task
    return task
  }

  function startSellerGiftSync(tgId: string, opts?: { force?: boolean }): Promise<void> | undefined {
    const now = Date.now()
    const lastAt = sellerGiftSyncLastAtRef.current[tgId] ?? 0
    if (!opts?.force && now - lastAt < SELLER_GIFT_SYNC_MIN_GAP_MS) return sellerGiftSyncInFlightRef.current[tgId]
    const existing = sellerGiftSyncInFlightRef.current[tgId]
    if (existing) return existing

    sellerGiftSyncLastAtRef.current[tgId] = now
    const task = apiPost<{ added: number; gifts: Gift[]; vaultAddress: string | null }>('/gifts/sync', { ownerTgId: tgId, limit: 80 })
      .then((out) => {
        if (sellerTgId === tgId) setSellerGifts(out.gifts)
        if (currentProfileTgId === tgId) {
          setProfileGifts(out.gifts)
          mergeCachedProfileSnapshot(tgId, { gifts: out.gifts })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (sellerGiftSyncInFlightRef.current[tgId] === task) delete sellerGiftSyncInFlightRef.current[tgId]
      })
    sellerGiftSyncInFlightRef.current[tgId] = task
    return task
  }

  async function refreshSellerData(opts?: { sync?: 'none' | 'background' | 'await'; forceSync?: boolean }) {
    if (!sellerTgId) return
    const snapshot = await loadProfileSnapshot(sellerTgId)
    setSellerGifts(snapshot.gifts)
    if (currentProfileTgId === sellerTgId) applyMyProfileSnapshot(snapshot, sellerTgId)

    const syncMode = opts?.sync ?? 'background'
    const syncTask = syncMode === 'none' ? undefined : startSellerGiftSync(sellerTgId, { force: opts?.forceSync })
    if (syncMode === 'await') await syncTask
  }

  async function refreshMyProfile(opts?: { sync?: 'none' | 'background' | 'await'; forceSync?: boolean }) {
    if (!currentProfileTgId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
    const tgId = currentProfileTgId
    const cached = readCachedProfileSnapshot(tgId)
    if (cached) applyMyProfileSnapshot(cached, tgId, { cache: false })
    const snapshot = await loadProfileSnapshot(tgId)
    applyMyProfileSnapshot(snapshot, tgId)

    const syncMode = opts?.sync ?? 'background'
    const syncTask = syncMode === 'none' ? undefined : startProfileBackgroundSync(tgId, { force: opts?.forceSync })
    if (syncMode === 'await') await syncTask
  }

  async function joinDealAsBuyer() {
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/join`, { tgId: buyerTgId, role: 'buyer', telegram: getMyTelegramPublic() ?? undefined })
    setDeal(out.deal)
  }

  function markIntroSeen() {
    try {
      window.localStorage.setItem(INTRO_STORAGE_KEY, '1')
    } catch {
      /* ignore */
    }
    setStepWalletOk(true)
  }

  async function enterApp() {
    const addr = wallet?.account?.address
    const tgFromApp = getTelegramUserId()
    if (addr && tgFromApp != null) {
      await apiPost<{ profile: Profile }>('/profiles/wallet', {
        tgId: tgFromApp,
        walletAddress: addr,
      })
    }

    const inv = pendingInvite ?? readStartParamInvite()
    if (inv) {
      const myId = getTelegramUserId()
      if (!myId) {
        setDeal(null)
        throw new Error('Не удалось прочитать Telegram ID — откройте ссылку внутри Telegram Mini App')
      }
      const loaded = await loadDealByPublicId(inv.deal, { tgId: myId, join: inv.join, commit: false })
      if (!loaded) {
        throw new Error(
          `Сделка по ссылке не найдена на сервере (${apiBase}). На Vercel переменная VITE_API_BASE_URL должна быть РОВНО URL вашего сервиса на Render (например https://gifthub-backend.onrender.com). Убедитесь, что на Render заданы UPSTASH_REDIS_* и ссылка полная.`,
        )
      }
      const isExistingSeller = loaded.sellerTgId === myId
      const isExistingBuyer = loaded.buyerTgId === myId
      const requestedSlotOwner = inv.join === 'buyer' ? loaded.buyerTgId : loaded.sellerTgId
      if (!isExistingSeller && !isExistingBuyer && requestedSlotOwner && requestedSlotOwner !== myId) {
        setDeal(null)
        throw new Error(DEAL_JOIN_CLOSED_MESSAGE)
      }
      if (!isExistingSeller && !isExistingBuyer && loaded.sellerTgId && loaded.buyerTgId) {
        setDeal(null)
        throw new Error(DEAL_JOIN_CLOSED_MESSAGE)
      }

      setDeal(loaded)
      setRole(inv.join)
      if (isExistingSeller) {
        setRole('seller')
        setSellerTgId(myId)
      } else if (isExistingBuyer) {
        setRole('buyer')
        setBuyerTgId(myId)
      } else {
        setRole(inv.join)
      }

      if (
        inv.join === 'buyer' &&
        !loaded.buyerTgId &&
        loaded.sellerTgId !== myId &&
        (loaded.status === 'WAITING_FOR_BUYER' || loaded.status === 'WAITING_FOR_PRICE')
      ) {
        const joined = await apiPost<{ deal: Deal }>(`/deals/${loaded.publicId}/join`, { tgId: myId, role: 'buyer', telegram: getMyTelegramPublic() ?? undefined })
        setDeal(joined.deal)
        setBuyerTgId(myId)
        await saveDealToHistory(joined.deal.publicId, 'buyer')
      }
      if (
        inv.join === 'seller' &&
        !loaded.sellerTgId &&
        loaded.buyerTgId !== myId &&
        loaded.status === 'WAITING_FOR_SELLER'
      ) {
        const joined = await apiPost<{ deal: Deal }>(`/deals/${loaded.publicId}/join`, { tgId: myId, role: 'seller', telegram: getMyTelegramPublic() ?? undefined })
        setDeal(joined.deal)
        setSellerTgId(myId)
        await saveDealToHistory(joined.deal.publicId, 'seller')
      }
      try {
        sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY)
      } catch {
        /* ignore */
      }
      stripInviteParamsFromUrl()
      setPendingInvite(null)
      markIntroSeen()
      setStepRolePicked(true)
      return
    }

    markIntroSeen()
  }

  useEffect(() => {
    if (!stepWalletOk || stepRolePicked || !pendingInvite) return
    void withBusy(enterApp)
  }, [stepWalletOk, stepRolePicked, pendingInvite])

  async function copyInviteLink() {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopyHint('Ссылка скопирована')
      setTimeout(() => setCopyHint(null), 2000)
    } catch {
      setCopyHint('Не удалось скопировать — выделите ссылку вручную')
      setTimeout(() => setCopyHint(null), 3000)
    }
  }

  function shareInviteLink() {
    if (!inviteUrl) return
    try {
      const opened = openTelegramShare(inviteUrl)
      if (!opened) throw new Error('openTelegramLink is not available')
      setCopyHint('Выберите чат в Telegram и отправьте ссылку.')
      setTimeout(() => setCopyHint(null), 3000)
    } catch {
      showTelegramShareUnavailable()
    }
  }

  function openTelegramUsername(username: string | null | undefined) {
    const u = (username ?? '').trim().replace(/^@/, '')
    if (!u) return
    const link = `https://t.me/${u}`
    if (!openTelegramInternalLink(link)) {
      showTelegramShareUnavailable()
    }
  }

  function openTelegramGift(gift: Gift) {
    const slug = gift.telegramGiftName?.trim()
    if (!slug) return
    const link = `https://t.me/nft/${encodeURIComponent(slug)}`
    if (!openTelegramInternalLink(link)) {
      showTelegramShareUnavailable()
    }
  }

  async function startDealEscrow() {
    if (!deal?.publicId) return
    if (!currentProfileTgId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
    const out = await apiPost<{ deal: Deal }>(`/deals/${deal.publicId}/start`, { tgId: currentProfileTgId })
    setDeal(out.deal)
  }

  function renderParticipantRow(tabRole: Role) {
    const me = tgUserState ?? getTelegramUser()
    const myId = me?.id != null ? String(me.id) : getTelegramUserId()

    if (role === tabRole) {
      if (me) {
        return (
          <div className="tabInner">
            <TelegramAvatar key={me.id} user={me} />
            <div className="tabName">
              <div className="tabNameMain">{tabRole === 'seller' ? 'Продавец' : 'Покупатель'}</div>
              <div className="tabNameSub">{formatTelegramDisplayName(me)}</div>
              <div className="tabNameSub mono">ID {me.id}</div>
            </div>
            <span className="tabYou">вы</span>
          </div>
        )
      }
      return (
        <div className="tabInner">
          <div className="tabName">
            <div className="tabNameMain">{tabRole === 'seller' ? 'Продавец' : 'Покупатель'}</div>
            <div className="tabNameSub mono">{myId ? `ID ${myId}` : 'Откройте из Telegram — тогда появятся имя и фото'}</div>
          </div>
        </div>
      )
    }

    if (tabRole === 'seller') {
      const id = deal?.sellerTgId ?? sellerTgId
      if (id) {
        return <CounterpartyCard tgId={id} roleLabel="Продавец" letter="P" initial={deal?.sellerTelegram ?? null} />
      }
    } else {
      const id = deal?.buyerTgId ?? buyerTgId
      if (id) {
        return <CounterpartyCard tgId={id} roleLabel="Покупатель" letter="B" initial={deal?.buyerTelegram ?? null} />
      }
    }

    return (
      <div className="tabInner">
        <div className="tabName">
          <div className="tabNameMain">{tabRole === 'seller' ? 'Продавец' : 'Покупатель'}</div>
          <div className="tabNameSub">подключится по ссылке</div>
        </div>
      </div>
    )
  }

  async function startProfileGiftDepositSession() {
    if (!currentProfileTgId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
    const out = await apiPost<GiftDepositSessionStart>('/gifts/deposit/session/start', { ownerTgId: currentProfileTgId, ttlSec: 600 })
    setTransferSessionExpiresAt(out.expiresAtMs)
    const contact = out.vaultContactUsername ?? out.businessAccountUsername ?? out.configuredVaultContactUsername ?? out.botUsername ?? telegramBotUsername
    openTelegramUsername(contact)
    setCopyHint(
      contact
        ? `Открыл @${contact.replace(/^@/, '')}. Сделайте Transfer подарка туда — инвентарь обновится автоматически.`
        : 'Сессия создана. Настройте vault-контакт или Telegram Business connection на backend.',
    )
    setTimeout(() => setCopyHint(null), 6000)
  }

  async function depositBalance() {
    if (!currentProfileTgId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
    if (!wallet) throw new Error('Подключите кошелёк')
    const normalizedAmount = depositAmount.trim().replace(',', '.')
    const amountNumber = Number(normalizedAmount)
    if (!normalizedAmount || !Number.isFinite(amountNumber) || amountNumber <= 0) throw new Error('Введите сумму пополнения')
    const depositOut = await apiPost<DepositPayRequest>(`/profiles/${currentProfileTgId}/deposit/pay-request`, {
      currency: depositCurrency,
      amount: normalizedAmount,
      walletAddress: wallet.account.address,
    })
    setLastDepositId(depositOut.depositId)
    try {
      await tonConnectUI.sendTransaction(depositOut.tonconnect)
    } catch (e) {
      throw new Error(walletErrorMessage(e, depositCurrency))
    }
    setCopyHint(`Транзакция на ${depositOut.totalDisplay} ${depositOut.currency} отправлена. Проверяем блокчейн...`)
    const confirmed = await confirmDepositBalance(depositOut.depositId, { quietPending: true })
    if (!confirmed) {
      setCopyHint('Транзакция отправлена, но сеть еще не показала ее боту. Нажмите «Проверить пополнение» через 20-60 секунд.')
      setTimeout(() => setCopyHint(null), 6000)
    }
  }

  async function confirmDepositBalance(depositId = lastDepositId, opts?: { quietPending?: boolean }): Promise<boolean> {
    if (!currentProfileTgId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
    if (!depositId) throw new Error('Нет активного пополнения для проверки')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await sleep(2500)
      const out = await apiPost<DepositConfirmResponse>(`/profiles/${currentProfileTgId}/deposits/${depositId}/confirm`, { scanLimit: 100 })
      setProfile(out.profile)
      if (out.matched) {
        setLastDepositId('')
        setCopyHint(`Баланс пополнен на ${out.deposit.amountDisplay} ${out.deposit.currency}`)
        setTimeout(() => setCopyHint(null), 3500)
        await refreshMyProfile().catch(() => undefined)
        return true
      }
    }

    if (!opts?.quietPending) {
      setCopyHint('Платеж пока не найден в блокчейне. Попробуйте проверить еще раз чуть позже.')
      setTimeout(() => setCopyHint(null), 4500)
    }
    return false
  }

  async function withdrawBalance() {
    if (!currentProfileTgId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
    if (!wallet) throw new Error('Подключите кошелёк')
    const normalizedAmount = depositAmount.trim().replace(',', '.')
    const amountNumber = Number(normalizedAmount)
    if (!normalizedAmount || !Number.isFinite(amountNumber) || amountNumber <= 0) throw new Error('Введите сумму вывода')
    let out: WithdrawBalanceRequest
    try {
      out = await apiPost<WithdrawBalanceRequest>(`/profiles/${currentProfileTgId}/withdraw/request`, {
        currency: depositCurrency,
        amount: normalizedAmount,
        walletAddress: wallet.account.address,
      })
    } catch (e) {
      await refreshMyProfile().catch(() => undefined)
      throw e
    }
    setProfile(out.profile)
    setCopyHint(
      out.manualWithdrawalRequired
        ? `Заявка #${out.withdrawalId} на вывод ${out.amountDisplay} ${out.currency} создана. Средства зарезервированы для выплаты на ${shortAddress(walletFriendlyAddress || out.destinationWallet)}.`
        : `Вывод ${out.amountDisplay} ${out.currency} отправлен на ${shortAddress(walletFriendlyAddress || out.destinationWallet)}.`,
    )
    setTimeout(() => setCopyHint(null), 4500)
  }

  async function withdrawProfileGift(giftId: string) {
    if (!currentProfileTgId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
    const requested = await apiPost<{ manualTransferRequired?: boolean }>('/gifts/withdraw/request', { ownerTgId: currentProfileTgId, giftId })
    if (requested.manualTransferRequired) {
      setCopyHint('Заявка создана: переведите подарок вручную с vault-аккаунта и подтвердите через админ-endpoint')
      setTimeout(() => setCopyHint(null), 4000)
      await refreshMyProfile()
      return
    }
    await apiPost('/gifts/withdraw/confirm', { ownerTgId: currentProfileTgId, giftId, limit: 120 })
    setCopyHint('Подарок отправлен обратно в Telegram')
    setTimeout(() => setCopyHint(null), 2500)
    await refreshMyProfile()
  }

  async function setDealPrice() {
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/price`, {
      sellerTgId,
      currency,
      price,
    })
    setDeal(out.deal)
  }

  async function pay() {
    if (!deal?.currency) throw new Error('Цена еще не задана')
    if (deal.currency === 'TON') {
      const out = await apiPost<PayRequestTon>(`/deals/${currentDealId}/pay-request`, { buyerTgId, buyerWalletAddress })
      try {
        await tonConnectUI.sendTransaction(out.tonconnect)
      } catch (e) {
        throw new Error(walletErrorMessage(e, 'TON'))
      }
      return
    }
    const out = await apiPost<PayRequestUsdt>(`/deals/${currentDealId}/pay-request`, {
      buyerTgId,
      buyerWalletAddress,
    })
    try {
      await tonConnectUI.sendTransaction(out.tonconnect)
    } catch (e) {
      throw new Error(walletErrorMessage(e, 'USDT'))
    }
  }

  async function payFromBalance() {
    if (!currentDealId) throw new Error('Сделка не загружена')
    if (!buyerTgId) throw new Error('Не удалось определить Telegram ID покупателя')
    const out = await apiPost<BalancePaymentResponse>(`/deals/${currentDealId}/payment/from-balance`, { buyerTgId })
    setDeal(out.deal)
    setProfile(out.profile)
    setCopyHint('Оплата зарезервирована с внутреннего баланса')
    setTimeout(() => setCopyHint(null), 3500)
  }

  async function autoConfirmPayment() {
    const out = await apiPost<{ matched: boolean; reason?: string; deal?: Deal }>(
      `/deals/${currentDealId}/payment/auto-confirm`,
      { buyerTgId, scanLimit: 30 },
    )
    if (out.deal) setDeal(out.deal)
    if (!out.matched) throw new Error(out.reason ?? 'Платеж пока не найден')
  }

  async function reserveGift(giftId: string) {
    if (!giftId) throw new Error('Сначала выберите подарок')
    setSelectedGiftId(giftId)
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/gift/reserve`, {
      sellerTgId,
      giftId,
    })
    setDeal(out.deal)
    await refreshSellerData()
  }

  async function releaseDeal() {
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/release`, {
      sellerTgId,
    })
    setDeal(out.deal)
    await refreshSellerData()
  }

  useEffect(() => {
    if (!showDealWorkspace || !sellerTgId) return
    void refreshSellerData({ sync: isSeller ? 'background' : 'none' })
  }, [showDealWorkspace, isSeller, sellerTgId, deal?.reservedGiftId])

  useEffect(() => {
    if (!stepWalletOk || !currentProfileTgId) return
    const tgId = currentProfileTgId
    let cancelled = false
    const cached = readCachedProfileSnapshot(tgId)
    if (cached) applyMyProfileSnapshot(cached, tgId, { cache: false })

    void loadProfileSnapshot(tgId)
      .then((snapshot) => {
        if (!cancelled) applyMyProfileSnapshot(snapshot, tgId)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [stepWalletOk, currentProfileTgId])

  useEffect(() => {
    if (!stepWalletOk || activePage !== 'profile' || !currentProfileTgId) return
    let cancelled = false
    const pull = (opts?: { forceSync?: boolean }) => {
      if (cancelled) return
      void refreshMyProfile(opts?.forceSync ? { forceSync: true } : undefined).catch(() => undefined)
    }
    pull()
    const timer = window.setInterval(pull, 15000)
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const transferSessionActive = transferSessionExpiresAt != null && transferSessionExpiresAt > Date.now()
        pull({ forceSync: transferSessionActive })
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [stepWalletOk, activePage, currentProfileTgId, transferSessionExpiresAt])

  useEffect(() => {
    if (!stepWalletOk || activePage !== 'deal' || !isBuyer || !currentProfileTgId) return
    void refreshMyProfile({ sync: 'none' }).catch(() => undefined)
  }, [stepWalletOk, activePage, isBuyer, currentProfileTgId, deal?.currency, deal?.totalBaseUnits])

  const handleBack = useCallback(() => {
    if (!stepWalletOk) return
    if (activePage === 'deposit' || activePage === 'withdraw') {
      setActivePage('profile')
      return
    }
    if (activePage === 'profile') {
      setActivePage('deal')
      return
    }
    if (!stepRolePicked) {
      setStepWalletOk(false)
      return
    }
    setStepRolePicked(false)
  }, [stepWalletOk, activePage, stepRolePicked])

  const showBack = stepWalletOk

  useEffect(() => {
    const BB = (
      typeof window !== 'undefined'
        ? (window as unknown as {
            Telegram?: {
              WebApp?: {
                BackButton?: {
                  show: () => void
                  hide: () => void
                  onClick: (fn: () => void) => void
                  offClick: (fn: () => void) => void
                }
              }
            }
          }).Telegram?.WebApp?.BackButton
        : undefined
    ) as
      | {
          show: () => void
          hide: () => void
          onClick: (fn: () => void) => void
          offClick: (fn: () => void) => void
        }
      | undefined

    if (!BB) return

    if (!showBack) {
      BB.hide()
      return
    }

    BB.show()
    const fn = () => handleBack()
    BB.onClick(fn)
    return () => {
      BB.offClick(fn)
      BB.hide()
    }
  }, [showBack, handleBack])

  function renderIntroPage() {
    return (
      <section className="introShell">
        <div className="introPanel">
          <img className="introLogo" src={gifthubLogoUrl} alt="GiftHub" />
          <div className="introKicker">GiftHub Escrow</div>
          <h1 className="introTitle">Безопасные сделки с Telegram-подарками</h1>
          <p className="introText">
            GiftHub помогает покупателю и продавцу провести сделку через гаранта: покупатель оплачивает, продавец фиксирует подарок, а бот ведет обе стороны по шагам.
          </p>
          <div className="introSteps">
            <div>Создайте сделку и выберите роль</div>
            <div>Отправьте ссылку второй стороне</div>
            <div>Используйте профиль для баланса и подарков</div>
          </div>
          <button type="button" className="primary introContinue" disabled={busy} onClick={() => withBusy(enterApp)}>
            Далее
          </button>
        </div>
      </section>
    )
  }

  function renderProfilePage() {
    const ton = profile?.balances?.TON
    const usdt = profile?.balances?.USDT
    const me = tgUserState ?? getTelegramUser()
    const giftCount = profileGifts.length
    return (
      <section className="profileScreen">
        <div className="profileHero">
          <ProfileAvatar user={me} />
          <div className="profileName">{getTelegramHandle(me)}</div>
          <div className="profileSubline">ID {currentProfileTgId ?? '-'}</div>
          <div className="profileStats">
            <div>
              <b>{giftCount}</b>
              <span>Подарков</span>
            </div>
            <div>
              <b>{ton?.availableDisplay ?? '0'} TON</b>
              <span>Баланс</span>
            </div>
          </div>
        </div>

        <div className="profileBalancePanel">
          <div className="profilePanelHead">
            <div>
              <div className="profilePanelTitle">Баланс</div>
              <div className="profilePanelSub">Средства для сделок внутри GiftHub</div>
            </div>
            <div className="profileBalanceActions">
              <button type="button" className="primary profileDepositBtn" onClick={() => setActivePage('deposit')}>
                Пополнить
              </button>
              <button type="button" className="profileDepositBtn" onClick={() => setActivePage('withdraw')}>
                Вывести
              </button>
            </div>
          </div>
          <div className="balanceGrid">
            <div className="balanceCard">
              <div className="balanceCurrency">TON</div>
              <div className="balanceAmount">{ton?.availableDisplay ?? '0'}</div>
              <div className="hint">В резерве: {ton?.reservedDisplay ?? '0'}</div>
            </div>
            <div className="balanceCard">
              <div className="balanceCurrency">USDT</div>
              <div className="balanceAmount">{usdt?.availableDisplay ?? '0'}</div>
              <div className="hint">В резерве: {usdt?.reservedDisplay ?? '0'}</div>
            </div>
          </div>
        </div>

        <div className="inventoryPanel">
          <div className="inventoryPanelHead">
            <div>
              <div className="profilePanelTitle">Инвентарь <span>{giftCount} подарков</span></div>
            </div>
            <div className="inventoryPanelActions">
              <button type="button" className="primary" disabled={busy || !currentProfileTgId} onClick={() => withBusy(startProfileGiftDepositSession)}>
                Отправить
              </button>
            </div>
          </div>
          {copyHint && <div className="success">{copyHint}</div>}
          <div className="inventoryGrid profileGiftGrid">
            {profileGifts.length === 0 && (
              <div className="profileEmpty">
                Подарков пока нет. Нажмите «Отправить» и сделайте Transfer на vault-аккаунт.
                {transferSessionExpiresAt ? ` Сессия активна до ${new Date(transferSessionExpiresAt).toLocaleTimeString()}.` : ''}
              </div>
            )}
            {profileGifts.map((g) => (
              <div key={g.id} className="inventoryCard profileGiftCard" role="button" tabIndex={0} onClick={() => setGiftDetails(g)}>
                <GiftArtwork gift={g} />
                <div className={`statusPill statusGift statusGift-${g.status}`}>{giftStatusLabel(g.status)}</div>
                <div className="actions giftCardActions">
                  <button
                    type="button"
                    disabled={busy || g.status !== 'AVAILABLE'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void withBusy(() => withdrawProfileGift(g.giftId))
                    }}
                  >
                    Вывести
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    )
  }

  function renderBalanceActionPage(action: 'deposit' | 'withdraw') {
    const quickAmounts = ['10', '50', '100']
    const amountNumber = Number(depositAmount.trim().replace(',', '.'))
    const canSubmit = Boolean(wallet && depositAmount && Number.isFinite(amountNumber) && amountNumber > 0)
    const availableDisplay = profile?.balances?.[depositCurrency]?.availableDisplay ?? '0'
    const isWithdraw = action === 'withdraw'
    return (
      <section className="depositScreen">
        <div className="depositTitle">{isWithdraw ? 'Вывод' : 'Пополнение'}</div>
        <div className="depositCard">
          <div className="depositWalletLabel">{isWithdraw ? 'Кошелек для вывода' : 'Подключенный кошелек'}</div>
          <div className="depositWalletChip">
            <span className="walletDot" />
            {shortAddress(walletFriendlyAddress || wallet?.account?.address)}
          </div>
          {isWithdraw && <div className="depositWalletLabel">Доступно: {availableDisplay} {depositCurrency}</div>}
          <div className="depositAmountLine">
            <input
              inputMode="decimal"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value.replace(',', '.'))}
              className="depositAmountInput"
              aria-label={isWithdraw ? 'Сумма вывода' : 'Сумма пополнения'}
            />
            <span>{depositCurrency}</span>
          </div>
          <div className="seg depositCurrencySeg">
            <button type="button" className={depositCurrency === 'TON' ? 'active' : ''} onClick={() => setDepositCurrency('TON')}>
              TON
            </button>
            <button type="button" className={depositCurrency === 'USDT' ? 'active' : ''} onClick={() => setDepositCurrency('USDT')}>
              USDT
            </button>
          </div>
          <div className="depositQuickRow">
            {quickAmounts.map((value) => (
              <button type="button" key={value} onClick={() => setDepositAmount(value)}>
                {value}
              </button>
            ))}
            {isWithdraw && (
              <button type="button" onClick={() => setDepositAmount(availableDisplay)}>
                All
              </button>
            )}
          </div>
          <button className="primary depositSubmit" disabled={busy || !canSubmit} onClick={() => withBusy(isWithdraw ? withdrawBalance : depositBalance)}>
            {isWithdraw ? 'Вывести' : 'Пополнить'}
          </button>
          {!isWithdraw && lastDepositId && (
            <button type="button" className="depositCheckBtn" disabled={busy} onClick={() => withBusy(async () => { await confirmDepositBalance() })}>
              Проверить пополнение
            </button>
          )}
          {!isWithdraw && (
            <div className="depositNote">
              Для пополнения TON оставьте немного TON на комиссию сети. Для USDT нужен баланс USDT и немного TON на газ.
            </div>
          )}
          {copyHint && <div className="success depositHint">{copyHint}</div>}
        </div>
      </section>
    )
  }

  function renderGiftDetails() {
    if (!giftDetails) return null
    const me = tgUserState ?? getTelegramUser()
    const canOpenGift = Boolean(giftDetails.telegramGiftName)
    const owner = getTelegramHandle(me)
    const row = (label: string, value?: string | number | null) => (
      <div className="giftDetailsRow" key={label}>
        <div>{label}</div>
        <div>{value == null || value === '' ? '-' : value}</div>
      </div>
    )
    return (
      <div className="giftDetailsOverlay" onClick={() => setGiftDetails(null)}>
        <div className="giftDetailsSheet" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="giftDetailsClose" onClick={() => setGiftDetails(null)} aria-label="Закрыть">
            ×
          </button>
          <div className="giftDetailsTop">
            <GiftArtwork gift={giftDetails} />
          </div>
          <div className="giftDetailsRows">
            {row('Owner', owner)}
            {row('Model', giftDetails.model)}
            {row('Symbol', giftDetails.telegramSymbol)}
            {row('Backdrop', giftDetails.background)}
            {row('Number', giftNumberLabel(giftDetails))}
            {row('Status', giftStatusLabel(giftDetails.status))}
          </div>
          <button type="button" className="primary giftDetailsOpen" disabled={!canOpenGift} onClick={() => openTelegramGift(giftDetails)}>
            Открыть в Telegram
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`container ${!stepWalletOk ? 'containerIntro' : ''}`}>
      {stepWalletOk && (
        <header className="header">
          <div className="headerLeft">
            {showBack && (
              <button type="button" className="headerBack" onClick={handleBack} aria-label="Назад">
                ←
              </button>
            )}
            <div className="headerTitles">
              <div className="title">GiftHub Escrow</div>
              <div className="sub">Сделка через безопасный escrow</div>
            </div>
          </div>
          <TonConnectButton />
        </header>
      )}

      {!stepWalletOk && renderIntroPage()}

      {stepWalletOk && activePage === 'profile' && renderProfilePage()}
      {stepWalletOk && activePage === 'deposit' && renderBalanceActionPage('deposit')}
      {stepWalletOk && activePage === 'withdraw' && renderBalanceActionPage('withdraw')}
      {renderGiftDetails()}

      {stepWalletOk && activePage === 'deal' && !stepRolePicked && (
        <section className="card roleStep">
          <div className="cardTitle">Кто вы в этой сделке?</div>
          <div className="seg">
            <button type="button" className={role === 'seller' ? 'active' : ''} onClick={() => setRole('seller')}>
              Я продавец
            </button>
            <button type="button" className={role === 'buyer' ? 'active' : ''} onClick={() => setRole('buyer')}>
              Я покупатель
            </button>
        </div>
          <div className="actions roleStepActions">
        <button
              type="button"
              className="primary ctaContinue"
              disabled={busy}
              onClick={() =>
                void withBusy(async () => {
                  const myId = getTelegramUserId()
                  if (!myId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')

                  // Создаём сделку в выбранной роли: seller ждёт buyer, buyer ждёт seller.
                  if (role === 'seller') {
                    setSellerTgId(myId)
                    setBuyerTgId('')
                  } else {
                    setBuyerTgId(myId)
                    setSellerTgId('')
                  }
                  const out = await apiPost<{ deal: Deal }>('/deals', { tgId: myId, role, telegram: getMyTelegramPublic() ?? undefined })
                  setDeal(out.deal)
                  await saveDealToHistory(out.deal.publicId, role)
                  try {
                    sessionStorage.setItem('gifthub_seller_deal', out.deal.publicId)
                  } catch {
                    /* ignore */
                  }
                  setStepRolePicked(true)
                })
              }
            >
              Продолжить
        </button>
          </div>
          {dealHistory.length > 0 && (
            <div className="dealHistory">
              <div className="hint" style={{ marginBottom: 8 }}>Мои сделки</div>
              {dealHistory.map((item) => (
                <div className={`dealHistoryItem ${deal?.publicId === item.publicId ? 'dealHistoryItemActive' : ''}`} key={item.publicId}>
                  <div className="dealHistoryInfo">
                    <div className="mono">
                      #{item.publicId}
                      {deal?.publicId === item.publicId && <span className="dealBadge">Активная</span>}
                    </div>
                    <div className="hint" style={{ margin: 0 }}>Я: {item.myRole === 'seller' ? 'продавец' : 'покупатель'}</div>
                  </div>
                  <div className="dealHistoryActions">
                    <button
                      type="button"
                      onClick={() =>
                        void withBusy(async () => {
                          const myId = getTelegramUserId()
                          const loaded = await loadDealByPublicId(item.publicId, { tgId: myId, join: item.myRole })
                          if (!loaded) throw new Error('Сделка не найдена')
                          if (myId && loaded.sellerTgId !== myId && loaded.buyerTgId !== myId) {
                            setDeal(null)
                            throw new Error(DEAL_JOIN_CLOSED_MESSAGE)
                          }
                          setRole(item.myRole)
                          if (myId) {
                            if (item.myRole === 'seller') {
                              setSellerTgId(myId)
                              setBuyerTgId(loaded.buyerTgId ?? '')
                            } else {
                              setBuyerTgId(myId)
                              setSellerTgId(loaded.sellerTgId ?? '')
                            }
                          }
                          setStepRolePicked(true)
                        })
                      }
                    >
                      К сделке
                    </button>
                    <button
                      type="button"
                      className="dealHistoryDelete"
                      aria-label="Удалить сделку из истории"
                      disabled={busy}
                      onClick={() => void withBusy(() => removeDealFromHistory(item))}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
      </section>
      )}

      {stepWalletOk && activePage === 'deal' && stepRolePicked && (
        <>
          <section className="card">
            <div className="participantStack">
              <div className={`participantRow ${role === 'seller' ? 'participantYou' : ''}`}>
                {renderParticipantRow('seller')}
              </div>
              <div className={`participantRow ${role === 'buyer' ? 'participantYou' : ''}`}>
                {renderParticipantRow('buyer')}
              </div>
            </div>
            <div className="inviteBlock">
              <div className="hint" style={{ marginBottom: 0 }}>
                {telegramMiniAppLinkBase
                  ? `Отправьте ссылку ${isSeller ? 'покупателю' : 'продавцу'} — она откроет Mini App внутри Telegram (нужен Telegram ID для присоединения).`
                  : `Отправьте ссылку ${isSeller ? 'покупателю' : 'продавцу'}. Лучше задайте на Vercel VITE_TELEGRAM_MINI_APP_LINK (Direct Link из BotFather), иначе человек может открыть URL в браузере без Telegram — тогда присоединиться не получится.`}
              </div>
              {inviteUrl ? (
                <>
                  <div className="inviteRow">
                    <input readOnly value={inviteUrl} title={inviteUrl} />
                    <button type="button" onClick={() => void copyInviteLink()}>
                      Копировать
                    </button>
                    <button type="button" className="shareBtn" onClick={() => shareInviteLink()}>
                      Поделиться
                    </button>
                  </div>
                  {copyHint && <div className="hint">{copyHint}</div>}
                </>
              ) : (
                <div className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                  {isSeller
                    ? 'Ссылка создаётся вместе со сделкой на шаге «Продолжить». Обновите страницу или пройдите шаги заново.'
                    : 'Ссылка будет здесь, когда у вас уже есть активная сделка (например после приглашения).'}
                </div>
              )}
        </div>
            {deal && !counterpartJoined && (
              <div className="dealWaitStatus">
                Ожидаем {isSeller ? 'покупателя' : 'продавца'}
              </div>
            )}
            <div className="actions">
              {deal && counterpartJoined && !deal.escrowStartedAt && currentUserIsDealCreator && (
                <button type="button" className="primary ctaContinue" disabled={busy} onClick={() => withBusy(startDealEscrow)}>
                  Начать оформление сделки
                </button>
              )}
              {deal && counterpartJoined && !deal.escrowStartedAt && !currentUserIsDealCreator && (
                <div className="hint">Ожидаем, пока создатель сделки начнет оформление.</div>
              )}
              {isBuyer && currentDealId && deal?.status === 'WAITING_FOR_BUYER' && !deal?.buyerTgId && (
                <>
                  <button disabled={busy || !buyerTgId} onClick={() => withBusy(joinDealAsBuyer)}>
                    Присоединиться к сделке
                  </button>
                  {!buyerTgId && (
                    <div className="hint">Нет Telegram ID — откройте эту страницу из Telegram Mini App, затем снова нажмите.</div>
                  )}
                </>
              )}
        </div>
      </section>

          {showDealWorkspace && deal && (
            <section className="card">
              <div className="cardTitle">Экран сделки #{deal.publicId}</div>
              <div className="statusPill">{getStatusLabel(deal.status)}</div>

              <div className="step">
                <div className="stepTitle">1) Подарок продавца</div>
                {isSeller ? (
                  <div className="dealGiftGrid">
                    {dealGiftOptions.length === 0 && <div className="dealGiftEmpty">Доступных подарков пока нет.</div>}
                    {dealGiftOptions.map((g) => {
                      const selected = selectedGiftId === g.giftId || deal.reservedGiftId === g.giftId
                      return (
                        <div key={g.id} className={`dealGiftCard ${selected ? 'dealGiftCardSelected' : ''}`}>
                          <button type="button" className="dealGiftArtworkBtn" onClick={() => setGiftDetails(g)} aria-label="Открыть подарок">
                            <GiftArtwork gift={g} />
                          </button>
                          <button
                            type="button"
                            className="primary dealGiftSelectBtn"
                            disabled={busy || selected}
                            onClick={() => withBusy(() => reserveGift(g.giftId))}
                          >
                            {selected ? 'Выбран' : 'Выбрать'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <>
                    {reservedDealGift ? (
                      <div className="dealGiftGrid">
                        <div className="dealGiftCard dealGiftCardSelected dealGiftCardReadonly">
                          <button type="button" className="dealGiftArtworkBtn" onClick={() => setGiftDetails(reservedDealGift)} aria-label="Открыть подарок">
                            <GiftArtwork gift={reservedDealGift} />
                          </button>
                          <div className="dealGiftSelectedLabel">Выбран продавцом</div>
                        </div>
                      </div>
                    ) : deal.reservedGiftId ? (
                      <div className="hint">
                        Выбранный подарок: <b>{deal.reservedGiftId}</b>
                      </div>
                    ) : (
                      <div className="hint">Ожидаем, пока продавец выберет подарок.</div>
                    )}
                  </>
                )}
              </div>

              <div className="step">
                <div className="stepTitle">2) Цена и валюта</div>
                {isSeller ? (
                  <>
                    <div className="grid2">
                      <div>
                        <label>Валюта</label>
                        <select value={currency} onChange={(e) => setCurrency(e.target.value as DealCurrency)}>
                          <option value="TON">TON</option>
                          <option value="USDT">USDT</option>
                        </select>
                      </div>
                      <div>
                        <label>Цена</label>
                        <input value={price} onChange={(e) => setPrice(e.target.value)} />
                      </div>
                    </div>
                    <div className="actions">
                      <button disabled={busy} onClick={() => withBusy(setDealPrice)}>
                        Зафиксировать цену
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="hint">
                    Цена: <b>{deal.priceDisplay ? `${deal.priceDisplay} ${deal.currency}` : 'еще не задана'}</b>
                  </div>
                )}
              </div>

              <div className="step">
                <div className="stepTitle">3) Оплата покупателя</div>
                <div className="hint">
                  К оплате: <b>{deal.totalDisplay ? `${deal.totalDisplay} ${deal.currency}` : '-'}</b>
                </div>
                {isBuyer ? (
                  <>
                    <div className="paymentBalanceLine">
                      Баланс: <b>{buyerDealBalanceDisplay != null && deal.currency ? `${buyerDealBalanceDisplay} ${deal.currency}` : '-'}</b>
                    </div>
                    {buyerDealBalanceEnough === false && deal.status === 'WAITING_FOR_PAYMENT' && (
                      <div className="hint">Недостаточно средств на внутреннем балансе. Пополните профиль или оплатите через кошелек.</div>
                    )}
                    {deal.paymentSource === 'PROFILE_BALANCE' && (
                      <div className="hint">Оплата зарезервирована с внутреннего баланса до завершения сделки.</div>
                    )}
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={busy || deal.status !== 'WAITING_FOR_PAYMENT' || buyerDealBalanceEnough === false}
                        onClick={() => withBusy(payFromBalance)}
                      >
                        Оплатить с баланса
                      </button>
                      <button disabled={busy || !wallet || deal.status !== 'WAITING_FOR_PAYMENT'} onClick={() => withBusy(pay)}>
                        Через кошелек
                      </button>
                      <button disabled={busy || deal.status !== 'WAITING_FOR_PAYMENT'} onClick={() => withBusy(autoConfirmPayment)}>
                        Проверить оплату
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="hint">Ожидаем оплату от покупателя.</div>
                )}
              </div>

              <div className="step">
                <div className="stepTitle">4) Завершение сделки</div>
                <div className="hint">
                  Выбранный подарок: <b>{deal.reservedGiftId ?? '-'}</b>
                </div>
                {isSeller ? (
                  <div className="actions">
                    <button className="primary" disabled={busy || deal.status !== 'GIFT_RESERVED'} onClick={() => withBusy(releaseDeal)}>
                      Завершить сделку
                    </button>
                  </div>
                ) : (
                  <div className="hint">После подтверждения обеих сторон продавец завершит сделку.</div>
                )}
                {deal.status === 'WAITING_FOR_MANUAL_GIFT_TRANSFER' && (
                  <div className="success">
                    Нужен ручной Transfer: отправьте выбранный подарок с vault-аккаунта покупателю, затем подтвердите перевод через админ-endpoint.
                  </div>
                )}
                {deal.status === 'COMPLETED' && (
                  <div className="success">Сделка завершена. Подарок отправлен покупателю, выплата отправлена продавцу.</div>
                )}
              </div>
            </section>
          )}
        </>
      )}

      {error && (
        <section className="card error">
          <div className="cardTitle">Ошибка</div>
          <pre className="pre">{error}</pre>
        </section>
      )}

      {stepWalletOk && (
        <nav className="bottomNav" aria-label="Основная навигация">
          <button type="button" className={activePage === 'deal' ? 'active' : ''} onClick={() => setActivePage('deal')} aria-label="Сделка">
            <HandshakeIcon />
          </button>
          <button
            type="button"
            className={activePage === 'profile' || activePage === 'deposit' || activePage === 'withdraw' ? 'active' : ''}
            onClick={() => setActivePage('profile')}
            aria-label="Профиль"
          >
            <PersonIcon />
          </button>
        </nav>
      )}
    </div>
  )
}

export default App
