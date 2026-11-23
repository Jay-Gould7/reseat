import { useEffect, useRef, useState } from "react";
import { Contract, getAddress, isAddress } from "ethers";
import { CalendarDays, Check, CircleAlert, ExternalLink, Link2, LoaderCircle, MapPin, Ticket, Users, Wallet, X } from "lucide-react";
import { Activity } from "./Activity";
import { Directory } from "./Directory";
import { Funding } from "./Funding";
import { Publish } from "./Publish";
import { Registration } from "./Registration";
import { bindingStatus, eventUrl, factoryAbi, contractAddress, firstTicketPage, formatTime, localText, networks, shortAddress, txUrl, type Chain } from "./chain";
import { signalConfirmation, useWorkshop } from "./useWorkshop";
import { walletSigner, buy, confirm, join, publish, useWallet, walletError, workshopWith, type Notify } from "./wallet";

type Notice = { text: string; hash?: string; chain?: Chain; kind: "pending" | "success" | "error" };
type Run = (action: () => Promise<string | void>, success: string, chain?: Chain) => Promise<void>;
export type Session = { account: string; busy: boolean; connect: () => void; run: Run; notify: Notify };

function Share({ source }: { source: string }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return <details className="share"><summary><Link2 size={15} />{localText("Share event", "分享活动")}</summary><div>
    <input aria-label="Shareable event link" readOnly value={eventUrl(source)} ref={input} onFocus={e => e.target.select()} />
    <button onClick={async () => { try { await navigator.clipboard.writeText(eventUrl(source)); setCopied(true); }
      catch { input.current?.focus(); input.current?.select(); } }}>{copied ? "Copied" : "Copy link"}</button></div></details>;
}

function EventPage({ source, account, busy, connect, run, notify }: Session & { source: string }) {
  const [ticketPage, setTicketPage] = useState({ owner: "", cursor: firstTicketPage });
  const cursor = ticketPage.owner === account ? ticketPage.cursor : firstTicketPage;
  const { base, lasna, baseHistory, lasnaHistory } = useWorkshop(source, account, cursor);
  const event = base.data?.event;
  const watcher = lasna.data;
  const binding = base.error || lasna.error ? "unavailable" : bindingStatus(event?.binding, watcher);
  const ready = binding === "ready";
  useEffect(() => { if (event) document.title = event.name + " · ReSeat"; }, [event?.name]);
  if (!event) return <section className="panel route-message"><h1>Event details</h1><p role="status">{base.error || "Reading this event from Base…"}</p><a href="?" className="text-action">All events</a></section>;
  const now = base.data!.block.timestamp;
  function register(qty: number, deadline: number, waiting: boolean) {
    if (!event || (waiting && !ready)) return;
    void run(async () => {
      notify("Checking your Base Sepolia wallet…");
      const signer = await walletSigner(account);
      return waiting ? join(signer, source, qty, deadline, notify) : buy(signer, source, qty, event.price, notify);
    }, waiting ? "Your order is confirmed on the waitlist." : "Tickets issued to your wallet.");
  }
  function action(method: "refund" | "cancel" | "requestSettlementRetry" | "withdrawProceeds", success: string, id?: string | bigint) {
    if (!account) { connect(); return; }
    void run(async () => {
      notify("Confirm the transaction in your wallet.");
      const contract = workshopWith(source, await walletSigner(account));
      return confirm(await contract[method](...(id === undefined ? [] : [id])), notify);
    }, success);
  }
  const historyErrors = [baseHistory.error && "Base Sepolia · " + baseHistory.error, lasnaHistory.error && "Lasna · " + lasnaHistory.error].filter(Boolean);
  return <>
    <div className="event-heading"><a href="?" className="text-action">All events</a>
      <a className="text-action" href={"?funding&event=" + source}>{localText("Event funding", "活动经费")}</a><Share source={source} /></div>
    <section className="hero" id="event" aria-labelledby="event-title">
      <img className="poster" src={event.cover || "/workshop.jpg"} alt="" referrerPolicy="no-referrer" fetchPriority="high" onError={e => { e.currentTarget.src = "/workshop.jpg"; }} />
      <div className="hero-copy"><div className="tags"><span className="pill pill-blue">Testnet event</span></div>
        <h1 id="event-title">{event.name}</h1><div className="metadata">
          <div><CalendarDays /><span>{formatTime(event.start)}</span></div>{event.location && <div><MapPin /><span>{event.location}</span></div>}
          <div><Users /><span>Hosted by <a href={networks.base.explorer + "/address/" + event.organizer} target="_blank" rel="noreferrer">{shortAddress(event.organizer)}</a></span></div>
        </div></div>
    </section>
    {(base.error || lasna.error) && <p className="connection-note" role="status">{base.error || lasna.error}</p>}
    <div className="content-grid"><div className="event-content">
      {event.description && <section className="about"><h2>About this event</h2><p className="event-description">{event.description}</p></section>}
      <Activity event={event} watcher={watcher} bound={ready} base={baseHistory.entries} lasna={lasnaHistory.entries} now={now} account={account}
        orderHistory={baseHistory.error || base.error ? "unavailable" : baseHistory.syncing ? "loading" : "ready"}
        busy={busy} errors={historyErrors} syncing={baseHistory.syncing || lasnaHistory.syncing} cancel={id => action("cancel", "Your waitlist order was cancelled.", id)}
        retry={() => action("requestSettlementRetry", "The latest settlement state was published.")} />
    </div><Registration event={event} now={now} account={account} busy={busy} readError={Boolean(base.error)} binding={binding}
      onConnect={connect} onRegister={register} onRefund={id => action("refund", "Ticket refunded to your wallet.", id)}
      onWithdraw={() => action("withdrawProceeds", "Event proceeds withdrawn.")} cursor={cursor}
      onPage={next => setTicketPage({ owner: account, cursor: next })}
      onActivate={() => void run(async () => {
        notify("Confirm the activation retry on Base.");
        const factory = new Contract(contractAddress("base"), factoryAbi, await walletSigner(account));
        return confirm(await factory.retryActivation(source), notify);
      }, "Activation requested again.")} /></div>
  </>;
}

