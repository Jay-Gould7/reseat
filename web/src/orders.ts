import { Contract, type TransactionReceipt } from "ethers";
import { baseAbi, localText, networks, reader } from "./chain";

export interface Order {
  id: string; buyer: string; qty: number; deadline: number; status: number;
}
export interface QueueSnapshot {
  block: number; now: number; first: bigint; orders: Order[]; complete: boolean;
}
export interface OrderConfirmation { order: Order; block: number }

export const isOpen = (order: Order, now: number) => order.status === 1 && now < order.deadline;
export const fifo = (a: Order, b: Order) => a.id.length - b.id.length || a.id.localeCompare(b.id);

export function orderStatus(order: Order, now: number) {
  if (order.status === 1 && now >= order.deadline) return localText("Deadline passed", "已过截止时间");
  const en = ["Unknown", "Waiting", "Issued", "Expired on Base", "Cancelled", "Skipped · Payment failed"];
  const zh = ["未知", "候补中", "已出票", "已确认过期", "已取消", "已跳过 · 支付失败"];
  return localText(en[order.status] ?? en[0], zh[order.status] ?? zh[0]);
}

// Read the head and newest entries first, then walk the remaining IDs in bounded pages.
// Every view call in a scan uses the same Base block.
async function readPages(event: Contract, block: number, first: bigint, end: bigint, headFirst: boolean,
  stopped: () => boolean, page: (orders: Order[]) => void) {
  let cursor = end, includeHead = headFirst && first < end;
  const lower = headFirst ? first + 1n : first;
  while ((includeHead || cursor > lower) && !stopped()) {
    const ids: bigint[] = [];
    if (includeHead) { ids.push(first); includeHead = false; }
    while (cursor > lower && ids.length < 12) ids.push(--cursor);
    const rows = await Promise.all(ids.map(async id => {
      const o = await event.orderInfo(id, { blockTag: block });
      return { id: String(id), buyer: String(o.buyer), qty: Number(o.qty), deadline: Number(o.deadline), status: Number(o.status) };
    }));
    if (!stopped()) page(rows);
  }
}

export function createQueueReader(source: string) {
  let previous: { snapshot: QueueSnapshot; hash: string; end: bigint; active: bigint } | undefined;
  return async (stopped: () => boolean, partial: (queue: QueueSnapshot) => void): Promise<QueueSnapshot> => {
    const rpc = await reader("base");
    const block = await rpc.getBlock("latest");
    if (!block?.hash) throw new Error(localText("Base block unavailable.", "暂时无法读取 Base 区块。"));
    const event = new Contract(source, baseAbi, rpc), at = { blockTag: block.number };
    const [first, end, active, anchor] = await Promise.all([
      event.headId(at) as Promise<bigint>, event.nextId(at) as Promise<bigint>, event.activeOrders(at) as Promise<bigint>,
      previous && previous.snapshot.block !== block.number ? rpc.getBlock(previous.snapshot.block) : block,
    ]);
    // Enqueues increase nextId and every resolution decreases activeOrders. Expiry alone only changes the clock.
    if (previous && anchor?.hash === previous.hash && first === previous.snapshot.first && end === previous.end && active === previous.active) {
      return { ...previous.snapshot, block: block.number, now: block.timestamp };
    }
    const snapshot: QueueSnapshot = { block: block.number, now: block.timestamp, first, orders: [], complete: false };
    await readPages(event, block.number, first, end, true, stopped, rows => {
      snapshot.orders.push(...rows);
      if (BigInt(snapshot.orders.length) < end - first) partial({ ...snapshot, orders: [...snapshot.orders] });
    });
    snapshot.complete = true;
    if (!stopped()) previous = { snapshot, hash: block.hash, end, active };
    return snapshot;
  };
}

// Older IDs are already resolved. Read them only when the wallet opens its history.
export async function readPastOrders(source: string, account: string, end: bigint, block: number, stopped: () => boolean, page: (orders: Order[]) => void) {
  if (end <= 1n) return;
  const rpc = await reader("base");
  const event = new Contract(source, baseAbi, rpc);
  const buyer = account.toLowerCase();
  await readPages(event, block, 1n, end, false, stopped, rows => {
    const owned = rows.filter(o => o.buyer.toLowerCase() === buyer);
    if (owned.length) page(owned);
  });
}

export function confirmedOrder(receipt: TransactionReceipt, source: string, buyer: string, previous?: Order): OrderConfirmation | undefined {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== source.toLowerCase()) continue;
    const entry = networks.base.abi.parseLog(log);
    if (!entry) continue;
    const a = entry.args;
    if (entry.name === "Queued" && a.buyer.toLowerCase() === buyer.toLowerCase()) {
      return { block: receipt.blockNumber, order: { id: String(a.id), buyer: a.buyer, qty: Number(a.qty), deadline: Number(a.deadline), status: 1 } };
    }
    if (entry.name === "OrderResolved" && previous?.id === String(a.id) && previous.buyer.toLowerCase() === buyer.toLowerCase()) {
      return { block: receipt.blockNumber, order: { ...previous, status: Number(a.status) } };
    }
  }
}
