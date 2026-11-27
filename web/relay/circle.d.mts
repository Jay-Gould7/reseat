import type { Provider, TypedDataField } from "ethers";
export const circleAddress: string;
export const receiveTypes: Record<string, TypedDataField[]>;
export function checkCircleAuthorization(rpc: Provider, source: string, order: {
  buyer: string; qty: number; deadline: number; v: number; r: string; s: string;
}, price: bigint, nonce: string, blockTag: number): Promise<string | undefined>;
