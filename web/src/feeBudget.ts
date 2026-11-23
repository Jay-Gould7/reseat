import { Contract, MaxUint256, getAddress, parseEther, type Provider } from "ethers";
import { baseAbi, contractAddress, factoryAbi, networks, reader, refundableFactory, type Chain } from "./chain";
import { confirm, walletSigner, type Notify } from "./wallet";

export type Fund = "event" | "watcher" | "refunds";
const system = "0x8888888888888888888888888888888888888888";
const feeService = ["function reserves(address) view returns (uint256)", "function debt(address) view returns (uint256)",
  "function depositTo(address) payable"];
export const fundChain = (fund: Fund): Chain => fund === "watcher" ? "lasna" : "base";

async function fundingTarget(fund: Fund, source: string | null, rpc: Provider) {
  const factoryAddress = contractAddress("base");
  if (fund === "watcher") {
    const address = contractAddress("lasna");
    const watcher = new Contract(address, ["function factory() view returns(address)", "function _SERVICE_PROVIDER() view returns(address)"], rpc);
    const [factory, service] = await Promise.all([watcher.factory(), watcher._SERVICE_PROVIDER()]);
    if (getAddress(factory) !== factoryAddress || getAddress(service) !== system) throw new Error("Check the Lasna watcher binding.");
    return { address, service: system, refundable: false };
  }
  const factory = new Contract(factoryAddress, factoryAbi, rpc);
  const [refundable, service] = await Promise.all([refundableFactory(factory), factory.callbackProxy()]);
  if (fund === "refunds") return refundable ? { address: factoryAddress, service: getAddress(service), refundable: false } : null;
  if (!source || !await factory.isEvent(source)) throw new Error("Choose an event published by this factory.");
  return { address: getAddress(source), service: getAddress(service), refundable };
}

export async function readFunding(fund: Fund, source: string | null) {
  const rpc = await reader(fundChain(fund));
  const target = await fundingTarget(fund, source, rpc);
  if (!target) return null;
  const service = new Contract(target.service, feeService, rpc);
  const block = await rpc.getBlock("latest");
  if (!block) throw new Error("Waiting for the latest block.");
  const at = { blockTag: block.number };
  const [credit, debt] = await Promise.all([service.reserves(target.address, at), service.debt(target.address, at)]);
  const budget = { ...target, credit: BigInt(credit), debt: BigInt(debt) };
  if (!target.refundable) return { ...budget, event: null };
  const e = new Contract(target.address, baseAbi, rpc);
  const [balance, owner, recipient, refunded, returned, closing, delivered, expected, start, retryAt] = await Promise.all([
    rpc.getBalance(target.address, block.number), e.organizer(at), e.feeRecipient(at), e.feesRefunded(at), e.returnedFees(at), e.feeCloseConfirmed(at),
    e.deliveredCallbacks(at), e.expectedCallbacks(at), e.eventStartTime(at), e.nextFeeRetry(at),
  ]);
  return { ...budget, event: { balance, owner: getAddress(owner), recipient: getAddress(recipient), refunded: Boolean(refunded), returned: BigInt(returned),
    closing: Boolean(closing), delivered: BigInt(delivered), expected: BigInt(expected), started: BigInt(block.timestamp) >= start,
    retryDue: BigInt(block.timestamp) >= retryAt } };
}

export type Budget = NonNullable<Awaited<ReturnType<typeof readFunding>>>;
export function nativeAmount(text: string) {
  if (!/^(?:\d+|\d*\.\d{1,18})$/.test(text.trim())) return 0n;
  try { const value = parseEther(text.trim()); return value <= MaxUint256 ? value : 0n; } catch { return 0n; }
}

export async function fundBudget(fund: Fund, source: string | null, shown: Budget, value: bigint, account: string, notify: Notify) {
  const chain = fundChain(fund), signer = await walletSigner(account, chain);
  const target = await fundingTarget(fund, source, signer.provider);
  if (!target || target.address !== shown.address || target.service !== shown.service || target.refundable !== shown.refundable || value <= 0n)
    throw new Error("Funding settings changed. Refresh and review the amount.");
  const options = { value, chainId: networks[chain].id };
  const tx = target.refundable
    ? await new Contract(target.address, baseAbi, signer).topUpFees(options)
    : await new Contract(target.service, feeService, signer).depositTo(target.address, options);
  return confirm(tx, notify, chain);
}
