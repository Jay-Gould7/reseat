# ReSeat

> Crypto-priced tickets can't use the waitlist because blockchain payments can't be authorized for later capture.

[Luma Help Center · Waitlist](https://help.luma.com/p/waitlist)

ReSeat lets an organizer publish a ticketed event on Base Sepolia. A guest can join the sold-out waitlist for a whole group, set a deadline and close the browser. USDC stays in the guest’s wallet until all requested seats can be issued together. Built for the DoraHacks Reactive Omni Buildathon, track 2, **Set It and Forget It**.

## Publish, share and attend

Open **Publish event** and choose the name, future start time, capacity and price in test USDC (up to six decimal places). The form displays its time zone. Location, description and a public HTTPS cover URL are optional. Two seats at 20 USDC each are editable form defaults. The publisher signs one Base transaction. Its receipt identifies the new event and opens its shareable `?event=<event-contract-address>` page.

The catalog and event pages read public RPCs. A shared event link shows availability, the total number of active orders and an event-level activity feed with explorer links. Browsing, purchasing and refunding work during activation. **Automatic waitlist ready** appears once both chains agree on the binding. The app checks again immediately before requesting a waitlist signature.

**My waitlist orders** shows the connected wallet’s quantities, deadlines, FIFO positions and held seats. Joining or cancelling updates this panel once Base confirms the change. Reloading or switching wallets reads the contract’s live order IDs directly, independently of historical logs. The public count and personal positions include every queued order whose effective deadline is later than the latest Base block time. **History** shows **Deadline passed** until Base settles the order as **Expired on Base**. Viewing either tab needs no signature. Order data remains public on the blockchain.

Joining the waitlist currently requires an externally owned account (EOA), such as a standard MetaMask account.

候补目前支持普通钱包账户（EOA），例如 MetaMask 的标准账户。

An EOA with smart-account delegation can join when its current validator accepts the exact signature used by Circle USDC. After signing, the relay simulates `receiveWithAuthorization` on Base Sepolia from the event address with the signed total, deadline and nonce. This spends no funds and leaves the nonce unused. If Circle rejects the signature, switch to a standard wallet account and sign again. The event also verifies order ownership. If a guest changes delegation after joining and Circle explicitly rejects that signature at collection, the next guest gets a turn. A paused token or an unknown collection failure preserves FIFO priority. [Circle's authorization implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol) · [Circle's signature checker](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/util/SignatureChecker.sol)

### Who pays the network fee?

| Action on a sponsorship-enabled event | Fee payer | What the guest does |
| --- | --- | --- |
| Join the waitlist | The event’s Base ETH reserve and the platform’s Lasna relay | Sign the exact Circle USDC authorization once. USDC stays in the wallet until all seats are available. |
| Cancel a queued order | The same event reserve and relay | Sign a ReSeat cancellation for that order. It takes effect when Base confirms it. |
| Check a deadline, retry collection or automatically issue tickets | The event’s Base reserve and the platform watcher on Lasna | Nothing. The guest can close the page. |
| Buy available tickets or refund a ticket | The wallet initiating the transaction | Confirm the Base transaction and pay its gas. |

在支持代付的活动里，加入和取消候补只需签名，来宾无需持有 Base ETH。主办方发布时的预存款支付本场活动的 Base 回调，平台提供 Lasna 经费。普通购票和主动退票由发起人付手续费。候补顺位、取消与出票均以 Base 确认顺序为准。

## Contracts and settlement

| Network | Contract | Responsibility |
| --- | --- | --- |
| Base Sepolia · 84532 | `EventFactory` | Records each event, passes the publishing wallet as organizer, deposits its Base callback reserve and announces its address |
| Base Sepolia | One `EventWaitlist` per event | Holds that event’s USDC, immutable terms, metadata, numbered non-transferable admissions and FIFO queue |
| Reactive Lasna · 5318007 | Shared `WaitlistReactive` | Discovers events from the trusted factory, keeps independent revisions, heads and deadlines and sends each callback to its originating event |

1. The watcher subscribes to the factory’s `EventCreated`. On discovery it subscribes to the child’s `SettlementState` and requests `confirmBinding` on that child. The Base callback authenticates both the proxy and watcher, then publishes a fresh inventory snapshot. This includes sales and refunds made before the subscription. The UI verifies factory membership, the configured watcher in both Base contracts, the watcher’s bound factory, registration for this exact event and receipt of a positive state revision on Lasna.
2. A direct sale issues individually refundable ticket IDs. A refund burns the ID and returns its ticket price in one transaction. While the queue is active, public sales cannot take its seats. Only the publishing wallet can withdraw retained USDC after the event starts.
3. A guest signs Circle’s EIP-712 `ReceiveWithAuthorization` for the event contract, exact group total and `validBefore = min(guestDeadline, eventStartTime)`. The sponsored nonce binds the event, Base chain, buyer, quantity, deadline and random salt to the waitlist. The ReSeat relay simulates the authenticated Base call, then submits the signed order to the registered Lasna watcher. Its callback records the guest as the buyer. A cancellation uses a separate short-lived ReSeat signature bound to the event and order ID. Both operations are idempotent. One returned seat for a two-seat head is held without a charge. With enough seats, a settlement callback captures USDC and issues the whole group atomically.
4. Expiration, cancellation, a used/revoked authorization or insufficient funds release the head for the next guest. Each callback processes at most five queue entries. Remaining actionable work emits a new state. A paused token, unreadable token state or unknown collection error preserves the order’s priority and seats. Once all requested seats are available, Lasna can retry a deferred payment up to three times for that event and head, after 30, 60 and 120 seconds respectively. A guest can close the page throughout.
5. Heads holding seats share one on-demand Cron10 subscription. The watcher checks up to four tracked events per tick in rotation and gives deadline settlement priority over a payment retry. Deadline callbacks have a 15-second per-event cooldown. Each payment callback carries a head ID and attempt number. Base rechecks its own clock, the current order, inventory and authorization before collecting. Ending one event’s hold removes only that event. Ending the last hold unsubscribes the shared timer. Per-event revisions discard stale snapshots and callbacks recheck the expected head before charging. All deadlines use timestamps.

The Omni system at `0x8888888888888888888888888888888888888888` accepts `SYSTEM.requestCallbackV_1_0`. `react` uses `onlySystem`. Base entry points use `onlyServiceProvider` and `onlyCallbackSender`. [Reactive contracts](https://dev.reactive.network/reactive-contracts) · [Callback contracts](https://dev.reactive.network/callback-contracts)

## Run locally

Use Foundry with Solidity 0.8.29 and Node.js 22.12+ with npm. The commands use Git Bash or a POSIX shell. Make `forge` and `anvil` available on PATH.

```sh
git submodule update --init
cp .env.example .env
(cd contracts && forge test -vvv)
cd web
npm install
npm run build
npx playwright-core install chromium
npm test
npm run dev
```

For an existing Chromium installation, set `RESEAT_BROWSER` to its executable path and omit the browser download. The browser tests start two loopback Anvil chains and Vite with temporary wallets and local mocks. They exercise two organizers, sharing into a fresh mobile browser, binding, purchases, signed orders, refunds, recovery after a failed collection and top-ups on both networks. The preceding Foundry run produces their required artifacts. The regular dev server uses the platform settings in the root `.env`.

The zero-ETH browser test gives the guest exactly 2 test USDC. They sign for two 1-USDC tickets and close the page. The first refund leaves their USDC untouched. The second triggers one charge and two tickets, even if the same callback arrives twice. Other browser tests cover concurrent admissions on a nearly depleted reserve, relay restart, rejection before submission, loss of an accepted HTTP response, reverse proxy quotas and old links after a two-factory cutover.

To exercise Circle's deployed USDC and the deployed wallet validators at Base Sepolia block **64300000**, run the following with an archive-capable RPC. The fork uses local balances, event contracts and callback identities. It makes no public transactions.

```sh
cd contracts
FOUNDRY_EVM_VERSION=prague RESEAT_FORK_RPC=https://sepolia.base.org forge test --match-contract CircleForkTest -vvv
```

On that fork a standard EOA and a MetaMask EIP-7702 account delegated to `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` both completed collection. With the tested Kernel delegation at `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28`, Circle rejected the raw ReSeat signature. Switching to that delegation after joining also allowed the next order to be paid and issued. Other validator configurations are checked per order at runtime.

## Deploy the platform once

The public settings in `.env.example` point to the sponsorship-enabled `ab375d9` deployment. Publishing an event deposits **0.0001 Base test ETH** into that event's callback reserve. Shared links from the earlier `23e89b3` platform still use their original contracts and wallet-paid entry and cancellation.

For a fresh platform, set `LASNA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, the Base callback proxy and Circle test USDC. `BASE_EVENT_CALLBACK_WEI` sets the per-event reserve and defaults to **0.0001 test ETH**. Actual callback fees determine how many requests it covers. Set `WAITLIST_RELAY_ADDRESS` to a dedicated Lasna wallet and fund it with test lREACT for forwarding transactions. Keep its matching `WAITLIST_RELAY_PRIVATE_KEY` on the relay host. The deployment machine needs only its public address and the separate `DEPLOYER_PRIVATE_KEY`. Only the `VITE_` settings go into the browser.

Run the following as the operator. Save real receipt addresses and deployment block numbers to the root `.env` and reload it at the indicated steps.

```sh
cd contracts
load_config() { set -a; . ../.env; set +a; }
load_config

# 1. Deploy on Lasna. Save VITE_REACTIVE_ADDRESS and VITE_LASNA_START_BLOCK.
forge script script/01_DeployReactive.s.sol:DeployReactive --rpc-url "$LASNA_RPC_URL" --broadcast
load_config

# 2. Deploy the Base factory. Save VITE_FACTORY_ADDRESS and VITE_BASE_START_BLOCK.
forge script script/02_DeployFactory.s.sol:DeployFactory --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
load_config

# 3. Bind the factory and authorize WAITLIST_RELAY_ADDRESS using the Lasna watcher's owner.
forge script script/03_BindSource.s.sol:BindSource --rpc-url "$LASNA_RPC_URL" --broadcast

# 4. Print the funding commands and review the amounts.
forge script script/04_FundingCommands.s.sol:FundingCommands
```

The updated `EventWaitlist` creation code is embedded in `EventFactory`. Deploy a fresh factory and a fresh `WaitlistReactive` instance because each watcher binds to one factory for its lifetime. Keep the existing Circle USDC and Base callback proxy. Set the new `VITE_FACTORY_ADDRESS`, `VITE_REACTIVE_ADDRESS`, `VITE_BASE_START_BLOCK` and `VITE_LASNA_START_BLOCK` to the two deployment receipts and rebuild the frontend. The Base start block is the factory deployment block. Browser-safe RPC overrides are `VITE_BASE_RPC_URL` and `VITE_LASNA_RPC_URL`.

Before switching, keep every trusted former deployment in `VITE_LEGACY_PLATFORMS`. Use the JSON array in `.env.example` and add each old pair's actual factory, watcher and deployment blocks. The directory and publication form use the current factory. An existing `?event=0x…` link resolves its original factory, checks factory membership and the event's callback sender, and reads history from its original watcher. Holders can refund before the start and organizers can withdraw afterwards on the original contract. Old events retain their own funds and on-chain rules. This relay admits requests only for its active factory.

**Run the relay.** Local `npm run dev` and `npm run preview` serve the API next to the app. For production, run `cd web && npm run relay` on the relay host and reverse-proxy the public site's `/api/waitlist/` path to `127.0.0.1:8787`, preserving the original Host header. Serve `web/dist/` for other paths. Use one relay process per signing wallet. The relay host needs the two RPCs, the two public platform addresses and the dedicated relay key. Keep the deployment key off that host. The watcher owner can rotate or disable the signer with `setWaitlistRelay(address)`.

For nginx on the same machine, set `WAITLIST_TRUSTED_PROXIES=127.0.0.1` on the relay. The proxy must overwrite the visitor header on every request. If another trusted ingress sits in front of nginx, configure nginx's real-IP module for that ingress so `$remote_addr` is the verified client IP.

```nginx
location /api/waitlist/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

The relay accepts a single valid `X-Real-IP` only from the exact socket peers in this comma-separated list. Direct connections use their socket IP. Write limits are 20 per visitor and 120 total per minute. Reads have separate limits of 180 per visitor and 1,200 total per minute.

The form and the serialized admission check use the same on-chain budget. The following server-only settings are native-token wei per unit. Set them from measured fees plus headroom before opening public sponsorship.

| Setting | Default | What it reserves |
| --- | --- | --- |
| `WAITLIST_BASE_CALLBACK_WEI` | 0.00001 Base test ETH | One Base callback per pending submission and at least one future settlement per queued or newly admitted order in that event |
| `WAITLIST_LASNA_TX_WEI` | 0.005 lREACT | Per relay transaction, using the larger of this floor or the forwarding gas limit times the current Lasna fee quote |
| `WAITLIST_LASNA_EXECUTION_WEI` | 0.01 lREACT | One watcher execution unit for each pending delivery and each reserved settlement across all active-factory events |

Base and watcher checks read native balances, prepaid credit and outstanding debt. Either contract having debt pauses new admissions. Low relay-wallet gas also pauses submissions. Each funding message identifies the account to top up. The page polls again after funding. These thresholds are operator estimates. On-chain fees and the number of retries can vary.

Set `WAITLIST_RELAY_STATE_DIR` to a private persistent directory outside the static site, or use `~/.reseat/relay-state`. Keep one writer per signing wallet and retain this directory across restarts. The relay journals signed transactions before broadcasting and reserves funds through destination confirmation. A Lasna receipt releases the forwarding-gas reservation. The destination allowance stays reserved until Lasna records the callback and Base has its receipt. A queued order continues to reserve settlement funds. An RPC timeout can replay the same signed transaction. If delivery stalls after Lasna confirmation, a later attempt retains the order nonce.

If the service explicitly rejects a first request before broadcasting, the guest can edit the quantity and deadline and sign again. A submitted request or disconnected response keeps its original terms and salt in the browser. Reloading checks Base, and confirmation clears the draft. The browser never stores the signed authorization.

**Funding.** Open **Automation funding** in the footer or **Event funding** on an event page. The three destinations are the event's Base callback reserve, the platform's Lasna execution credit and the authorized relay wallet's Lasna gas balance. The host funds the event when publishing. The platform operator funds the watcher and relay. Anyone can top up the displayed destinations.

The funding page switches to the selected chain. It calls `depositTo` for event and watcher credit and sends a native transfer for the relay wallet read from the watcher. Unused prepaid credit stays on the fee service after the event starts. The watcher and each event also expose `coverDebt()` for native funds sent directly to the contracts. Ticket refunds and organizer proceeds are paid separately in USDC. [Reactive funding and debt](https://dev.reactive.network/economy)

**Recovery.** A host can replay the factory announcement on Base after five minutes if activation stalls. After Base confirmation one additional replay can repair a lost initial snapshot. After the third automatic payment request, the watcher keeps the deadline timer. A retry due at or after the deadline is omitted. A refund that only partially covers the head waits for more seats or expiry. When a replay is available, the organizer can open **Organizer tools** and select **Resend waitlist status**. This Base transaction costs gas and republishes the state to Lasna. The contract’s `requestSettlementRetry()` remains publicly callable. Each distinct head, inventory, observed payment state and processed payment attempt allows one replay. Empty or repeatedly unchanged requests revert before emitting a new report. After restoring funding, the watcher owner can call `syncEvent(eventAddress)` on Lasna for a registered event when repeated deliveries have failed. Only authenticated callbacks can settle orders.

## Testnet addresses and evidence

| Contract | Address |
| --- | --- |
| Lasna watcher | [`0xc1BD44Ab59f254fAC8DB1D0C2cDDf00D6Cf31742`](https://lasna.reactscan.net/address/0xc1BD44Ab59f254fAC8DB1D0C2cDDf00D6Cf31742) · [Deployment at block 9388397](https://lasna.reactscan.net/tx/0xf3933f2867cfe84b328d7586733bec3f479579bf9dc08087b7731db0819500be) |
| Base Sepolia factory | [`0xFA186f628F1F7DCA230b80E99e6c86F095c3BBc9`](https://sepolia.basescan.org/address/0xFA186f628F1F7DCA230b80E99e6c86F095c3BBc9) · [Deployment at block 64369230](https://sepolia.basescan.org/tx/0x459f4dffbf271a92dec7b5d1bb3c647760e34d921f762378b959df8cf17213bf) |
| Lasna relay wallet | [`0x691c56ad29A16dC85A43304Bfb0aB54785e73F81`](https://lasna.reactscan.net/address/0x691c56ad29A16dC85A43304Bfb0aB54785e73F81) · [Relay authorization](https://lasna.reactscan.net/tx/0x26b6ff8ff1f78fcf172339eb9ad3536cd9a3cef39f53d26b6248c54731032f5b) |
| Published demo event | Pending publication |
| Base Sepolia callback proxy | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` |
| Base Sepolia Circle test USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

The watcher bound the new factory at Lasna block 9388479. Its execution reserve received 0.3 lREACT and the relay wallet received 0.3 lREACT for forwarding transactions. [Factory binding](https://lasna.reactscan.net/tx/0xbe715623fb8b1a7a125c4824cacb3b38636ca842ea449dbda2192782f0bccf04) · [Watcher deposit](https://lasna.reactscan.net/tx/0xcd746c325f18ce2be479b556977229ce6217f22d8e7d2c38c767d3042d8a153e) · [Relay funding](https://lasna.reactscan.net/tx/0xb049647e81be5b2c57bbc843b1aa5aed5772be946dbf6aaad2cdb90e301c1afc)

The previous platform remains in `VITE_LEGACY_PLATFORMS` for existing event links. [Original Base factory](https://sepolia.basescan.org/address/0x30f8D0140C181cEb12Fd7f8325DD3c9e58520E3e) · [Original watcher binding](https://lasna.reactscan.net/tx/0x18bcdb3ea92de520c9ddb5de8731d44d7712c66985f368e5107afb502e87dadb)

[Reactive network addresses](https://dev.reactive.network/origins-and-destinations) · [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses#testnet)

For the deadline demo, sell both seats, queue one guest for two seats with a short deadline and a second guest for one seat with a later deadline. Refund one seat and close both guests’ pages. Verify the first guest keeps their USDC and the second receives the ticket. Returning both seats before the first deadline demonstrates whole-order capture instead.

| Evidence | Explorer | Transaction hash |
| --- | --- | --- |
| Refund that creates a held seat | BaseScan · Base Sepolia | Pending live receipt |
| Due CRON tick requests settlement for this event | Reactscan · Lasna | Pending live receipt |
| Callback expires the head and issues the next order | BaseScan · Base Sepolia | Pending live receipt |

## Repository

```text
contracts/src/      EventFactory, EventWaitlist, TicketBook, WaitlistReactive and interfaces
contracts/test/     Foundry scenarios, mock Circle USDC, Omni system and callback proxy
contracts/script/   Platform deployment, binding and funding commands
web/src/            Catalog, publishing form, event page, wallet and public chain readers
web/relay/          Server-only Lasna relay for signed waitlist entry and cancellation
web/test/           Browser journey on two local chains
```

ReSeat-authored code uses the [MIT License](LICENSE). The pinned [reactive-lib-omni v0.1.0](https://github.com/Reactive-Network/reactive-lib-omni/tree/3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8) retains its upstream `SPDX-License-Identifier: UNLICENSED` headers. forge-std and web dependencies retain their upstream licenses.
