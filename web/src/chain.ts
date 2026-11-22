import { Contract, Interface, JsonRpcProvider, ZeroAddress, formatUnits, getAddress, isAddress, type Provider } from "ethers";

export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const BASE = 84532;
export const LASNA = 5318007;
const detailsTuple = "(string name,string location,string description,string cover)";
export const factoryAbi = [
  "function createEvent(" + detailsTuple + " info,uint256 start,uint32 capacity,uint256 price) payable returns (address)",
  "function watcher() view returns (address)", "function callbackDeposit() view returns (uint256)",
  "function isEvent(address) view returns (bool)", "function eventCount() view returns (uint256)",
  "function events(uint256) view returns (address)", "function retryActivation(address)",
  "function activationRetryAt(address) view returns (uint256)",
  "event EventCreated(address indexed eventAddress,address indexed organizer,uint256 announcedAt)",
];
export const baseAbi = [
  "function details() view returns (" + detailsTuple + ")",
  "function capacity() view returns (uint32)", "function ticketPrice() view returns (uint256)",
  "function eventStartTime() view returns (uint256)", "function availableSpots() view returns (uint256)",
  "function publicSpots() view returns (uint256)", "function activeOrders() view returns (uint256)",
  "function factory() view returns (address)", "function _CALLBACK_SENDER() view returns (address)",
  "function automationReady() view returns (bool)", "function organizer() view returns (address)",
  "function retainedProceeds() view returns (uint256)", "function ticketBalance(address) view returns (uint256)",
  "function ticketsPage(address,uint256,uint32) view returns (uint256[] ids,uint256 nextGrant,uint32 nextOffset,bool more)",
  "function settlementState() view returns (uint256 head,uint256 deadline,uint256 heldSpots,bool ready,bool paymentBlocked)",
  "function canRetrySettlement() view returns (bool)",
  "function orderInfo(uint256) view returns (address buyer,uint32 qty,uint256 deadline,uint8 status)",
  "function buy(uint32 qty)", "function refund(uint256 ticketId)",
  "function enqueue(uint32 qty,uint256 userDeadline,(bytes32 nonce,uint8 v,bytes32 r,bytes32 s) auth) returns (uint256)",
  "function cancel(uint256 id)", "function requestSettlementRetry()", "function withdrawProceeds()",
  "event TicketsIssued(uint256 indexed firstId,address indexed buyer,uint256 indexed orderId,uint32 qty)",
  "event TicketRefunded(uint256 indexed ticketId,address indexed buyer,uint256 amount)",
  "event Queued(uint256 indexed id,address indexed buyer,uint32 qty,uint256 deadline)",
  "event OrderResolved(uint256 indexed id,uint8 status)", "event PaymentDeferred(uint256 indexed id)",
  "event BindingConfirmed(address indexed watcher)",
  "event SettlementState(uint256 indexed revision,uint256 headId,uint256 headEffectiveDeadline,uint256 heldSpots,bool ready,uint256 availableSpots)",
  "event ProceedsWithdrawn(address indexed organizer,uint256 amount)",
  ...["EventStarted","InvalidQuantity","SalesAvailable","SeatsUnavailable","InvalidAuthorization","NotTicketOwner",
    "NotOrderOwner","NotQueued","WithdrawalUnavailable","TokenTransferFailed","RetryUnavailable","BindingPending"].map(name => "error " + name + "()"),
];
export const watcherAbi = [
  "function factory() view returns (address)",
  "function sourceState(address) view returns ((bool registered,uint256 revision,uint256 head,uint256 deadline,uint256 available,uint256 slot,uint256 lastCronAt,uint256 lastAnnouncementAt))",
  "event SourceBound(address indexed source)",
  "event CronChanged(address indexed source,bool active,uint256 headId,uint256 deadline,bool subscriptionChanged)",
  "event SettlementRequested(address indexed source,uint256 indexed headId,bool fromCron,bytes32 indexed sourceTx)",
];
export const tokenAbi = [
  "function name() view returns (string)", "function version() view returns (string)", "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
];

