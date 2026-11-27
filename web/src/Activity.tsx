import { useMemo, useState } from "react";
import { ZeroHash } from "ethers";
import { Activity as Pulse, Armchair, ExternalLink, ListOrdered, Radio, Users } from "lucide-react";
import { formatTime, localText as t, networks, txUrl, type Chain, type Workshop, type Watcher } from "./chain";
import { describe, type Entry } from "./ledger";

interface Props {
  event: Workshop; watcher?: Watcher | null; bound: boolean;
  openCount?: number; queueError: boolean;
  base: Entry[]; lasna: Entry[]; errors: string[]; syncing: boolean;
}

export function Activity({ event, watcher, bound, openCount, queueError, base, lasna, errors, syncing }: Props) {
  const [filter, setFilter] = useState<"all" | Chain>("all");
  const [limit, setLimit] = useState(6);
  const logs = useMemo(() => [...base, ...lasna]
    .filter(row => filter === "all" || row.chain === filter)
    .flatMap(row => { const label = describe(row); return label ? [{ row, label }] : []; })
    .sort((a, b) => b.row.time - a.row.time || (a.row.chain === b.row.chain
      ? b.row.block - a.row.block || b.row.index - a.row.index : a.row.chain.localeCompare(b.row.chain))), [base, lasna, filter]);
  return <>
    <section className="panel queue" id="waitlist" aria-labelledby="queue-title">
      <div className="heading-icon"><ListOrdered size={20} /><h2 id="queue-title">{t("Waitlist overview", "候补概况")}</h2></div>
      <div className="metric-grid">
        <div><Armchair size={17} /><span>{t("Public seats", "可售票数")}</span><strong>{event.publicSeats} <small>/ {event.capacity}</small></strong></div>
        <div><Users size={17} /><span>{t("Open orders", "有效候补订单")}</span><strong role="status">{openCount ?? <small>{queueError ? t("Unavailable", "暂不可用") : t("Loading…", "读取中…")}</small>}</strong></div>
        <div><Radio size={17} /><span>{t("Deadline checks", "自动检查期限")}</span><strong className={"cron-value " + (bound && watcher?.active ? "active" : "")}>
          {!bound ? t("Pending", "待启用") : watcher?.active ? t("Active", "运行中") : t("Standby", "待命")}</strong></div>
      </div>
      <p className="inline-note">{t("Returned seats go to the next group in line. Payment is collected when the whole group can be seated.",
        "退回的票按候补顺序分配。凑齐一笔订单的全部票后，才会扣款出票。")}</p>
    </section>
    <section className="panel activity" id="activity" aria-labelledby="activity-title">
      <div className="heading-icon"><Pulse size={20} /><h2 id="activity-title">{t("Event activity", "活动动态")}</h2></div>
      <div className="tabs" aria-label={t("Activity network", "动态所属网络")}>{(["all", "base", "lasna"] as const).map(f =>
        <button type="button" key={f} aria-pressed={filter === f} onClick={() => { setFilter(f); setLimit(6); }}>
          {f === "all" ? t("All networks", "全部网络") : networks[f].label}</button>)}</div>
      {errors.map(err => <p className="inline-note problem" key={err}>{err}</p>)}
      {!logs.length ? <p className="inline-note" role="status">{syncing ? t("Loading activity…", "正在读取活动动态…") :
        t("No confirmed activity to show.", "暂无可展示的活动动态。")}</p> :
        <ol className="timeline">{logs.slice(0, limit).map(({ row, label }) => <li key={row.chain + row.hash + row.index}>
          <span className={"timeline-dot " + row.chain} /><div><strong>{label}</strong><small>{formatTime(row.time)} · {networks[row.chain].label}</small>
            {row.event.name === "SettlementRequested" && row.event.args.sourceTx !== ZeroHash && <a className="source-link" target="_blank" rel="noreferrer"
              href={txUrl(row.event.args.fromCron ? "lasna" : "base", row.event.args.sourceTx)}>{t("Trigger transaction", "触发此检查的交易")} <ExternalLink size={11} /></a>}</div>
          <a className="explorer" href={txUrl(row.chain, row.hash)} target="_blank" rel="noreferrer">{row.chain === "base" ? "BaseScan" : "Reactscan"} <ExternalLink size={13} /></a>
        </li>)}</ol>}
      {logs.length > limit && <button type="button" className="text-action" onClick={() => setLimit(v => v + 10)}>{t("Show more activity", "查看更多动态")}</button>}
    </section>
  </>;
}
