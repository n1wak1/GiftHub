import { Address, beginCell } from '@ton/core';

export function buildJettonTransferPayload(params: {
  jettonAmount: bigint; // in jetton base units
  recipient: string; // TON address
  responseDestination: string; // TON address (usually sender)
  forwardTonAmount: bigint; // nanoTON
  comment?: string; // optional
}): string {
  const recipient = Address.parse(params.recipient);
  const response = Address.parse(params.responseDestination);

  const forwardPayload = params.comment
    ? beginCell()
        .storeUint(0, 32) // text comment opcode
        .storeStringTail(params.comment)
        .endCell()
    : null;

  // Jetton standard transfer op
  const body = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(0, 64) // query id
    .storeCoins(params.jettonAmount)
    .storeAddress(recipient)
    .storeAddress(response)
    .storeBit(false) // no custom payload
    .storeCoins(params.forwardTonAmount)
    .storeMaybeRef(forwardPayload ?? undefined)
    .endCell();

  return body.toBoc().toString('base64');
}

