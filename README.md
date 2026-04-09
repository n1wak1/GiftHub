<<<<<<< HEAD
# GiftHub
Your choice to conduct safe transactions
=======
# Teleg Escrow (MVP)

Backend skeleton for an escrow bot + Telegram Mini App.

## Run (Windows PowerShell)

If `node`/`npm` are not in PATH inside Cursor terminal:

```powershell
$env:Path += ";C:\Program Files\nodejs"
```

Install deps:

```powershell
npm install
```

Set env and start:

```powershell
$env:TON_NETWORK="testnet" # or "mainnet"
$env:ESCROW_ADDRESS="UQB32u8KyV9ddFO0Mi34DMCSGiupNot2yfM4Nu8YIVERfrY9"
# Optional (override default per network):
# $env:USDT_JETTON_MASTER="..."

npm run dev
```

## Env vars

- `TON_NETWORK`: `testnet` (default) or `mainnet`.
- `ESCROW_ADDRESS`: TON address that receives buyer payment (`price + fee`).
- `USDT_JETTON_MASTER`: USDT Jetton master contract address (optional; has defaults for testnet/mainnet).
- `TONAPI_KEY`: optional TonAPI key (increases rate limits).
- `USDT_GAS_NANOTON`: TON amount attached to USDT jetton transfer (default `50000000` = 0.05 TON).
- `USDT_FORWARD_NANOTON`: forward TON amount in jetton transfer payload (default `1`).
- `MIN_FEE_USDT` (default `0.2`)
- `FEE_THRESHOLD_USDT` (default `15`)
- `FEE_BPS_USDT` (default `500` = 5%)
- `MIN_FEE_TON` (default `0.02`)
- `FEE_THRESHOLD_TON` (default `15`)
- `FEE_BPS_TON` (default `500`)

## API

- `GET /health`
- `GET /config`
- `POST /deals`
- `GET /deals/:publicId`
- `POST /deals/:publicId/join`
- `POST /deals/:publicId/price`
- `POST /deals/:publicId/pay-request`

>>>>>>> a042f96 (Ручной confirm)
