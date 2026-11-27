import { Contract, TypedDataEncoder, concat, keccak256, recoverAddress } from "ethers";

export const circleAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const receiveAbi = ["function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "function DOMAIN_SEPARATOR() view returns(bytes32)"];
export const receiveTypes = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
const authorization = TypedDataEncoder.from(receiveTypes);

// Using eth_call against the token also preserves the USDC caller seen by a caller-sensitive ERC-1271 wallet.
export async function checkCircleAuthorization(rpc, source, order, price, nonce, blockTag) {
  const at = { blockTag };
  if (await rpc.getCode(order.buyer, blockTag) === "0x") return;
  const circle = new Contract(circleAddress, receiveAbi, rpc);
  const value = BigInt(order.qty) * price;
  try {
    await circle.receiveWithAuthorization.staticCall(order.buyer, source, value, 0, order.deadline,
      nonce, order.v, order.r, order.s, { ...at, from: source });
  } catch (error) {
    if (error.code !== "CALL_EXCEPTION") throw error;
    if (error.reason === "FiatTokenV2: invalid signature") return "wallet-signature";
    return "collection-unavailable";
  }
  // A validator can accept a session key while ReSeat still requires the buyer's own ECDSA signature.
  const body = authorization.hash({ from: order.buyer, to: source, value, validAfter: 0, validBefore: order.deadline, nonce });
  const digest = keccak256(concat(["0x1901", await circle.DOMAIN_SEPARATOR(at), body]));
  try {
    if (recoverAddress(digest, order).toLowerCase() !== order.buyer.toLowerCase()) return "order-owner-signature";
  } catch { return "order-owner-signature"; }
}
