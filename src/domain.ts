export type Currency = 'TON' | 'USDT';
export type GiftStatus = 'AVAILABLE' | 'RESERVED' | 'TRANSFER_PENDING' | 'SENT' | 'WITHDRAW_PENDING' | 'WITHDRAWN';
export type GiftSource = 'MANUAL' | 'TELEGRAM_BUSINESS' | 'TELEGRAM_BOT_PROFILE' | 'ONCHAIN_VAULT';
export type TelegramGiftType = 'unique' | 'regular';
export type ProfileDepositStatus = 'PENDING' | 'CONFIRMED';
export type ProfileWithdrawalStatus = 'REQUESTED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
export type DealPaymentSource = 'ONCHAIN' | 'PROFILE_BALANCE';

export type DealStatus =
  | 'CREATED'
  | 'WAITING_FOR_BUYER'
  | 'WAITING_FOR_SELLER'
  | 'WAITING_FOR_PRICE'
  | 'WAITING_FOR_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'WAITING_FOR_GIFT'
  | 'GIFT_RESERVED'
  | 'WAITING_FOR_MANUAL_GIFT_TRANSFER'
  | 'RELEASING'
  | 'COMPLETED'
  | 'CANCELLED';

export type Deal = {
  id: string;
  publicId: string;

  sellerTgId?: bigint;
  buyerTgId?: bigint;

  /** Public Telegram info captured from Mini App initData (works even if Bot API can't read profiles). */
  sellerTelegram?: { firstName?: string; lastName?: string; username?: string; photoUrl?: string };
  buyerTelegram?: { firstName?: string; lastName?: string; username?: string; photoUrl?: string };

  status: DealStatus;

  escrowAddress?: string; // TON address that receives buyer payment (escrow)

  currency?: Currency;
  priceDisplay?: string;
  priceBaseUnits?: bigint;

  feeDisplay?: string;
  feeBaseUnits?: bigint;

  totalDisplay?: string;
  totalBaseUnits?: bigint;

  paymentTxHash?: string;
  paymentSource?: DealPaymentSource;
  paymentConfirmedAt?: string; // ISO
  reservedGiftId?: string;
  giftReservedAt?: string; // ISO
  releasedAt?: string; // ISO
  sellerPayoutAddress?: string;
  sellerPayoutAmountDisplay?: string;
  feeRecipientAddress?: string;
  feeAmountFinalDisplay?: string;
  payoutTxHash?: string;
  giftTransferTxHash?: string;
  manualGiftTransferRequestedAt?: string; // ISO
  giftTransferConfirmedAt?: string; // ISO

  priceLockedAt?: string; // ISO
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

export type GiftAsset = {
  id: string;
  ownerTgId: bigint;
  giftId: string; // unique gift/NFT id from Telegram
  title?: string;
  model?: string;
  background?: string;
  telegramGiftName?: string;
  telegramGiftNumber?: number;
  telegramImageFileId?: string;
  telegramImageFileKind?: 'image' | 'video' | 'thumbnail';
  telegramSymbol?: string;
  telegramSymbolFileId?: string;
  backdropCenterColor?: string;
  backdropEdgeColor?: string;
  backdropSymbolColor?: string;
  backdropTextColor?: string;
  source?: GiftSource;
  telegramOwnedGiftId?: string;
  telegramGiftType?: TelegramGiftType;
  telegramSenderUserId?: bigint;
  status: GiftStatus;
  reservedDealPublicId?: string;
  withdrawRequestedAt?: string; // ISO
  withdrawnAt?: string; // ISO
  createdAt: string;
  updatedAt: string;
};

export type UserProfile = {
  tgId: bigint;
  payoutWalletAddress?: string;
  balances?: Partial<Record<Currency, { availableBaseUnits: bigint; reservedBaseUnits: bigint }>>;
  creditedDepositTxHashes?: string[];
  createdAt: string;
  updatedAt: string;
};

export type ProfileDeposit = {
  id: string;
  tgId: bigint;
  currency: Currency;
  amountBaseUnits: bigint;
  walletAddress?: string;
  escrowAddress: string;
  comment: string;
  status: ProfileDepositStatus;
  txHash?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
};

export type ProfileWithdrawal = {
  id: string;
  tgId: bigint;
  currency: Currency;
  amountBaseUnits: bigint;
  walletAddress: string;
  status: ProfileWithdrawalStatus;
  txHash?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
};

