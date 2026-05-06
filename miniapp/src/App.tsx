import { useCallback, useEffect, useMemo, useState } from 'react'
import WebApp from '@twa-dev/sdk'
import { TonConnectButton, useTonWallet, useTonConnectUI } from '@tonconnect/ui-react'
import './App.css'

type Role = 'seller' | 'buyer'
type DealCurrency = 'TON' | 'USDT'
type DealStatus =
  | 'WAITING_FOR_BUYER'
  | 'WAITING_FOR_SELLER'
  | 'WAITING_FOR_PRICE'
  | 'WAITING_FOR_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'GIFT_RESERVED'
  | 'COMPLETED'
  | string

type Deal = {
  publicId: string
  status: DealStatus
  sellerTgId?: string
  buyerTgId?: string
  sellerTelegram?: { firstName?: string; lastName?: string; username?: string; photoUrl?: string }
  buyerTelegram?: { firstName?: string; lastName?: string; username?: string; photoUrl?: string }
  currency?: DealCurrency
  priceDisplay?: string
  feeDisplay?: string
  totalDisplay?: string
  paymentConfirmedAt?: string
  reservedGiftId?: string
  releasedAt?: string
}

type Gift = {
  id: string
  giftId: string
  title?: string
  status: 'AVAILABLE' | 'RESERVED' | 'SENT'
}

type Profile = {
  payoutWalletAddress?: string
}
type DealHistoryItem = { publicId: string; myRole: Role; updatedAt: number }

type PayRequestTon = {
  tonconnect: {
    validUntil: number
    messages: Array<{ address: string; amount: string; payload?: string }>
  }
}

type PayRequestUsdt = {
  tonconnect: {
    validUntil: number
    messages: Array<{ address: string; amount: string; payload: string }>
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
const DEALS_HISTORY_STORAGE_KEY = 'gifthub_my_deals_v1'

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
    case 'COMPLETED':
      return 'Сделка завершена'
    default:
      return status ?? '-'
  }
}

