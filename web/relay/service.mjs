import { AbiCoder, Contract, JsonRpcProvider, Wallet, getAddress, isHexString, keccak256 } from "ethers";
import abi from "./abi.json" with { type: "json" };

const factoryAbi = ["function isEvent(address) view returns(bool)", "function watcher() view returns(address)", "function callbackProxy() view returns(address)"];
const eventAbi = [...abi.event, "function automationReady() view returns(bool)", "function _CALLBACK_SENDER() view returns(address)",
  "function orderInfo(uint256) view returns(address buyer,uint32 qty,uint256 deadline,uint8 status)"];
const watcherAbi = [...abi.watcher, "function factory() view returns(address)",
  "function sourceState(address) view returns((bool registered,uint256 revision,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8))"];
const feeAbi = ["function reserves(address) view returns(uint256)", "function debt(address) view returns(uint256)"];
const coder = AbiCoder.defaultAbiCoder();
const system = "0x8888888888888888888888888888888888888888";

class RelayError extends Error {
  constructor(code, status = 503) { super(code); this.status = status; }
}

function parseIntent(body) {
  const { kind, v, r, s } = body;
  if (![27, 28].includes(v) || !isHexString(r, 32) || !isHexString(s, 32)) throw new RelayError("invalid", 400);
  if (kind === "join" && isHexString(body.salt, 32) && Number.isSafeInteger(body.qty) && body.qty > 0 && body.qty <= 0xffffffff &&
      Number.isSafeInteger(body.deadline) && body.deadline > 0) {
    let buyer;
    try { buyer = getAddress(body.buyer); } catch { throw new RelayError("invalid", 400); }
    return { kind, order: { buyer, qty: body.qty, deadline: body.deadline, salt: body.salt, v, r, s } };
  }
  if (kind === "cancel" && typeof body.orderId === "string" && /^[1-9]\d{0,76}$/.test(body.orderId) &&
      Number.isSafeInteger(body.validBefore) && body.validBefore > 0) {
    return { kind, order: { orderId: body.orderId, validBefore: body.validBefore, v, r, s } };
  }
  throw new RelayError("invalid", 400);
}

