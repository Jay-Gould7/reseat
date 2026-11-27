import { BrowserProvider, Contract, Signature, TypedDataEncoder, getAddress, hexlify, isAddress, isError, randomBytes,
  type ContractTransactionResponse, type Eip1193Provider, type JsonRpcSigner, type TransactionReceipt } from "ethers";
import { useEffect, useRef, useState } from "react";
import { BASE, USDC, baseAbi, bindingStatus, contractAddress, factoryAbi, localText, networks, readBaseBinding, readLasna, tokenAbi, type Chain } from "./chain";
import { awaitDelivery, forgetJoin, pendingJoin, readDelivery, requireSponsorship, saveJoin, submitSponsored } from "./sponsorship";
import type { Order, OrderConfirmation } from "./orders";

interface Wallet extends Eip1193Provider {
  on?: (name: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (name: string, cb: (...args: unknown[]) => void) => void;
}
declare global { interface Window { ethereum?: Wallet } }

export interface WalletChoice { id: string; name: string; provider: Wallet; preference: string }
interface ConnectedAccounts { provider: Wallet; addresses: string[]; account: string }
function saved(key: string) {
  try { return sessionStorage.getItem(key) || ""; } catch { return ""; }
}
function remember(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
}
function addressesFrom(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(address => typeof address === "string" && isAddress(address)).map(address => getAddress(address)))] : [];
}

export function useWallet() {
  const [choices, setChoices] = useState<WalletChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [preferred] = useState(() => saved("reseat:wallet"));
  const [session, setSession] = useState<ConnectedAccounts>();
  const observation = useRef(0);
  const active = choices.find(w => w.id === selected) ?? choices.find(w => w.preference === preferred) ??
    (choices.length === 1 ? choices[0] : undefined);
  const provider = active?.provider;
  const accountKey = "reseat:account:" + active?.preference;
  const account = session?.provider === provider ? session?.account || "" : "";
  const accounts = session?.provider === provider ? session?.addresses || [] : [];
  useEffect(() => {
    function announce(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (!detail?.provider || typeof detail.provider.request !== "function" ||
        typeof detail.info?.uuid !== "string" || typeof detail.info.name !== "string") return;
      const { provider: announced, info } = detail;
      setChoices(prev => prev.some(w => w.id === info.uuid) ? prev : [
        ...prev.filter(w => w.provider !== announced),
        { provider: announced, id: info.uuid, name: info.name, preference: info.rdns || info.uuid },
      ]);
    }
    function legacy() {
      const injected = window.ethereum;
      if (injected) setChoices(prev => prev.some(w => w.provider === injected) ? prev :
        [...prev, { id: "injected", preference: "injected", name: localText("Browser wallet", "浏览器钱包"), provider: injected }]);
    }
    window.addEventListener("eip6963:announceProvider", announce);
    window.addEventListener("ethereum#initialized", legacy);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    legacy();
    return () => {
      window.removeEventListener("eip6963:announceProvider", announce);
      window.removeEventListener("ethereum#initialized", legacy);
    };
  }, []);

  useEffect(() => {
    if (!provider) return;
    const wallet = provider;
    function update(value: unknown, preserve: boolean) {
      const addresses = addressesFrom(value);
      const last = saved(accountKey);
      if (!preserve) remember(accountKey, addresses[0] || "");
      setSession(prev => ({ provider: wallet, addresses, account:
        preserve && prev?.provider === wallet && addresses.includes(prev.account) ? prev.account :
          preserve && addresses.includes(last) ? last : addresses[0] || "" }));
    }
    const changed = (value: unknown) => { observation.current++; update(value, false); };
    const disconnected = () => changed([]);
    const refresh = () => {
      const request = ++observation.current;
      void wallet.request({ method: "eth_accounts" }).then(value => {
        if (request === observation.current) update(value, true);
      }).catch(() => { if (request === observation.current) update([], false); });
    };
    wallet.on?.("accountsChanged", changed);
    wallet.on?.("chainChanged", refresh);
    wallet.on?.("disconnect", disconnected);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      observation.current++;
      window.removeEventListener("focus", refresh);
      wallet.removeListener?.("accountsChanged", changed);
      wallet.removeListener?.("chainChanged", refresh);
      wallet.removeListener?.("disconnect", disconnected);
    };
  }, [provider, accountKey]);

  async function connect(choice = active, requestAccess = false) {
    if (!choice) throw new Error(localText("Enable a browser wallet to connect.", "请启用浏览器钱包后连接。"));
    if (requestAccess) {
      try { await choice.provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] }); }
      catch (err) {
        const code = Number((err as { code?: number }).code);
        if (code === 4200 || code === -32601)
          throw new Error(localText("Choose another account in your wallet extension. ReSeat will update automatically.", "请在钱包扩展内切换账户，ReSeat 会自动更新。"));
        throw err;
      }
    }
    const addresses = addressesFrom(await choice.provider.request({ method: requestAccess ? "eth_accounts" : "eth_requestAccounts" }));
    if (!addresses.length) throw new Error(localText("Select an account to connect.", "请选择要连接的账户。"));
    const key = "reseat:account:" + choice.preference;
    const last = saved(key);
    const next = !requestAccess && addresses.includes(last) ? last : addresses[0];
    observation.current++;
    setSelected(choice.id);
    setSession({ provider: choice.provider, addresses, account: next });
    remember("reseat:wallet", choice.preference);
    remember(key, next);
  }
  function selectAccount(address: string) {
    if (provider && accounts.includes(address)) {
      observation.current++;
      remember(accountKey, address);
      setSession({ provider, addresses: accounts, account: address });
    }
  }
  function getSigner(chain: Chain = "base") {
    if (!provider || !account) throw new Error(localText("Connect your wallet first.", "请先连接钱包。"));
    return walletSigner(provider, account, chain);
  }
  return { choices, active, account, accounts, connect, selectAccount, getSigner };
}

