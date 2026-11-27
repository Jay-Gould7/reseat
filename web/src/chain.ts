import { Contract, Interface, JsonRpcProvider, ZeroAddress, ZeroHash, formatUnits, getAddress, isAddress, isError, type Provider } from "ethers";
import sponsorshipAbi from "../relay/abi.json";
import { circleAddress } from "../relay/circle.mjs";

export const USDC = circleAddress;
export const BASE = 84532;
export const LASNA = 5318007;
const detailsTuple = "(string name,string location,string description,string cover)";
export const factoryAbi = [
  "function createEvent(" + detailsTuple + " info,uint256 start,uint32 capacity,uint256 price) payable returns (address)",
  "function watcher() view returns (address)", "function callbackDeposit() view returns (uint256)",
  "function callbackProxy() view returns (address)",
  "function isEvent(address) view returns (bool)", "function eventCount() view returns (uint256)",
  "function events(uint256) view returns (address)", "function retryActivation(address)",
  "function activationRetryAt(address) view returns (uint256)",
  "event EventCreated(address indexed eventAddress,address indexed organizer,uint256 announcedAt)",
];
export const baseAbi = [
  ...sponsorshipAbi.event,
  "function details() view returns (" + detailsTuple + ")",
  "function capacity() view returns (uint32)", "function ticketPrice() view returns (uint256)",
  "function eventStartTime() view returns (uint256)", "function availableSpots() view returns (uint256)",
  "function publicSpots() view returns (uint256)",
  "function factory() view returns (address)", "function _CALLBACK_SENDER() view returns (address)",
  "function automationReady() view returns (bool)", "function organizer() view returns (address)",
  "function retainedProceeds() view returns (uint256)", "function ticketBalance(address) view returns (uint256)",
  "function ticketsPage(address,uint256,uint32) view returns (uint256[] ids,uint256 nextGrant,uint32 nextOffset,bool more)",
  "function settlementState() view returns (uint256 head,uint256 deadline,uint256 heldSpots,bool ready,bool paymentBlocked)",
  "function canRetrySettlement() view returns (bool)",
  "function headId() view returns (uint256)", "function nextId() view returns (uint256)", "function activeOrders() view returns (uint256)",
  "function orderInfo(uint256) view returns (address buyer,uint32 qty,uint256 deadline,uint8 status)",
  "function buy(uint32 qty)", "function refund(uint256 ticketId)",
  "function enqueue(uint32 qty,uint256 userDeadline,(bytes32 nonce,uint8 v,bytes32 r,bytes32 s) auth) returns (uint256)",
  "function retryPayment(address reactive_,uint256 expectedHeadId,uint8 attempt)",
  "function cancel(uint256 id)", "function requestSettlementRetry()", "function withdrawProceeds()",
  "event TicketsIssued(uint256 indexed firstId,address indexed buyer,uint256 indexed orderId,uint32 qty)",
  "event TicketRefunded(uint256 indexed ticketId,address indexed buyer,uint256 amount)",
  "event Queued(uint256 indexed id,address indexed buyer,uint32 qty,uint256 deadline)",
  "event OrderResolved(uint256 indexed id,uint8 status)", "event PaymentDeferred(uint256 indexed id)",
  "event BindingConfirmed(address indexed watcher)",
  "event SettlementState(uint256 indexed revision,uint256 headId,uint256 headEffectiveDeadline,uint256 heldSpots,bool ready,uint256 availableSpots,uint256 paymentRetryAt)",
  "event ProceedsWithdrawn(address indexed organizer,uint256 amount)",
  ...["EventStarted","InvalidQuantity","SalesAvailable","SeatsUnavailable","InvalidAuthorization","NotTicketOwner",
    "NotOrderOwner","NotQueued","WithdrawalUnavailable","TokenTransferFailed","RetryUnavailable","BindingPending"].map(name => "error " + name + "()"),
];
export const watcherAbi = [
  ...sponsorshipAbi.watcher,
  "function factory() view returns (address)",
  "function sourceState(address) view returns ((bool registered,uint256 revision,uint256 head,uint256 deadline,uint256 available,uint256 slot,uint256 lastCronAt,uint256 lastAnnouncementAt,uint256 paymentRetryAt,uint256 lastPaymentAt,uint8 paymentAttempts))",
  "event SourceBound(address indexed source)",
  "event CronChanged(address indexed source,bool active,uint256 headId,uint256 deadline,bool subscriptionChanged)",
  "event SettlementRequested(address indexed source,uint256 indexed headId,bool fromCron,bytes32 indexed sourceTx,uint8 paymentAttempt)",
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
const readers = new Map<Chain, Promise<JsonRpcProvider>>();

export async function reader(chain: Chain) {
  const net = networks[chain];
  let ready = readers.get(chain);
  if (!ready) {
    const provider = new JsonRpcProvider(net.url, net.id, { staticNetwork: true, batchMaxCount: 1 });
    ready = provider.send("eth_chainId", []).then(id => {
      if (Number(id) !== net.id) throw new Error("The configured RPC is on the wrong network.");
      return provider;
    }).catch(err => { readers.delete(chain); provider.destroy(); throw err; });
    readers.set(chain, ready);
  }
  return ready;
}

export function contractAddress(chain: Chain) {
  const value = networks[chain].address;
  if (!isAddress(value) || value.toLowerCase() === ZeroAddress) throw new Error("Check the configured contract address.");
  return getAddress(value);
}

type Platform = { factory: string; watcher: string; baseStart?: string; lasnaStart?: string };
function configuredPlatforms(): Platform[] {
  const current = networks.base.address ? [{ factory: contractAddress("base"), watcher: networks.lasna.address ? contractAddress("lasna") : "",
    baseStart: networks.base.start, lasnaStart: networks.lasna.start }] : [];
  const rows = JSON.parse(import.meta.env.VITE_LEGACY_PLATFORMS || "[]") as Platform[];
  return [...current, ...rows.map(row => ({ ...row, factory: getAddress(row.factory), watcher: getAddress(row.watcher),
    baseStart: row.baseStart == null ? undefined : String(row.baseStart), lasnaStart: row.lasnaStart == null ? undefined : String(row.lasnaStart) }))];
}
const platformsByEvent = new Map<string, Platform & { sender: string; current: boolean }>();
export async function eventPlatform(source: string, rpc?: Provider, blockTag: number | "latest" = "latest") {
  source = getAddress(source);
  const cached = platformsByEvent.get(source);
  if (cached) return cached;
  const base = rpc ?? await reader("base"), at = { blockTag };
  const event = new Contract(source, baseAbi, base);
  const origin = await event.factory(at).catch((err: unknown) => {
    if (isError(err, "CALL_EXCEPTION") || isError(err, "BAD_DATA")) throw new Error("Choose an event published by this factory or a configured legacy factory.");
    throw err;
  });
  const platform = configuredPlatforms().find(p => p.factory === origin);
  if (!platform) throw new Error("Choose an event published by this factory or a configured legacy factory.");
  const factory = new Contract(origin, factoryAbi, base);
  const [listed, watcher, sender] = await Promise.all([factory.isEvent(source, at), factory.watcher(at), event._CALLBACK_SENDER(at)]);
  const current = origin.toLowerCase() === networks.base.address.toLowerCase();
  if (!listed || sender !== watcher || (!current && watcher !== platform.watcher)) throw new Error("The event and its trusted platform do not match.");
  const verified = { ...platform, sender: String(sender), current };
  platformsByEvent.set(source, verified);
  return verified;
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
  const platform = await eventPlatform(source, rpc, blockTag);
  const factory = new Contract(platform.factory, factoryAbi, rpc);
  const event = new Contract(source, baseAbi, rpc);
  const at = { blockTag };
  const [confirmed, retryAt] = await Promise.all([event.automationReady(at), factory.activationRetryAt(source, at)]);
  return { source: getAddress(source), factory: platform.factory, sender: platform.sender, confirmed: Boolean(confirmed),
    platformWatcher: platform.sender, current: platform.current, retryAt: Number(retryAt) };
}

export const firstTicketPage = { grant: 0n, offset: 0 };
export type TicketCursor = typeof firstTicketPage;
export interface EventPreview {
  name: string; location: string; description: string; cover: string; start: number; capacity: number; price: bigint;
  sponsored: boolean;
}
// Only immutable metadata read from a factory-listed event can be reused between pages.
const previews = new Map<string, EventPreview>();
export const cachedPreview = (source: string) => previews.get(getAddress(source));
async function readPreview(source: string, event: Contract, blockTag: number | "latest"): Promise<EventPreview> {
  const known = cachedPreview(source);
  if (known) return known;
  const at = { blockTag };
  const capability = event.sponsoredNonce(ZeroAddress, 1, 1, ZeroHash, at).then(() => true).catch((err: unknown) => {
    // The public Base RPC reports an unknown selector on the legacy event with code 3 and no revert data.
    if (isError(err, "CALL_EXCEPTION") && (err.data === "0x" ||
      (err.data == null && /execution reverted/i.test(String(err.info?.error?.message))))) return false;
    if (isError(err, "BAD_DATA") && err.value === "0x") return false;
    throw err;
  });
  const [info, start, capacity, price, sponsored] = await Promise.all([event.details(at), event.eventStartTime(at), event.capacity(at), event.ticketPrice(at), capability]);
  return { name: String(info.name), location: String(info.location), description: String(info.description), cover: coverUrl(info.cover),
    start: Number(start), capacity: Number(capacity), price: BigInt(price), sponsored };
}
export async function readBase(source: string, account: string, cursor: TicketCursor, onPreview?: (preview: EventPreview) => void) {
  const rpc = await reader("base");
  const block = await rpc.getBlock("latest");
  if (!block) throw new Error("Base block unavailable.");
  const event = new Contract(source, baseAbi, rpc);
  const at = { blockTag: block.number };
  const identity = Promise.all([readBaseBinding(rpc, source, block.number), readPreview(source, event, block.number)]).then(([binding, preview]) => {
    previews.set(getAddress(source), preview);
    onPreview?.(preview);
    return { binding, preview };
  });
  const [{ binding, preview }, publicSeats, state, page, count, organizer, proceeds, canRetry] = await Promise.all([
    identity,
    event.publicSpots(at), event.settlementState(at),
    account ? event.ticketsPage(account, cursor.grant, cursor.offset, at) : null,
    account ? event.ticketBalance(account, at) : 0n, event.organizer(at), event.retainedProceeds(at), event.canRetrySettlement(at),
  ]);
  return { block, event: { ...preview, sponsored: preview.sponsored && binding.current, binding, publicSeats: Number(publicSeats),
    heldFor: String(state.head), held: Number(state.heldSpots), blocked: Boolean(state.paymentBlocked), tickets: Array.from((page?.ids ?? []) as bigint[]),
    ticketCount: BigInt(count), nextPage: page?.more ? { grant: BigInt(page.nextGrant), offset: Number(page.nextOffset) } : null,
    account, canRetry: Boolean(canRetry), organizer: String(organizer), proceeds: BigInt(proceeds) } };
}

export async function readLasna(source: string) {
  const address = (await eventPlatform(source)).watcher;
  if (!address) return null;
  const rpc = await reader("lasna");
  const block = await rpc.getBlock("latest");
  if (!block) throw new Error("Lasna block unavailable.");
  const contract = new Contract(address, watcherAbi, rpc);
  const at = { blockTag: block.number };
  const [factory, state] = await Promise.all([contract.factory(at), contract.sourceState(source, at)]);
  return { address, source: getAddress(source), factory: String(factory), registered: Boolean(state.registered),
    revision: BigInt(state.revision), active: state.slot !== 0n };
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
    const [preview, seats] = await Promise.all([readPreview(source, event, "latest"), event.publicSpots()]);
    previews.set(getAddress(source), preview);
    return { source, ...preview, seats: Number(seats) };
  }));
  return { items, count };
}

export async function readPublishSettings() {
  if (!networks.base.address) return null;
  const rpc = await reader("base");
  const factory = new Contract(contractAddress("base"), factoryAbi, rpc);
  return { fee: BigInt(await factory.callbackDeposit()) };
}
