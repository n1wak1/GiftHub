import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, SendMode, comment, internal } from '@ton/core';
import { JettonWallet, TonClient, WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import type { Currency } from './domain.js';
import { buildJettonTransferPayload } from './jetton.js';
import { getTonNetwork, getUsdtJettonMaster } from './ton.config.js';
import { resolveJettonWalletAddress } from './tonapi.js';

type WalletVersion = 'v3r2' | 'v4' | 'v5r1';

type WalletCandidate = {
  version: WalletVersion;
  wallet: WalletContractV3R2 | WalletContractV4 | WalletContractV5R1;
};

type MnemonicEnv = {
  key: string;
  value: string;
  source: 'plain' | 'base64' | 'json' | 'file';
  filePath?: string;
};

export type WithdrawalSendResult = {
  txHash: string;
  seqno: number;
  escrowWalletAddress: string;
  walletVersion: WalletVersion;
};

export type EscrowWithdrawalConfigStatus = {
  configured: boolean;
  mnemonicEnvKey: string | null;
  mnemonicEnvSource: MnemonicEnv['source'] | null;
  mnemonicWordCount: number;
  escrowEnvKeysVisible: string[];
  mnemonicSecretFilesChecked: string[];
  mnemonicSecretFileFound: string | null;
  secretDirectoryFiles: Record<string, string[] | string>;
  escrowAddress: string | null;
  walletVersion: WalletVersion | null;
  walletAddress: string | null;
  matchesEscrowAddress: boolean;
  error: string | null;
};

function toncenterJsonRpcEndpoint(): string {
  return getTonNetwork() === 'mainnet'
    ? 'https://toncenter.com/api/v2/jsonRPC'
    : 'https://testnet.toncenter.com/api/v2/jsonRPC';
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer nanotons value`);
  return BigInt(raw);
}

function normalizeMnemonic(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function mnemonicWords(raw: string): string[] {
  return normalizeMnemonic(raw).replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
}

function visibleEscrowEnvKeys(): string[] {
  const interesting = /^(ESCROW|TON_WITHDRAW|USDT_WITHDRAW|USDT_GAS|USDT_FORWARD|TON_NETWORK|TONCENTER)/;
  return Object.keys(process.env)
    .filter((key) => interesting.test(key))
    .sort();
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v?.trim())).map((v) => v.trim()))];
}

function mnemonicSecretFileCandidates(): string[] {
  return uniqueStrings([
    process.env.ESCROW_WALLET_MNEMONIC_FILE,
    process.env.ESCROW_MNEMONIC_FILE,
    '/etc/secrets/.env',
    '/etc/secrets/ESCROW_WALLET_MNEMONIC',
    '/etc/secrets/ESCROW_MNEMONIC',
    '/etc/secrets/escrow_wallet_mnemonic',
    '/etc/secrets/escrow-mnemonic.txt',
    join(process.cwd(), '.env'),
    join(process.cwd(), 'ESCROW_WALLET_MNEMONIC'),
    join(process.cwd(), 'ESCROW_MNEMONIC'),
    join(process.cwd(), 'escrow_wallet_mnemonic'),
    join(process.cwd(), 'escrow-mnemonic.txt')
  ]);
}

function safeDirectoryFiles(dir: string): string[] | string {
  try {
    if (!existsSync(dir)) return 'missing';
    const stat = statSync(dir);
    if (!stat.isDirectory()) return 'not a directory';
    return readdirSync(dir).sort();
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

function secretDirectoryFiles(): Record<string, string[] | string> {
  return {
    '/etc/secrets': safeDirectoryFiles('/etc/secrets'),
    [process.cwd()]: safeDirectoryFiles(process.cwd())
  };
}

function parseMnemonicSecretFile(raw: string): string {
  const trimmed = raw.trim();
  const keys = new Set([
    'ESCROW_WALLET_MNEMONIC',
    'ESCROW_MNEMONIC',
    'ESCROW_SEED_PHRASE',
    'ESCROW_WALLET_SEED',
    'ESCROW_WALLET_MNEMONIC_BASE64',
    'ESCROW_MNEMONIC_BASE64'
  ]);

  for (const lineRaw of trimmed.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !keys.has(m[1])) continue;
    const value = normalizeMnemonic(m[2]);
    if (m[1].endsWith('_BASE64')) {
      try {
        return Buffer.from(value, 'base64').toString('utf8');
      } catch {
        return value;
      }
    }
    return value;
  }

  return trimmed;
}

function readMnemonicSecretFile(): MnemonicEnv | null {
  for (const filePath of mnemonicSecretFileCandidates()) {
    try {
      if (!existsSync(filePath)) continue;
      const value = parseMnemonicSecretFile(readFileSync(filePath, 'utf8'));
      if (value.trim()) return { key: 'SECRET_FILE', value, source: 'file', filePath };
    } catch {
      /* try next path */
    }
  }
  return null;
}

function tryReadBase64Mnemonic(key: string): MnemonicEnv | null {
  const raw = process.env[key]?.trim();
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (mnemonicWords(decoded).length >= 12) return { key, value: decoded, source: 'base64' };
  } catch {
    /* ignore invalid base64 */
  }
  return null;
}

function tryReadJsonMnemonic(key: string): MnemonicEnv | null {
  const raw = process.env[key]?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return { key, value: parsed.join(' '), source: 'json' };
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as { mnemonic?: unknown }).mnemonic === 'string') {
      return { key, value: (parsed as { mnemonic: string }).mnemonic, source: 'json' };
    }
  } catch {
    /* ignore invalid json */
  }
  return null;
}

function readMnemonicEnv(): MnemonicEnv | null {
  const names = ['ESCROW_WALLET_MNEMONIC', 'ESCROW_MNEMONIC', 'ESCROW_SEED_PHRASE', 'ESCROW_WALLET_SEED'];
  for (const key of names) {
    const value = process.env[key];
    if (value?.trim()) return { key, value: normalizeMnemonic(value), source: 'plain' };
  }

  const file = readMnemonicSecretFile();
  if (file) return file;

  const base64Names = ['ESCROW_WALLET_MNEMONIC_BASE64', 'ESCROW_MNEMONIC_BASE64', 'ESCROW_SEED_PHRASE_BASE64'];
  for (const key of base64Names) {
    const value = tryReadBase64Mnemonic(key);
    if (value) return value;
  }

  const jsonNames = ['ESCROW_WALLET_MNEMONIC_JSON', 'ESCROW_MNEMONIC_JSON'];
  for (const key of jsonNames) {
    const value = tryReadJsonMnemonic(key);
    if (value) return value;
  }
  return null;
}

function escrowMnemonicWords(): string[] {
  const mnemonic = readMnemonicEnv();
  const raw = mnemonic?.value ?? '';
  if (!raw) {
    throw new Error(
      'ESCROW_WALLET_MNEMONIC is not configured on server. Add it to the Render backend service environment and redeploy.'
    );
  }
  const words = raw.replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 12) throw new Error('ESCROW_WALLET_MNEMONIC looks invalid');
  return words;
}

function friendlyAddress(address: Address): string {
  return address.toString({
    urlSafe: true,
    bounceable: false,
    testOnly: getTonNetwork() === 'testnet'
  });
}

function createWalletCandidates(publicKey: Buffer): WalletCandidate[] {
  const v5NetworkGlobalId = getTonNetwork() === 'mainnet' ? -239 : -3;
  return [
    { version: 'v4', wallet: WalletContractV4.create({ workchain: 0, publicKey }) },
    {
      version: 'v5r1',
      wallet: WalletContractV5R1.create({
        publicKey,
        walletId: {
          networkGlobalId: v5NetworkGlobalId,
          context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber: 0 }
        }
      })
    },
    { version: 'v3r2', wallet: WalletContractV3R2.create({ workchain: 0, publicKey }) }
  ];
}

async function openEscrowWallet() {
  const key = await mnemonicToPrivateKey(escrowMnemonicWords(), process.env.ESCROW_WALLET_PASSWORD?.trim() || undefined);
  const candidates = createWalletCandidates(key.publicKey);
  const expectedRaw = process.env.ESCROW_ADDRESS?.trim();
  const expected = expectedRaw ? Address.parse(expectedRaw) : null;
  const requestedVersion = process.env.ESCROW_WALLET_VERSION?.trim().toLowerCase() as WalletVersion | undefined;

  let selected: WalletCandidate | undefined;
  if (requestedVersion) {
    selected = candidates.find((c) => c.version === requestedVersion);
    if (!selected) throw new Error('ESCROW_WALLET_VERSION must be one of: v4, v5r1, v3r2');
  } else if (expected) {
    selected = candidates.find((c) => c.wallet.address.equals(expected));
  } else {
    selected = candidates[0];
  }

  if (!selected) {
    const derived = candidates.map((c) => `${c.version}=${friendlyAddress(c.wallet.address)}`).join(', ');
    throw new Error(`ESCROW_WALLET_MNEMONIC does not match ESCROW_ADDRESS. Derived addresses: ${derived}`);
  }

  if (expected && !selected.wallet.address.equals(expected)) {
    throw new Error(
      `ESCROW_WALLET_MNEMONIC/${selected.version} address ${friendlyAddress(selected.wallet.address)} does not match ESCROW_ADDRESS ${expectedRaw}`
    );
  }

  const client = new TonClient({
    endpoint: toncenterJsonRpcEndpoint(),
    apiKey: process.env.TONCENTER_API_KEY?.trim() || undefined
  });
  const opened = client.open(selected.wallet) as any;
  return { client, opened, wallet: selected.wallet as any, key, version: selected.version, address: selected.wallet.address };
}

export async function getEscrowWithdrawalConfigStatus(): Promise<EscrowWithdrawalConfigStatus> {
  const mnemonic = readMnemonicEnv();
  const escrowAddress = process.env.ESCROW_ADDRESS?.trim() || null;
  const wordCount = mnemonic ? mnemonicWords(mnemonic.value).length : 0;
  const escrowEnvKeysVisible = visibleEscrowEnvKeys();
  const mnemonicSecretFilesChecked = mnemonicSecretFileCandidates();
  const dirs = secretDirectoryFiles();

  if (!mnemonic) {
    return {
      configured: false,
      mnemonicEnvKey: null,
      mnemonicEnvSource: null,
      mnemonicWordCount: 0,
      escrowEnvKeysVisible,
      mnemonicSecretFilesChecked,
      mnemonicSecretFileFound: null,
      secretDirectoryFiles: dirs,
      escrowAddress,
      walletVersion: null,
      walletAddress: null,
      matchesEscrowAddress: false,
      error: 'ESCROW_WALLET_MNEMONIC is not visible to the backend process. Save env on the Render backend service, then restart or redeploy the service.'
    };
  }

  try {
    const key = await mnemonicToPrivateKey(escrowMnemonicWords(), process.env.ESCROW_WALLET_PASSWORD?.trim() || undefined);
    const candidates = createWalletCandidates(key.publicKey);
    const expected = escrowAddress ? Address.parse(escrowAddress) : null;
    const requestedVersion = process.env.ESCROW_WALLET_VERSION?.trim().toLowerCase() as WalletVersion | undefined;
    const selected = requestedVersion
      ? candidates.find((c) => c.version === requestedVersion)
      : expected
        ? candidates.find((c) => c.wallet.address.equals(expected))
        : candidates[0];

    if (!selected) {
      return {
        configured: true,
        mnemonicEnvKey: mnemonic.key,
        mnemonicEnvSource: mnemonic.source,
        mnemonicWordCount: wordCount,
        escrowEnvKeysVisible,
        mnemonicSecretFilesChecked,
        mnemonicSecretFileFound: mnemonic.filePath ?? null,
        secretDirectoryFiles: dirs,
        escrowAddress,
        walletVersion: null,
        walletAddress: null,
        matchesEscrowAddress: false,
        error: requestedVersion
          ? 'ESCROW_WALLET_VERSION must be one of: v4, v5r1, v3r2'
          : 'Mnemonic is set, but none of the supported wallet versions matches ESCROW_ADDRESS'
      };
    }

    const walletAddress = friendlyAddress(selected.wallet.address);
    return {
      configured: true,
      mnemonicEnvKey: mnemonic.key,
      mnemonicEnvSource: mnemonic.source,
      mnemonicWordCount: wordCount,
      escrowEnvKeysVisible,
      mnemonicSecretFilesChecked,
      mnemonicSecretFileFound: mnemonic.filePath ?? null,
      secretDirectoryFiles: dirs,
      escrowAddress,
      walletVersion: selected.version,
      walletAddress,
      matchesEscrowAddress: expected ? selected.wallet.address.equals(expected) : false,
      error: expected && !selected.wallet.address.equals(expected)
        ? 'Mnemonic-derived wallet address does not match ESCROW_ADDRESS'
        : null
    };
  } catch (e) {
    return {
      configured: true,
      mnemonicEnvKey: mnemonic.key,
      mnemonicEnvSource: mnemonic.source,
      mnemonicWordCount: wordCount,
      escrowEnvKeysVisible,
      mnemonicSecretFilesChecked,
      mnemonicSecretFileFound: mnemonic.filePath ?? null,
      secretDirectoryFiles: dirs,
      escrowAddress,
      walletVersion: null,
      walletAddress: null,
      matchesEscrowAddress: false,
      error: (e as Error).message
    };
  }
}

async function sendSignedMessages(params: {
  messages: ReturnType<typeof internal>[];
  minTonBalance: bigint;
}): Promise<WithdrawalSendResult> {
  const escrow = await openEscrowWallet();
  const walletBalance = await escrow.opened.getBalance();
  if (walletBalance < params.minTonBalance) {
    throw new Error('Escrow wallet has not enough TON for withdrawal amount and network gas');
  }

  const seqno = await escrow.opened.getSeqno();
  const transfer = (await Promise.resolve(
    escrow.wallet.createTransfer({
      seqno,
      secretKey: escrow.key.secretKey,
      messages: params.messages,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      timeout: Math.floor(Date.now() / 1000) + 120
    })
  )) as Cell;

  await escrow.opened.send(transfer);
  return {
    txHash: transfer.hash().toString('base64'),
    seqno,
    escrowWalletAddress: friendlyAddress(escrow.address),
    walletVersion: escrow.version
  };
}

export async function sendProfileWithdrawal(params: {
  withdrawalId: string;
  currency: Currency;
  amountBaseUnits: bigint;
  destinationWallet: string;
}): Promise<WithdrawalSendResult> {
  const destination = Address.parse(params.destinationWallet);
  const withdrawComment = `gifthub-withdraw:${params.withdrawalId}`;

  if (params.currency === 'TON') {
    const gasReserve = envBigInt('TON_WITHDRAW_GAS_RESERVE_NANOTON', 50_000_000n);
    return sendSignedMessages({
      minTonBalance: params.amountBaseUnits + gasReserve,
      messages: [
        internal({
          to: destination,
          value: params.amountBaseUnits,
          bounce: false,
          body: comment(withdrawComment)
        })
      ]
    });
  }

  const escrowAddress = process.env.ESCROW_ADDRESS?.trim();
  if (!escrowAddress) throw new Error('ESCROW_ADDRESS is not configured on server');
  const usdtJettonMaster = getUsdtJettonMaster();
  if (!usdtJettonMaster) throw new Error('USDT_JETTON_MASTER is not configured on server');

  const escrow = await openEscrowWallet();
  const escrowJettonWallet = await resolveJettonWalletAddress({
    jettonMaster: usdtJettonMaster,
    ownerAddress: escrowAddress
  });
  const jettonBalance = await (escrow.client.open(JettonWallet.create(Address.parse(escrowJettonWallet))) as any).getBalance();
  if (jettonBalance < params.amountBaseUnits) {
    throw new Error('Escrow USDT jetton balance is lower than requested withdrawal');
  }

  const gasAmount = process.env.USDT_WITHDRAW_GAS_NANOTON?.trim()
    ? envBigInt('USDT_WITHDRAW_GAS_NANOTON', 50_000_000n)
    : envBigInt('USDT_GAS_NANOTON', 50_000_000n);
  const forwardAmount = envBigInt('USDT_FORWARD_NANOTON', 1n);
  const payload = buildJettonTransferPayload({
    jettonAmount: params.amountBaseUnits,
    recipient: destination.toString({ urlSafe: true, bounceable: false, testOnly: getTonNetwork() === 'testnet' }),
    responseDestination: escrowAddress,
    forwardTonAmount: forwardAmount,
    comment: withdrawComment
  });

  return sendSignedMessages({
    minTonBalance: gasAmount + 20_000_000n,
    messages: [
      internal({
        to: escrowJettonWallet,
        value: gasAmount,
        bounce: true,
        body: Cell.fromBase64(payload)
      })
    ]
  });
}
