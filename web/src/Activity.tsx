import { useMemo, useState } from "react";
import { Activity as Pulse, Armchair, Clock3, ExternalLink, Layers3, ListOrdered, Radio, Timer } from "lucide-react";
import { formatTime, networks, shortAddress, txUrl, type Chain, type Workshop, type Watcher } from "./chain";
import { describe, ordersFrom, statusNames, type Entry } from "./ledger";

interface Props {
  event?: Workshop | null;
  watcher?: Watcher | null;
  base: Entry[];
  lasna: Entry[];
  now: number;
  account: string;
  busy: boolean;
  errors: string[];
  syncing: boolean;
  cancel: (id: string) => void;
  retry: () => void;
}

export function Activity({ event, watcher, base, lasna, now, account, busy, errors, syncing, cancel, retry }: Props) {
  const [allOrders, setAllOrders] = useState(false);
  const [filter, setFilter] = useState<"all" | Chain>("all");
  const [orderLimit, setOrderLimit] = useState(5);
  const [logLimit, setLogLimit] = useState(6);
  const orders = useMemo(() => ordersFrom(base), [base]);
  const ranks = useMemo(() => new Map(orders.filter(o => o.status === 1 && o.deadline > now).map((o, i) => [o.id, i + 1])), [orders, now]);
  const visible = orders.filter(o => allOrders || o.status === 1);
  const logs = useMemo(() => [...base, ...lasna].sort((a, b) => b.time - a.time ||
    (a.chain === b.chain ? b.block - a.block || b.index - a.index : a.chain.localeCompare(b.chain)))
    .filter(row => filter === "all" || row.chain === filter), [base, lasna, filter]);
  const matches = watcher && networks.base.address.toLowerCase() === watcher.source.toLowerCase();
  return <>
    <section className="panel queue" id="waitlist" aria-labelledby="queue-title">
      <div className="section-heading"><div className="heading-icon"><ListOrdered size={20} /><h2 id="queue-title">Waitlist</h2></div>
        <span className="count-label">{event ? event.active + " open" : "FIFO"}</span></div>
      <div className="metric-grid">
        <div><Armchair size={17} /><span>Public seats</span><strong>{event?.publicSeats ?? "—"} <small>/ {event?.capacity ?? 2}</small></strong></div>
        <div><Clock3 size={17} /><span>Held seats</span><strong>{event?.held ?? "—"}</strong></div>
        <div><Radio size={17} /><span>Lasna CRON</span><strong className={"cron-value " + (matches && watcher.active ? "active" : "")}>{matches ? watcher.active ? "Active" : "Off" : "Pending"}</strong></div>
      </div>
      {matches && watcher.active && <p className="inline-note">Tracking the head deadline · {formatTime(watcher.deadline)}</p>}
      <div className="tabs" aria-label="Queue view">{["Open orders", "All orders"].map((s, i) =>
        <button key={s} aria-pressed={allOrders === Boolean(i)} onClick={() => { setAllOrders(Boolean(i)); setOrderLimit(5); }}>{s}</button>)}</div>
      {!visible.length ? <div className="empty"><Layers3 size={21} /><div><strong>{syncing ? "Reading orders…" : "No confirmed orders"}</strong>
        <p>Requests appear here in the order they join.</p></div></div> :
        <ol className="order-list">{visible.slice(0, orderLimit).map(o => <li key={o.id}>
          <span className="rank" aria-label="Queue position">{ranks.has(o.id) ? "#" + ranks.get(o.id) : "–"}</span>
          <div className="order-label"><strong>Order #{o.id} · {o.qty} {o.qty === 1 ? "ticket" : "tickets"}</strong>
            <small>{shortAddress(o.buyer)} · Until {formatTime(o.deadline)}</small></div>
          <div className="order-state"><span className={"pill " + (o.status === 2 ? "pill-green" : "")}>{o.status === 1 && now >= o.deadline ?
            "Deadline passed" : o.status >= 3 ? "Skipped · " + statusNames[o.status] : statusNames[o.status]}</span>
            {o.status === 1 && o.buyer.toLowerCase() === account.toLowerCase() &&
              <button className="text-action" disabled={busy} onClick={() => cancel(o.id)}>Cancel order</button>}</div>
        </li>)}</ol>}
      {visible.length > orderLimit && <button className="text-action" onClick={() => setOrderLimit(v => v + 10)}>Show more orders</button>}
      {event && event.available > 0 && event.active > 0 && <button className="retry" disabled={busy} onClick={retry}><Timer size={15} />Request settlement retry</button>}
    </section>
    <section className="panel activity" id="activity" aria-labelledby="activity-title">
      <div className="section-heading"><div className="heading-icon"><Pulse size={20} /><h2 id="activity-title">Onchain activity</h2></div></div>
      <div className="tabs" aria-label="Activity network">{(["all", "base", "lasna"] as const).map(f =>
        <button key={f} aria-pressed={filter === f} onClick={() => { setFilter(f); setLogLimit(6); }}>{f === "all" ? "All chains" : networks[f].label}</button>)}</div>
      {errors.map(err => <p className="inline-note problem" key={err}>{err}</p>)}
      {logs.length === 0 ? <div className="empty"><Pulse size={21} /><div><strong>{syncing ? "Syncing chain history…" : "No confirmed activity"}</strong>
        <p>Ticket transactions and Lasna responses will appear here.</p></div></div> :
        <ol className="timeline">{logs.slice(0, logLimit).map(row => <li key={row.chain + row.hash + row.index}>
          <span className={"timeline-dot " + row.chain} />
          <div><strong>{describe(row)}</strong><small>{formatTime(row.time)} · {networks[row.chain].label}</small>
            {row.event.name === "SettlementRequested" && <a className="source-link" target="_blank" rel="noreferrer"
              href={txUrl(row.event.args.fromCron ? "lasna" : "base", row.event.args.sourceTx)}>Trigger transaction <ExternalLink size={11} /></a>}</div>
          <a className="explorer" href={txUrl(row.chain, row.hash)} target="_blank" rel="noreferrer">{row.chain === "base" ? "BaseScan" : "Reactscan"} <ExternalLink size={13} /></a>
        </li>)}</ol>}
      {logs.length > logLimit && <button className="text-action" onClick={() => setLogLimit(v => v + 10)}>Show more activity</button>}
    </section>
  </>;
}
