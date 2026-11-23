import { BrowserProvider, Contract, Signature, TypedDataEncoder, getAddress, hexlify, isError, randomBytes,
  type ContractTransactionResponse, type Eip1193Provider, type JsonRpcSigner } from "ethers";
import { useEffect, useState } from "react";
import { BASE, USDC, baseAbi, bindingStatus, contractAddress, factoryAbi, networks, readBaseBinding, readLasna, tokenAbi, type Chain } from "./chain";

interface Wallet extends Eip1193Provider {
  on?: (name: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (name: string, cb: (...args: unknown[]) => void) => void;
}
declare global { interface Window { ethereum?: Wallet } }

function injected() {
  if (!window.ethereum) throw new Error("Open this page in a wallet browser or enable a browser wallet.");
  return window.ethereum;
}

export function useWallet() {
  const [account, setAccount] = useState("");
  useEffect(() => {
    const wallet = window.ethereum;
    if (!wallet) return;
    let current = true;
    function update(accounts: unknown) {
      if (current) setAccount(Array.isArray(accounts) && accounts[0] ? getAddress(accounts[0]) : "");
    }
    const refresh = () => { void wallet!.request({ method: "eth_accounts" }).then(update).catch(() => update([])); };
    refresh();
    wallet.on?.("accountsChanged", update);
    wallet.on?.("chainChanged", refresh);
    return () => { current = false; wallet.removeListener?.("accountsChanged", update); wallet.removeListener?.("chainChanged", refresh); };
  }, []);
  async function connect() {
    const accounts = await injected().request({ method: "eth_requestAccounts" }) as string[];
    if (!accounts[0]) throw new Error("Select an account to connect.");
    setAccount(getAddress(accounts[0]));
  }
  return { account, connect };
}

export async function walletSigner(account: string, chain: Chain = "base") {
  const wallet = injected();
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
  return provider.getSigner(account);
}

export const workshopWith = (source: string, signer: JsonRpcSigner) => new Contract(source, baseAbi, signer);
export type Notify = (text: string, hash?: string, chain?: Chain) => void;

export async function confirm(tx: ContractTransactionResponse, notify: Notify, chain: Chain = "base") {
  notify("Waiting for " + networks[chain].label + " confirmation…", tx.hash, chain);
  try {
    const receipt = await tx.wait(1);
    if (receipt?.status !== 1) throw new Error("The transaction did not confirm.");
    return receipt.hash;
  } catch (error) {
    if (isError(error, "TRANSACTION_REPLACED") && !error.cancelled && error.receipt.status === 1) return error.receipt.hash;
    throw error;
  }
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

export async function join(signer: JsonRpcSigner, source: string, qty: number, userDeadline: number, notify: Notify) {
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
  const nonce = hexlify(randomBytes(32));
  const fields = { ReceiveWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] };
  notify("Step 1 of 2 · Sign the exact USDC authorization.");
  const sig = Signature.from(await signer.signTypedData(domain, fields, { from: signer.address, to: source,
    value: BigInt(qty) * price, validAfter: 0, validBefore, nonce }));
  notify("Step 2 of 2 · Confirm your waitlist entry on Base.");
  return confirm(await workshop.enqueue(qty, userDeadline, [nonce, sig.v, sig.r, sig.s]), notify);
}

export function walletError(err: unknown) {
  const e = err as { code?: string | number; revert?: {name: string}; data?: string; shortMessage?: string; message?: string };
  if (e.code === 4001 || e.code === "ACTION_REJECTED") return "Request declined in your wallet.";
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