export function App() {
  const { account, connect } = useWallet();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState<Notice>();
  const notify: Notify = (text, hash, chain) => setNotice({ text, hash, chain, kind: "pending" });
  const run: Run = async (action, success, chain = "base") => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { const hash = await action(); setNotice({ text: success, hash: hash || undefined, chain, kind: "success" }); }
    catch (err) { setNotice({ text: walletError(err), kind: "error" }); }
    finally { lock.current = false; setBusy(false); signalConfirmation(); }
  };
  const connectWallet = () => void run(async () => { notify("Choose an account in your wallet."); await connect(); }, "Wallet connected.");
  const query = new URLSearchParams(window.location.search);
  const source = query.get("event");
  return <><a className="skip" href="#main">Skip to content</a>
    <header className="site-header"><div className="shell nav-shell"><a className="wordmark" href="?"><span className="brand-icon"><Ticket size={23} /></span>ReSeat</a>
      <nav aria-label="Browse"><a href="?">Events</a>{source && !query.has("funding") ? <><a href="#waitlist">Waitlist</a><a href="#activity">Activity</a></> :
        <a href="?funding">{localText("Funding", "运行经费")}</a>}</nav>
      <div className="nav-actions"><a href="?publish" className="publish-link">{localText("Publish event", "发布活动")}</a>
        {account ? <span className="wallet-connected" title={account}><Wallet size={16} />{shortAddress(account)}</span> :
          <button className="wallet-button" disabled={busy} onClick={connectWallet}><Wallet size={16} />Connect Wallet</button>}</div>
    </div></header><main id="main" className="shell">
      {query.has("funding") ? <Funding source={source} account={account} busy={busy} connect={connectWallet} run={run} notify={notify} /> :
      query.has("publish") ? <Publish account={account} busy={busy} connect={connectWallet} submit={(draft, fee) => void run(async () => {
        const address = await publish(await walletSigner(account), draft, fee, notify);
        window.location.assign(eventUrl(address));
      }, "Event published.")} /> : source !== null ? isAddress(source) && networks.base.address ?
        <EventPage key={source} source={getAddress(source)} account={account} busy={busy} connect={connectWallet} run={run} notify={notify} /> :
        <section className="route-message panel"><h1>Event unavailable</h1><p>Check the event link and the configured Base factory.</p><a href="?" className="text-action">All events</a></section> :
        <Directory />}
    </main><footer><div className="shell footer-inner"><span className="footer-brand"><Ticket size={17} />ReSeat</span><div>
      <a href={"?funding" + (source && isAddress(source) ? "&event=" + source : "")}>{localText("Automation funding", "自动化运行经费")}</a>
      {(["base", "lasna"] as const).map(chain => <a key={chain} target="_blank" rel="noreferrer" href={networks[chain].explorer + (networks[chain].address ? "/address/" + networks[chain].address : "")}>{networks[chain].label}<ExternalLink size={12} /></a>)}
    </div></div></footer>
    {notice && <div className={"toast " + notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.kind === "pending" ? <LoaderCircle className="animate-spin" size={19} /> : notice.kind === "success" ? <Check size={19} /> : <CircleAlert size={19} />}
      <div><span>{notice.text}</span>{notice.hash && <a href={txUrl(notice.chain || "base", notice.hash)} target="_blank" rel="noreferrer">
        {notice.chain === "lasna" ? "View on Reactscan" : "View on BaseScan"} <ExternalLink size={12} /></a>}</div>
      <button aria-label="Dismiss notification" onClick={() => setNotice(undefined)}><X size={15} /></button></div>}
  </>;
}
