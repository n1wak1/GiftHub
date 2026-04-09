import { useEffect, useMemo, useState } from 'react'
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

const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000'

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`)
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

function getTelegramUserId(): string | null {
  try {
    const id = WebApp.initDataUnsafe?.user?.id
    return id != null ? String(id) : null
  } catch {
    return null
  }
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

  const [sellerTgId, setSellerTgId] = useState(() => getTelegramUserId() ?? '111')
  const [buyerTgId, setBuyerTgId] = useState(() => getTelegramUserId() ?? '222')
  const [dealIdInput, setDealIdInput] = useState('')
  const [deal, setDeal] = useState<Deal | null>(null)

  const [currency, setCurrency] = useState<DealCurrency>('TON')
  const [price, setPrice] = useState('10')

  const [sellerPayoutWallet, setSellerPayoutWallet] = useState('')
  const [sellerProfile, setSellerProfile] = useState<Profile | null>(null)

  const [sellerGifts, setSellerGifts] = useState<Gift[]>([])
  const [giftIdToDeposit, setGiftIdToDeposit] = useState('')
  const [giftTitleToDeposit, setGiftTitleToDeposit] = useState('')
  const [selectedGiftId, setSelectedGiftId] = useState('')

  const buyerWalletAddress = wallet?.account?.address
  const currentDealId = useMemo(() => deal?.publicId ?? dealIdInput.trim(), [deal?.publicId, dealIdInput])
  const isSeller = role === 'seller'
  const isBuyer = role === 'buyer'

  useEffect(() => {
    try {
      WebApp.ready()
      WebApp.expand()
    } catch {
      // local browser mode
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

  async function refreshDeal() {
    if (!currentDealId) return
    const out = await apiGet<{ deal: Deal | null }>(`/deals/${currentDealId}`)
    setDeal(out.deal)
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

  async function createDealAsSeller() {
    const out = await apiPost<{ deal: Deal }>('/deals', { sellerTgId })
    setDeal(out.deal)
    setDealIdInput(out.deal.publicId)
    await refreshSellerData()
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
    setStepWalletOk(true)
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

  return (
    <div className="container">
      <header className="header">
        <div>
          <div className="title">GiftHub Escrow</div>
          <div className="sub">Сделка через безопасный escrow</div>
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
          <div className="hint">
            Адрес:{' '}
            <span className="mono">{buyerWalletAddress ?? 'ещё не подключён'}</span>
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
        <section className="card">
          <div className="cardTitle">Шаг 2 — кто вы в этой сделке?</div>
          <div className="seg">
            <button className={role === 'seller' ? 'active' : ''} onClick={() => setRole('seller')}>
              Я продавец
            </button>
            <button className={role === 'buyer' ? 'active' : ''} onClick={() => setRole('buyer')}>
              Я покупатель
            </button>
          </div>
          <div className="actions">
            <button className="primary" onClick={() => setStepRolePicked(true)}>
              Продолжить
            </button>
          </div>
        </section>
      )}

      {stepWalletOk && stepRolePicked && (
        <>
          <section className="card">
            <div className="tabs">
              <div className={`tab ${role === 'seller' ? 'tabActive' : ''}`}>Seller: @{sellerTgId}</div>
              <div className={`tab ${role === 'buyer' ? 'tabActive' : ''}`}>Buyer: @{buyerTgId}</div>
            </div>
            <div className="grid2">
              <div>
                <label>Seller TG ID</label>
                <input value={sellerTgId} onChange={(e) => setSellerTgId(e.target.value)} />
              </div>
              <div>
                <label>Buyer TG ID</label>
                <input value={buyerTgId} onChange={(e) => setBuyerTgId(e.target.value)} />
              </div>
            </div>
            <div className="row">
              <label>Deal ID</label>
              <input
                placeholder="Вставьте ID сделки или создайте новую"
                value={dealIdInput}
                onChange={(e) => setDealIdInput(e.target.value)}
              />
              <button disabled={busy} onClick={() => withBusy(refreshDeal)}>
                Открыть
              </button>
            </div>
            <div className="actions">
              {isSeller && (
                <button className="primary" disabled={busy} onClick={() => withBusy(createDealAsSeller)}>
                  Создать сделку
                </button>
              )}
              {isBuyer && (
                <button disabled={busy || !currentDealId} onClick={() => withBusy(joinDealAsBuyer)}>
                  Присоединиться к сделке
                </button>
              )}
              <button disabled={busy || !currentDealId} onClick={() => withBusy(refreshDeal)}>
                Обновить статус
              </button>
            </div>
          </section>

          {deal && (
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