function openRelay(env) {
  if (!env.WAITLIST_RELAY_PRIVATE_KEY) throw new RelayError("offline");
  const base = new JsonRpcProvider(env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org", 84532, { cacheTimeout: -1 });
  const lasna = new JsonRpcProvider(env.LASNA_RPC_URL || "https://lasna-rpc.rnk.dev", 5318007, { cacheTimeout: -1 });
  const signer = new Wallet(env.WAITLIST_RELAY_PRIVATE_KEY, lasna);
  const factory = new Contract(getAddress(env.VITE_FACTORY_ADDRESS), factoryAbi, base);
  const watcher = new Contract(getAddress(env.VITE_REACTIVE_ADDRESS), watcherAbi, signer);
  const economy = new Contract(system, feeAbi, lasna);
  let chain = Promise.resolve(), queued = 0;
  const sent = new Map();

  async function check(source) {
    const event = new Contract(source, eventAbi, base);
    const [listed, watcherAddress, origin, relay, proxy] = await Promise.all([
      factory.isEvent(source), factory.watcher(), watcher.factory(), watcher.waitlistRelay(), factory.callbackProxy(),
    ]);
    if (!listed || watcherAddress !== watcher.target || origin !== factory.target) throw new RelayError("binding");
    if (relay !== signer.address) throw new RelayError("offline");
    const fee = new Contract(proxy, feeAbi, base);
    const [state, ready, sender, credit, debt, eventBalance, relayBalance, executionCredit, executionDebt, watcherBalance] = await Promise.all([
      watcher.sourceState(source), event.automationReady(), event._CALLBACK_SENDER(), fee.reserves(source), fee.debt(source),
      base.getBalance(source), lasna.getBalance(signer.address), economy.reserves(watcher.target), economy.debt(watcher.target), lasna.getBalance(watcher.target),
    ]);
    if (!ready || !state.registered || state.revision === 0n || sender !== watcher.target) throw new RelayError("binding");
    if (credit + eventBalance === 0n || debt > 0n) throw new RelayError("event-funds");
    if (relayBalance === 0n || executionCredit + watcherBalance === 0n || executionDebt > 0n) throw new RelayError("platform-funds");
    return { event, proxy };
  }

  async function send(source, intent) {
    const { event, proxy } = await check(source);
    const { kind, order } = intent;
    const joining = kind === "join";
    const key = joining ? keccak256(coder.encode(["address","address","bytes32"], [source, order.buyer, order.salt]))
      : keccak256(coder.encode(["address","uint256"], [source, order.orderId]));
    // Simulate the authenticated callback at the real recipient before spending the relay wallet's funds.
    const method = joining ? event.enqueueSponsored : event.cancelSponsored;
    try { await method.staticCall(watcher.target, order, { from: proxy }); }
    catch (error) {
      if (error.code === "CALL_EXCEPTION") throw new RelayError("invalid-order", 422);
      throw error;
    }
    if (joining) {
      const nonce = await event.sponsoredNonce(order.buyer, order.qty, order.deadline, order.salt);
      if (await event.orderIdForNonce(order.buyer, nonce) !== 0n) return { status: "confirmed" };
    } else if ((await event.orderInfo(order.orderId)).status === 4n) return { status: "confirmed" };
    const now = Date.now();
    for (const [key, entry] of sent) if (entry.until <= now) sent.delete(key);
    if (sent.has(key)) return { status: "pending", hash: sent.get(key).hash };
    const [retryAt, latest] = await Promise.all([watcher.relayRetryAt(key), lasna.getBlock("latest")]);
    if (retryAt > BigInt(latest.timestamp)) return { status: "pending" };
    const request = joining ? watcher.requestEnrollment : watcher.requestCancellation;
    const tx = await request(source, order, { nonce: await lasna.getTransactionCount(signer.address, "pending") });
    sent.set(key, { hash: tx.hash, until: now + 300_000 });
    return { status: "pending", hash: tx.hash };
  }

  return { check, submit(source, input) {
    const intent = parseIntent(input);
    if (queued >= 16) throw new RelayError("busy", 429);
    queued++;
    // A single signer broadcasts in order, including concurrent requests from different guests.
    const result = chain.then(() => send(source, intent));
    chain = result.catch(() => {}).finally(() => { queued--; });
    return result;
  }, close() { base.destroy(); lasna.destroy(); } };
}

export function createWaitlistApi(env) {
  let relay;
  const peers = new Map();
  async function handle(req, res) {
    const path = (req.url || "").split("?")[0];
    if (!path.startsWith("/api/waitlist/")) return false;
    let status = 200, result;
    try {
      if (!/^\/api\/waitlist\/0x[0-9a-fA-F]{40}$/.test(path)) throw new RelayError("invalid", 400);
      const source = getAddress(path.slice(-42).toLowerCase());
      relay ??= openRelay(env);
      if (req.method === "GET") { await relay.check(source); result = { status: "ready" }; }
      else if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json") ||
            (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) throw new RelayError("invalid", 403);
        const now = Date.now(), ip = req.socket.remoteAddress;
        for (const [peer, bucket] of peers) if (bucket.until <= now) peers.delete(peer);
        const bucket = peers.get(ip) || { count: 0, until: now + 60_000 };
        if (++bucket.count > 20) throw new RelayError("busy", 429);
        peers.set(ip, bucket);
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) throw new RelayError("invalid", 413);
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new RelayError("invalid", 400); }
        if (!body || typeof body !== "object") throw new RelayError("invalid", 400);
        result = await relay.submit(source, body);
        status = result.status === "confirmed" ? 200 : 202;
      } else throw new RelayError("invalid", 405);
    } catch (error) {
      status = error instanceof RelayError ? error.status : 503;
      result = { status: error instanceof RelayError ? error.message : "offline" };
    }
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(result));
    return true;
  }
  return { handle, close() { relay?.close(); } };
}
