import { useState, type ReactNode } from "react";
import { CalendarClock, ChevronDown, CircleDollarSign, LockKeyhole, Minus, Plus, Ticket, Wallet } from "lucide-react";
import { firstTicketPage, formatTime, localText, usdc, type TicketCursor, type Workshop } from "./chain";
import { pendingJoin, sponsorshipMessage } from "./sponsorship";

interface Props {
  children?: ReactNode;
  event: Workshop; now: number; account: string; busy: boolean; readError: boolean; binding: "ready" | "pending" | "unavailable";
  sponsorship: string; cursor: TicketCursor; onPage: (cursor: TicketCursor) => void;
  onConnect: () => void; onRegister: (qty: number, deadline: number, joinQueue: boolean) => void;
  onRefund: (id: bigint) => void; onWithdraw: () => void; onActivate: () => void; onRetry: () => void;
}

export function Registration({ event, now, account, busy, readError, binding, sponsorship, cursor, onPage, onConnect, onRegister, onRefund, onWithdraw, onActivate, onRetry, children }: Props) {
  const [inputQty, setQty] = useState("1");
  const [until, setUntil] = useState("start");
  const [custom, setCustom] = useState("");
  const started = now >= event.start;
  const joinQueue = event.publicSeats === 0;
  const saved = account && joinQueue && event.sponsored ? pendingJoin(event.binding.source, account) : undefined;
  const draft = saved && saved.deadline > now ? saved : undefined;
  const price = event.price;
  const effective = draft?.deadline ?? Math.min(event.start, until === "custom" ? Math.floor(new Date(custom).getTime() / 1000) :
    until === "start" ? event.start : now + Number(until));
  const limit = joinQueue ? event.capacity : event.publicSeats;
  const qty = draft?.qty ?? Number(inputQty);
  const validQty = Number.isInteger(qty) && qty >= 1 && qty <= limit;
  const invalidTime = joinQueue && !(effective > now);
  const ready = binding === "ready";
  const pending = joinQueue && !ready;
  const feeUnavailable = joinQueue && event.sponsored && sponsorship !== "ready" && !draft?.sentAt;
  const label = started ? localText("Event started", "活动已开场") : pending ? (binding === "unavailable" ?
    localText("Waitlist unavailable", "候补暂不可用") : localText("Waitlist activation pending", "正在启用自动候补")) : !account ? localText("Connect wallet", "连接钱包") :
    joinQueue && draft ? localText("Check pending entry", "查看待确认的入队请求") :
    joinQueue && feeUnavailable ? localText("Checking sponsorship", "候补代付暂未就绪") :
    joinQueue && !event.sponsored ? localText("Join with wallet gas", "自行付费加入候补") :
    joinQueue ? localText("Sign & join waitlist", "签名加入候补") :
    localText(qty === 1 ? "Buy ticket" : "Buy " + (validQty ? qty + " " : "") + "tickets", validQty ? "购买 " + qty + " 张票" : "购票");
  const status = started ? localText("Closed", "已结束") : event.publicSeats ? localText("On sale", "售票中") : localText("Sold out", "已售罄");
  const tickets = event.account === account ? event.tickets : [];
  const owner = account.toLowerCase() === event.organizer.toLowerCase();
  return <aside className="sidebar">{children}<section className="panel registration" aria-labelledby="registration-title">
    <div className="section-heading"><h2 id="registration-title">{localText("Registration", "报名")}</h2><span className="pill pill-peach">{status}</span></div>
    <div className="rate"><span className="usdc-icon"><CircleDollarSign size={23} /></span><strong>{usdc(price)} <span>USDC</span></strong><small>/ ticket</small></div>
    <p className="inventory-line">{localText(`${event.publicSeats} available · ${event.capacity} total`, `可售 ${event.publicSeats} 张 · 共 ${event.capacity} 张`)}</p>
    <p className={"binding-status " + (ready ? "complete" : "")} role="status">{ready ? localText("Automatic waitlist ready", "候补已就绪") : binding === "unavailable" ?
      localText("Automatic waitlist unavailable", "自动候补暂不可用") : localText("Activating automatic waitlist", "正在启用自动候补")}</p>
    {binding === "pending" && owner && !started && event.binding.retryAt > 0 && <button className="text-action"
      disabled={busy || now < event.binding.retryAt} onClick={onActivate}>
      {now < event.binding.retryAt ? "Retry available " + formatTime(event.binding.retryAt) : "Retry activation"}</button>}
    <div className="form-row"><label htmlFor="quantity">{localText("Tickets", "要几张")}</label>
      <div className="stepper">
        <button aria-label="Decrease ticket quantity" disabled={Boolean(draft) || qty <= 1 || started || busy} onClick={() => setQty(String(Math.max(1, (qty || 1) - 1)))}><Minus size={16} /></button>
        <input id="quantity" aria-label="Ticket quantity" type="number" min="1" max={limit} step="1" value={draft?.qty ?? inputQty} disabled={Boolean(draft) || started || busy} onChange={e => setQty(e.target.value)} />
        <button aria-label="Increase ticket quantity" disabled={Boolean(draft) || qty >= limit || started || busy} onClick={() => setQty(String(Math.min(limit, (qty || 0) + 1)))}><Plus size={16} /></button>
      </div></div>
    {!validQty && !started && <p className="inline-note problem">Choose between 1 and {limit} tickets.</p>}
    {joinQueue && !started && <div className="deadline-field"><label htmlFor="deadline">{localText("Wait until", "最晚等到几点")}</label>
      <div className="select-wrap"><CalendarClock size={16} /><select id="deadline" value={draft ? "saved" : until} disabled={busy || Boolean(draft)} onChange={e => setUntil(e.target.value)}>
        {draft && <option value="saved">{formatTime(draft.deadline)}</option>}
        <option value="start">{localText("Event start", "活动开场")}</option><option value="3600">{localText("One hour from now", "一小时后")}</option><option value="86400">{localText("One day from now", "一天后")}</option><option value="custom">{localText("Choose date & time", "选择日期和时间")}</option>
      </select><ChevronDown size={15} /></div>
      {!draft && until === "custom" && <input type="datetime-local" aria-label="Custom waitlist deadline in your local time" value={custom} onChange={e => setCustom(e.target.value)} />}
      <small className={invalidTime ? "problem" : ""}>{invalidTime ? "Choose a future date and time." : "Effective deadline · " + formatTime(effective)}</small>
      <p id="waitlist-wallet-note" className="inline-note">{localText(
        "Joining the waitlist currently requires an externally owned account (EOA), such as a standard MetaMask account.",
        "候补目前支持普通钱包账户（EOA），例如 MetaMask 的标准账户。"
      )}</p>
      {ready && <p className="inline-note" role="status">{sponsorshipMessage(sponsorship)}</p>}
    </div>}
    <div className="total"><span>{joinQueue ? localText("Total if seated", "出票时整单扣款") : localText("Total", "整单金额")}</span><strong>{validQty ? usdc(price * BigInt(qty)) + " USDC" : "—"}</strong></div>
    <button type="button" className="primary" disabled={busy || started || pending || (Boolean(account) && feeUnavailable) || readError || !validQty || invalidTime}
      aria-describedby={joinQueue && !started ? "waitlist-wallet-note" : undefined}
      onClick={() => !account ? onConnect() : onRegister(qty, effective, joinQueue)}>
      {!account ? <Wallet size={17} /> : <Ticket size={17} />}{label}</button>
    <p className="form-note"><LockKeyhole size={14} />{started ? "Ticket sales and refunds have ended." :
      joinQueue ? localText("USDC stays in your wallet until every seat is ready.", "凑齐整单票后才会扣 USDC。") :
      localText("Your wallet pays gas for buying and refunding tickets.", "普通购票和主动退票的手续费由你的钱包支付。")}</p>
  </section>
  {owner && event.canRetry && <details className="panel organizer-tools">
    <summary>{localText("Organizer tools", "主办方维护")}</summary>
    <p>{localText("If automatic settlement stalls, resend this event’s waitlist status to Lasna. Your wallet will confirm a Base transaction and pay gas. This request spends no ticket USDC.",
      "自动补位停滞时，可重新通知 Lasna 检查本场候补。钱包会确认一笔 Base 交易并支付 gas，这笔交易不扣门票 USDC。")}</p>
    <button type="button" className="text-action" disabled={busy || readError} onClick={onRetry}>{localText("Resend waitlist status", "重新发送候补状态")}</button>
  </details>}
  {account && <section className="panel personal"><div className="section-heading"><h2>My tickets</h2><Ticket size={18} /></div>
    {event.account === account && <p className="muted text-sm">{String(event.ticketCount)} active {event.ticketCount === 1n ? "ticket" : "tickets"}</p>}
    {tickets.map(id => <div className="personal-row" key={String(id)}><span>Ticket #{String(id)}</span>
      {!started && <button className="text-action" disabled={busy || readError} onClick={() => onRefund(id)}>Refund {usdc(price)} USDC</button>}</div>)}
    {tickets.length > 0 && !started && <small>{localText("Your wallet pays the refund transaction fee.", "退票交易手续费由你的钱包支付。")}</small>}
    <div className="pager">{(cursor.grant !== 0n || cursor.offset > 0) && <button onClick={() => onPage(firstTicketPage)}>First page</button>}
      {event.nextPage && <button onClick={() => onPage(event.nextPage!)}>More tickets</button>}</div>
    {started && owner && event.proceeds > 0n && <button className="secondary" disabled={busy || readError} onClick={onWithdraw}>Withdraw {usdc(event.proceeds)} USDC</button>}
  </section>}</aside>;
}
