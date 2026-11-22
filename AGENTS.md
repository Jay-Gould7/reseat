## 3. Reactive Omni 硬性开发红线（必须严格遵守）

- **严禁使用任何旧版 Reactive API**：禁止 `vmOnly`、`service.subscribe`、`emit Callback`、`authorizedSenderOnly`、`rvmIdOnly`。
- **使用最新 `reactive-lib-omni` 规范**（参考 `dev.reactive.network/reactive-contracts` 与 `dev.reactive.network/callback-contracts`）：
  - Lasna 上的 `WaitlistReactive.sol` 继承 `AbstractReactive`（`SYSTEM` 为 `0x8888888888888888888888888888888888888888`），`react(LogRecord memory log_)` 必须带 `onlySystem`，通配主题使用 `REACTIVE_IGNORE`（不要用 `0`），回调通过 `SYSTEM.requestCallbackV_1_0(...)` 发起。
  - Base Sepolia 上的 `EventWaitlist.sol` 继承 `AbstractCallback`，构造函数接收 `address callbackProxy_`、`address callbackSender_`（均 immutable），并由工厂显式传入主办方及本场活动参数。所有回调入口第一个参数必须为 `address reactive_`，且同时加上 `onlyServiceProvider` 和 `onlyCallbackSender(reactive_)` 两个修饰器；同时暴露公开的 `coverDebt()` 调用 `_coverDebt()`。
  - **禁止在 Base Sepolia 使用 `block.number` 计时**：Base Sepolia 出块间隔为 200ms，所有截止时间、开场时间、冷却时间必须全部使用 `block.timestamp`。
  - **公开重试兜底**：当因回调欠费或临时故障导致空位停滞时，在 Base 合约提供公开的 `requestSettlementRetry()` 仅重新抛出状态事件，仍由 Reactive 驱动回调完成结算。
- **部署脚本顺序**（`contracts/script/`）：严格按官方顺序拆步编写：1) 部署 Lasna `WaitlistReactive` → 2) 用其地址 + Base Callback Proxy 部署 Base `EventFactory` → 3) 将工厂地址绑定到 `WaitlistReactive` 并订阅工厂创建事件；各场 `EventWaitlist` 由工厂创建并自动订阅、回调确认 → 4) 输出双边充值（Lasna REACT 与 Base ETH）命令。
