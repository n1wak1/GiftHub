# Teleg Escrow (MVP)

Backend + Telegram Mini App skeleton for escrow deals.

## Quick Start (one command)

1. Install deps once:

```powershell
npm install
npm --prefix miniapp install
```

2. Create backend env once:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

3. Run both backend + frontend:

```powershell
npm run dev:all
```

Open:
- Frontend: `http://127.0.0.1:5173`
- Backend health: `http://127.0.0.1:3000/health`
- Backend config: `http://127.0.0.1:3000/config`

## Scripts

- `npm run dev:all` - start backend and frontend together
- `npm run dev:backend` - backend only
- `npm run dev:frontend` - frontend only

## Backend env vars (`.env`)

- `TON_NETWORK`: `testnet` (default) or `mainnet`.
- `ESCROW_ADDRESS`: TON address that receives buyer payment (`price + fee`).
- `ESCROW_WALLET_MNEMONIC`: 24-word seed for the escrow wallet. Required for automatic profile withdrawals; it must derive `ESCROW_ADDRESS`.
- Accepted seed aliases: `ESCROW_MNEMONIC`, `ESCROW_SEED_PHRASE`, `ESCROW_WALLET_SEED`.
- If Render does not pass the plain seed value, use `ESCROW_WALLET_MNEMONIC_BASE64` with the same seed encoded as UTF-8 base64.
- Alternative for Render: create a Secret File named `ESCROW_WALLET_MNEMONIC` with the 24 words inside; the backend checks `/etc/secrets/ESCROW_WALLET_MNEMONIC`.
- `ESCROW_WALLET_VERSION`: optional wallet version override: `v4`, `v5r1`, or `v3r2`. If unset, the backend auto-detects by matching `ESCROW_ADDRESS`.
- `TON_WITHDRAW_GAS_RESERVE_NANOTON`: extra TON reserve required on escrow for exact TON withdrawals (default `50000000` = 0.05 TON).
- `SERVICE_FEE_ADDRESS`: wallet address that receives your platform fee on release.
- `USDT_JETTON_MASTER`: USDT Jetton master contract address (optional; has defaults for testnet/mainnet).
- `TONAPI_KEY`: optional TonAPI key (increases rate limits).
- `TONCENTER_API_KEY`: optional Toncenter key for higher limits on tx scanning.
- `TELEGRAM_BOT_TOKEN`: bot token for profile avatars, invite buttons, and Telegram Business gift operations.
- `TELEGRAM_BUSINESS_CONNECTION_ID`: Business connection id for the vault contact/account that stores transferable Telegram gifts.
- `TELEGRAM_VAULT_CONTACT_USERNAME`: vault contact username shown/opened by the Mini App when a user deposits a gift.
- `TELEGRAM_BUSINESS_GIFT_TRANSFER_ENABLED`: set to `true` only when Telegram allows the bot to transfer gifts; leave empty/false for manual vault transfers.
- `ADMIN_SECRET`: secret used by manual admin endpoints after you transfer a gift from the vault account by hand.
- `USDT_GAS_NANOTON`: TON amount attached to USDT jetton transfer (default `50000000` = 0.05 TON).
- `USDT_WITHDRAW_GAS_NANOTON`: TON amount attached to USDT withdrawal jetton transfer (default: `USDT_GAS_NANOTON` or 0.05 TON).
- `USDT_FORWARD_NANOTON`: forward TON amount in jetton transfer payload (default `1`).
- `MIN_FEE_USDT` (default `0.2`)
- `FEE_THRESHOLD_USDT` (default `15`)
- `FEE_BPS_USDT` (default `500` = 5%)
- `MIN_FEE_TON` (default `0.02`)
- `FEE_THRESHOLD_TON` (default `15`)
- `FEE_BPS_TON` (default `500`)

## Main API

- `GET /health`
- `GET /config`
- `POST /profiles/wallet`
- `GET /profiles/:tgId`
- `POST /gifts/deposit` (MVP mock for deposited NFT/gift)
- `GET /gifts/:ownerTgId`
- `POST /deals`
- `GET /deals/:publicId`
- `POST /deals/:publicId/join`
- `POST /deals/:publicId/price`
- `POST /deals/:publicId/pay-request`
- `POST /deals/:publicId/payment/confirm`
- `POST /deals/:publicId/payment/auto-confirm`
  - TON: scans escrow in-msg by amount + `deal:<publicId>` comment
  - USDT: scans incoming jetton transfers by amount + destination + USDT jetton master
- `POST /deals/:publicId/gift/reserve`
- `POST /deals/:publicId/gift/unreserve`
- `POST /deals/:publicId/release`
- `POST /admin/deals/:publicId/gift-transfer/confirm` (manual vault transfer confirmation)
- `POST /admin/gifts/withdraw/manual-confirm` (manual gift withdraw confirmation)
