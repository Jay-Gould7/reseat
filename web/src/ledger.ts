import { zeroPadValue, type JsonRpcProvider, type LogDescription } from "ethers";
import { contractAddress, networks, reader, type Chain } from "./chain";

export interface Entry {
  chain: Chain;
  block: number;
  index: number;
  hash: string;
  time: number;
  event: LogDescription;
}

export interface Order {
  id: string;
  buyer: string;
  qty: number;
  deadline: number;
  status: number;
  hash: string;
}

export const statusNames = ["Unknown", "Waiting", "Issued", "Expired", "Cancelled", "Payment failed"];

export function ordersFrom(entries: Entry[]) {
  const orders = new Map<string, Order>();
  for (const { event, hash } of entries) {
    const a = event.args;
    if (event.name === "Queued") {
      const id = String(a.id);
      orders.set(id, { id, buyer: a.buyer, qty: Number(a.qty), deadline: Number(a.deadline), status: 1, hash });
    } else if (event.name === "OrderResolved") {
      const order = orders.get(String(a.id));
      if (order) order.status = Number(a.status);
    }
  }
  return Array.from(orders.values());
}

async function firstBlock(rpc: JsonRpcProvider, chain: Chain, address: string, head: number) {
  const configured = networks[chain].start;
  if (configured?.trim()) {
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < 0 || value > head) throw new Error("Check the deployment block in .env.");
    return value;
  }
  if (await rpc.getCode(address, head) === "0x") throw new Error("No contract at the configured address.");
  let low = 0, high = head;
  try {
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (await rpc.getCode(address, mid) === "0x") low = mid + 1;
      else high = mid;
    }
  } catch {
    throw new Error("Set the deployment receipt block in VITE_" + (chain === "base" ? "BASE" : "LASNA") + "_START_BLOCK.");
  }
  return low;
}

// One incremental index per chain. Keep the last confirmed checkpoint to detect reorgs.
export function createLedger(chain: Chain, source: string) {
  let start: number | undefined;
  let checkpoint: { number: number; hash: string | null } | undefined;
  let entries: Entry[] = [];
  let span = 5000;
  return async (publish: (entries: Entry[]) => void, stopped: () => boolean) => {
    if (!networks[chain].address) return entries;
    const address = chain === "lasna" ? contractAddress(chain) : source;
    const rpc = await reader(chain);
    const latest = await rpc.getBlockNumber();
    const target = Math.max(0, latest - (chain === "base" ? 2 : 1));
    if (checkpoint && (await rpc.getBlock(checkpoint.number))?.hash !== checkpoint.hash) {
      checkpoint = undefined;
      entries = [];
      publish([]);
    }
    start ??= await firstBlock(rpc, chain, address, latest);
    let from = checkpoint ? checkpoint.number + 1 : start;
    while (from <= target && !stopped()) {
      const to = Math.min(target, from + span - 1);
      let logs;
      try {
        logs = await rpc.getLogs({ address, fromBlock: from, toBlock: to,
          topics: chain === "lasna" ? [null, zeroPadValue(source, 32)] : undefined });
      } catch (error) {
        const detail = JSON.stringify(error, (_, v) => typeof v === "bigint" ? String(v) : v) + " " + String(error);
        if (span <= 1 || !/range|too many|too large|limit exceeded|more than|exceed.*block|-32005/i.test(detail)) throw error;
        span = Math.max(1, Math.floor(span / 2));
        continue;
      }
      const blockNumbers = [...new Set([...logs.map(log => log.blockNumber), to])];
      const times = new Map<number, number>();
      let endHash: string | null = null;
      for (let i = 0; i < blockNumbers.length; i += 6) {
        const blocks = await Promise.all(blockNumbers.slice(i, i + 6).map(n => rpc.getBlock(n)));
        for (const block of blocks) {
          if (!block?.hash) throw new Error("A confirmed block is being reindexed.");
          times.set(block.number, block.timestamp);
          if (block.number === to) endHash = block.hash;
        }
      }
      if (stopped()) return entries;
      const page: Entry[] = [];
      for (const log of logs) {
        const event = networks[chain].abi.parseLog(log);
        if (event) page.push({ chain, block: log.blockNumber, index: log.index, hash: log.transactionHash,
          time: times.get(log.blockNumber)!, event });
      }
      page.sort((a, b) => a.block - b.block || a.index - b.index);
      entries = entries.concat(page);
      checkpoint = { number: to, hash: endHash };
      if (page.length) publish(entries);
      from = to + 1;
    }
    return entries;
  };
}

export function describe(entry: Entry) {
  const a = entry.event.args;
  switch (entry.event.name) {
    case "TicketsIssued": return `${a.qty} ${a.qty === 1n ? "ticket" : "tickets"} ${a.orderId === 0n ? "purchased" : "issued to order #" + a.orderId} · first ID #${a.firstId}`;
    case "BindingConfirmed": return "Base confirmed the waitlist watcher";
    case "PaymentDeferred": return `Payment delayed · order #${a.id} retains priority`;
    case "TicketRefunded": return `Ticket #${a.ticketId} refunded`;
    case "Queued": return `Order #${a.id} joined for ${a.qty} ${a.qty === 1n ? "seat" : "seats"}`;
    case "OrderResolved": return `Order #${a.id} · ${statusNames[Number(a.status)]}`;
    case "SettlementState": return a.heldSpots > 0n ? `Holding ${a.heldSpots} ${a.heldSpots === 1n ? "seat" : "seats"} for order #${a.headId}` :
      a.ready ? `Order #${a.headId} ready for settlement` : "Settlement complete · no seats held";
    case "SourceBound": return "Lasna subscribed to this event";
    case "CronChanged": return a.active ? `CRON tracking order #${a.headId}` :
      a.subscriptionChanged ? "CRON unsubscribed" : "Deadline tracking stopped for this event";
    case "SettlementRequested": return `${a.fromCron ? "CRON" : "Lasna"} requested settlement for order #${a.headId}`;
    case "ProceedsWithdrawn": return "Organizer withdrew ticket proceeds";
    default: return entry.event.name;
  }
}
