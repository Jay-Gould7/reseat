import { AbiCoder, Contract, JsonRpcProvider, Wallet, getAddress, isHexString, keccak256 } from "ethers";
import { isIP } from "node:net";
import { checkCircleAuthorization } from "./circle.mjs";
import { createBudget, relayGasLimit } from "./budget.mjs";
import abi from "./abi.json" with { type: "json" };

const factoryAbi = ["function isEvent(address) view returns(bool)", "function watcher() view returns(address)", "function callbackProxy() view returns(address)",
  "function eventCount() view returns(uint256)", "function events(uint256) view returns(address)"];
const eventAbi = [...abi.event, "function ticketPrice() view returns(uint256)", "function automationReady() view returns(bool)", "function _CALLBACK_SENDER() view returns(address)",
  "function orderInfo(uint256) view returns(address buyer,uint32 qty,uint256 deadline,uint8 status)"];
const watcherAbi = [...abi.watcher, "function factory() view returns(address)",
  "function sourceState(address) view returns((bool registered,uint256 revision,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8))"];
const coder = AbiCoder.defaultAbiCoder();

class RelayError extends Error {
  constructor(code, status = 503, delivery = "not-sent") { super(code); this.status = status; this.delivery = delivery; }
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
  const budget = createBudget(env, base, lasna, factory, watcher, signer);
  let chain = Promise.resolve(), queued = 0;

  async function check(source, kind, prune = false) {
    const event = new Contract(source, eventAbi, base);
    const [listed, watcherAddress, origin, relay, proxy] = await Promise.all([
      factory.isEvent(source), factory.watcher(), watcher.factory(), watcher.waitlistRelay(), factory.callbackProxy(),
    ]);
    if (!listed || watcherAddress !== watcher.target || origin !== factory.target) throw new RelayError("binding");
    if (relay !== signer.address) throw new RelayError("offline");
    const [state, ready, sender] = await Promise.all([watcher.sourceState(source), event.automationReady(), event._CALLBACK_SENDER()]);
    if (!ready || !state.registered || state.revision === 0n || sender !== watcher.target) throw new RelayError("binding");
    return { event, proxy, ...await budget.assess(source, proxy, kind, prune) };
  }

