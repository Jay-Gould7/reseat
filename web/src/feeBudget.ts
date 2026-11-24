import { Contract, MaxUint256, getAddress, parseEther, type Provider } from "ethers";
import { contractAddress, factoryAbi, networks, reader, type Chain } from "./chain";
import { confirm, walletSigner, type Notify } from "./wallet";

export type Fund = "event" | "watcher";
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
    return { address, service: system };
  }
  if (!source) throw new Error("Choose an event published by this factory.");
  const factory = new Contract(factoryAddress, factoryAbi, rpc);
  const [registered, watcher, service] = await Promise.all([factory.isEvent(source), factory.watcher(), factory.callbackProxy()]);
  if (!registered) throw new Error("Choose an event published by this factory.");
  if (getAddress(watcher) !== contractAddress("lasna")) throw new Error("Check the Base factory's watcher.");
  return { address: getAddress(source), service: getAddress(service) };
}

export async function readFunding(fund: Fund, source: string | null) {
  const rpc = await reader(fundChain(fund));
  const [target, block] = await Promise.all([fundingTarget(fund, source, rpc), rpc.getBlockNumber()]);
  const service = new Contract(target.service, feeService, rpc);
  const at = { blockTag: block };
  const [credit, debt] = await Promise.all([service.reserves(target.address, at), service.debt(target.address, at)]);
  return { ...target, credit: BigInt(credit), debt: BigInt(debt) };
}

export type Budget = Awaited<ReturnType<typeof readFunding>>;
export function nativeAmount(text: string) {
  if (!/^(?:\d+|\d*\.\d{1,18})$/.test(text.trim())) return 0n;
  try { const value = parseEther(text.trim()); return value <= MaxUint256 ? value : 0n; } catch { return 0n; }
}

export async function fundBudget(fund: Fund, source: string | null, shown: Budget, value: bigint, account: string, notify: Notify) {
  const chain = fundChain(fund), signer = await walletSigner(account, chain);
  const target = await fundingTarget(fund, source, signer.provider);
  if (target.address !== shown.address || target.service !== shown.service || value <= 0n)
    throw new Error("Funding settings changed. Refresh and review the amount.");
  const options = { value, chainId: networks[chain].id };
  const tx = await new Contract(target.service, feeService, signer).depositTo(target.address, options);
  return confirm(tx, notify, chain);
}
