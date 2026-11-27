import { zeroPadValue, type JsonRpcProvider, type LogDescription } from "ethers";
import { contractAddress, localText as t, networks, reader, type Chain } from "./chain";

export interface Entry {
  chain: Chain;
  block: number;
  index: number;
  hash: string;
  time: number;
  event: LogDescription;
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
  const topics = chain === "lasna" ? [null, zeroPadValue(source, 32)] : [
    ["TicketsIssued", "TicketRefunded", "BindingConfirmed", "ProceedsWithdrawn"].map(name => networks.base.abi.getEvent(name)!.topicHash),
  ];
  let start: number | undefined;
  let checkpoint: { number: number; hash: string | null } | undefined;
  let entries: Entry[] = [];
  let span = 5000;
  return async (onSync: () => void, stopped: () => boolean) => {
    if (!networks[chain].address) return { entries, through: -1 };
    const address = chain === "lasna" ? contractAddress(chain) : source;
    const rpc = await reader(chain);
    const latest = await rpc.getBlockNumber();
    const target = Math.max(0, latest - (chain === "base" ? 2 : 1));
    if (checkpoint && (await rpc.getBlock(checkpoint.number))?.hash !== checkpoint.hash) {
      checkpoint = undefined;
      entries = [];
    }
    start ??= await firstBlock(rpc, chain, address, latest);
    let from = checkpoint ? checkpoint.number + 1 : start;
    if (from <= target && !stopped()) onSync();
    while (from <= target && !stopped()) {
      const to = Math.min(target, from + span - 1);
      let logs;
      try {
        logs = await rpc.getLogs({ address, fromBlock: from, toBlock: to, topics });
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
      if (stopped()) return { entries, through: checkpoint?.number ?? -1 };
      const page: Entry[] = [];
      for (const log of logs) {
        const event = networks[chain].abi.parseLog(log);
        if (event) page.push({ chain, block: log.blockNumber, index: log.index, hash: log.transactionHash,
          time: times.get(log.blockNumber)!, event });
      }
      page.sort((a, b) => a.block - b.block || a.index - b.index);
      entries = entries.concat(page);
      checkpoint = { number: to, hash: endHash };
      from = to + 1;
    }
    return { entries, through: checkpoint?.number ?? -1 };
  };
}

export function describe(entry: Entry) {
  const a = entry.event.args;
  switch (entry.event.name) {
    case "TicketsIssued": return a.orderId === 0n ? t("Tickets purchased", "购票已完成") : t("Tickets issued from the waitlist", "候补已自动出票");
    case "TicketRefunded": return t("A ticket was refunded", "退票已完成，票款已退回");
    case "BindingConfirmed": return t("Automatic waitlist enabled", "自动候补已启用");
    case "SourceBound": return t("Lasna is listening for changes to this event", "Lasna 已开始监听本场活动");
    case "EnrollmentRequested": return t("Sponsored waitlist entry sent to Base", "已向 Base 提交代付入队请求");
    case "CancellationRequested": return t("Sponsored cancellation sent to Base", "已向 Base 提交代付取消请求");
    case "CronChanged": return a.active ? t("Automatic deadline checks are active", "正在自动检查候补截止时间") :
      t("Deadline checks stopped for this event", "本场活动已停止检查候补截止时间");
    case "SettlementRequested": return a.paymentAttempt > 0n ? t("Automatic payment retry requested", "已请求自动重试收款") :
      t("Lasna asked Base to check the waitlist", "Lasna 已通知 Base 检查能否补位");
    case "ProceedsWithdrawn": return t("The organizer withdrew ticket proceeds", "主办方已提取票款");
    default: return null;
  }
}
