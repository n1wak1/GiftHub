export type Currency = 'TON' | 'USDT';

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

  priceLockedAt?: string; // ISO
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

