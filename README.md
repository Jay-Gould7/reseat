# ReSeat

> Crypto-priced tickets can't use the waitlist because blockchain payments can't be authorized for later capture.

[Luma Help Center · Waitlist](https://help.luma.com/p/waitlist)

ReSeat lets an organizer publish a ticketed event on Base Sepolia. A guest can join the sold-out waitlist for a whole group, set a deadline and close the browser. USDC stays in the guest’s wallet until all requested seats can be issued together. Built for the DoraHacks Reactive Omni Buildathon, track 2, **Set It and Forget It**.

## Publish, share and attend

Open **Publish event** and choose the name, future start time, capacity and price in test USDC (up to six decimal places). The form displays its time zone. Location, description and a public HTTPS cover URL are optional. Two seats at 20 USDC each are editable form defaults. The publisher signs one Base transaction. Its receipt identifies the new event and opens its shareable `?event=<event-contract-address>` page.

The catalog and event pages read public RPCs. Guests opening the link on another device see the same Base-stored details, inventory, queue and source-filtered activity. Images are fetched from the published cover URL. Browsing, purchasing and refunding work during activation. **Automatic waitlist ready** appears once both chains agree on the binding. The app checks again immediately before requesting a waitlist signature. The open count, list and ranks use the full confirmed Base queue history and the latest Base block time. At the deadline an unsettled order moves to **All orders** with **Deadline passed**. A later Base settlement records **Expired**.

## Contracts and settlement

| Network | Contract | Responsibility |
| --- | --- | --- |
| Base Sepolia · 84532 | `EventFactory` | Records each event, passes the publishing wallet as organizer, deposits its Base callback reserve and announces its address |
| Base Sepolia | One `EventWaitlist` per event | Holds that event’s USDC, immutable terms, metadata, numbered non-transferable admissions and FIFO queue |
| Reactive Lasna · 5318007 | Shared `WaitlistReactive` | Discovers events from the trusted factory, keeps independent revisions, heads and deadlines and sends each callback to its originating event |

1. The watcher subscribes to the factory’s `EventCreated`. On discovery it subscribes to the child’s `SettlementState` and requests `confirmBinding` on that child. The Base callback authenticates both the proxy and watcher, then publishes a fresh inventory snapshot. This includes sales and refunds made before the subscription. The UI verifies factory membership, the configured watcher in both Base contracts, the watcher’s bound factory, registration for this exact event and receipt of a positive state revision on Lasna.
2. A direct sale issues individually refundable ticket IDs. A refund burns the ID and returns its ticket price in one transaction. While the queue is active, public sales cannot take its seats. Only the publishing wallet can withdraw retained USDC after the event starts.
3. A guest signs Circle’s EIP-712 `ReceiveWithAuthorization` for the event contract, exact group total, unique nonce and `validBefore = min(guestDeadline, eventStartTime)`, then submits the order. One returned seat for a two-seat head is held without a charge. With enough seats, an authenticated callback rechecks Base time, the authorization and balance, then captures USDC and issues the whole group atomically. A contiguous ticket-ID range keeps issuance gas independent of group size.
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

For an existing Chromium installation, set `RESEAT_BROWSER` to its executable path and omit the browser download. The browser test starts two loopback Anvil chains and Vite with temporary wallets and local mocks. It exercises two organizers, sharing into a fresh mobile browser, binding, purchases, signed orders, refunds and recovery after a failed collection. The preceding Foundry run produces its required artifacts. The regular dev server uses the platform settings in the root `.env`.

## Deploy the platform once

Review `.env.example`. Set `LASNA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, the Base callback proxy and Circle test USDC. Choose `BASE_EVENT_CALLBACK_WEI`, the initial per-event Base reserve. The example is 0.001 test ETH. Choose an amount against current callback costs. Keep `DEPLOYER_PRIVATE_KEY` in the local ignored environment. Only the `VITE_` settings go into the frontend bundle.

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

# 3. Bind the factory once, using the Lasna watcher's owner.
forge script script/03_BindSource.s.sol:BindSource --rpc-url "$LASNA_RPC_URL" --broadcast

# 4. Print the funding commands and review the amounts.
forge script script/04_FundingCommands.s.sol:FundingCommands
```

Use the same revision for the watcher, factory and frontend. The automatic payment retry uses an updated settlement event and callback interface. Build the web app with the two platform addresses and their start blocks. The Base start block is the **factory deployment block**. Browser-safe public RPC overrides are `VITE_BASE_RPC_URL` and `VITE_LASNA_RPC_URL`. Later publications are discovered by address using the same web build. The static site supports share links without server-side routing.

**Funding.** The platform operator funds the Lasna watcher with test REACT for execution. The host pays Base gas and the factory’s exact ETH reserve in the publication transaction. The factory forwards the reserve with `depositTo(eventAddress)` on the Base callback proxy; each event has its own callback balance. Anyone can top up that event on the proxy. Use the event’s address from its factory receipt. The watcher and event expose `coverDebt()` for native funds sent directly to the contracts. Ticket USDC remains separate from the native fee reserves. [Reactive funding and debt](https://dev.reactive.network/economy)

**Recovery.** A host can replay the factory announcement on Base after five minutes if activation stalls. After Base confirmation one additional replay can repair a lost initial snapshot. After the third automatic payment request, the watcher keeps the deadline timer. A retry due at or after the deadline is omitted. A refund that only partially covers the head waits for more seats or expiry. When inventory and queued orders coexist, a guest can request settlement manually, including after automatic retries run out. Each distinct head, inventory, observed payment state and processed payment attempt allows one public replay. Empty or repeatedly unchanged requests revert before emitting a new report. After restoring funding, the watcher owner can call `syncEvent(eventAddress)` on Lasna for a registered event when repeated deliveries have failed. Only authenticated callbacks can settle orders.

## Testnet addresses and evidence

| Contract | Address |
| --- | --- |
| Lasna watcher | Pending deployment |
| Base Sepolia factory | Pending deployment |
| Published demo event | Pending publication |
| Base Sepolia callback proxy | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` |
| Base Sepolia Circle test USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

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
web/test/           Browser journey on two local chains
```

ReSeat-authored code uses the [MIT License](LICENSE). The pinned [reactive-lib-omni v0.1.0](https://github.com/Reactive-Network/reactive-lib-omni/tree/3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8) retains its upstream `SPDX-License-Identifier: UNLICENSED` headers. forge-std and web dependencies retain their upstream licenses.
