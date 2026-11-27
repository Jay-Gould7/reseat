import { useEffect, useEffectEvent, useState } from "react";
import { ChevronDown, ListOrdered } from "lucide-react";
import { formatTime, localText as t, usdc, type Workshop } from "./chain";
import { fifo, isOpen, orderStatus, readPastOrders, type Order, type QueueSnapshot } from "./orders";
import { sponsorshipMessage } from "./sponsorship";

interface Props {
  source: string; account: string; now: number; event: Workshop; busy: boolean;
  orders: Order[]; queue?: QueueSnapshot; ranks?: Map<string, number>; readError: boolean;
  sponsorship: string; cancel: (order: Order, walletPaid?: boolean) => void;
}

export function MyOrders({ source, account, now, event, busy, orders, queue, ranks, readError, sponsorship, cancel }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const [limit, setLimit] = useState(5);
  const [past, setPast] = useState<{ rows: Order[]; loading: boolean; error: boolean }>({ rows: [], loading: false, error: false });
  const first = queue?.first;
  const latestOrderBlock = useEffectEvent(() => queue?.block);
  useEffect(() => {
    const block = latestOrderBlock();
    if (!showHistory || first === undefined || block === undefined) return;
    let stopped = false;
    setPast({ rows: [], loading: true, error: false });
    void readPastOrders(source, account, first, block, () => stopped, rows => {
      if (!stopped) setPast(prev => ({ ...prev, rows: [...prev.rows, ...rows] }));
    }).then(() => { if (!stopped) setPast(prev => ({ ...prev, loading: false })); })
      .catch(() => { if (!stopped) setPast(prev => ({ ...prev, loading: false, error: true })); });
    return () => { stopped = true; };
  }, [source, account, first, showHistory]);

  const mine = orders.filter(o => o.buyer.toLowerCase() === account.toLowerCase());
  const active = mine.filter(o => isOpen(o, now)).sort(fifo);
  const history = new Map(past.rows.map(o => [o.id, o]));
  for (const o of mine) if (!isOpen(o, now)) history.set(o.id, o);
  const visible = showHistory ? [...history.values()].sort((a, b) => fifo(b, a)) : active;
  const loading = !queue?.complete || (showHistory && past.loading);
  const error = readError || (showHistory && past.error);
  return <section className="panel personal my-orders" aria-labelledby="my-orders-title">
    <div className="heading-icon"><ListOrdered size={19} /><h2 id="my-orders-title">{t("My waitlist orders", "我的候补订单")}</h2></div>
    <div className="tabs" aria-label={t("Orders for this wallet", "当前钱包的候补记录")}>
      {[t("Current", "当前候补"), t("History", "历史订单")].map((label, i) =>
        <button type="button" key={label} aria-pressed={showHistory === Boolean(i)} onClick={() => { setShowHistory(Boolean(i)); setLimit(5); }}>{label}</button>)}
    </div>
    {visible.slice(0, limit).map(order => {
      const rank = ranks?.get(order.id);
      const held = !showHistory && event.heldFor === order.id ? event.held : 0;
      return <article className="my-order" key={order.id}>
        <div className="section-heading"><h3>{t("Order", "订单")} #{order.id}</h3><span className={"pill" + (order.status === 2 ? " pill-green" : "")}>{orderStatus(order, now)}</span></div>
        <p>{t(`${order.qty} ${order.qty === 1 ? "ticket" : "tickets"}`, `${order.qty} 张票`)} · {usdc(event.price * BigInt(order.qty))} USDC</p>
        {rank !== undefined && <small>{t(`Queue position #${rank}`, `候补顺位：第 ${rank} 位`)}</small>}
        <small>{t("Deadline", "截止时间")} · {formatTime(order.deadline)}</small>
        {held > 0 && <p className="hold-note">{event.blocked ? t(`All ${held} seats are held for you. Payment is delayed. No USDC charged.`, `已为你凑齐 ${held} 张票，收款暂时延迟。顺位已保留，尚未扣款。`) :
          t(`Holding ${held} ${held === 1 ? "seat" : "seats"} · ${order.qty - held} more needed. No USDC charged.`, `已暂留 ${held} 张，还差 ${order.qty - held} 张，尚未扣款`)}</p>}
        {!showHistory && <button type="button" className="cancel-order" disabled={busy || (event.sponsored && sponsorship !== "ready")} onClick={() => cancel(order)}>{t("Cancel waitlist order", "取消候补订单")}</button>}
        {!showHistory && event.sponsored && sponsorship !== "checking" && sponsorship !== "ready" &&
          <button type="button" className="text-action" disabled={busy} onClick={() => cancel(order, true)}>{t("Cancel using my own Base ETH", "用我自己的 Base ETH 取消")}</button>}
      </article>;
    })}
    {!showHistory && visible.length > 0 && <small>{sponsorship === "ready" ?
      t("The event pays for cancellation. It takes effect when Base confirms it.", "活动支付取消手续费。取消以 Base 确认为准。") : sponsorshipMessage(sponsorship)}</small>}
    {visible.length > limit && <button className="text-action" onClick={() => setLimit(v => v + 5)}>{t("Show more orders", "查看更多订单")} <ChevronDown size={14} /></button>}
    {error ? <p className="inline-note problem" role="status">{t("Some orders could not be read from Base.", "部分订单暂时无法从 Base 读取。")}</p> :
      loading ? <p className="inline-note" role="status">{showHistory ? t("Reading older orders…", "正在读取历史订单…") : t("Checking this wallet’s orders…", "正在查询当前钱包的候补…")}</p> :
      !visible.length && <p className="inline-note">{showHistory ? t("No past waitlist orders for this wallet.", "当前钱包还没有历史候补订单。") :
        t("No active waitlist orders for this wallet.", "当前钱包没有有效候补。")}</p>}
  </section>;
}
