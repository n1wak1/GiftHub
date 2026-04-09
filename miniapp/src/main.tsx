import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { TonConnectUIProvider } from '@tonconnect/ui-react'

// Default: same origin as the Mini App. Optional override: see .env.example (ngrok / free tunnels often break
// server-side manifest fetch — TON docs: wallets load the JSON from outside the WebView).
const manifestUrl =
  import.meta.env.VITE_TONCONNECT_MANIFEST_URL?.trim() ||
  `${window.location.origin}/tonconnect-manifest.json`

if (import.meta.env.DEV) {
  console.info('[TonConnect] manifestUrl =', manifestUrl)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TonConnectUIProvider manifestUrl={manifestUrl}>
      <App />
    </TonConnectUIProvider>
  </StrictMode>,
)