export type Chain = "base" | "lasna";
export const networks = {
  base: { id: BASE, label: "Base Sepolia", url: import.meta.env.VITE_BASE_RPC_URL || "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org", address: (import.meta.env.VITE_FACTORY_ADDRESS || "").trim(),
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
export const localText = (english: string, chinese: string) =>
  typeof navigator !== "undefined" && /^zh(?:-|$)/i.test(navigator.language) ? chinese : english;
export const formatTime = (time: number) => new Date(time * 1000).toLocaleString(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

export const usdc = (amount: bigint) => formatUnits(amount, 6).replace(/\.0$/, "");
export const eventUrl = (source: string) => new URL("?event=" + getAddress(source), window.location.href).href;
export function coverUrl(raw: string) {
  try { const url = new URL(raw); return url.protocol === "https:" ? url.href : ""; } catch { return ""; }
}

export async function readBaseBinding(rpc: Provider, source: string, blockTag: number | "latest" = "latest") {
  const platform = contractAddress("base");
  const factory = new Contract(platform, factoryAbi, rpc);
  const event = new Contract(source, baseAbi, rpc);
  const at = { blockTag };
  if (!await factory.isEvent(source, at)) throw new Error("This event is outside the configured ReSeat factory.");
  const [origin, sender, confirmed, platformWatcher, retryAt] = await Promise.all([
    event.factory(at), event._CALLBACK_SENDER(at), event.automationReady(at), factory.watcher(at), factory.activationRetryAt(source, at),
  ]);
  if (getAddress(origin) !== platform) throw new Error("The event factory does not match this platform.");
  return { source: getAddress(source), factory: platform, sender: String(sender), confirmed: Boolean(confirmed),
    platformWatcher: String(platformWatcher), retryAt: Number(retryAt) };
}

export const firstTicketPage = { grant: 0n, offset: 0 };
export type TicketCursor = typeof firstTicketPage;
export async function readBase(source: string, account: string, cursor: TicketCursor) {
  const rpc = await reader("base");
  const block = await rpc.getBlock("latest");
  if (!block) throw new Error("Base block unavailable.");
  const binding = await readBaseBinding(rpc, source, block.number);
  const event = new Contract(source, baseAbi, rpc);
  const at = { blockTag: block.number };
  const [metadata, capacity, price, start, available, publicSeats, active, state, page, count, organizer, proceeds, canRetry] = await Promise.all([
    event.details(at), event.capacity(at), event.ticketPrice(at), event.eventStartTime(at), event.availableSpots(at),
    event.publicSpots(at), event.activeOrders(at), event.settlementState(at),
    account ? event.ticketsPage(account, cursor.grant, cursor.offset, at) : null,
    account ? event.ticketBalance(account, at) : 0n, event.organizer(at), event.retainedProceeds(at), event.canRetrySettlement(at),
  ]);
  const headQty = state.head !== 0n ? Number((await event.orderInfo(state.head, at)).qty) : 0;
  return { block, event: { binding, name: String(metadata.name), location: String(metadata.location),
    description: String(metadata.description), cover: coverUrl(metadata.cover), capacity: Number(capacity), price: BigInt(price),
    start: Number(start), available: Number(available), publicSeats: Number(publicSeats), active: Number(active),
    headQty, held: Number(state.heldSpots), blocked: Boolean(state.paymentBlocked), tickets: Array.from((page?.ids ?? []) as bigint[]),
    ticketCount: BigInt(count), nextPage: page?.more ? { grant: BigInt(page.nextGrant), offset: Number(page.nextOffset) } : null,
    account, canRetry: Boolean(canRetry), organizer: String(organizer), proceeds: BigInt(proceeds) } };
}

export async function readLasna(source: string) {
  if (!networks.lasna.address) return null;
  const address = contractAddress("lasna");
  const rpc = await reader("lasna");
  const block = await rpc.getBlock("latest");
  if (!block) throw new Error("Lasna block unavailable.");
  const contract = new Contract(address, watcherAbi, rpc);
  const at = { blockTag: block.number };
  const [factory, state] = await Promise.all([contract.factory(at), contract.sourceState(source, at)]);
  return { address, source: getAddress(source), factory: String(factory), registered: Boolean(state.registered),
    revision: BigInt(state.revision), active: state.slot !== 0n, deadline: Number(state.deadline) };
}

export type Workshop = Awaited<ReturnType<typeof readBase>>["event"];
export type Watcher = NonNullable<Awaited<ReturnType<typeof readLasna>>>;
export function bindingStatus(binding?: Workshop["binding"], watcher?: Watcher | null) {
  if (!binding) return "pending";
  if (watcher === null) return "unavailable";
  if (!watcher) return "pending";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(binding.source, watcher.source) || !same(binding.sender, watcher.address) ||
      !same(binding.platformWatcher, watcher.address)) return "unavailable";
  if (same(watcher.factory, ZeroAddress)) return "pending";
  if (!same(binding.factory, watcher.factory)) return "unavailable";
  return binding.confirmed && watcher.registered && watcher.revision > 0n ? "ready" : "pending";
}

export async function readDirectory(page: number) {
  if (!networks.base.address) return { items: [], count: 0 };
  const rpc = await reader("base");
  const factory = new Contract(contractAddress("base"), factoryAbi, rpc);
  const count = Number(await factory.eventCount());
  const top = Math.max(0, count - page * 6);
  const items = await Promise.all(Array.from({ length: Math.min(6, top) }, async (_, i) => {
    const source: string = await factory.events(top - 1 - i);
    const event = new Contract(source, baseAbi, rpc);
    const [info, date, price, seats] = await Promise.all([event.details(), event.eventStartTime(), event.ticketPrice(), event.publicSpots()]);
    return { source, name: String(info.name), location: String(info.location), cover: coverUrl(info.cover),
      date: Number(date), price: BigInt(price), seats: Number(seats) };
  }));
  return { items, count };
}

export async function readPublishSettings() {
  if (!networks.base.address) return null;
  const rpc = await reader("base");
  const factory = new Contract(contractAddress("base"), factoryAbi, rpc);
  return { fee: BigInt(await factory.callbackDeposit()) };
}
