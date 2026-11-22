import { Contract, Interface, JsonRpcProvider, ZeroAddress, getAddress, isAddress } from "ethers";

export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PRICE = 20_000_000n;
export const BASE = 84532;
export const LASNA = 5318007;
export const baseAbi = [
  "function capacity() view returns (uint256)",
  "function ticketPrice() view returns (uint256)",
  "function eventStartTime() view returns (uint256)",
  "function availableSpots() view returns (uint256)",
  "function publicSpots() view returns (uint256)",
  "function activeOrders() view returns (uint256)",
  "function organizer() view returns (address)",
  "function retainedProceeds() view returns (uint256)",
  "function ticketsOf(address) view returns (uint256[])",
  "function settlementState() view returns (uint256 head,uint256 deadline,uint256 heldSpots,bool ready)",
  "function buy(uint8 qty)",
  "function refund(uint256 ticketId)",
  "function enqueue(uint8 qty,uint256 userDeadline,(bytes32 nonce,uint8 v,bytes32 r,bytes32 s) auth) returns (uint256)",
  "function cancel(uint256 id)",
  "function requestSettlementRetry()",
  "function withdrawProceeds()",
  "event TicketIssued(uint256 indexed ticketId,address indexed buyer,uint256 indexed orderId)",
  "event TicketRefunded(uint256 indexed ticketId,address indexed buyer,uint256 amount)",
  "event Queued(uint256 indexed id,address indexed buyer,uint8 qty,uint256 deadline)",
  "event OrderResolved(uint256 indexed id,uint8 status)",
  "event SettlementState(uint256 indexed revision,uint256 headId,uint256 headEffectiveDeadline,uint256 heldSpots,bool ready)",
  "event ProceedsWithdrawn(address indexed organizer,uint256 amount)",
  ...["EventStarted","InvalidQuantity","SalesAvailable","SeatsUnavailable","InvalidAuthorization","NotTicketOwner",
    "NotOrderOwner","NotQueued","WithdrawalUnavailable","TokenTransferFailed","RetryCoolingDown"].map(name => "error " + name + "()"),
];
export const watcherAbi = [
  "function cronActive() view returns (bool)",
  "function trackedHeadDeadline() view returns (uint256)",
  "function eventContract() view returns (address)",
  "event SourceBound(address indexed source)",
  "event CronChanged(bool active,uint256 headId,uint256 deadline)",
  "event SettlementRequested(uint256 indexed headId,bool fromCron,bytes32 indexed sourceTx)",
];
export const tokenAbi = [
  "function name() view returns (string)", "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
];

export type Chain = "base" | "lasna";
export const networks = {
  base: { id: BASE, label: "Base Sepolia", url: import.meta.env.VITE_BASE_RPC_URL || "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org", address: (import.meta.env.VITE_EVENT_ADDRESS || "").trim(),
    start: import.meta.env.VITE_BASE_START_BLOCK, abi: new Interface(baseAbi) },
  lasna: { id: LASNA, label: "Lasna", url: import.meta.env.VITE_LASNA_RPC_URL || "https://lasna-rpc.rnk.dev",
    explorer: "https://lasna.reactscan.net", address: (import.meta.env.VITE_REACTIVE_ADDRESS || "").trim(),
    start: import.meta.env.VITE_LASNA_START_BLOCK, abi: new Interface(watcherAbi) },
};
const readers = new Map<Chain, JsonRpcProvider>();
const verified = new Set<Chain>();

export async function reader(chain: Chain) {
  const net = networks[chain];
  let provider = readers.get(chain);
  if (!provider) {
    provider = new JsonRpcProvider(net.url, net.id, { staticNetwork: true, batchMaxCount: 1 });
    readers.set(chain, provider);
  }
  if (!verified.has(chain)) {
    const id = Number(await provider.send("eth_chainId", []));
    if (id !== net.id) throw new Error("The configured RPC is on the wrong network.");
    verified.add(chain);
  }
  return provider;
}

export function contractAddress(chain: Chain) {
  const value = networks[chain].address;
  if (!isAddress(value) || value.toLowerCase() === ZeroAddress) throw new Error("Check the configured contract address.");
  return getAddress(value);
}

export const txUrl = (chain: Chain, hash: string) => networks[chain].explorer + "/tx/" + hash;
export const shortAddress = (value: string) => value.slice(0, 6) + "…" + value.slice(-4);
export const formatTime = (time: number) => new Date(time * 1000).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

export async function readBase(account: string) {
  const rpc = await reader("base");
  const block = await rpc.getBlock("latest");
  if (!block) throw new Error("Base block unavailable.");
  if (!networks.base.address) return { block, event: null };
  const event = new Contract(contractAddress("base"), baseAbi, rpc);
  const at = { blockTag: block.number };
  const [capacity, price, start, available, publicSeats, active, state, tickets, organizer, proceeds] = await Promise.all([
    event.capacity(at), event.ticketPrice(at), event.eventStartTime(at), event.availableSpots(at), event.publicSpots(at),
    event.activeOrders(at), event.settlementState(at), account ? event.ticketsOf(account, at) : [],
    event.organizer(at), event.retainedProceeds(at),
  ]);
  return { block, event: { capacity: Number(capacity), price: BigInt(price), start: Number(start),
    available: Number(available), publicSeats: Number(publicSeats), active: Number(active), held: Number(state.heldSpots),
    tickets: Array.from(tickets as bigint[]), account, organizer: String(organizer), proceeds: BigInt(proceeds) } };
}

export async function readLasna() {
  const rpc = await reader("lasna");
  const block = await rpc.getBlock("latest");
  if (!block) throw new Error("Lasna block unavailable.");
  if (!networks.lasna.address) return { block, watcher: null };
  const watcher = new Contract(contractAddress("lasna"), watcherAbi, rpc);
  const at = { blockTag: block.number };
  const [active, deadline, source] = await Promise.all([
    watcher.cronActive(at), watcher.trackedHeadDeadline(at), watcher.eventContract(at),
  ]);
  return { block, watcher: { active: Boolean(active), deadline: Number(deadline), source: String(source) } };
}

export type Workshop = NonNullable<Awaited<ReturnType<typeof readBase>>["event"]>;
export type Watcher = NonNullable<Awaited<ReturnType<typeof readLasna>>["watcher"]>;
