import { Contract, isHexString, type Provider } from "ethers";
import { baseAbi, localText as t, reader } from "./chain";
import type { OrderConfirmation } from "./orders";
import type { Notify } from "./wallet";

export function sponsorshipMessage(code: string) {
  switch (code) {
    case "ready": return t("The event pays the Base fee for joining and cancelling. Your wallet only signs.", "加入和取消候补的 Base 手续费由活动支付，你只需签名。");
    case "legacy": return t("This older event requires a wallet transaction and Base gas to join or cancel.", "这场旧版活动加入和取消候补都需要钱包发交易并支付 Base 手续费。");
    case "event-funds": return t("The host needs to replenish this event’s Base callback credit.", "本场活动的回调经费不足，请主办方补充 Base 测试 ETH。");
    case "relay-funds": return t("Top up the Lasna relay wallet with lREACT for forwarding transactions.", "Lasna 转发钱包的手续费不足，请在活动经费页为转发钱包补充 lREACT。");
    case "watcher-funds": return t("Top up the Lasna watcher’s execution credit or clear its debt.", "Lasna 监听合约的执行经费不足或存在欠费，请在活动经费页为监听合约充值。");
    case "wallet-signature": return t("Circle USDC cannot collect with this smart account signature. Switch to a standard wallet account and sign again.", "Circle USDC 无法使用这个智能账户的签名扣款。请切换到普通钱包账户后重新签名。");
    case "order-owner-signature": return t("This signature does not identify the ticket buyer. Switch to a standard wallet account and sign again.", "这份签名无法确认候补订单属于你。请切换到普通钱包账户后重新签名。");
    case "collection-unavailable": return t("USDC could not simulate this payment. Check the ticket balance and token availability before retrying.", "USDC 收款预检未通过，请核对整单 USDC 余额和代币状态后重试。");
    case "binding": return t("Waiting for the event and watcher to confirm activation.", "正在等待活动和候补合约确认绑定。");
    case "checking": return t("Checking the event’s gas sponsorship…", "正在核对本场活动的代付状态…");
    case "invalid-order": return t("Base could not accept this signed request. Check availability, ownership and the deadline.", "Base 未接受本次签名请求，请核对余票、订单归属和截止时间。");
    case "busy": return t("The relay is busy. Try again shortly.", "代付服务正忙，请稍后重试。");
    default: return t("The ReSeat relay is unavailable. The operator can restore sponsorship.", "ReSeat 代付服务暂不可用，请联系活动方恢复服务。");
  }
}

async function api(source: string, body?: object) {
  try {
    const response = await fetch("/api/waitlist/" + source, { method: body ? "POST" : "GET", cache: "no-store",
      signal: AbortSignal.timeout(20_000), ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json();
    return { status: String(data.status), delivery: data.delivery, hash: isHexString(data.hash, 32) ? data.hash as string : undefined };
  } catch { return { status: "offline", delivery: "unknown", hash: undefined }; }
}
export async function sponsorshipStatus(source: string, action: "join" | "cancel" = "join") { return (await api(source + "?action=" + action)).status; }
export async function requireSponsorship(source: string, action: "join" | "cancel" = "join") {
  const state = await sponsorshipStatus(source, action);
  if (state !== "ready") throw new Error(sponsorshipMessage(state));
}

// Only the salt and public terms are saved. The signature is never written to browser storage.
export type JoinDraft = { salt: string; qty: number; deadline: number; sentAt?: number; hash?: string };
const drafts = new Map<string, JoinDraft>();
const draftKey = (source: string, buyer: string) => "reseat:pending:84532:" + source.toLowerCase() + ":" + buyer.toLowerCase();
export function pendingJoin(source: string, buyer: string): JoinDraft | undefined {
  const key = draftKey(source, buyer);
  try {
    const data = JSON.parse(localStorage.getItem(key) || "null");
    if (data && isHexString(data.salt, 32) && Number.isSafeInteger(data.qty) && Number.isSafeInteger(data.deadline)) return data;
  } catch { /* Storage is optional. */ }
  return drafts.get(key);
}
export function saveJoin(source: string, buyer: string, draft?: JoinDraft) {
  const key = draftKey(source, buyer);
  if (draft) drafts.set(key, draft); else drafts.delete(key);
  try { if (draft) localStorage.setItem(key, JSON.stringify(draft)); else localStorage.removeItem(key); } catch { /* Use memory. */ }
}
export function forgetJoin(source: string, buyer: string, salt: string) {
  if (pendingJoin(source, buyer)?.salt === salt) saveJoin(source, buyer);
}

export class PendingDelivery extends Error {
  constructor(readonly hash?: string, unknown = false) {
    super(unknown ? t("Delivery could not be confirmed. Your original request is saved while ReSeat checks Base.", "暂时无法确定请求是否发出。已保留原订单，刷新后会继续查询 Base。") :
      t("Request submitted. My waitlist orders will show the result when Base confirms it.", "请求已提交。Base 确认后，「我的候补订单」会显示最终结果。"));
  }
}

type SignedRequest = { v: number; r: string; s: string } & (
  { kind: "join"; buyer: string; qty: number; deadline: number; salt: string } |
  { kind: "cancel"; orderId: string; validBefore: number }
);
export async function submitSponsored(source: string, payload: SignedRequest, prior?: JoinDraft) {
  const result = await api(source, payload);
  if (result.status !== "pending" && result.status !== "confirmed") {
    if (result.delivery !== "not-sent") throw new PendingDelivery(result.hash, true);
    if (payload.kind === "join" && pendingJoin(source, payload.buyer)?.salt === payload.salt) {
      if (prior) saveJoin(source, payload.buyer, prior);
      else forgetJoin(source, payload.buyer, payload.salt);
    }
    throw new Error(sponsorshipMessage(result.status));
  }
  return result.hash;
}

export async function readDelivery(event: Contract, rpc: Provider, buyer: string, ref: { nonce: string } | { id: string }): Promise<OrderConfirmation | undefined> {
  const block = await rpc.getBlock("latest");
  if (!block) throw new Error(t("Base block unavailable.", "暂时无法读取 Base 区块。"));
  const at = { blockTag: block.number };
  const id = "nonce" in ref ? await event.orderIdForNonce(buyer, ref.nonce, at) : BigInt(ref.id);
  if (id === 0n) return;
  const o = await event.orderInfo(id, at);
  if (o.buyer.toLowerCase() !== buyer.toLowerCase()) throw new Error(t("Order owner changed.", "订单所属钱包不匹配。"));
  if ("id" in ref && o.status !== 4n) {
    if (o.status !== 1n) throw new Error(t("Base already resolved this order before cancellation.", "Base 已先处理这笔候补，无法再取消。"));
    return;
  }
  return { block: block.number, order: { id: String(id), buyer: o.buyer, qty: Number(o.qty), deadline: Number(o.deadline), status: Number(o.status) } };
}

export async function awaitDelivery(source: string, buyer: string, ref: { nonce: string } | { id: string }, hash: string | undefined,
  notify: Notify, confirmed: (update: OrderConfirmation) => void) {
  notify(t("The event is paying the fee. Waiting for Base confirmation…", "本场活动代付手续费，正在等待 Base 确认…"), hash, "lasna");
  const rpc = await reader("base"), event = new Contract(source, baseAbi, rpc);
  const until = Date.now() + 30_000;
  do {
    const result = await readDelivery(event, rpc, buyer, ref);
    if (result) { confirmed(result); return; }
    await new Promise(resolve => setTimeout(resolve, 1200));
  } while (Date.now() < until);
  throw new PendingDelivery(hash);
}
