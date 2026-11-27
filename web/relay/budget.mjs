import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Contract } from "ethers";

export const relayGasLimit = 1_200_000n;
const feeAbi = ["function reserves(address) view returns(uint256)", "function debt(address) view returns(uint256)"];
const accounting = ["function eventStartTime() view returns(uint256)", "function activeOrders() view returns(uint256)", "function orderIdForNonce(address,bytes32) view returns(uint256)"];
const transport = "function getCallbacks(uint256) view returns((uint256,address sender,uint256,uint256 chainId,uint256 txHash,bytes)[])";
const max = (a, b) => a > b ? a : b;

function threshold(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw Error("Invalid waitlist fee threshold");
  return BigInt(value);
}

export function createBudget(env, base, lasna, factory, watcher, signer) {
  const baseUnit = threshold(env.WAITLIST_BASE_CALLBACK_WEI, 10_000_000_000_000n);
  const relayFloor = threshold(env.WAITLIST_LASNA_TX_WEI, 5_000_000_000_000_000n);
  const watcherUnit = threshold(env.WAITLIST_LASNA_EXECUTION_WEI, 10_000_000_000_000_000n);
  const economy = new Contract("0x8888888888888888888888888888888888888888", [...feeAbi, transport], lasna);
  const dir = env.WAITLIST_RELAY_STATE_DIR || join(homedir(), ".reseat", "relay-state");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, [factory.target, watcher.target].join("-") + ".json");
  let entries = [];
  try { entries = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  function save(next) {
    writeFileSync(file + ".tmp", JSON.stringify(next), { mode: 0o600, flush: true });
    renameSync(file + ".tmp", file);
    entries = next;
  }

  // Both chains are pinned. A mined Lasna transaction still needs a Base delivery allowance.
  async function outstanding(block, lasnaBlock) {
    const snapshot = entries.slice();
    return Promise.all(snapshot.map(async entry => {
      const at = { blockTag: block.number }, event = new Contract(entry.source, accounting, base);
      const receipt = await lasna.getTransactionReceipt(entry.hash);
      const mined = receipt && receipt.blockNumber <= lasnaBlock.number;
      let done = mined && receipt.status === 0;
      let enrolled = false;
      if (mined && !done) {
        const callbacks = await economy.getCallbacks(entry.hash, { blockTag: lasnaBlock.number });
        const delivered = callbacks.find(c => c.sender === watcher.target && c.chainId === 84532n && c.txHash !== 0n);
        if (delivered) {
          const dest = await base.getTransactionReceipt("0x" + delivered.txHash.toString(16).padStart(64, "0"));
          done = Boolean(dest && dest.blockNumber <= block.number);
        }
        // Another relay attempt or a wallet-paid call can create the same order before this callback is billed.
        if (!done && entry.kind === "join") enrolled = await event.orderIdForNonce(entry.buyer, entry.nonce, at) !== 0n;
      }
      return { entry, mined, done, enrolled };
    }));
  }

  async function assess(source, proxy, kind, prune = false) {
    const [block, lasnaBlock, fees] = await Promise.all([base.getBlock("latest"), lasna.getBlock("latest"), lasna.getFeeData()]);
    const at = { blockTag: block.number }, onLasna = { blockTag: lasnaBlock.number };
    const fee = new Contract(proxy, feeAbi, base);
    const [credit, balance, debt, relayBalance, executionCredit, watcherBalance, executionDebt, count, checked] = await Promise.all([
      fee.reserves(source, at), base.getBalance(source, block.number), fee.debt(source, at), lasna.getBalance(signer.address, lasnaBlock.number),
      economy.reserves(watcher.target, onLasna), lasna.getBalance(watcher.target, lasnaBlock.number), economy.debt(watcher.target, onLasna),
      factory.eventCount(at), outstanding(block, lasnaBlock),
    ]);
    const open = checked.filter(row => !row.done);
    if (prune && open.length !== checked.length) save(open.map(row => row.entry));
    // The watcher is shared. Reserve one execution unit for every live order in its factory.
    let localActive = 0n, allActive = 0n;
    for (let offset = 0; offset < Number(count); offset += 16) {
      const rows = await Promise.all(Array.from({ length: Math.min(16, Number(count) - offset) }, async (_, i) => {
        const address = await factory.events(offset + i, at);
        const event = new Contract(address, accounting, base);
        const active = await event.eventStartTime(at) > block.timestamp ? await event.activeOrders(at) : 0n;
        return { address, active };
      }));
      for (const row of rows) { allActive += row.active; if (row.address === source) localActive = row.active; }
    }
    const local = open.filter(row => row.entry.source === source);
    const unseated = rows => BigInt(new Set(rows.filter(({entry, enrolled}) =>
      !enrolled && entry.kind === "join" && entry.deadline > block.timestamp).map(row => row.entry.key)).size);
    const joining = kind === "join";
    // A join needs an enrollment callback plus a future settlement. A cancellation can use its own order's unit.
    const baseUnits = BigInt(local.length) + unseated(local) + (joining ? localActive + 2n : max(localActive, 1n));
    const watchUnits = BigInt(open.length) + unseated(open) + (joining ? allActive + 2n : max(allActive, 1n));
    const maxGasPrice = fees.maxFeePerGas ?? fees.gasPrice;
    if (!maxGasPrice) throw Error("Lasna gas price unavailable");
    const relayUnit = max(relayFloor, relayGasLimit * maxGasPrice);
    const unmined = open.filter(row => !row.mined && row.entry.signer === signer.address).map(row => row.entry);
    const relayHeld = unmined.reduce((sum, entry) => sum + BigInt(entry.relayWei), 0n);
    let status = "ready";
    if (debt > 0n || credit + balance < baseUnits * baseUnit) status = "event-funds";
    else if (relayBalance < relayHeld + relayUnit) status = "relay-funds";
    else if (executionDebt > 0n || executionCredit + watcherBalance < watchUnits * watcherUnit) status = "watcher-funds";
    return { status, relayUnit, fees, block, pending: open.map(row => row.entry), unmined };
  }
  return { assess, reserve(entry) { save([...entries, { ...entry, signer: signer.address }]); } };
}
