import { useState } from "react";
import { CalendarClock, ChevronDown, CircleDollarSign, LockKeyhole, Minus, Plus, Ticket, Wallet } from "lucide-react";
import { formatUnits } from "ethers";
import { PRICE, formatTime, networks, type Workshop } from "./chain";

interface Props {
  event?: Workshop | null;
  now: number;
  account: string;
  busy: boolean;
  readError: boolean;
  onConnect: () => void;
  onRegister: (qty: number, deadline: number, joinQueue: boolean) => void;
  onRefund: (id: bigint) => void;
  onWithdraw: () => void;
}

export const usdc = (amount: bigint) => Number(formatUnits(amount, 6)).toLocaleString(undefined, { maximumFractionDigits: 6 });

export function Registration({ event, now, account, busy, readError, onConnect, onRegister, onRefund, onWithdraw }: Props) {
  const [qty, setQty] = useState(1);
  const [until, setUntil] = useState("start");
  const [custom, setCustom] = useState("");
  const started = Boolean(event && now >= event.start);
  const joinQueue = !event || event.publicSeats === 0;
  const price = event?.price ?? PRICE;
  const effective = event ? Math.min(event.start, until === "custom" ? Math.floor(new Date(custom).getTime() / 1000) :
    until === "start" ? event.start : now + Number(until)) : 0;
  const limit = event ? joinQueue ? event.capacity : event.publicSeats : 2;
  const quantity = Math.min(qty, Math.max(1, limit));
  const invalidTime = Boolean(joinQueue && event && !(effective > now));
  const open = event && !started && !busy && !invalidTime && !readError;
  const label = started ? "Event started" : !account ? "Connect wallet" : !event ? (networks.base.address ? "Reading workshop…" : "Awaiting deployment") :
    joinQueue ? "Sign & join waitlist" : "Buy " + (quantity === 1 ? "ticket" : quantity + " tickets");
  const status = started ? "Closed" : !event ? (networks.base.address ? "Connecting" : "Preview") :
    event.publicSeats ? "On sale" : event.held ? "Seats held" : "Sold out";
  const tickets = event?.account === account ? event.tickets : [];
  return <aside className="sidebar">
    <section className="panel registration" aria-labelledby="registration-title">
      <div className="section-heading"><h2 id="registration-title">Registration</h2><span className={"pill " + (event && !started ? "pill-peach" : "")}>{status}</span></div>
      <div className="rate"><span className="usdc-icon"><CircleDollarSign size={23} /></span><strong>{usdc(price)} <span>USDC</span></strong><small>/ ticket</small></div>
      <div className="form-row"><label id="quantity-label">Tickets</label>
        <div className="stepper" role="group" aria-labelledby="quantity-label">
          <button type="button" aria-label="Decrease ticket quantity" disabled={quantity <= 1 || started || busy} onClick={() => setQty(quantity - 1)}><Minus size={16} /></button>
          <output aria-live="polite">{quantity}</output>
          <button type="button" aria-label="Increase ticket quantity" disabled={quantity >= limit || started || busy} onClick={() => setQty(quantity + 1)}><Plus size={16} /></button>
        </div>
      </div>
      {joinQueue && !started && <div className="deadline-field">
        <label htmlFor="deadline">Wait until</label>
        <div className="select-wrap"><CalendarClock size={16} /><select id="deadline" value={until} disabled={busy} onChange={e => setUntil(e.target.value)}>
          <option value="start">Event start</option><option value="3600">One hour from now</option><option value="86400">One day from now</option><option value="custom">Choose date & time</option>
        </select><ChevronDown size={15} /></div>
        {until === "custom" && <input type="datetime-local" aria-label="Custom waitlist deadline in your local time" value={custom} onChange={e => setCustom(e.target.value)} />}
        {until !== "start" && event && <small className={invalidTime ? "problem" : ""}>{invalidTime ? "Choose a future date and time." : "Effective deadline · " + formatTime(effective)}</small>}
      </div>}
      <div className="total"><span>{joinQueue ? "Total if seated" : "Total"}</span><strong>{usdc(price * BigInt(quantity))} USDC</strong></div>
      <button type="button" className="primary" disabled={busy || started || (Boolean(account) && !open)}
        onClick={() => !account ? onConnect() : onRegister(quantity, effective, joinQueue)}>
        {!account ? <Wallet size={17} /> : <Ticket size={17} />}{label}
      </button>
      <p className="form-note"><LockKeyhole size={14} />{!networks.base.address ? "Testnet registration opens after deployment." :
        started ? "Ticket sales and refunds have ended." : joinQueue ? "USDC stays in your wallet until every seat is ready." : "Tickets are refundable until the workshop starts."}</p>
    </section>
    {account && event && <section className="panel personal">
      <div className="section-heading"><h2>My tickets</h2><Ticket size={18} /></div>
      {!tickets.length && <p className="muted text-sm">This wallet holds no tickets.</p>}
      {tickets.map(id => <div className="personal-row" key={String(id)}><span>Ticket #{String(id)}</span>
        {!started && <button className="text-action" disabled={busy || readError} onClick={() => onRefund(id)}>Refund {usdc(price)} USDC</button>}</div>)}
      {started && account.toLowerCase() === event.organizer.toLowerCase() && event.proceeds > 0n &&
        <button className="secondary" disabled={busy || readError} onClick={onWithdraw}>Withdraw {usdc(event.proceeds)} USDC</button>}
    </section>}
  </aside>;
}
