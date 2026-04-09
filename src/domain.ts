export type Currency = 'TON' | 'USDT';
export type GiftStatus = 'AVAILABLE' | 'RESERVED' | 'SENT';

export type DealStatus =
  | 'CREATED'
  | 'WAITING_FOR_BUYER'
  | 'WAITING_FOR_PRICE'
  | 'WAITING_FOR_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'WAITING_FOR_GIFT'
  | 'GIFT_RESERVED'
  | 'RELEASING'
  | 'COMPLETED'
  | 'CANCELLED';

export type Deal = {
  id: string;
  publicId: string;

  sellerTgId: bigint;
  buyerTgId?: bigint;

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
  status: GiftStatus;
  reservedDealPublicId?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserProfile = {
  tgId: bigint;
  payoutWalletAddress?: string;
  createdAt: string;
  updatedAt: string;
};

