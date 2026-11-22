import { useRef, useState } from "react";
import { Armchair, AudioLines, CalendarDays, Check, CircleAlert, ExternalLink, Flag, Globe2, LoaderCircle, MapPin, Ticket, Users, Wallet, X } from "lucide-react";
import { Activity } from "./Activity";
import { Registration } from "./Registration";
import { formatTime, networks, shortAddress, txUrl } from "./chain";
import { signalConfirmation, useWorkshop } from "./useWorkshop";
import { baseSigner, buy, confirm, join, useWallet, walletError, workshopWith, type Notify } from "./wallet";

type Notice = { text: string; hash?: string; kind: "pending" | "success" | "error" };
const links = [["Event", "event"], ["Waitlist", "waitlist"], ["Activity", "activity"]];

export function App() {
  const { account, connect } = useWallet();
  const { base, lasna, baseHistory, lasnaHistory } = useWorkshop(account);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState<Notice>();
  const event = base.data?.event;
  const watcher = lasna.data?.watcher;
  const now = base.data?.block.timestamp ?? Math.floor(Date.now() / 1000);
  const update: Notify = (text, hash) => setNotice({ text, hash, kind: "pending" });
  async function run(action: () => Promise<string | void>, success: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const hash = await action();
      setNotice({ text: success, hash: hash || undefined, kind: "success" });
      signalConfirmation();
    } catch (err) {
      setNotice({ text: walletError(err), kind: "error" });
      signalConfirmation();
    } finally { lock.current = false; setBusy(false); }
  }
  const connectWallet = () => void run(async () => { update("Choose an account in your wallet."); await connect(); }, "Wallet connected.");
  function register(qty: number, deadline: number, waiting: boolean) {
    if (!event) return;
    void run(async () => {
      update("Checking your Base Sepolia wallet…");
      const signer = await baseSigner(account);
      return waiting ? join(signer, qty, deadline, update) : buy(signer, qty, event.price, update);
    }, waiting ? "Your order is confirmed on the waitlist." : "Tickets issued to your wallet.");
  }
  function action(method: "refund" | "cancel" | "requestSettlementRetry" | "withdrawProceeds", success: string, id?: string | bigint) {
    if (!account) { connectWallet(); return; }
    void run(async () => {
      update("Confirm the transaction in your wallet.");
      const workshop = workshopWith(await baseSigner(account));
      return confirm(await workshop[method](...(id === undefined ? [] : [id])), update);
    }, success);
  }
  const historyErrors = [baseHistory.error && "Base Sepolia · " + baseHistory.error, lasnaHistory.error && "Lasna · " + lasnaHistory.error].filter(Boolean);
  return <>
    <a className="skip" href="#event">Skip to event</a>
    <header className="site-header"><div className="shell nav-shell">
      <a className="wordmark" href="#event" aria-label="ReSeat event"><span className="brand-icon"><Ticket size={23} strokeWidth={2.3} /></span>ReSeat</a>
      <nav aria-label="Event sections">{links.map(([label, id]) => <a key={id} href={"#" + id}>{label}</a>)}</nav>
      <div className="nav-actions"><span className="network-tag"><i />Base Sepolia</span>
        {account ? <span className="wallet-connected" title={account}><Wallet size={16} />{shortAddress(account)}</span> :
          <button className="wallet-button" disabled={busy} onClick={connectWallet}><Wallet size={16} />Connect Wallet</button>}</div>
    </div></header>
    <main className="shell">
      <div className="context"><Flag size={15} /><span>Reactive Omni Buildathon</span><span className="context-slash">/</span><span>Set It and Forget It</span></div>
      <section className="hero" id="event" aria-labelledby="event-title">
        <img className="poster" src="/workshop.jpg" width="1254" height="1254" alt="An orange folding chair on a cobalt-blue screen-printed workshop poster" fetchPriority="high" />
        <div className="hero-copy">
          <div className="tags"><span className="pill pill-peach"><Armchair size={13} />Workshop</span><span className="pill pill-blue"><span className="testnet-mark" />Testnet event</span></div>
          <h1 id="event-title">Reactive Builders<br />Workshop</h1>
          <div className="metadata"><div><CalendarDays /><span>{event ? formatTime(event.start) : networks.base.address ? "Reading event date…" : "Starts 7 days after deployment"}</span></div>
          <div><MapPin /><span>Online workshop</span></div><div><Users /><span>Hosted by <strong>ReSeat</strong></span></div></div>
        </div>
      </section>
      {(base.error || lasna.error) && <div className="connection-note" role="status"><CircleAlert size={16} /><span>{[base.error && "Base Sepolia · " + base.error, lasna.error && "Lasna · " + lasna.error].filter(Boolean).join(" · ")}</span></div>}
      <div className="content-grid">
        <div className="event-content">
          <section className="about" aria-labelledby="about-title"><h2 id="about-title">About this event</h2>
            <p>A two-seat workshop on building event-driven contracts with Reactive Omni. Follow a ticket from a Base Sepolia refund to an automatic USDC payment and a new admission.</p>
            <p>Coming together? Join the waitlist for your whole group. The first order in line keeps its place until every seat is ready or its deadline passes.</p>
          </section>
          <Activity event={event} watcher={watcher} base={baseHistory.entries} lasna={lasnaHistory.entries} now={now} account={account}
            busy={busy} errors={historyErrors} syncing={baseHistory.syncing || lasnaHistory.syncing}
            cancel={id => action("cancel", "Your waitlist order was cancelled.", id)}
            retry={() => action("requestSettlementRetry", "The workshop published its latest settlement state.")} />
        </div>
        <Registration event={event} now={now} account={account} busy={busy} readError={Boolean(base.error)}
          onConnect={connectWallet} onRegister={register} onRefund={id => action("refund", "Ticket refunded to your wallet.", id)}
          onWithdraw={() => action("withdrawProceeds", "Workshop proceeds withdrawn.")} />
      </div>
    </main>
    <footer><div className="shell footer-inner"><span className="footer-brand"><Ticket size={17} />ReSeat</span>
      <div>{(["base", "lasna"] as const).map(chain => { const state = chain === "base" ? base : lasna;
        return <a key={chain} target="_blank" rel="noreferrer" href={networks[chain].explorer + (networks[chain].address ? "/address/" + networks[chain].address : "")}>
          {chain === "base" ? <Globe2 size={13} /> : <AudioLines size={13} />}{networks[chain].label}
          {state.data && !state.error && <span>#{state.data.block.number.toLocaleString()}</span>}<ExternalLink size={12} /></a>;
      })}</div></div></footer>
    {notice && <div className={"toast " + notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.kind === "pending" ? <LoaderCircle className="animate-spin" size={19} /> : notice.kind === "success" ? <Check size={19} /> : <CircleAlert size={19} />}
      <div>{notice.text}{notice.hash && <a href={txUrl("base", notice.hash)} target="_blank" rel="noreferrer">View on BaseScan <ExternalLink size={12} /></a>}</div>
      <button aria-label="Dismiss notification" onClick={() => setNotice(undefined)}><X size={15} /></button></div>}
  </>;
}