function App() {
  const wallet = useTonWallet()
  const [tonConnectUI] = useTonConnectUI()

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [stepWalletOk, setStepWalletOk] = useState(false)
  const [stepRolePicked, setStepRolePicked] = useState(false)
  const [role, setRole] = useState<Role>('seller')

  const [pendingInvite, setPendingInvite] = useState<{ deal: string; join: Role } | null>(() =>
    typeof window !== 'undefined' ? readInviteOnce() : null,
  )
  const [sellerTgId, setSellerTgId] = useState('')
  const [buyerTgId, setBuyerTgId] = useState('')
  const [deal, setDeal] = useState<Deal | null>(null)
  const [tgUserState, setTgUserState] = useState<TgWebUser | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const [sellerEscrowStarted, setSellerEscrowStarted] = useState(false)
  const [tgTick, setTgTick] = useState(0)
  const [dealHistory, setDealHistory] = useState<DealHistoryItem[]>([])

  const [currency, setCurrency] = useState<DealCurrency>('TON')
  const [price, setPrice] = useState('10')

  const [sellerPayoutWallet, setSellerPayoutWallet] = useState('')
  const [sellerProfile, setSellerProfile] = useState<Profile | null>(null)

  const [sellerGifts, setSellerGifts] = useState<Gift[]>([])
  const [giftIdToDeposit, setGiftIdToDeposit] = useState('')
  const [giftTitleToDeposit, setGiftTitleToDeposit] = useState('')
  const [selectedGiftId, setSelectedGiftId] = useState('')

  const buyerWalletAddress = wallet?.account?.address
  const currentDealId = deal?.publicId ?? ''
  const isSeller = role === 'seller'
  const isBuyer = role === 'buyer'
  const counterpartJoined = Boolean(deal && (isSeller ? deal.buyerTgId : deal.sellerTgId))

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
      const payload = `deal.${id}.${inviteeRole}`
      return `https://t.me/${telegramBotUsername}?start=${encodeURIComponent(payload)}`
    }
    const path = window.location.pathname || '/'
    const base = `${window.location.origin}${path === '/' ? '' : path}`.replace(/\/$/, '') || window.location.origin
    return `${base}/?deal=${encodeURIComponent(id)}&join=${inviteeRole}`
  }, [deal?.publicId, isSeller])

  const showDealWorkspace = useMemo(
    () => Boolean(deal && counterpartJoined && sellerEscrowStarted),
    [deal, counterpartJoined, sellerEscrowStarted],
  )

  const saveDealToHistory = useCallback((publicId: string, myRole: Role) => {
    if (!publicId) return
    setDealHistory((prev) => {
      const next = [{ publicId, myRole, updatedAt: Date.now() }, ...prev.filter((d) => d.publicId !== publicId)].slice(0, 20)
      try {
        sessionStorage.setItem(DEALS_HISTORY_STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DEALS_HISTORY_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as DealHistoryItem[]
      if (!Array.isArray(parsed)) return
      setDealHistory(parsed.filter((x) => x?.publicId && (x.myRole === 'seller' || x.myRole === 'buyer')))
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!deal?.publicId) {
      setSellerEscrowStarted(false)
      return
    }
    setSellerEscrowStarted(sessionStorage.getItem(`gifthub_escrow_${deal.publicId}`) === '1')
  }, [deal?.publicId])

  /** Live-синхронизация сделки: SSE с бэкенда; при обрыве — polling (два клиента видят лобби почти сразу). */
  useEffect(() => {
    if (!deal?.publicId) return

    const id = deal.publicId
    let cancelled = false

    const applyRemote = (d: Deal | null | undefined) => {
      if (cancelled || !d) return
      setDeal(d)
    }

    const pullOnce = async () => {
      try {
        const out = await apiGet<{ deal: Deal | null }>(`/deals/${encodeURIComponent(id)}`)
        applyRemote(out.deal ?? null)
      } catch {
        /* ignore */
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
      es = new EventSource(`${apiBase}/deals/${encodeURIComponent(id)}/stream`)
      es.onopen = () => stopPoll()
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { deal: Deal | null }
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
  }, [deal?.publicId])

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

  async function loadDealByPublicId(publicId: string): Promise<Deal | null> {
    const out = await apiGet<{ deal: Deal | null }>(`/deals/${publicId}`)
    setDeal(out.deal)
    return out.deal
  }

  async function refreshSellerData() {
    const [profileOut, giftsOut] = await Promise.all([
      apiGet<{ profile: Profile }>(`/profiles/${sellerTgId}`),
      apiGet<{ gifts: Gift[] }>(`/gifts/${sellerTgId}`),
    ])
    setSellerProfile(profileOut.profile)
    setSellerPayoutWallet(profileOut.profile.payoutWalletAddress ?? '')
    setSellerGifts(giftsOut.gifts)
  }

  async function joinDealAsBuyer() {
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/join`, { tgId: buyerTgId, role: 'buyer', telegram: getMyTelegramPublic() ?? undefined })
    setDeal(out.deal)
  }

  async function bindWallet() {
    const out = await apiPost<{ profile: Profile }>('/profiles/wallet', {
      tgId: sellerTgId,
      walletAddress: sellerPayoutWallet,
    })
    setSellerProfile(out.profile)
  }

  async function continueAfterWallet() {
    const addr = wallet?.account?.address
    if (!addr) throw new Error('Сначала подключите кошелёк через TON Connect')
    const tgFromApp = getTelegramUserId()
    if (tgFromApp != null) {
      const out = await apiPost<{ profile: Profile }>('/profiles/wallet', {
        tgId: tgFromApp,
        walletAddress: addr,
      })
      setSellerProfile(out.profile)
      setSellerPayoutWallet(out.profile.payoutWalletAddress ?? addr)
    }

    const inv = pendingInvite ?? readStartParamInvite()
    if (inv) {
      const myId = getTelegramUserId()
      const loaded = await loadDealByPublicId(inv.deal)
      if (!loaded) {
        throw new Error(
          `Сделка по ссылке не найдена на сервере (${apiBase}). На Vercel переменная VITE_API_BASE_URL должна быть РОВНО URL вашего сервиса на Render (например https://gifthub-backend.onrender.com). Убедитесь, что на Render заданы UPSTASH_REDIS_* и ссылка полная.`,
        )
      }
      if (myId) {
        const isExistingSeller = loaded.sellerTgId === myId
        const isExistingBuyer = loaded.buyerTgId === myId
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
          saveDealToHistory(joined.deal.publicId, 'buyer')
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
          saveDealToHistory(joined.deal.publicId, 'seller')
        }
      }
      try {
        sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY)
      } catch {
        /* ignore */
      }
      stripInviteParamsFromUrl()
      setPendingInvite(null)
      setStepWalletOk(true)
      setStepRolePicked(true)
      return
    }

    setStepWalletOk(true)
  }

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
    void (async () => {
      try {
        if (navigator.share) {
          await navigator.share({ title: 'GiftHub Escrow', text: 'Сделка GiftHub — присоединитесь по ссылке', url: inviteUrl })
          return
        }
      } catch {
        /* ignore */
      }
      const text = encodeURIComponent('Сделка GiftHub — присоединитесь по ссылке')
      const u = encodeURIComponent(inviteUrl)
      const tg = `https://t.me/share/url?url=${u}&text=${text}`
      try {
        WebApp.openTelegramLink(tg)
      } catch {
        window.open(tg, '_blank', 'noopener,noreferrer')
      }
    })()
  }

  function startSellerEscrow() {
    if (!deal?.publicId) return
    sessionStorage.setItem(`gifthub_escrow_${deal.publicId}`, '1')
    setSellerEscrowStarted(true)
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

  async function depositGift() {
    await apiPost('/gifts/deposit', {
      ownerTgId: sellerTgId,
      giftId: giftIdToDeposit,
      title: giftTitleToDeposit || undefined,
    })
    setGiftIdToDeposit('')
    setGiftTitleToDeposit('')
    await refreshSellerData()
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
      const out = await apiPost<PayRequestTon>(`/deals/${currentDealId}/pay-request`, { buyerTgId })
      await tonConnectUI.sendTransaction(out.tonconnect as any)
      return
    }
    const out = await apiPost<PayRequestUsdt>(`/deals/${currentDealId}/pay-request`, {
      buyerTgId,
      buyerWalletAddress,
    })
    await tonConnectUI.sendTransaction(out.tonconnect as any)
  }

  async function autoConfirmPayment() {
    const out = await apiPost<{ matched: boolean; reason?: string; deal?: Deal }>(
      `/deals/${currentDealId}/payment/auto-confirm`,
      { buyerTgId, scanLimit: 30 },
    )
    if (out.deal) setDeal(out.deal)
    if (!out.matched) throw new Error(out.reason ?? 'Платеж пока не найден')
  }

  async function reserveSelectedGift() {
    if (!selectedGiftId) throw new Error('Сначала выберите подарок')
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/gift/reserve`, {
      sellerTgId,
      giftId: selectedGiftId,
    })
    setDeal(out.deal)
    await refreshSellerData()
  }

  async function releaseDeal() {
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/release`, {
      sellerTgId,
      payoutTxHash: 'manual-payout',
      giftTransferTxHash: 'manual-gift-transfer',
    })
    setDeal(out.deal)
    await refreshSellerData()
  }

  useEffect(() => {
    if (!sellerEscrowStarted || !isSeller || !sellerTgId) return
    void refreshSellerData()
  }, [sellerEscrowStarted, isSeller, sellerTgId])

  const handleBack = useCallback(() => {
    if (!stepWalletOk) return
    if (!stepRolePicked) {
      setStepWalletOk(false)
      return
    }
    if (showDealWorkspace && isSeller && sellerEscrowStarted) {
      setSellerEscrowStarted(false)
      return
    }
    setStepRolePicked(false)
  }, [stepWalletOk, stepRolePicked, showDealWorkspace, isSeller, sellerEscrowStarted])

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

  return (
    <div className="container">
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

      {!stepWalletOk && (
        <section className="card">
          <div className="cardTitle">Шаг 1 — подключите кошелёк</div>
          <p className="hint">
            Без привязанного TON-адреса нельзя оплатить сделку (покупатель) и зафиксировать выплату (продавец). Нажмите
            «Connect Wallet» выше и подтвердите в Telegram Wallet.
          </p>
          <div className={`walletStatus ${wallet ? 'walletStatusOk' : 'walletStatusBad'}`}>
            <span className="walletStatusIcon" aria-hidden>
              {wallet ? '✓' : '✕'}
            </span>
            <span>{wallet ? 'Кошелёк подключён' : 'Кошелёк не подключён'}</span>
          </div>
          {!getTelegramUserId() && (
            <div className="hint">
              Откройте приложение из Telegram — тогда адрес сохранится в вашем профиле по Telegram ID. В браузере без
              Telegram сохранение профиля на этом шаге пропускается.
            </div>
          )}
          <div className="actions">
            <button className="primary" disabled={busy || !wallet} onClick={() => withBusy(continueAfterWallet)}>
              Продолжить
            </button>
          </div>
        </section>
      )}

      {stepWalletOk && !stepRolePicked && (
        <section className="card roleStep">
          <div className="cardTitle">Шаг 2 — кто вы в этой сделке?</div>
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
                  saveDealToHistory(out.deal.publicId, role)
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
                  <div>
                    <div className="mono">
                      #{item.publicId}
                      {deal?.publicId === item.publicId && <span className="dealBadge">Активная</span>}
                    </div>
                    <div className="hint" style={{ margin: 0 }}>Я: {item.myRole === 'seller' ? 'продавец' : 'покупатель'}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void withBusy(async () => {
                        const loaded = await loadDealByPublicId(item.publicId)
                        if (!loaded) throw new Error('Сделка не найдена')
                        const myId = getTelegramUserId()
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
                </div>
              ))}
            </div>
          )}
      </section>
      )}

      {stepWalletOk && stepRolePicked && (
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
              <div className="hint">
                Ожидаем {isSeller ? 'покупателя' : 'продавца'}: обновление через поток с сервера (SSE) или короткий polling. API сейчас:{' '}
                <span className="mono">{apiBase}</span> — он должен совпадать с URL вашего сервиса на Render. Если
                второй участник не появляется, проверьте Redis на Render и переменную VITE_API_BASE_URL на Vercel.
              </div>
            )}
            <div className="actions">
              {deal && counterpartJoined && !sellerEscrowStarted && (
                <button type="button" className="primary ctaContinue" disabled={busy} onClick={() => startSellerEscrow()}>
                  Начать оформление сделки
                </button>
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
                  <>
                    <div className="row">
                      <label>Кошелек продавца</label>
                      <input
                        placeholder="TON-адрес для выплаты"
                        value={sellerPayoutWallet}
                        onChange={(e) => setSellerPayoutWallet(e.target.value)}
                      />
                      <button disabled={busy} onClick={() => withBusy(bindWallet)}>
                        Привязать
                      </button>
                    </div>
                    <div className="row">
                      <label>Депозит подарка</label>
                      <input
                        placeholder="Gift ID (после Transfer боту)"
                        value={giftIdToDeposit}
                        onChange={(e) => setGiftIdToDeposit(e.target.value)}
                      />
                      <button disabled={busy} onClick={() => withBusy(depositGift)}>
                        Добавить
                      </button>
                    </div>
                    <div className="grid2">
                      <div>
                        <label>Название (опционально)</label>
                        <input value={giftTitleToDeposit} onChange={(e) => setGiftTitleToDeposit(e.target.value)} />
                      </div>
                      <div>
                        <label>Выбрать подарок для сделки</label>
                        <select value={selectedGiftId} onChange={(e) => setSelectedGiftId(e.target.value)}>
                          <option value="">-- выберите --</option>
                          {sellerGifts
                            .filter((g) => g.status === 'AVAILABLE' || g.giftId === deal.reservedGiftId)
                            .map((g) => (
                              <option key={g.id} value={g.giftId}>
                                {g.title ? `${g.title} (${g.giftId})` : g.giftId}
                              </option>
                            ))}
                        </select>
                      </div>
                    </div>
                    <div className="actions">
                      <button disabled={busy || !deal.paymentConfirmedAt} onClick={() => withBusy(reserveSelectedGift)}>
                        Выбрать подарок
                      </button>
                      <button disabled={busy} onClick={() => withBusy(refreshSellerData)}>
                        Обновить подарки
                      </button>
                    </div>
                    <div className="hint">
                      Привязанный кошелек: <span className="mono">{sellerProfile?.payoutWalletAddress ?? '-'}</span>
                    </div>
                  </>
                ) : (
                  <div className="hint">Ожидаем, пока продавец выберет подарок.</div>
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
                  <div className="actions">
                    <button className="primary" disabled={busy || !wallet} onClick={() => withBusy(pay)}>
                      Оплатить
                    </button>
                    <button disabled={busy} onClick={() => withBusy(autoConfirmPayment)}>
                      Проверить оплату
                    </button>
                  </div>
                ) : (
                  <div className="hint">Ожидаем оплату от покупателя.</div>
                )}
                <div className="hint">
                  Wallet buyer: <span className="mono">{buyerWalletAddress ?? 'не подключен'}</span>
                </div>
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
    </div>
  )
}

export default App
