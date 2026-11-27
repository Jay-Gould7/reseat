import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Contract, getAddress, isAddress, type TransactionReceipt } from "ethers";
import { CalendarDays, Check, ChevronDown, CircleAlert, ExternalLink, Link2, LoaderCircle, MapPin, Ticket, Users, Wallet, X } from "lucide-react";
import { Activity } from "./Activity";
import { Directory } from "./Directory";
import { Funding } from "./Funding";
import { MyOrders } from "./MyOrders";
import { Publish } from "./Publish";
import { Registration } from "./Registration";
import { baseAbi, bindingStatus, eventUrl, factoryAbi, firstTicketPage, formatTime, localText, networks, reader, shortAddress, txUrl, type Chain } from "./chain";
import { signalConfirmation, usePolling, useWorkshop } from "./useWorkshop";
import { buy, cancelSponsored, confirm, join, publish, useWallet, walletError, workshopWith, type GetSigner, type Notify, type WalletChoice } from "./wallet";
import { PendingDelivery, forgetJoin, pendingJoin, readDelivery, sponsorshipStatus } from "./sponsorship";
import { AppLink, navigate, useSearch } from "./navigation";
import { confirmedOrder, fifo, isOpen, type Order, type OrderConfirmation } from "./orders";

type Notice = { text: string; hash?: string; chain?: Chain; owner?: string; kind: "pending" | "success" | "error" };
type Run = (action: () => Promise<string | void>, success: string, chain?: Chain) => Promise<void>;
export type Session = { account: string; busy: boolean; connect: () => void; run: Run; notify: Notify; getSigner: GetSigner };

function Share({ source }: { source: string }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return <details className="share"><summary><Link2 size={15} />{localText("Share event", "分享活动")}</summary><div>
    <input aria-label="Shareable event link" readOnly value={eventUrl(source)} ref={input} onFocus={e => e.target.select()} />
    <button onClick={async () => { try { await navigator.clipboard.writeText(eventUrl(source)); setCopied(true); }
      catch { input.current?.focus(); input.current?.select(); } }}>{copied ? "Copied" : "Copy link"}</button></div></details>;
}