export type GetSigner = ReturnType<typeof useWallet>["getSigner"];
async function walletSigner(wallet: Wallet, account: string, chain: Chain) {
  const net = networks[chain], chainId = "0x" + net.id.toString(16);
  if (Number(await wallet.request({ method: "eth_chainId" })) !== net.id) {
    try {
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (err) {
      if ((err as {code?: number}).code !== 4902) throw err;
      await wallet.request({ method: "wallet_addEthereumChain", params: [{ chainId, chainName: net.label,
        nativeCurrency: { name: chain === "base" ? "Ether" : "Lasna REACT", symbol: chain === "base" ? "ETH" : "lREACT", decimals: 18 },
        rpcUrls: [net.url], blockExplorerUrls: [net.explorer] }] });
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
  }
  const provider = new BrowserProvider(wallet);
  if ((await provider.getNetwork()).chainId !== BigInt(net.id)) throw new Error("Select " + net.label + " in your wallet.");
  if (!await provider.hasSigner(account)) throw new Error(localText("The wallet account changed. Select it again.", "钱包账户已变更，请重新选择。"));
  return provider.getSigner(account);
}

export const workshopWith = (source: string, signer: JsonRpcSigner) => new Contract(source, baseAbi, signer);
export type Notify = (text: string, hash?: string, chain?: Chain) => void;

export async function confirm(tx: ContractTransactionResponse, notify: Notify, chain: Chain = "base", onReceipt?: (receipt: TransactionReceipt) => void) {
  notify("Waiting for " + networks[chain].label + " confirmation…", tx.hash, chain);
  let receipt: TransactionReceipt | null;
  try {
    receipt = await tx.wait(1);
  } catch (error) {
    if (!isError(error, "TRANSACTION_REPLACED") || error.cancelled) throw error;
    receipt = error.receipt;
  }
  if (receipt?.status !== 1) throw new Error("The transaction did not confirm.");
  onReceipt?.(receipt);
  return receipt.hash;
}

export async function buy(signer: JsonRpcSigner, source: string, qty: number, price: bigint, notify: Notify) {
  const token = new Contract(USDC, tokenAbi, signer);
  const { source: address } = await readBaseBinding(signer.provider, source);
  const total = BigInt(qty) * price;
  if (await token.allowance(signer.address, address) < total) {
    notify("Approve the exact ticket total in your wallet.");
    await confirm(await token.approve(address, total), notify);
  }
  notify("Confirm the ticket purchase in your wallet.");
  return confirm(await workshopWith(source, signer).buy(qty), notify);
}

export async function join(signer: JsonRpcSigner, source: string, qty: number, userDeadline: number, sponsored: boolean,
  notify: Notify, onReceipt: (receipt: TransactionReceipt) => void, onOrder: (result: OrderConfirmation) => void) {
  const token = new Contract(USDC, tokenAbi, signer);
  const [binding, watcher] = await Promise.all([readBaseBinding(signer.provider, source), readLasna(source)]);
  if (bindingStatus(binding, watcher) !== "ready") throw new Error("The watcher binding for this event could not be confirmed.");
  const workshop = workshopWith(source, signer);
  const [name, version, separator, price, start, block] = await Promise.all([
    token.name(), token.version(), token.DOMAIN_SEPARATOR(), workshop.ticketPrice(), workshop.eventStartTime(),
    signer.provider.getBlock("latest"),
  ]);
  const validBefore = Math.min(userDeadline, Number(start));
  if (!block || !Number.isSafeInteger(validBefore) || validBefore <= block.timestamp) throw new Error("Choose a future deadline.");
  const domain = { name, version, chainId: BASE, verifyingContract: USDC };
  if (TypedDataEncoder.hashDomain(domain) !== separator) throw new Error("The USDC signing domain could not be verified.");
  const previous = sponsored ? pendingJoin(source, signer.address) : undefined;
  const draft = previous && previous.deadline > block.timestamp ? previous : { qty, deadline: validBefore, salt: hexlify(randomBytes(32)) };
  const nonce: string = sponsored ? await workshop.sponsoredNonce(signer.address, draft.qty, draft.deadline, draft.salt) : draft.salt;
  const confirmed = (result: OrderConfirmation) => { forgetJoin(source, signer.address, draft.salt); onOrder(result); };
  if (sponsored) {
    if (previous === draft) {
      const result = await readDelivery(workshop, signer.provider, signer.address, { nonce });
      if (result) { confirmed(result); return; }
      if (draft.sentAt && Date.now() - draft.sentAt < 300_000)
        return awaitDelivery(source, signer.address, { nonce }, draft.hash, notify, confirmed);
      if (draft.qty !== qty || draft.deadline !== validBefore) throw new Error(localText(
        "Review the pending order’s quantity and deadline before retrying.", "请核对待提交订单的张数和截止时间，再重试。"));
    }
    await requireSponsorship(source);
  }
  const fields = { ReceiveWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] };
  notify(sponsored ? localText("Sign the ticket total in USDC. The event pays the entry fee.", "请签名确认整单 USDC 金额，入队手续费由活动支付。") :
    localText("Sign the USDC authorization. Your wallet will then pay Base gas.", "请签署 USDC 授权，下一步由你的钱包支付 Base 手续费。"));
  const sig = Signature.from(await signer.signTypedData(domain, fields, { from: signer.address, to: source,
    value: BigInt(qty) * price, validAfter: 0, validBefore, nonce }));
  if (sponsored) {
    saveJoin(source, signer.address, draft);
    const hash = await submitSponsored(source, { kind: "join", buyer: signer.address, qty, deadline: validBefore, salt: draft.salt, v: sig.v, r: sig.r, s: sig.s });
    saveJoin(source, signer.address, { ...draft, sentAt: Date.now(), hash });
    return awaitDelivery(source, signer.address, { nonce }, hash, notify, confirmed);
  }
  notify(localText("Confirm the wallet-paid entry on Base.", "请确认这笔由钱包支付手续费的 Base 入队交易。"));
  return confirm(await workshop.enqueue(qty, userDeadline, [nonce, sig.v, sig.r, sig.s]), notify, "base", onReceipt);
}

export async function cancelSponsored(signer: JsonRpcSigner, source: string, order: Order, notify: Notify,
  confirmed: (value: OrderConfirmation) => void) {
  await requireSponsorship(source);
  const block = await signer.provider.getBlock("latest");
  if (!block || order.deadline <= block.timestamp) throw new Error(localText("The order deadline has passed.", "这笔候补已过截止时间。"));
  const validBefore = Math.min(order.deadline, block.timestamp + 900);
  notify(localText("Sign to cancel your order. The event pays the fee.", "请签名取消本单，手续费由活动支付。"));
  const signature = Signature.from(await signer.signTypedData({ name: "ReSeat", version: "1", chainId: BASE, verifyingContract: source },
    { CancelWaitlist: [{ name: "orderId", type: "uint256" }, { name: "validBefore", type: "uint256" }] }, { orderId: order.id, validBefore }));
  const hash = await submitSponsored(source, { kind: "cancel", orderId: order.id, validBefore, v: signature.v, r: signature.r, s: signature.s });
  return awaitDelivery(source, signer.address, { id: order.id }, hash, notify, confirmed);
}

export function walletError(err: unknown) {
  const e = err as { code?: string | number; revert?: {name: string}; data?: string; shortMessage?: string; message?: string;
    error?: {message?: string}; info?: {error?: {message?: string}} };
  if (e.code === 4001 || e.code === "ACTION_REJECTED") return "Request declined in your wallet.";
  if ([e.message, e.error?.message, e.info?.error?.message].some(m => m && /chain must support EIP-7702 for sponsored or gas included/i.test(m)))
    return localText("MetaMask could not sponsor this wallet transaction. Select Base Sepolia ETH as the gas payment method in your wallet.",
      "MetaMask 无法为这个账户代付本次钱包交易。可在钱包中选择用 Base Sepolia 测试 ETH 支付手续费。");
  let name = e.revert?.name;
  if (!name && typeof e.data === "string") {
    try { name = networks.base.abi.parseError(e.data)?.name; } catch { /* Non-contract wallet error. */ }
  }
  const errors: Record<string, string> = {
    EventStarted: "The event has started.", SeatsUnavailable: "Availability changed. Check the latest seat count.",
    SalesAvailable: "Public seats are available again.", InvalidAuthorization: "The authorization is invalid or expired.",
    NotQueued: "This order has already been resolved.", NotTicketOwner: "This ticket is no longer in your wallet.",
    RetryUnavailable: "This state has no pending retry. Refresh to see the latest activity.",
    BindingPending: "Waitlist activation is pending.",
  };
  return (name && errors[name]) || e.shortMessage || e.message || "The wallet request failed.";
}
export interface Publication { name: string; location: string; description: string; cover: string; start: number; capacity: number; price: bigint }

export async function publish(signer: JsonRpcSigner, draft: Publication, fee: bigint, notify: Notify) {
  const address = contractAddress("base");
  const factory = new Contract(address, factoryAbi, signer);
  const block = await signer.provider.getBlock("latest");
  if (!block || draft.start <= block.timestamp) throw new Error("Choose a future start time.");
  notify("Confirm publication and the event’s callback reserve in your wallet.");
  const tx = await factory.createEvent([draft.name, draft.location, draft.description, draft.cover],
    draft.start, draft.capacity, draft.price, { value: fee });
  const hash = await confirm(tx, notify);
  const receipt = await signer.provider.getTransactionReceipt(hash);
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    const created = factory.interface.parseLog(log);
    if (created?.name === "EventCreated" && getAddress(created.args.organizer) === signer.address)
      return getAddress(created.args.eventAddress);
  }
  throw new Error("Publication confirmed. Find the event in the directory.");
}
