import { useEffect, useMemo, useState } from 'react'
import WebApp from '@twa-dev/sdk'
import { TonConnectButton, useTonWallet, useTonConnectUI } from '@tonconnect/ui-react'
import './App.css'

type DealCurrency = 'TON' | 'USDT'

type Deal = {
  publicId: string
  status: string
  sellerTgId: string
  buyerTgId?: string
  currency?: DealCurrency
  priceDisplay?: string
  feeDisplay?: string
  totalDisplay?: string
  escrowAddress?: string | null
  paymentTxHash?: string
  paymentConfirmedAt?: string
}

type PayRequestTon = {
  tonNetwork: 'testnet' | 'mainnet'
  currency: 'TON'
  totalDisplay: string
  tonconnect: {
    validUntil: number
    messages: Array<{ address: string; amount: string; payload?: string }>
  }
}

type PayRequestUsdt = {
  tonNetwork: 'testnet' | 'mainnet'
  currency: 'USDT'
  totalDisplay: string
  tonconnect: {
    validUntil: number
    messages: Array<{ address: string; amount: string; payload: string }>
  }
  debug?: Record<string, unknown>
}

type Config = {
  tonNetwork: 'testnet' | 'mainnet'
  escrowAddress: string | null
  usdtJettonMaster: string | null
  fee: {
    USDT: { threshold: string; minFee: string; bps: number; decimals: number }
    TON: { threshold: string; minFee: string; bps: number; decimals: number }
  }
}

const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000'

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
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

function App() {
  const wallet = useTonWallet()
  const [tonConnectUI] = useTonConnectUI()

  const [config, setConfig] = useState<Config | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [role, setRole] = useState<'seller' | 'buyer'>('seller')
  const [sellerTgId, setSellerTgId] = useState('111')
  const [buyerTgId, setBuyerTgId] = useState('222')

  const [dealIdInput, setDealIdInput] = useState('')
  const [deal, setDeal] = useState<Deal | null>(null)

  const [currency, setCurrency] = useState<DealCurrency>('TON')
  const [price, setPrice] = useState('10')

  const buyerWalletAddress = wallet?.account?.address

  useEffect(() => {
    try {
      WebApp.ready()
      WebApp.expand()
    } catch {
      // Not in Telegram environment - OK for local dev.
    }
  }, [])

  useEffect(() => {
    apiGet<Config>('/config')
      .then(setConfig)
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  const canSellerActions = role === 'seller'
  const canBuyerActions = role === 'buyer'

  const currentDealId = useMemo(() => deal?.publicId ?? dealIdInput.trim(), [deal?.publicId, dealIdInput])

  async function refreshDeal() {
    if (!currentDealId) return
    setError(null)
    const out = await apiGet<{ deal: Deal | null }>(`/deals/${currentDealId}`)
    setDeal(out.deal)
  }

  async function createDeal() {
    setError(null)
    const out = await apiPost<{ deal: Deal }>('/deals', { sellerTgId })
    setDeal(out.deal)
    setDealIdInput(out.deal.publicId)
  }

  async function joinDeal() {
    setError(null)
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/join`, { buyerTgId })
    setDeal(out.deal)
  }

  async function setDealPrice() {
    setError(null)
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/price`, {
      sellerTgId,
      currency,
      price,
    })
    setDeal(out.deal)
  }

  async function pay() {
    if (!deal?.currency) throw new Error('No currency on deal yet')
    setError(null)
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

  async function manualConfirm() {
    setError(null)
    const out = await apiPost<{ deal: Deal }>(`/deals/${currentDealId}/payment/confirm`, {
      buyerTgId,
      txHash: 'manual-test',
    })
    setDeal(out.deal)
  }

  return (
    <>
      <div className="container">
        <header className="header">
          <div>
            <div className="title">Teleg Escrow Mini App (MVP)</div>
            <div className="sub">
              API: <code>{apiBase}</code>
            </div>
          </div>
          <TonConnectButton />
        </header>

        <section className="card">
          <div className="row">
            <label>Role</label>
            <div className="seg">
              <button className={role === 'seller' ? 'active' : ''} onClick={() => setRole('seller')}>
                Seller
              </button>
              <button className={role === 'buyer' ? 'active' : ''} onClick={() => setRole('buyer')}>
                Buyer
              </button>
            </div>
          </div>

          <div className="grid2">
            <div>
              <label>Seller tgId</label>
              <input value={sellerTgId} onChange={(e) => setSellerTgId(e.target.value)} />
            </div>
            <div>
              <label>Buyer tgId</label>
              <input value={buyerTgId} onChange={(e) => setBuyerTgId(e.target.value)} />
            </div>
          </div>

          <div className="row">
            <label>Buyer wallet</label>
            <div className="mono">{buyerWalletAddress ?? 'not connected'}</div>
          </div>
        </section>

        <section className="card">
          <div className="row">
            <label>Deal ID</label>
            <input
              placeholder="publicId (e.g. 728a77d569e1)"
              value={dealIdInput}
              onChange={(e) => setDealIdInput(e.target.value)}
            />
            <button onClick={() => refreshDeal().catch((e) => setError(String(e?.message ?? e)))}>Load</button>
          </div>

          <div className="actions">
            {canSellerActions && (
              <button className="primary" onClick={() => createDeal().catch((e) => setError(String(e?.message ?? e)))}>
                Create deal
              </button>
            )}
            {canBuyerActions && (
              <button onClick={() => joinDeal().catch((e) => setError(String(e?.message ?? e)))}>Join deal</button>
            )}
            <button onClick={() => refreshDeal().catch((e) => setError(String(e?.message ?? e)))}>Refresh</button>
          </div>
        </section>

        <section className="card">
          <div className="cardTitle">Set price (seller)</div>
          <div className="grid2">
            <div>
              <label>Currency</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value as DealCurrency)}>
                <option value="TON">TON</option>
                <option value="USDT">USDT</option>
              </select>
            </div>
            <div>
              <label>Price</label>
              <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 20" />
            </div>
          </div>
          <div className="actions">
            <button
              disabled={!canSellerActions || !currentDealId}
              onClick={() => setDealPrice().catch((e) => setError(String(e?.message ?? e)))}
            >
              Lock price
            </button>
          </div>
        </section>

        <section className="card">
          <div className="cardTitle">Payment (buyer)</div>
          <div className="grid2">
            <div>
              <label>Status</label>
              <div className="mono">{deal?.status ?? '-'}</div>
            </div>
            <div>
              <label>Total</label>
              <div className="mono">
                {deal?.totalDisplay ? `${deal.totalDisplay} ${deal.currency ?? ''}` : '-'}
              </div>
            </div>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={!canBuyerActions || !deal || !wallet}
              onClick={() => pay().catch((e) => setError(String(e?.message ?? e)))}
            >
              Pay via Telegram Wallet
            </button>
            <button
              disabled={!canBuyerActions || !deal}
              onClick={() => manualConfirm().catch((e) => setError(String(e?.message ?? e)))}
            >
              Manual confirm (test)
            </button>
          </div>
        </section>

        <section className="card">
          <div className="cardTitle">Deal JSON</div>
          <pre className="pre">{deal ? JSON.stringify(deal, null, 2) : 'No deal loaded'}</pre>
        </section>

        <section className="card">
          <div className="cardTitle">Backend config</div>
          <pre className="pre">{config ? JSON.stringify(config, null, 2) : 'Loading...'}</pre>
        </section>

        {error && (
          <section className="card error">
            <div className="cardTitle">Error</div>
            <pre className="pre">{error}</pre>
          </section>
        )}
      </div>
    </>
  )
}

export default App
