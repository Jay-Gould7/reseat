import { Contract, MaxUint256, ZeroAddress, getAddress, isError, parseEther, type Provider } from "ethers";
import { contractAddress, eventPlatform, factoryAbi, networks, reader, type Chain } from "./chain";
import { confirm, type GetSigner, type Notify } from "./wallet";

export type Fund = "event" | "watcher" | "relay";
const system = "0x8888888888888888888888888888888888888888";
const feeService = ["function reserves(address) view returns (uint256)", "function debt(address) view returns (uint256)",
  "function depositTo(address) payable"];
export const fundChain = (fund: Fund): Chain => fund === "event" ? "base" : "lasna";

async function fundingTarget(fund: Fund, source: string | null, rpc: Provider) {
  const event = source ? await eventPlatform(source) : undefined;
  const platform = event ?? { factory: contractAddress("base"), watcher: contractAddress("lasna") };
  const factoryAddress = platform.factory;
  if (fund !== "event") {
    const address = platform.watcher;
    const watcher = new Contract(address, ["function factory() view returns(address)", "function _SERVICE_PROVIDER() view returns(address)", "function waitlistRelay() view returns(address)"], rpc);
    const [factory, service, sender] = await Promise.all([watcher.factory(), watcher._SERVICE_PROVIDER(),
      event?.sender ?? new Contract(factoryAddress, factoryAbi, await reader("base")).watcher()]);
    if (getAddress(factory) !== factoryAddress || getAddress(service) !== system || sender !== address) throw new Error("Check the Lasna watcher binding.");
    if (fund === "relay") {
      const relay = getAddress(await watcher.waitlistRelay().catch((err: unknown) => {
        if (isError(err, "CALL_EXCEPTION") || isError(err, "BAD_DATA")) return ZeroAddress;
        throw err;
      }));
      if (relay === ZeroAddress) throw new Error("The platform has no authorized relay wallet.");
      return { address: relay, service: relay };
    }
    return { address, service: system };
  }
  if (!source) throw new Error("Choose an event published by this factory.");
  const factory = new Contract(factoryAddress, factoryAbi, rpc);
  const [registered, watcher, service] = await Promise.all([factory.isEvent(source), factory.watcher(), factory.callbackProxy()]);
  if (!registered) throw new Error("Choose an event published by this factory.");
  if (getAddress(watcher) !== platform.watcher) throw new Error("Check the Base factory's watcher.");
  return { address: getAddress(source), service: getAddress(service) };
}

export async function readFunding(fund: Fund, source: string | null) {
  const rpc = await reader(fundChain(fund));
  const [target, block] = await Promise.all([fundingTarget(fund, source, rpc), rpc.getBlockNumber()]);
  if (fund === "relay") return { ...target, credit: await rpc.getBalance(target.address, block), debt: 0n };
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

export async function fundBudget(fund: Fund, source: string | null, shown: Budget, value: bigint, getSigner: GetSigner, notify: Notify) {
  const chain = fundChain(fund), signer = await getSigner(chain);
  const target = await fundingTarget(fund, source, signer.provider);
  if (target.address !== shown.address || target.service !== shown.service || value <= 0n)
    throw new Error("Funding settings changed. Refresh and review the amount.");
  const options = { value, chainId: networks[chain].id };
  const tx = fund === "relay" ? await signer.sendTransaction({ ...options, to: target.address }) :
    await new Contract(target.service, feeService, signer).depositTo(target.address, options);
  return confirm(tx, notify, chain);
}