function EventPage({ source, account, busy, connect, run, notify, getSigner }: Session & { source: string }) {
  const [ticketPage, setTicketPage] = useState({ owner: "", cursor: firstTicketPage });
  const cursor = ticketPage.owner === account ? ticketPage.cursor : firstTicketPage;
  const { base, preview, lasna, queue, baseHistory, lasnaHistory } = useWorkshop(source, account, cursor);
  const [confirmations, setConfirmations] = useState<OrderConfirmation[]>([]);
  const event = base.data?.event;
  const summary = event ?? preview;
  const watcher = lasna.data;
  const binding = base.error || lasna.error ? "unavailable" : bindingStatus(event?.binding, watcher);
  const ready = binding === "ready";
  const checkSponsor = Boolean(event?.sponsored && ready && (event.publicSeats === 0 || account));
  const feeStatus = usePolling(useCallback(async () => checkSponsor ? sponsorshipStatus(source) : "checking", [source, checkSponsor]));
  const sponsorship = event?.sponsored === false ? "legacy" : feeStatus.data ?? "checking";
  const checkCancel = Boolean(checkSponsor && account);
  const cancelFees = usePolling(useCallback(async () => checkCancel ? sponsorshipStatus(source, "cancel") : "checking", [source, checkCancel]));
  useEffect(() => { document.title = (summary?.name || localText("Event details", "活动详情")) + " · ReSeat"; }, [summary?.name]);
  const snapshot = queue.data;
  const now = Math.max(base.data?.block.timestamp ?? 0, snapshot?.now ?? 0);
  const saved = account && event?.sponsored ? pendingJoin(source, account) : undefined;
  const savedSalt = saved?.salt, savedQty = saved?.qty, savedDeadline = saved?.deadline;
  useEffect(() => {
    if (busy || !savedSalt || !savedQty || !savedDeadline) return;
    let stale = false;
    // A closed or reloaded tab can recover a submitted order without signing it a second time.
    void (async () => {
      const rpc = await reader("base"), contract = new Contract(source, baseAbi, rpc);
      const nonce = await contract.sponsoredNonce(account, savedQty, savedDeadline, savedSalt);
      const update = await readDelivery(contract, rpc, account, { nonce });
      if (!stale && update) { forgetJoin(source, account, savedSalt); rememberOrder(update); }
      else if (!stale && now >= savedDeadline) forgetJoin(source, account, savedSalt);
    })().catch(() => { /* The next Base refresh checks the same signed intent. */ });
    return () => { stale = true; };
  }, [source, account, busy, now, savedSalt, savedQty, savedDeadline]);
  const orders = useMemo(() => {
    const byId = new Map(snapshot?.orders.map(o => [o.id, o]));
    for (const { order, block } of confirmations) {
      if (!snapshot || block > snapshot.block || (!snapshot.complete && block === snapshot.block && !byId.has(order.id))) byId.set(order.id, order);
    }
    return [...byId.values()];
  }, [snapshot, confirmations]);
  const complete = snapshot?.complete && !queue.error && !confirmations.some(r => r.block > snapshot.block);
  const ranks = useMemo(() => complete ? new Map(orders.filter(o => isOpen(o, now)).sort(fifo).map((o, i) => [o.id, i + 1])) : undefined, [complete, orders, now]);
  function rememberOrder(update?: OrderConfirmation) {
    if (update) setConfirmations(old => [...old.filter(r => r.order.id !== update.order.id), update]);
  }
  function remember(receipt: TransactionReceipt, buyer: string, previous?: Order) {
    rememberOrder(confirmedOrder(receipt, source, buyer, previous));
  }
  function register(qty: number, deadline: number, waiting: boolean) {
    if (!event || (waiting && !ready)) return;
    void run(async () => {
      notify("Checking your Base Sepolia wallet…");
      const signer = await getSigner();
      return waiting ? join(signer, source, qty, deadline, event.sponsored, notify, r => remember(r, signer.address), rememberOrder) : buy(signer, source, qty, event.price, notify);
    }, waiting ? localText("Your order is confirmed on the waitlist.", "你的候补订单已在 Base 确认。") : "Tickets issued to your wallet.");
  }
  function action(method: "refund" | "cancel" | "requestSettlementRetry" | "withdrawProceeds", success: string, id?: string | bigint, previous?: Order, walletPaid = false) {
    if (!account) { connect(); return; }
    void run(async () => {
      notify(method === "cancel" && event?.sponsored && !walletPaid ? localText("Checking your order on Base…", "正在 Base 核对你的订单…") :
        localText("Confirm the transaction in your wallet.", "请在钱包中确认这笔 Base 交易。"));
      const signer = await getSigner();
      const contract = workshopWith(source, signer);
      if (method === "cancel") {
        const block = await signer.provider.getBlock("latest");
        const order = await contract.orderInfo(id, { blockTag: block?.number });
        if (!block || getAddress(order.buyer) !== signer.address || order.status !== 1n || block.timestamp >= Number(order.deadline))
          throw new Error(localText("This account has no pending order with that ID.", "该账户已没有这笔待处理的候补订单。"));
        if (event?.sponsored && previous && !walletPaid) return cancelSponsored(signer, source, previous, notify, rememberOrder);
      }
      if (method === "requestSettlementRetry" && (event?.organizer !== signer.address || !await contract.canRetrySettlement()))
        throw new Error(localText("There is no status to resend from this organizer account.", "当前主办方账户没有需要重新通知的候补状态。"));
      return confirm(await contract[method](...(id === undefined ? [] : [id])), notify, "base", previous ? r => remember(r, signer.address, previous) : undefined);
    }, success);
  }
  const historyErrors = [baseHistory.error && "Base Sepolia · " + baseHistory.error, lasnaHistory.error && "Lasna · " + lasnaHistory.error].filter(Boolean);
  const cancel = (order: Order, walletPaid = false) => action("cancel", localText("Your waitlist order was cancelled.", "你的候补订单已取消。"), order.id, order, walletPaid);
  return <>
    <div className="event-heading"><AppLink href="?events" className="text-action">{localText("All events", "所有活动")}</AppLink>
      <AppLink className="text-action" href={"?funding&event=" + source}>{localText("Event funding", "活动经费")}</AppLink><Share source={source} /></div>
    {summary ? <section className="hero" id="event" aria-labelledby="event-title">
      <img className="poster" src={summary.cover || "/workshop.jpg"} alt="" referrerPolicy="no-referrer" fetchPriority="high" onError={e => { e.currentTarget.src = "/workshop.jpg"; }} />
      <div className="hero-copy"><div className="tags"><span className="pill pill-blue">Testnet event</span></div>
        <h1 id="event-title">{summary.name}</h1><div className="metadata">
          <div><CalendarDays /><span>{formatTime(summary.start)}</span></div>{summary.location && <div><MapPin /><span>{summary.location}</span></div>}
          {event && <div><Users /><span>Hosted by <a href={networks.base.explorer + "/address/" + event.organizer} target="_blank" rel="noreferrer">{shortAddress(event.organizer)}</a></span></div>}
        </div></div>
    </section> : <h1 className="route-title">{localText("Event details", "活动详情")}</h1>}
    {!event ? <p className="panel route-loading" role="status">{base.error || localText("Loading ticket availability…", "正在读取本场活动的可售票数…")}</p> : <>
      {(base.error || lasna.error) && <p className="connection-note" role="status">{base.error || lasna.error}</p>}
      <div className="content-grid"><div className="event-content">
      {event.description && <section className="about"><h2>About this event</h2><p className="event-description">{event.description}</p></section>}
      <Activity event={event} watcher={watcher} bound={ready} base={baseHistory.entries} lasna={lasnaHistory.entries}
        openCount={ranks?.size} queueError={Boolean(queue.error)} errors={historyErrors} syncing={baseHistory.syncing || lasnaHistory.syncing} />
    </div><Registration event={event} now={now} account={account} busy={busy} readError={Boolean(base.error)} binding={binding} sponsorship={sponsorship}
      onConnect={connect} onRegister={register} onRefund={id => action("refund", "Ticket refunded to your wallet.", id)}
      onWithdraw={() => action("withdrawProceeds", "Event proceeds withdrawn.")} cursor={cursor}
      onRetry={() => action("requestSettlementRetry", localText("Waitlist status republished on Base.", "已在 Base 重新发布候补状态。"))}
      onPage={next => setTicketPage({ owner: account, cursor: next })}
      onActivate={() => void run(async () => {
        notify("Confirm the activation retry on Base.");
        const factory = new Contract(event.binding.factory, factoryAbi, await getSigner());
        return confirm(await factory.retryActivation(source), notify);
      }, "Activation requested again.")}>
        {account && <MyOrders key={account} source={source} account={account} now={now} event={event} busy={busy}
          orders={orders} queue={snapshot} ranks={ranks} readError={Boolean(queue.error)} sponsorship={event.sponsored ? cancelFees.data ?? "checking" : "legacy"} cancel={cancel} />}
      </Registration></div></>}
  </>;
}

