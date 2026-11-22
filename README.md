# ReSeat

> Crypto-priced tickets can't use the waitlist because blockchain payments can't be authorized for later capture.

[Luma Help Center · Waitlist](https://help.luma.com/p/waitlist)

ReSeat lets a guest request two workshop tickets, set a deadline and close the page. A signed USDC authorization leaves the money in their wallet until the entire order can be filled. Built for the DoraHacks Reactive Omni Buildathon, track 2, **Set It and Forget It**.

## The workshop

**Reactive Builders Workshop** is an online testnet event with two admissions at 20 USDC each (6 decimals). Deploying the Base contract schedules the start exactly seven days later. Two initial purchases sell it out. Each admission has its own ID and wallet owner. A refund burns that ID and returns 20 USDC in the same transaction. The organizer can withdraw retained proceeds once the workshop starts.

| Chain | Contract | Responsibility |
| --- | --- | --- |
| Base Sepolia · 84532 | `EventWaitlist` | Tickets, escrow, refunds, FIFO orders and atomic settlement |
| Reactive Lasna · 5318007 | `WaitlistReactive` | Base state subscription, on-demand Cron10 and authenticated callback requests |

1. The guest signs Circle’s EIP-712 `ReceiveWithAuthorization` with the event as payee, the exact total, a random 32-byte nonce, `validAfter = 0` and `validBefore = min(userDeadline, eventStartTime)`. The guest then submits the order. Either a queued order or its USDC authorization can be cancelled before capture.
2. A refund publishes the new Base state. One returned seat stays with a two-seat head. Public sales cannot take reserved seats. Lasna subscribes to Cron10 only while waiting on a partially filled order. Both operations share the same six filter arguments.
3. Enough seats trigger an immediate callback. Otherwise the first eligible tick at or after the head deadline requests one, with a 15-second cooldown. Base checks its own timestamp, the head, inventory and balance. It catches failed ERC-3009 payments and advances up to five orders per callback. A ready state continues the batch. A partial state tracks the new deadline. An idle state removes CRON.
4. Monotonic state revisions discard reordered Base logs. The expected head makes repeated callbacks harmless. An early tick from Lasna leaves the Base queue untouched and a later tick retries. With zero vacancies, expired orders need no timer and are skipped when a seat next becomes available.

The Omni system at `0x8888888888888888888888888888888888888888` manages subscriptions and accepts `requestCallbackV_1_0`. Cron10 logs originate at the protocol’s separate CRON emitter. The Base entry point checks both the proxy and its injected Lasna sender. [Reactive contracts](https://dev.reactive.network/reactive-contracts) · [Callback contracts](https://dev.reactive.network/callback-contracts)

## Local development

Use Foundry with Solidity 0.8.29 and Node 22.12+ with npm. The commands below use Git Bash or a POSIX shell. On Windows, a local Foundry installation normally places its executables in `~/.foundry/bin`.

```sh
git submodule update --init
cp .env.example .env
(cd contracts && forge test -vvv)
cd web
npm install
npm run build
npm run dev
```

Open the local URL printed by Vite. Anyone can browse. Public RPCs provide Base and Lasna block heights even before deployment. With contract addresses configured in the root `.env`, the same page reads seat inventory, queue history, CRON and explorer-linked transactions. Blank addresses show a deployment preview. The local web server and the app can be closed throughout settlement.

`web/` reads only `VITE_*` variables from the root environment. Put the two contract addresses and their deployment receipt block numbers in `.env`. Restart Vite or rebuild after changes. Without start blocks, the reader locates deployment with historical `eth_getCode`. Supply receipt blocks if your RPC lacks archive access. History reads bounded ranges, follows new blocks, and waits two Base blocks and one Lasna block before displaying events. Wallet writes use an injected EOA wallet on Base Sepolia.

## Deploy and fund the testnets

Review the networks and addresses first. The commands below broadcast when you run them. Fill in a testnet-only `DEPLOYER_PRIVATE_KEY` locally and use the same deployer to bind the watcher. Source the updated file after each receipt.

```sh
cd contracts
load_config() { set -a; . ../.env; set +a; }
load_config

# 1. Lasna. Save its address and receipt block as VITE_REACTIVE_ADDRESS and VITE_LASNA_START_BLOCK.
forge script script/01_DeployReactive.s.sol:DeployReactive --rpc-url "$LASNA_RPC_URL" --broadcast
load_config

# 2. Base. Save its address and receipt block as VITE_EVENT_ADDRESS and VITE_BASE_START_BLOCK.
forge script script/02_DeployEvent.s.sol:DeployEvent --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
load_config

# 3. Lasna. Bind the Base event once and subscribe to SettlementState.
forge script script/03_BindSource.s.sol:BindSource --rpc-url "$LASNA_RPC_URL" --broadcast

# 4. Print the two funding commands for review.
forge script script/04_FundingCommands.s.sol:FundingCommands
```

Step 4 prints `cast send --interactive` commands for `depositTo(address)` on the Lasna system (test REACT) and Base callback proxy (test ETH). Review the sample amounts, then fund both reserves before starting the demo. A reserve deposit first pays outstanding debt. Both contracts also expose `coverDebt()` for funds sent directly to their native balances. After restoring service, anyone can call `requestSettlementRetry()` on Base to republish the latest state. Settlement still goes through Lasna. [Funding and debt](https://dev.reactive.network/economy)

| Deployment | Address |
| --- | --- |
| Lasna · WaitlistReactive | Pending deployment |
| Base Sepolia · EventWaitlist | Pending deployment |
| Base Sepolia · callback proxy | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` |
| Base Sepolia · Circle test USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

[Reactive network addresses](https://dev.reactive.network/origins-and-destinations) · [Circle test USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses#testnet)

## Demo and transaction evidence

Buy one ticket from each of two wallets. Have Lin queue for two tickets with a short deadline and Mei queue for one with a later deadline. Return one ticket and close the buyers’ browsers. After Lin’s deadline, Mei receives the seat and Lin keeps all 40 USDC. In a fresh run, return both tickets before Lin’s deadline to demonstrate the 40 USDC whole-order fill.

| Stage | Network / explorer | Transaction hash |
| --- | --- | --- |
| Refund creates a held seat | Base Sepolia / BaseScan | Pending live receipt |
| CRON requests settlement at the head deadline | Lasna / Reactscan | Pending live receipt |
| Callback skips Lin and issues Mei’s ticket | Base Sepolia / BaseScan | Pending live receipt |

The activity feed also links the subsequent Lasna CRON unsubscription. Foundry tests relay actual Base event data through a filter-matching mock system and a sender-injecting mock proxy. They cover both demo paths, revocation, insufficient funds, cancellation, clock skew, retries, ordering, replay, withdrawal and bounded continuation.

## Repository

```text
contracts/
  src/       EventWaitlist, WaitlistReactive and shared interfaces
  test/      Foundry scenarios, MockUSDC, mock Omni system and proxy
  script/    Numbered deployment and funding steps
  lib/       Pinned upstream Git submodules
web/
  src/       React event page, ethers readers, event history and wallet actions
  public/    Workshop poster
AGENTS.md    Reactive Omni development rules
```

ReSeat-authored code is released under the [MIT License](LICENSE). The upstream [reactive-lib-omni v0.1.0](https://github.com/Reactive-Network/reactive-lib-omni/tree/3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8) submodule retains its published `SPDX-License-Identifier: UNLICENSED` headers. forge-std and frontend packages retain their upstream licenses.