  async function send(source, intent) {
    const { kind, order } = intent;
    const { event, proxy, status, block, relayUnit, fees, pending, unmined } = await check(source, kind, true);
    const joining = kind === "join";
    const key = joining ? keccak256(coder.encode(["address","address","bytes32"], [source, order.buyer, order.salt]))
      : keccak256(coder.encode(["address","uint256"], [source, order.orderId]));
    const at = { blockTag: block.number };
    const nonce = joining ? await event.sponsoredNonce(order.buyer, order.qty, order.deadline, order.salt, at) : undefined;
    if (joining && await event.orderIdForNonce(order.buyer, nonce, at) !== 0n) return { status: "confirmed" };
    const previous = pending.findLast(row => row.key === key);
    if (previous && joining && previous.nonce !== nonce) throw new RelayError("invalid-order", 422);
    if (previous && unmined.includes(previous)) {
      if (!await lasna.getTransaction(previous.hash)) {
        try { await lasna.broadcastTransaction(previous.raw); }
        catch { throw new RelayError("delivery-unknown", 503, "unknown"); }
      }
      return { status: "pending", hash: previous.hash };
    }
    if (previous && Date.now() - previous.sentAt < 300_000) return { status: "pending", hash: previous.hash };
    const previousDelivery = previous ? "unknown" : "not-sent";
    if (status !== "ready") throw new RelayError(status, 503, previousDelivery);
    if (joining) {
      const problem = await checkCircleAuthorization(base, source, order, await event.ticketPrice(at), nonce, block.number);
      if (problem) throw new RelayError(problem, 422, previousDelivery);
    }
    // Check ownership, nonce, event terms and the two callback identities in the actual destination contract.
    const method = joining ? event.enqueueSponsored : event.cancelSponsored;
    try { await method.staticCall(watcher.target, order, { from: proxy, ...at }); }
    catch (error) {
      if (error.code === "CALL_EXCEPTION") throw new RelayError("invalid-order", 422, previousDelivery);
      throw error;
    }
    if (!joining && (await event.orderInfo(order.orderId, at)).status === 4n) return { status: "confirmed" };
    const [retryAt, latest] = await Promise.all([watcher.relayRetryAt(key), lasna.getBlock("latest")]);
    if (retryAt > BigInt(latest.timestamp)) return { status: "pending" };
    const request = joining ? watcher.requestEnrollment : watcher.requestCancellation;
    const gas = await request.estimateGas(source, order);
    if (gas > relayGasLimit) throw new RelayError("offline", 503, previousDelivery);
    const feeFields = fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null ?
      { type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : { type: 0, gasPrice: fees.gasPrice };
    let txNonce = await lasna.getTransactionCount(signer.address, "pending");
    // An RPC timeout after signing must never let a different buyer replace that transaction.
    for (const prior of unmined.sort((a, b) => a.txNonce - b.txNonce)) {
      if (prior.txNonce < txNonce) continue;
      if (prior.txNonce !== txNonce) throw new RelayError("busy", 503, previousDelivery);
      try { await lasna.broadcastTransaction(prior.raw); }
      catch { throw new RelayError("busy", 503, previousDelivery); }
      txNonce++;
    }
    const raw = await signer.signTransaction({ ...await request.populateTransaction(source, order), ...feeFields,
      chainId: 5318007, nonce: txNonce, gasLimit: relayGasLimit });
    const hash = keccak256(raw);
    budget.reserve({ key, hash, raw, txNonce, kind, source, nonce, id: order.orderId, buyer: order.buyer,
      deadline: order.deadline ?? order.validBefore, sentAt: Date.now(), relayWei: String(relayUnit) });
    try { await lasna.broadcastTransaction(raw); }
    catch { throw new RelayError("delivery-unknown", 503, "unknown"); }
    return { status: "pending", hash };
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
  const normalize = ip => ip?.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const proxies = new Set((env.WAITLIST_TRUSTED_PROXIES || "").split(",").map(s => normalize(s.trim())).filter(Boolean));
  if ([...proxies].some(ip => !isIP(ip))) throw Error("Expected exact IP addresses in WAITLIST_TRUSTED_PROXIES");
  function limit(req) {
    const peer = normalize(req.socket.remoteAddress), header = req.headers["x-real-ip"];
    const visitor = proxies.has(peer) && typeof header === "string" && isIP(header) ? normalize(header) : peer;
    const now = Date.now(), reading = req.method === "GET";
    for (const [key, bucket] of peers) if (bucket.until <= now) peers.delete(key);
    const quotas = [["global", reading ? 1200 : 120], [visitor, reading ? 180 : 20]].map(([key, max]) => {
      const id = req.method + ":" + key;
      return { id, max, bucket: peers.get(id) ?? { count: 0, until: now + 60_000 } };
    });
    if (quotas.some(({ bucket, max }) => bucket.count >= max)) throw new RelayError("busy", 429);
    for (const { id, bucket } of quotas) { bucket.count++; peers.set(id, bucket); }
  }
  async function handle(req, res) {
    const path = (req.url || "").split("?")[0];
    if (!path.startsWith("/api/waitlist/")) return false;
    let status = 200, result;
    try {
      if (!/^\/api\/waitlist\/0x[0-9a-fA-F]{40}$/.test(path)) throw new RelayError("invalid", 400);
      const source = getAddress(path.slice(-42).toLowerCase());
      limit(req);
      relay ??= openRelay(env);
      if (req.method === "GET") {
        const kind = new URL(req.url, "http://localhost").searchParams.get("action") === "cancel" ? "cancel" : "join";
        result = { status: (await relay.check(source, kind)).status };
      }
      else if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json") ||
            (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) throw new RelayError("invalid", 403);
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
      result = { status: error instanceof RelayError ? error.message : "offline",
        delivery: error instanceof RelayError ? error.delivery : "not-sent" };
    }
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(result));
    return true;
  }
  return { handle, close() { relay?.close(); } };
}
