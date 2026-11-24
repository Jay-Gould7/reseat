import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, parseEther, toBeHex } from "ethers";

export const webRoot = fileURLToPath(new URL("../", import.meta.url));
export const tokenAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const systemAddress = "0x8888888888888888888888888888888888888888";

export async function freePort() {
  const socket = createServer();
  await new Promise((ok, fail) => socket.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = socket.address().port;
  await new Promise(ok => socket.close(ok));
  return port;
}

async function node(t, chain) {
  const port = await freePort();
  const url = "http://127.0.0.1:" + port;
  const child = spawn("anvil", ["--silent", "--accounts", "0", "--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chain)],
    { windowsHide: true, stdio: "ignore" });
  let error;
  child.on("error", e => { error = e; });
  const rpc = new JsonRpcProvider(url, chain, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1, pollingInterval: 100 });
  t.after(() => { rpc.destroy(); child.kill(); });
  for (let i = 0; i < 100; i++) {
    if (error) throw error;
    if (child.exitCode !== null) throw new Error("Local Anvil exited.");
    try { if (Number(await rpc.send("eth_chainId", [])) === chain) return { rpc, url }; } catch { /* Starting. */ }
    await delay(100);
  }
  throw new Error("Local Anvil did not start.");
}

async function artifact(name, file = name) {
  return JSON.parse(await readFile(new URL("../../contracts/out/" + file + ".sol/" + name + ".json", import.meta.url), "utf8"));
}
export const mined = async tx => (await tx).wait();
export async function actor(rpc) {
  const wallet = Wallet.createRandom().connect(rpc);
  await rpc.send("anvil_setBalance", [wallet.address, toBeHex(parseEther("10"))]);
  return wallet;
}
async function deploy(art, wallet, ...args) {
  const contract = await new ContractFactory(art.abi, art.bytecode.object, wallet).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

export async function platform(t) {
  const base = await node(t, 84532);
  const lasna = await node(t, 5318007);
  const operator = await actor(base.rpc), operatorL = await actor(lasna.rpc);
  const tokenArt = await artifact("MockUSDC"), systemArt = await artifact("MockReactiveSystem");
  await base.rpc.send("anvil_setCode", [tokenAddress, tokenArt.deployedBytecode.object]);
  await lasna.rpc.send("anvil_setCode", [systemAddress, systemArt.deployedBytecode.object]);
  const token = new Contract(tokenAddress, tokenArt.abi, operator);
  const system = new Contract(systemAddress, systemArt.abi, operatorL);
  const proxy = await deploy(await artifact("MockCallbackProxy", "MockReactiveSystem"), operator);
  const watcher = await deploy(await artifact("WaitlistReactive"), operatorL);
  const factory = await deploy(await artifact("EventFactory"), operator, proxy.target, watcher.target, parseEther("0.0001"));
  await mined(watcher.bindFactory(factory.target));
  const eventArt = await artifact("EventWaitlist");
  const event = address => new Contract(address, eventArt.abi, operator);

  async function relay(log) {
    return mined(system.relay(watcher.target, { chainId: 84532, contractAddress: log.address, topic0: log.topics[0],
      topic1: log.topics[1] ?? 0, topic2: log.topics[2] ?? 0, topic3: log.topics[3] ?? 0, data: log.data,
      blockNumber: log.blockNumber, opCode: log.topics.length, blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.index }));
  }
  async function deliver(index, destination) {
    const [request, sender] = await system.requestAt(index);
    assert.equal(request.recipient, destination);
    assert.equal(sender, watcher.target);
    return mined(proxy.forward(destination, request.payload, sender, request.gasLimit));
  }
  const cursors = new Map();
  async function relayStates(contract) {
    const logs = await contract.queryFilter(contract.filters.SettlementState(), cursors.get(contract.target) ?? 0);
    for (const log of logs) await relay(log);
    if (logs.length) cursors.set(contract.target, logs.at(-1).blockNumber + 1);
  }
  return { base, lasna, factory, watcher, token, system, proxy, event, relay, deliver, relayStates };
}

export async function walletPage(browser, platform, wallet, origin) {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "UTC" });
  await context.route("https://covers.reseat.test/**", route => route.fulfill({ path: webRoot + "/public/workshop.jpg" }));
  let connected = false;
  let chain = platform.base;
  const signatures = [];
  await context.exposeFunction("requestLocalWallet", async ({ method, params = [] }) => {
    if (method === "eth_requestAccounts") connected = true;
    if (method === "wallet_switchEthereumChain") {
      const id = Number(params[0].chainId);
      assert.ok(id === 84532 || id === 5318007);
      chain = id === 84532 ? platform.base : platform.lasna;
      return null;
    }
    if (method === "eth_accounts" || method === "eth_requestAccounts") return connected ? [wallet.address] : [];
    if (method === "eth_signTypedData_v4") {
      const { domain, types, message } = JSON.parse(params[1]);
      delete types.EIP712Domain;
      assert.equal(domain.verifyingContract.toLowerCase(), tokenAddress.toLowerCase());
      signatures.push(message);
      return wallet.signTypedData(domain, types, message);
    }
    if (method === "eth_sendTransaction") {
      const [tx] = params;
      assert.equal(tx.from.toLowerCase(), wallet.address.toLowerCase());
      return (await wallet.connect(chain.rpc).sendTransaction({ to: tx.to, data: tx.data, value: tx.value || 0, gasLimit: tx.gas })).hash;
    }
    return chain.rpc.send(method, params);
  });
  await context.addInitScript(() => { window.ethereum = { request: window.requestLocalWallet }; });
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Connect Wallet", exact: true }).click();
  await page.getByText("Wallet connected.", { exact: true }).waitFor();
  return { wallet, page, signatures };
}
