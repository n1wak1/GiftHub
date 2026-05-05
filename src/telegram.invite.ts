export function presentDealForMiniappInvite(params: {
  miniappUrl: string;
  dealPublicId: string;
  join: 'buyer' | 'seller';
}): string {
  const base = params.miniappUrl.replace(/\/$/, '');
  const u = new URL(base);
  u.searchParams.set('deal', params.dealPublicId);
  u.searchParams.set('join', params.join);
  return u.toString();
}

export function presentBotDeepLink(params: {
  botUsername: string;
  dealPublicId: string;
  join: 'buyer' | 'seller';
}): string {
  const payload = `deal.${params.dealPublicId}.${params.join}`;
  return `https://t.me/${params.botUsername}?start=${encodeURIComponent(payload)}`;
}