export function App() {
  const wallet = useWallet();
  const { account, getSigner } = wallet;
  const chooser = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState<Notice>();
  const notify: Notify = (text, hash, chain) => setNotice({ text, hash, chain, owner: hash ? account : undefined, kind: "pending" });
  const run: Run = async (action, success, chain = "base") => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { const hash = await action(); setNotice({ text: success, hash: hash || undefined, chain, owner: hash ? account : undefined, kind: "success" }); }
    catch (err) {
      if (err instanceof PendingDelivery) setNotice({ text: err.message, hash: err.hash, chain: "lasna", owner: account, kind: "pending" });
      else setNotice({ text: walletError(err), kind: "error" });
    }
    finally { lock.current = false; setBusy(false); signalConfirmation(); }
  };
  function chooseWallet(choice?: WalletChoice, requestAccess = false) {
    if (!choice && wallet.choices.length > 1) { chooser.current?.showModal(); return; }
    chooser.current?.close();
    void run(async () => {
      notify(localText("Choose an account in your wallet.", "请在钱包中选择账户。"));
      await wallet.connect(choice, requestAccess);
      if (requestAccess) chooser.current?.showModal();
    }, requestAccess ? localText("Wallet accounts updated.", "已更新钱包账户。") : localText("Wallet connected.", "钱包已连接。"));
  }
  const connectWallet = () => chooseWallet();
  const query = new URLSearchParams(useSearch());
  const source = query.get("event");
  const page = query.has("funding") ? "funding" : query.has("publish") ? "publish" : source !== null ? "event" : query.has("events") ? "events" : "home";
  useEffect(() => {
    if (page !== "event") document.title = ({ funding: "Automation funding", publish: "Publish event", home: "Home", events: "Events" })[page] + " · ReSeat";
  }, [page]);
  return <><a className="skip" href="#main">Skip to content</a>
    <header className="site-header"><div className="shell nav-shell"><AppLink className="wordmark" aria-label="ReSeat" href="?"><span className="brand-icon"><Ticket size={23} /></span><span className="brand-name">ReSeat</span></AppLink>
      <nav aria-label={localText("Main navigation", "主导航")}>
        <AppLink href="?" aria-current={page === "home" ? "page" : undefined}>{localText("Home", "首页")}</AppLink>
        <AppLink href="?events" aria-current={page === "events" ? "page" : page === "event" ? "location" : undefined}>{localText("Events", "活动")}</AppLink>
      </nav>
      <div className="nav-actions"><AppLink href="?publish" className="publish-link">{localText("Publish event", "发布活动")}</AppLink>
        {account ? <button className="wallet-connected" title={account} aria-haspopup="dialog" aria-label={localText("Switch wallet or account", "切换钱包或账户")} disabled={busy}
          onClick={() => chooser.current?.showModal()}><Wallet size={16} />{shortAddress(account)}<ChevronDown size={13} /></button> :
          <button className="wallet-button" disabled={busy} onClick={connectWallet}><Wallet size={16} />{localText("Connect Wallet", "连接钱包")}</button>}</div>
    </div></header>
    <dialog ref={chooser} className="wallet-picker" aria-labelledby="wallet-title">
      <div className="section-heading"><h2 id="wallet-title">{localText("Choose a wallet", "选择钱包")}</h2>
        <button aria-label={localText("Close", "关闭")} onClick={() => chooser.current?.close()}><X size={19} /></button></div>
      {wallet.accounts.length > 0 && <><h3>{localText("Authorized accounts", "已授权账户")} · {wallet.active?.name}</h3>
        {wallet.accounts.map(address => <button className="wallet-option" key={address} aria-pressed={address === account} onClick={() => {
          wallet.selectAccount(address); chooser.current?.close();
        }}>{address}{address === account && <Check size={16} />}</button>)}
        <button className="text-action" onClick={() => chooseWallet(wallet.active, true)}>{localText("Choose accounts in wallet", "在钱包中选择其他账户")}</button></>}
      {(wallet.choices.length > 1 || !account) && <><h3>{localText("Installed wallets", "已安装的钱包")}</h3>
        {wallet.choices.map(option => <button key={option.id} className="wallet-option" onClick={() => chooseWallet(option)}>
          {option.name}{account && option.provider === wallet.active?.provider && <Check size={16} />}</button>)}</>}
    </dialog>
    <main id="main" className="shell" tabIndex={-1}>
      {page === "funding" ? <Funding key={source} source={source} account={account} busy={busy} connect={connectWallet} run={run} notify={notify} getSigner={getSigner} /> :
      page === "publish" ? <Publish account={account} busy={busy} connect={connectWallet} submit={(draft, fee) => void run(async () => {
        const address = await publish(await getSigner(), draft, fee, notify);
        if (new URLSearchParams(window.location.search).has("publish")) navigate(eventUrl(address));
      }, "Event published.")} /> : source !== null ? isAddress(source) && networks.base.address ?
        <EventPage key={source} source={getAddress(source)} account={account} busy={busy} connect={connectWallet} run={run} notify={notify} getSigner={getSigner} /> :
        <section className="route-message panel"><h1>Event unavailable</h1><p>Check the event link and the configured Base factory.</p><AppLink href="?events" className="text-action">All events</AppLink></section> :
        <Directory key={page} home={page === "home"} />}
    </main><footer><div className="shell footer-inner"><span className="footer-brand"><Ticket size={17} />ReSeat</span><div>
      <AppLink href={"?funding" + (source && isAddress(source) ? "&event=" + source : "")}>{localText("Automation funding", "自动化运行经费")}</AppLink>
      {(["base", "lasna"] as const).map(chain => <a key={chain} target="_blank" rel="noreferrer" href={networks[chain].explorer + (networks[chain].address ? "/address/" + networks[chain].address : "")}>{networks[chain].label}<ExternalLink size={12} /></a>)}
    </div></div></footer>
    {notice && (!notice.owner || notice.owner === account) && <div className={"toast " + notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.kind === "pending" ? <LoaderCircle className="animate-spin" size={19} /> : notice.kind === "success" ? <Check size={19} /> : <CircleAlert size={19} />}
      <div><span>{notice.text}</span>{notice.hash && <a href={txUrl(notice.chain || "base", notice.hash)} target="_blank" rel="noreferrer">
        {notice.chain === "lasna" ? "View on Reactscan" : "View on BaseScan"} <ExternalLink size={12} /></a>}</div>
      <button aria-label="Dismiss notification" onClick={() => setNotice(undefined)}><X size={15} /></button></div>}
  </>;
}
