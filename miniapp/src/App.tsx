import { useCallback, useEffect, useMemo, useState } from 'react'
import WebApp from '@twa-dev/sdk'
import { TonConnectButton, useTonWallet, useTonConnectUI } from '@tonconnect/ui-react'
import './App.css'

type Role = 'seller' | 'buyer'
type DealCurrency = 'TON' | 'USDT'
type DealStatus =
  | 'WAITING_FOR_BUYER'
  | 'WAITING_FOR_PRICE'
  | 'WAITING_FOR_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'GIFT_RESERVED'
  | 'COMPLETED'
  | string

type Deal = {
  publicId: string
  status: DealStatus
  sellerTgId: string
  buyerTgId?: string
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

function CounterpartyAvatar({ tgId, letter }: { tgId: string; letter: string }) {
  const [fall, setFall] = useState(false)
  if (fall) {
    return <div className="tabAvatarPh">{letter}</div>
  }
  return (
    <img
      className="tabAvatar"
      src={`${apiBase}/profiles/${tgId}/avatar`}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFall(true)}
    />
  )
}

function CounterpartyCard({ tgId, roleLabel, letter }: { tgId: string; roleLabel: string; letter: string }) {
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
  return (
    <div className="tabInner">
      <CounterpartyAvatar tgId={tgId} letter={letter} />
      <div className="tabName">
        <div className="tabNameMain">{roleLabel}</div>
        {nameLine && <div className="tabNameSub">{nameLine}</div>}
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
    typeof window !== 'undefined' ? readPendingInviteFromLocation() : null,
  )
  const [sellerTgId, setSellerTgId] = useState('')
  const [buyerTgId, setBuyerTgId] = useState('')
  const [deal, setDeal] = useState<Deal | null>(null)
  const [tgUserState, setTgUserState] = useState<TgWebUser | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const [sellerEscrowStarted, setSellerEscrowStarted] = useState(false)

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

  const inviteUrl = useMemo(() => {
    const id = deal?.publicId
    if (!id || typeof window === 'undefined') return ''
    const path = window.location.pathname || '/'
    const base = `${window.location.origin}${path === '/' ? '' : path}`.replace(/\/$/, '') || window.location.origin
    const inviteeRole: Role = isSeller ? 'buyer' : 'seller'
    return `${base}/?deal=${encodeURIComponent(id)}&join=${inviteeRole}`
  }, [deal?.publicId, isSeller])

  const showDealWorkspace = useMemo(
    () => Boolean(deal && (!isSeller || sellerEscrowStarted)),
    [deal, isSeller, sellerEscrowStarted],
  )

  useEffect(() => {
    if (!deal?.publicId || !isSeller) {
      setSellerEscrowStarted(false)
      return
    }
    setSellerEscrowStarted(sessionStorage.getItem(`gifthub_escrow_${deal.publicId}`) === '1')
  }, [deal?.publicId, isSeller])

  /** Покупатель: подтягиваем сделку с сервера (Redis/другой инстанс), чтобы видеть обновления продавца. */
  useEffect(() => {
    if (!isBuyer || !deal?.publicId) return
    const id = deal.publicId
    const t = window.setInterval(() => {
      void (async () => {
        try {
          const out = await apiGet<{ deal: Deal | null }>(`/deals/${id}`)
          if (out.deal) setDeal(out.deal)
        } catch {
          /* ignore */
        }
      })()
    }, 2500)
    return () => clearInterval(t)
  }, [isBuyer, deal?.publicId])

  useEffect(() => {
    if (!isSeller || !deal?.publicId || deal.buyerTgId) return
    const id = deal.publicId
    const t = window.setInterval(() => {
      void (async () => {
        try {
          const out = await apiGet<{ deal: Deal | null }>(`/deals/${id}`)
          if (out.deal) setDeal(out.deal)
        } catch {
          /* ignore */
        }
      })()
    }, 1500)
    return () => clearInterval(t)
  }, [isSeller, deal?.publicId, deal?.buyerTgId])

  useEffect(() => {
    if (!isSeller || !deal?.publicId || deal.buyerTgId) return
    const id = deal.publicId
    const refresh = () => {
      void (async () => {
        try {
          const out = await apiGet<{ deal: Deal | null }>(`/deals/${id}`)
          if (out.deal) setDeal(out.deal)
        } catch {
          /* ignore */
        }
      })()
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [isSeller, deal?.publicId, deal?.buyerTgId])

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
  const [tgTick, setTgTick] = useState(0)
  useEffect(() => {
    setTgUserState(getTelegramUser())
  }, [tgTick, stepWalletOk, stepRolePicked])

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
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/join`, { buyerTgId })
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

    const inv = pendingInvite
    if (inv) {
      setRole(inv.join)
      const myId = getTelegramUserId()
      if (myId) {
        if (inv.join === 'seller') setSellerTgId(myId)
        else setBuyerTgId(myId)
      }
      const loaded = await loadDealByPublicId(inv.deal)
      if (!loaded) {
        throw new Error(
          'Сделка по ссылке не найдена на сервере. Проверьте: 1) VITE_API_BASE_URL на Vercel указывает на ваш Render API; 2) на Render заданы UPSTASH_REDIS_* и сделка создана после их настройки; 3) ссылка скопирована полностью.',
        )
      }
      if (
        inv.join === 'buyer' &&
        loaded.status === 'WAITING_FOR_BUYER' &&
        !loaded.buyerTgId &&
        myId
      ) {
        const joined = await apiPost<{ deal: Deal }>(`/deals/${loaded.publicId}/join`, { buyerTgId: myId })
        setDeal(joined.deal)
        setBuyerTgId(myId)
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
    const text = encodeURIComponent('Сделка GiftHub — присоединитесь по ссылке')
    const u = encodeURIComponent(inviteUrl)
    const tg = `https://t.me/share/url?url=${u}&text=${text}`
    try {
      WebApp.openTelegramLink(tg)
    } catch {
      window.open(tg, '_blank', 'noopener,noreferrer')
    }
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
        return <CounterpartyCard tgId={id} roleLabel="Продавец" letter="P" />
      }
    } else {
      const id = deal?.buyerTgId ?? buyerTgId
      if (id) {
        return <CounterpartyCard tgId={id} roleLabel="Покупатель" letter="B" />
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
    try {
      WebApp.close()
    } catch {
      if (window.history.length > 1) window.history.back()
    }
  }, [stepWalletOk, stepRolePicked])

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
                  if (role === 'seller') {
                    if (!myId) throw new Error('Не удалось прочитать Telegram ID — откройте приложение из Telegram')
                    setSellerTgId(myId)
                    setBuyerTgId('')
                    const out = await apiPost<{ deal: Deal }>('/deals', { sellerTgId: myId })
                    setDeal(out.deal)
                    try {
                      sessionStorage.setItem('gifthub_seller_deal', out.deal.publicId)
                    } catch {
                      /* ignore */
                    }
                  } else {
                    if (myId) {
                      setBuyerTgId(myId)
                      setSellerTgId('')
                    }
                  }
                  setStepRolePicked(true)
                })
              }
            >
              Продолжить
            </button>
          </div>
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
                {isSeller
                  ? 'Отправьте ссылку покупателю — по ней он откроет сделку в своём Telegram и сможет присоединиться.'
                  : 'Если вы открыли приложение по ссылке продавца, сделка подтянется сама. Иначе попросите у него ссылку.'}
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
            {isSeller && deal && !deal.buyerTgId && (
              <div className="hint">Ожидаем покупателя по ссылке. Статус обновляется автоматически.</div>
            )}
            <div className="actions">
              {isSeller && deal?.buyerTgId && !sellerEscrowStarted && (
                <button type="button" className="primary ctaContinue" disabled={busy} onClick={() => startSellerEscrow()}>
                  Начать оформление сделки
                </button>
              )}
              {isBuyer && currentDealId && deal?.status === 'WAITING_FOR_BUYER' && !deal?.buyerTgId && (
                <button disabled={busy} onClick={() => withBusy(joinDealAsBuyer)}>
                  Присоединиться к сделке
                </button>
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
