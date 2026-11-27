import assert from "node:assert/strict";
import test from "node:test";
import { Signature, hexlify, parseEther, randomBytes, toBeHex } from "ethers";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { actor, freePort, mined, platform, walletPage, webRoot } from "./local.mjs";

async function openPlatform(t) {
  const p = await platform(t);
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  Object.assign(process.env, { VITE_BASE_RPC_URL: p.base.url, VITE_LASNA_RPC_URL: p.lasna.url,
    BASE_SEPOLIA_RPC_URL: p.base.url, LASNA_RPC_URL: p.lasna.url, WAITLIST_RELAY_PRIVATE_KEY: p.relayer.privateKey,
    VITE_FACTORY_ADDRESS: p.factory.target, VITE_REACTIVE_ADDRESS: p.watcher.target,
    VITE_BASE_START_BLOCK: "0", VITE_LASNA_START_BLOCK: "0" });
  const server = await createServer({ root: webRoot, cacheDir: "node_modules/.vite-reseat-tests", logLevel: "error",
    server: { host: "127.0.0.1", port, strictPort: true } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.RESEAT_BROWSER });
  t.after(() => browser.close());
  return { p, server, browser, origin };
}

test("publish and share two independent events, activate, reserve and recover payment", { timeout: 240_000 }, async t => {
  const { p, server, browser, origin } = await openPlatform(t);
  const newUser = async () => walletPage(browser, p, await actor(p.base.rpc), origin);
  const hostA = await newUser(), hostB = await newUser();
  const now = (await p.base.rpc.getBlock("latest")).timestamp;
  async function publish(host, name, days, seats, price) {
    const page = host.page;
    await page.getByRole("link", { name: "Publish event", exact: true }).first().click();
    await page.getByText("0.0001 test ETH", { exact: true }).waitFor();
    await page.getByText(/Unused credit is non-refundable/).waitFor();
    await page.locator('[name="name"]').fill(name);
    await page.locator('[name="start"]').fill(new Date((now + days * 86400) * 1000).toISOString().slice(0, 16));
    await page.locator('[name="capacity"]').fill(String(seats)); await page.locator('[name="price"]').fill(price);
    await page.locator('[name="location"]').fill("Studio " + name);
    await page.getByRole("textbox", { name: "About the event Optional" }).fill("Guests will build together at " + name + ".");
    await page.locator('[name="cover"]').fill("https://covers.reseat.test/poster.jpg");
    await page.getByRole("button", { name: "Publish event", exact: true }).click();
    await page.waitForURL(/\?event=0x/);
    await page.getByRole("heading", { name, exact: true }).waitFor();
    return p.event(new URL(page.url()).searchParams.get("event"));
  }
  const a = await publish(hostA, "Morning Lab", 2, 2, "20");
  const b = await publish(hostB, "Evening Studio", 3, 3, "7.5");
  assert.equal(await a.organizer(), hostA.wallet.address); assert.equal(await b.organizer(), hostB.wallet.address);
  assert.equal(await p.factory.eventCount(), 2n);
  await hostA.page.getByText("Share event", { exact: true }).click();
  const share = await hostA.page.getByLabel("Shareable event link").inputValue();
  const guest = await browser.newContext({ locale: "zh-CN", viewport: { width: 390, height: 844 } });
  await guest.route("https://covers.reseat.test/**", r => r.fulfill({ path: webRoot + "/public/workshop.jpg" }));
  const mobile = await guest.newPage(); await mobile.goto(share);
  await mobile.getByRole("heading", { name: "Morning Lab", exact: true }).waitFor();
  await mobile.getByText("Studio Morning Lab", { exact: true }).waitFor();
  assert.equal(await mobile.locator("img.poster").getAttribute("src"), "https://covers.reseat.test/poster.jpg");
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(await mobile.locator("header").getByRole("button", {name:"连接钱包",exact:true}).isVisible());

  async function refresh(page) {
    await Promise.all([p.base.rpc.send("anvil_mine", ["0x3"]), p.lasna.rpc.send("anvil_mine", ["0x2"])]);
    await page.evaluate(() => window.dispatchEvent(new Event("reseat:confirmed")));
  }
  async function buy(host, qty) {
    await mined(p.token.mint(host.wallet.address, 100_000_000n));
    await host.page.getByLabel("Ticket quantity", {exact:true}).fill(String(qty));
    await host.page.getByRole("button", {name:"Buy " + qty + " tickets",exact:true}).click();
    await host.page.getByText("Tickets issued to your wallet.", {exact:true}).waitFor();
    await refresh(host.page);
    assert.equal(await host.page.getByRole("button", {name:"Waitlist activation pending"}).isDisabled(),true);
  }
  await buy(hostA,2); await buy(hostB,3);
  const announcements = await p.factory.queryFilter(p.factory.filters.EventCreated());
  for (const [i, target] of [a,b].entries()) {
    const index = await p.system.requestCount();
    await p.relay(announcements[i]); await p.deliver(index,target.target);
    if (i === 0) {
      await refresh(hostA.page);
      assert.equal(await hostA.page.getByRole("button", {name:"Waitlist activation pending"}).isDisabled(),true);
    }
    await p.relayStates(target);
  }

  const chain = await server.ssrLoadModule("/src/chain.ts");
  const binding = await chain.readBaseBinding(p.base.rpc, a.target), watcher = await chain.readLasna(a.target);
  assert.equal(chain.bindingStatus(binding, watcher), "ready");
  for (const invalid of [null, {...watcher,source:b.target}, {...watcher,factory:b.target}, {...watcher,address:b.target},
    {...watcher,registered:false}, {...watcher,revision:0n}]) assert.equal(chain.bindingStatus(binding, invalid) === "ready", false);
  assert.equal(chain.bindingStatus({...binding,confirmed:false},watcher),"pending");

  // A previously ready screen must recheck the binding before it asks the wallet to sign.
  const changedBinding = await newUser();
  await changedBinding.page.goto(share);
  await changedBinding.page.getByText("Automatic waitlist ready", {exact:true}).waitFor();
  await changedBinding.page.route(p.lasna.url + "/**", async route => {
    const call = route.request().postDataJSON();
    if (call?.method !== "eth_call" || call.params[0].data !== p.watcher.interface.encodeFunctionData("factory")) {
      return route.continue();
    }
    return route.fulfill({ json: { jsonrpc: "2.0", id: call.id,
      result: p.watcher.interface.encodeFunctionResult("factory", [b.target]) } });
  });
  await changedBinding.page.getByRole("button", {name:"Sign & join waitlist"}).click();
  await changedBinding.page.getByText("The watcher binding for this event could not be confirmed.", {exact:true}).waitFor();
  await changedBinding.page.getByText("Automatic waitlist unavailable", {exact:true}).waitFor();
  assert.equal(await changedBinding.page.getByRole("button", {name:"Waitlist unavailable"}).isDisabled(), true);
  assert.equal(changedBinding.signatures.length, 0);
  await changedBinding.page.close();

  const lin = await newUser(), mei = await newUser();
  async function join(user, target, qty, total) {
    await mined(p.token.mint(user.wallet.address, total));
    await user.page.goto(origin + "/?event=" + target.target);
    await user.page.getByText("Automatic waitlist ready", {exact:true}).waitFor();
    await user.page.getByLabel("Ticket quantity", {exact:true}).fill(String(qty));
    await user.page.getByRole("button", {name:"Sign & join waitlist"}).click();
    await p.deliverSponsored(target, "enqueueSponsored");
    await user.page.getByText("Your order is confirmed on the waitlist.", {exact:true}).waitFor();
    assert.equal(user.signatures.length,1);
    assert.equal(user.signatures[0].to.toLowerCase(),target.target.toLowerCase());
    assert.equal(BigInt(user.signatures[0].value),total);
  }
  await join(lin,a,2,40_000_000n); await join(mei,b,3,22_500_000n);
  async function refund(host, target, price) {
    await host.page.getByRole("button", {name:"Refund " + price + " USDC",exact:true}).first().click();
    await host.page.getByText("Ticket refunded to your wallet.", {exact:true}).waitFor();
    await p.relayStates(target); await refresh(host.page);
  }
  await refund(hostA,a,"20"); await refund(hostB,b,"7.5");
  await refresh(mobile);
  await refresh(lin.page);
  await lin.page.getByRole("region", { name: "My waitlist orders" }).getByText("Holding 1 seat · 1 more needed. No USDC charged.", {exact:true}).waitFor();
  await mobile.getByText("候补已就绪", {exact:true}).waitFor();
  assert.equal(await mobile.getByText(/已暂留|还差|订单 #/).count(), 0);
  assert.equal(await mobile.getByRole("heading", {name:"我的候补订单"}).count(), 0);
  assert.equal(await mobile.getByRole("link", { name: "发布活动", exact: true }).count(), 1);
  const bRevision = (await p.watcher.sourceState(b.target)).revision;
  const pending = await p.system.requestCount();
  await refund(hostA,a,"20");
  await mined(p.token.setCollectionFailure(true)); await p.deliver(pending,a.target); await p.relayStates(a);
  assert.equal(await a.headId(),1n); assert.equal(await p.token.balanceOf(lin.wallet.address),40_000_000n);
  await lin.page.close();
  await mined(p.token.setCollectionFailure(false));
  const due = Number((await p.watcher.sourceState(a.target)).paymentRetryAt);
  assert.ok(due > (await p.base.rpc.getBlock("latest")).timestamp);
  await p.base.rpc.send("evm_setNextBlockTimestamp", [due]);
  await p.base.rpc.send("evm_mine", []);
  await p.lasna.rpc.send("evm_setNextBlockTimestamp", [due]);
  await mined(p.system.relay(p.watcher.target, {
    chainId: 5318007, contractAddress: await p.watcher.CRON_EMITTER(), topic0: await p.watcher.CRON10(),
    topic1: 0, topic2: 0, topic3: 0, data: "0x", blockNumber: 0, opCode: 1, blockHash: 0, txHash: 0, logIndex: 0
  }));
  assert.equal(await p.system.requestCount(), pending + 2n);
  await p.deliver(pending + 1n, a.target);
  await p.relayStates(a);
  await p.deliver(pending + 1n, a.target);
  assert.equal(await a.ticketBalance(lin.wallet.address),2n); assert.equal(await p.token.balanceOf(lin.wallet.address),0n);
  assert.equal(await b.activeOrders(),1n); assert.equal(await b.availableSpots(),1n);
  assert.equal((await p.watcher.sourceState(b.target)).revision,bRevision); assert.equal(await p.watcher.cronActive(),true);
  assert.equal(await p.token.balanceOf(mei.wallet.address),22_500_000n);
  await refresh(mobile);
  await mobile.getByText("候补已自动出票", {exact:true}).waitFor();
  await mobile.getByRole("button", {name:"Lasna",exact:true}).click();
  await mobile.getByText("已请求自动重试收款", {exact:true}).waitFor();
  await mobile.getByText("本场活动已停止检查候补截止时间", {exact:true}).first().waitFor();
  const retryLog = mobile.locator("#activity li").filter({ hasText: "已请求自动重试收款" });
  assert.match(await retryLog.getByRole("link", { name: "Reactscan" }).getAttribute("href"), /^https:\/\/lasna\.reactscan\.net\/tx\/0x/);
  assert.doesNotMatch(await mobile.locator("#activity").innerText(), /订单\s*#|order\s*#|CRON|暂留\s*\d/i);
  await mobile.goto(origin); await mobile.getByRole("heading",{name:"Morning Lab"}).waitFor();
  await mobile.getByRole("heading",{name:"Evening Studio"}).waitFor();
});

test("public total and private ranks use the full live queue and Base time without a refund", { timeout: 120_000 }, async t => {
  const { p, browser, origin } = await openPlatform(t);
  const seller = await actor(p.base.rpc);
  const buyerB = await actor(p.base.rpc);
  const buyerC = await actor(p.base.rpc);
  const price = 20_000_000n;
  const deadline = (await p.base.rpc.getBlock("latest")).timestamp + 600;
  const start = deadline + 3600;
  await mined(p.factory.connect(seller).createEvent(["Queue test", "", "", ""], start, 1, price,
    { value: await p.factory.callbackDeposit() }));
  const event = p.event(await p.factory.events(0));
  await p.relay((await p.factory.queryFilter(p.factory.filters.EventCreated()))[0]);
  await p.deliver(0, event.target);
  await p.relayStates(event);
  await mined(p.token.mint(seller.address, price));
  await mined(p.token.connect(seller).approve(event.target, price));
  await mined(event.connect(seller).buy(1));
  await mined(p.token.mint(buyerC.address, price));

  const domain = { name: await p.token.name(), version: await p.token.version(), verifyingContract: p.token.target, chainId: 84532 };
  const types = { ReceiveWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }
  ] };
  for (let i = 0; i < 7; i++) {
    const buyer = i === 1 ? buyerC : buyerB;
    const validBefore = i === 1 ? start : deadline;
    const nonce = hexlify(randomBytes(32));
    const sig = Signature.from(await buyer.signTypedData(domain, types,
      { from: buyer.address, to: event.target, value: price, validAfter: 0, validBefore, nonce }));
    await mined(event.connect(buyer).enqueue(1, validBefore, [nonce, sig.v, sig.r, sig.s]));
  }
  await p.base.rpc.send("anvil_mine", ["0x3"]);
  const page = await browser.newPage({ locale: "zh-CN" });
  let releaseOrder;
  const gate = new Promise(resolve => { releaseOrder = resolve; });
  t.after(() => releaseOrder());
  await page.route(p.base.url + "/**", async route => {
    const call = route.request().postDataJSON();
    if (call?.method === "eth_call" && call.params[0].data === event.interface.encodeFunctionData("orderInfo", [7])) await gate;
    await route.continue();
  });
  const url = origin + "/?event=" + event.target;
  await page.goto(url);
  const queue = page.locator("#waitlist");
  const total = queue.getByRole("status");
  await total.getByText("读取中…").waitFor();
  releaseOrder();
  await total.getByText("7", { exact: true }).waitFor();
  assert.equal(await queue.getByRole("button").count(), 0);
  const b = (await walletPage(browser, p, buyerB, url)).page, c = (await walletPage(browser, p, buyerC, url)).page;
  const mineB = b.getByRole("region", {name:"My waitlist orders"}), mineC = c.getByRole("region", {name:"My waitlist orders"});
  await mineC.getByText("Queue position #2", {exact:true}).waitFor();
  await mineB.getByRole("button", {name:"Show more orders"}).click();
  assert.equal(await mineB.locator("article").count(), 6);
  await p.base.rpc.send("evm_setNextBlockTimestamp", [deadline]);
  await p.base.rpc.send("evm_mine", []);
  assert.equal(Number((await p.base.rpc.send("eth_getBlockByNumber", ["latest", false])).timestamp), deadline);
  // Let the open pages observe the exact deadline without a refund or settlement.
  await total.getByText("1", { exact: true }).waitFor();
  await mineC.getByText("Queue position #1", {exact:true}).waitFor();
  assert.equal(await mineC.getByText("Order #1", {exact:true}).count(), 0);
  assert.equal(await event.activeOrders(), 7n);
  await mineB.getByRole("button", {name:"History", exact:true}).click();
  await mineB.getByRole("button", {name:"Show more orders"}).click();
  const rowB = mineB.locator("article").filter({has: b.getByRole("heading", {name:"Order #1", exact:true})});
  await rowB.getByText("Deadline passed", {exact:true}).waitFor();
  assert.equal(await rowB.getByRole("button").count(), 0);

  // A later refund gives Base a reason to resolve the expired head on-chain.
  await mined(event.connect(seller).refund(1));
  await p.relayStates(event);
  await p.deliver(1, event.target);
  await p.base.rpc.send("anvil_mine", ["0x3"]);
  await b.evaluate(() => window.dispatchEvent(new Event("reseat:confirmed")));
  await rowB.getByText("Expired on Base", {exact:true}).waitFor();
  assert.equal(await event.ticketBalance(buyerC.address), 1n);
});

test("top up the Lasna watcher and an event's Base proxy credit from the funding page", { timeout: 120_000 }, async t => {
  const { p, browser, origin, server } = await openPlatform(t);
  const host = await actor(p.base.rpc), sponsor = await actor(p.base.rpc);
  await p.lasna.rpc.send("anvil_setBalance", [sponsor.address, toBeHex(parseEther("1"))]);
  const start = (await p.base.rpc.getBlock("latest")).timestamp + 86400;
  const initial = await p.factory.callbackDeposit();
  await mined(p.factory.connect(host).createEvent(["Funding Lab", "", "", ""], start, 3, 1_000_000n, { value: initial }));
  const event = await p.factory.events(0);

  const guest = await browser.newPage({ locale: "en-US" });
  await guest.goto(origin + "/?funding");
  await guest.getByLabel("Base event address").fill(event);
  await guest.getByRole("button", { name: "View event balance" }).click();
  await guest.getByText("0.0001 ETH", { exact: true }).waitFor();
  await guest.getByRole("region", { name: "Event callbacks" }).getByRole("button", { name: "Connect wallet to fund" }).waitFor();
  assert.equal(await guest.getByRole("region", { name: "Automatic refund delivery" }).count(), 0);

  const { page } = await walletPage(browser, p, sponsor, origin + "/?event=" + event);
  await page.getByRole("link", { name: "Event funding", exact: true }).click();
  const watcher = page.getByRole("region", { name: "Platform watcher" });
  await watcher.getByLabel("Top-up amount (lREACT)").fill("0.1");
  await watcher.getByRole("button", { name: "Add 0.1 lREACT" }).click();
  await watcher.getByText("0.1 lREACT", { exact: true }).waitFor();
  assert.match(await page.getByRole("link", { name: "View on Reactscan" }).getAttribute("href"), /^https:\/\/lasna\.reactscan\.net\/tx\/0x/);

  const callbacks = page.getByRole("region", { name: "Event callbacks" });
  await callbacks.getByLabel("Top-up amount (ETH)").fill("0");
  assert.ok(await callbacks.getByRole("button", { name: "Add ETH" }).isDisabled());
  await callbacks.getByLabel("Top-up amount (ETH)").fill("0.0002");
  await callbacks.getByRole("button", { name: "Add 0.0002 ETH" }).click();
  await callbacks.getByText("0.0003 ETH", { exact: true }).waitFor();
  assert.match(await page.getByRole("link", { name: "View on BaseScan" }).getAttribute("href"), /^https:\/\/sepolia\.basescan\.org\/tx\/0x/);
  assert.equal(await p.proxy.reserves(event), initial + parseEther("0.0002"));
  assert.equal(await p.base.rpc.getBalance(event), 0n);
  assert.equal(await p.proxy.reserves(p.factory.target), 0n);
  assert.equal(await p.system.reserves(p.watcher.target), parseEther("0.1"));

  const budgets = await server.ssrLoadModule("/src/feeBudget.ts");
  await assert.rejects(budgets.readFunding("event", host.address), /Choose an event published by this factory/);
});

test("mobile navigation shows the selected event before its live inventory arrives", { timeout: 90_000 }, async t => {
  const { p, browser, origin } = await openPlatform(t);
  const host = await actor(p.base.rpc);
  const start = (await p.base.rpc.getBlock("latest")).timestamp + 86400;
  for (const name of ["First Studio", "Next Studio"]) {
    await mined(p.factory.connect(host).createEvent([name, name + " venue", "", ""], start, 3, 2_000_000n, { value: await p.factory.callbackDeposit() }));
  }
  const event = p.event(await p.factory.events(0));
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 390, height: 844 } });
  await page.goto(origin);
  const nav = page.getByRole("navigation", { name: "主导航" });
  assert.deepEqual(await nav.getByRole("link").allTextContents(), ["首页", "活动"]);
  await page.evaluate(() => { window.reseatPageMarker = "same document"; });
  await nav.getByRole("link", { name: "活动", exact: true }).click();
  await page.getByRole("heading", { name: "活动", exact: true }).waitFor();
  await page.getByRole("heading", { name: "First Studio" }).waitFor();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  await page.route(p.base.url + "/**", async route => {
    const call = route.request().postDataJSON();
    if (call?.method === "eth_call" && call.params[0].data === event.interface.encodeFunctionData("settlementState")) await gate;
    await route.continue();
  });
  await page.getByRole("link", { name: /First Studio/ }).click();
  await page.getByRole("heading", { name: "First Studio", level: 1 }).waitFor();
  await page.getByText("正在读取本场活动的可售票数…").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Next Studio" }).count(), 0);
  assert.deepEqual(await nav.getByRole("link").allTextContents(), ["首页", "活动"]);
  assert.equal(await page.locator(".registration").count(), 0);
  await page.goBack();
  await page.getByRole("heading", { name: "活动", exact: true }).waitFor();
  await page.goForward();
  await page.getByRole("heading", { name: "First Studio", level: 1 }).waitFor();
  release();
  await page.locator(".registration").getByText("可售 3 张 · 共 3 张").waitFor();
  assert.equal(await page.evaluate(() => window.reseatPageMarker), "same document");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test("two zero-ETH accounts join and cancel with event credit across wallet extensions", { timeout: 120_000 }, async t => {
  const { p, browser, origin } = await openPlatform(t);
  const host = await actor(p.base.rpc), first = await actor(p.base.rpc);
  const buyer = await actor(p.base.rpc), other = await actor(p.base.rpc);
  const start = (await p.base.rpc.getBlock("latest")).timestamp + 86400;
  const price = 20_000_000n;
  await mined(p.factory.connect(host).createEvent(["Account Lab", "", "", ""], start, 2, price, { value: await p.factory.callbackDeposit() }));
  const event = p.event(await p.factory.events(0));
  await p.relay((await p.factory.queryFilter(p.factory.filters.EventCreated()))[0]);
  await p.deliver(0, event.target);
  await p.relayStates(event);
  await mined(p.token.mint(host.address, price * 2n));
  await mined(p.token.connect(host).approve(event.target, price * 2n));
  await mined(event.connect(host).buy(2));
  await mined(p.token.mint(buyer.address, price * 2n));
  await mined(p.token.mint(other.address, price));

  const url = origin + "/?event=" + event.target;
  await p.base.rpc.send("anvil_setBalance", [buyer.address, "0x0"]);
  await p.base.rpc.send("anvil_setBalance", [other.address, "0x0"]);
  await p.base.rpc.send("anvil_setCode", [other.address, "0xef0100d6cedde84be40893d153be9d467cd6ad37875b28"]);
  const fee = parseEther("0.000005");
  await mined(p.proxy.setDeliveryFee(fee));
  const credit = await p.proxy.reserves(event.target);
  const { page, transactions, signatures } = await walletPage(browser, p, first, url, { secondAccount: buyer, otherWallet: other, rejectWalletTransactions: true });
  await page.setViewportSize({ width: 320, height: 780 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const switcher = page.getByRole("button", { name: "Switch wallet or account" });
  const dialog = page.getByRole("dialog");
  const mine = page.getByRole("region", { name: "My waitlist orders" });
  let releaseHistory, releaseQueue;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  const queueGate = new Promise(resolve => { releaseQueue = resolve; });
  t.after(() => { releaseHistory(); releaseQueue(); });
  await page.route(p.base.url + "/**", async route => {
    const call = route.request().postDataJSON();
    if (call?.method === "eth_getLogs") await historyGate;
    if (call?.method === "eth_call" && call.params[0].data === event.interface.encodeFunctionData("nextId")) await queueGate;
    await route.continue();
  });
  async function selectExtension(name) {
    await switcher.click();
    await dialog.getByRole("button", { name, exact: true }).click();
  }
  async function join(qty) {
    await page.getByText("Automatic waitlist ready", { exact: true }).waitFor();
    await page.getByLabel("Ticket quantity", { exact: true }).fill(String(qty));
    await page.getByRole("button", { name: "Sign & join waitlist" }).click();
    await page.getByText("The event is paying the fee. Waiting for Base confirmation…", { exact: true }).waitFor();
    assert.equal(await page.getByText("Your order is confirmed on the waitlist.", { exact: true }).count(), 0);
    await p.deliverSponsored(event, "enqueueSponsored");
    await mine.getByRole("button", { name: "Cancel waitlist order" }).waitFor();
  }
  await switcher.click();
  await dialog.getByRole("button", { name: "Choose accounts in wallet" }).click();
  await dialog.getByRole("button", { name: buyer.address, exact: true }).click();
  await join(2);
  await mine.getByText("2 tickets · 40 USDC", { exact: true }).waitFor();
  assert.equal((await event.orderInfo(1)).buyer, buyer.address);
  releaseQueue();

  await selectExtension("Wallet Two");
  await mine.getByText("No active waitlist orders for this wallet.", { exact: true }).waitFor();
  await join(1);
  await mine.getByText("Order #2", { exact: true }).waitFor();
  assert.equal((await event.orderInfo(2)).buyer, other.address);
  assert.equal(await mine.getByText("Order #1", { exact: true }).count(), 0);
  await mined(event.connect(host).refund(1));
  await page.evaluate(() => window.dispatchEvent(new Event("reseat:confirmed")));
  await page.locator(".registration").getByText("0 available · 2 total", {exact:true}).waitFor();
  await mine.getByText("Queue position #2", {exact:true}).waitFor();
  assert.doesNotMatch(await page.locator("main").innerText(), /Holding 1 seat|Order #1|Resend waitlist status|Organizer tools|head deadline/i);
  const {page: hostPage, signatures: hostSignatures} = await walletPage(browser, p, host, url);
  const hostNonce = await p.base.rpc.getTransactionCount(host.address);
  await hostPage.getByText("Organizer tools", {exact:true}).click();
  await hostPage.getByText(/Your wallet will confirm a Base transaction and pay gas/).waitFor();
  assert.equal(await p.base.rpc.getTransactionCount(host.address), hostNonce);
  assert.equal(await hostPage.getByText(/Holding 1 seat|Order #1/).count(), 0);
  await hostPage.getByRole("button", {name:"Resend waitlist status", exact:true}).click();
  await hostPage.getByText("Waitlist status republished on Base.", {exact:true}).waitFor();
  assert.equal(await p.base.rpc.getTransactionCount(host.address), hostNonce + 1);
  assert.equal(hostSignatures.length, 0);
  assert.equal(await p.token.balanceOf(buyer.address), price * 2n);
  await page.getByRole("navigation").getByRole("link", { name: "Events" }).click();
  await page.getByRole("link", { name: /Account Lab/ }).getByText("0 available · 2 total").waitFor();
  await page.getByRole("link", { name: /Account Lab/ }).click();
  await selectExtension("Wallet One");
  await mine.getByText("Order #1", { exact: true }).waitFor();
  await mine.getByText("Holding 1 seat · 1 more needed. No USDC charged.", {exact:true}).waitFor();
  // A fresh read must find an old pending order even when all public Base history stays blocked.
  await p.base.rpc.send("anvil_mine", ["0x180"]);
  await page.reload();
  await mine.getByRole("button", { name: "Cancel waitlist order" }).click();
  await p.deliverSponsored(event, "cancelSponsored");
  await page.getByText("Your waitlist order was cancelled.", {exact:true}).waitFor();
  await mine.getByRole("button", {name:"History",exact:true}).click();
  await mine.getByText("Cancelled", { exact: true }).waitFor();
  assert.equal((await event.orderInfo(1)).status, 4n);
  assert.equal((await event.orderInfo(2)).status, 1n);
  assert.equal(await p.proxy.reserves(event.target), credit - 3n * fee);
  assert.equal(await p.base.rpc.getBalance(buyer.address), 0n);
  assert.equal(await p.base.rpc.getBalance(other.address), 0n);
  assert.equal(transactions.length, 0);
  assert.equal(signatures.length, 3);
  assert.equal(await p.token.balanceOf(buyer.address), price * 2n);
  assert.equal(await mine.getByRole("button", { name: "Cancel waitlist order" }).count(), 0);
  await page.reload();
  await mine.getByRole("button", {name:"History",exact:true}).click();
  await mine.getByText("Cancelled", { exact: true }).waitFor();
  releaseHistory();
});

test("funding gates signatures and a pending entry survives reload and duplicate submission", { timeout: 120_000 }, async t => {
  const { p, browser, origin } = await openPlatform(t);
  const host = await actor(p.base.rpc), buyer = await actor(p.base.rpc);
  const start = (await p.base.rpc.getBlock("latest")).timestamp + 86400;
  const price = 2_000_000n, credit = await p.factory.callbackDeposit();
  await mined(p.factory.connect(host).createEvent(["Sponsored Lab", "", "", ""], start, 1, price, { value: credit }));
  const event = p.event(await p.factory.events(0));
  await mined(p.proxy.setDeliveryFee(credit));
  await p.relay((await p.factory.queryFilter(p.factory.filters.EventCreated()))[0]);
  await p.deliver(0, event.target);
  await p.relayStates(event);
  await mined(p.token.mint(host.address, price));
  await mined(p.token.connect(host).approve(event.target, price));
  await mined(event.connect(host).buy(1));
  await mined(p.token.mint(buyer.address, price));
  await p.base.rpc.send("anvil_setBalance", [buyer.address, "0x0"]);
  const { page, signatures, transactions } = await walletPage(browser, p, buyer, origin + "/?event=" + event.target, { rejectWalletTransactions: true });
  await page.getByText("The host needs to replenish this event’s Base callback credit.", { exact: true }).waitFor();
  assert.ok(await page.locator(".registration .primary").isDisabled());
  assert.equal(signatures.length, 0);
  await mined(p.proxy.depositTo(event.target, { value: 3n * credit }));
  await mined(p.watcher.setWaitlistRelay(host.address));
  await page.evaluate(() => window.dispatchEvent(new Event("reseat:confirmed")));
  await page.getByText("The ReSeat relay is unavailable. The operator can restore sponsorship.", { exact: true }).waitFor();
  assert.ok(await page.locator(".registration .primary").isDisabled());
  await mined(p.watcher.setWaitlistRelay(p.relayer.address));
  await page.evaluate(() => window.dispatchEvent(new Event("reseat:confirmed")));

  const endpoint = origin + "/api/waitlist/" + event.target;
  const post = body => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const firstResponse = page.waitForResponse(r => r.url() === endpoint && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign & join waitlist" }).click();
  const response = await firstResponse;
  assert.equal(response.status(), 202);
  const signed = response.request().postDataJSON();
  const original = await response.json(), before = await p.system.requestCount();
  assert.deepEqual(await (await post(signed)).json(), original);
  assert.equal((await post({ ...signed, deadline: signed.deadline - 10 })).status, 422);
  assert.equal(await p.system.requestCount(), before);
  assert.equal(await event.activeOrders(), 0n);
  await page.getByText("The event is paying the fee. Waiting for Base confirmation…", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Check pending entry" }).click();
  await page.getByText("The event is paying the fee. Waiting for Base confirmation…", { exact: true }).waitFor();
  assert.equal(signatures.length, 1);
  await p.deliverSponsored(event, "enqueueSponsored");
  await page.getByText("Your order is confirmed on the waitlist.", { exact: true }).waitFor();
  assert.equal((await (await post(signed)).json()).status, "confirmed");
  assert.equal(await event.nextId(), 2n);
  assert.equal(await p.system.requestCount(), before);
  assert.equal(await p.proxy.reserves(event.target), 2n * credit);
  assert.equal(await p.token.balanceOf(buyer.address), price);
  assert.equal(transactions.length, 0);

  const legacy = await browser.newPage({ locale: "zh-CN" });
  const selector = event.interface.getFunction("sponsoredNonce").selector;
  await legacy.route(p.base.url + "/**", route => {
    const call = route.request().postDataJSON();
    if (call?.method !== "eth_call" || !call.params[0].data.startsWith(selector)) return route.continue();
    return route.fulfill({ json: { jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted" } } });
  });
  await legacy.goto(origin + "/?event=" + event.target);
  await legacy.getByText("这场旧版活动加入和取消候补都需要钱包发交易并支付 Base 手续费。", { exact: true }).waitFor();
});
