import { useState, type FormEvent } from "react";
import { CalendarClock, ImagePlus, Ticket } from "lucide-react";
import { formatEther, parseUnits } from "ethers";
import { coverUrl, localText, readPublishSettings } from "./chain";
import { usePolling } from "./useWorkshop";
import type { Publication } from "./wallet";

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export function Publish({ account, busy, connect, submit }: {
  account: string; busy: boolean; connect: () => void; submit: (draft: Publication, fee: bigint) => void;
}) {
  const settings = usePolling(readPublishSettings);
  const [error, setError] = useState("");
  function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = (key: string) => String(form.get(key) ?? "").trim();
    try {
      const name = field("name"), cover = field("cover"), priceText = field("price");
      const capacity = Number(field("capacity"));
      const start = Math.floor(new Date(field("start")).getTime() / 1000);
      if (!name || !Number.isSafeInteger(start) || start <= Date.now() / 1000) throw new Error("Enter a name and a future start time.");
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4294967295) throw new Error("Enter a valid whole number of tickets.");
      if (!/^\d+(\.\d{1,6})?$/.test(priceText)) throw new Error("USDC prices support up to six decimal places.");
      const price = parseUnits(priceText, 6);
      if (price <= 0n || price * BigInt(capacity) >= 2n ** 256n) throw new Error("Enter a valid positive ticket price.");
      if (cover && !coverUrl(cover)) throw new Error("Use a publicly accessible HTTPS image URL.");
      if (!settings.data || settings.error) throw new Error("The event factory is unavailable.");
      setError("");
      if (!account) { connect(); return; }
      submit({ name, location: field("location"), description: field("description"), cover, start, capacity, price }, settings.data.fee);
    } catch (reason) { setError((reason as Error).message); }
  }
  return <section className="publish-layout"><div className="publish-intro">
    <div className="tags"><span className="pill pill-blue"><Ticket size={14} />Base Sepolia</span></div>
    <h1>{localText("Publish an event", "发布活动")}</h1><p>{localText("Set your ticket price and capacity. Guests can share the event link and reserve seats together.", "设置票价和名额。来宾可以分享活动链接，也可以为多人整单候补。")}</p>
    <img src="/workshop.jpg" alt="Orange folding chair on a blue workshop poster" />
  </div><form onSubmit={review} className="panel publish-form">
    <h2>{localText("Event details", "活动信息")}</h2>
    <label>{localText("Event name", "活动名称")}<input name="name" placeholder="Reactive Builders Workshop" required /></label>
    <label>{localText("Starts at", "开场时间")} <small>{zone}</small><input name="start" type="datetime-local" required /></label>
    <div className="form-pair"><label>{localText("Total tickets", "总票数")}<input name="capacity" type="number" min="1" max="4294967295" step="1" defaultValue="2" required /></label>
      <label>{localText("USDC per ticket", "每张票的 USDC 价格")}<input name="price" inputMode="decimal" defaultValue="20" required /></label></div>
    <label>{localText("Location", "地点")} <small>{localText("Optional", "选填")}</small><input name="location" placeholder="Venue or online meeting location" /></label>
    <label>{localText("About the event", "活动简介")} <small>{localText("Optional", "选填")}</small><textarea name="description" rows={3} /></label>
    <label><span><ImagePlus size={15} /> {localText("Cover image", "活动封面")} <small>{localText("Optional", "选填")}</small></span><input name="cover" type="url" placeholder="https://…" /></label>
    <div className="reserve-note"><CalendarClock size={18} /><p>{settings.data ?
      <><strong>{formatEther(settings.data.fee)} {localText("test ETH", "测试 ETH")}</strong>{" "}
        {localText("pays for this event’s Base callbacks, including entry and cancellation on sponsorship-enabled events. Unused credit is non-refundable. Your wallet pays the publication fee.",
          "用于本场活动的 Base 回调；支持代付的活动也从中支付加入和取消候补的手续费。未使用余额不可退，发布交易手续费由你的钱包支付。")}</> :
      settings.error || "The callback reserve appears when the Base factory is connected."}</p></div>
    {error && <p role="alert" className="problem">{error}</p>}
    <button className="primary" disabled={busy || !settings.data || Boolean(settings.error)}>{account ? localText("Publish event", "发布活动") : localText("Connect wallet to publish", "连接钱包发布")}</button>
  </form></section>;
}
