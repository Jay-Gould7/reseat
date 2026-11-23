import { useCallback, useState } from "react";
import { formatEther, getAddress, isAddress, ZeroAddress } from "ethers";
import { ExternalLink, Wallet } from "lucide-react";
import { localText as t, networks, shortAddress } from "./chain";
import { fundBudget, fundChain, nativeAmount, readFunding, type Fund } from "./feeBudget";
import { usePolling } from "./useWorkshop";
import { confirm, walletSigner, workshopWith } from "./wallet";
import type { Session } from "./App";

function FundCard({ fund, source, account, busy, connect, run, notify }: Session & { fund: Fund; source: string | null }) {
  const chain = fundChain(fund), net = networks[chain], unit = chain === "base" ? "ETH" : "lREACT";
  const load = useCallback(() => readFunding(fund, source), [fund, source]);
  const { data, error } = usePolling(load);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const value = nativeAmount(amount), event = data?.event;
  const owner = Boolean(event && account === event.owner);
  const title = fund === "event" ? t("Event callbacks", "本场活动回调") : fund === "watcher" ?
    t("Platform watcher", "平台自动候补") : t("Automatic refund delivery", "平台自动退款");
  const success = t("Funding confirmed.", "充值已确认。");
  if (data === null && !error) return null;
  function recovery(changeRecipient: boolean) {
    if (!data || !owner) return;
    void run(async () => {
      const contract = workshopWith(data.address, await walletSigner(account));
      return confirm(changeRecipient ? await contract.setFeeRecipient(getAddress(recipient)) : await contract.retryFeeRefund(), notify);
    }, changeRecipient ? t("Refund wallet updated.", "退款钱包已更新。") : t("Refund check requested.", "已请求重新核对退款。"));
  }
  return <section className="panel funding-card" aria-label={title}>
    <div className="section-heading"><h2>{title}</h2><span className="pill pill-blue">{net.label}</span></div>
    <p>{fund === "event" ? t("Pays for this event’s waitlist callbacks.", "支付本场活动的候补回调费。") : fund === "watcher" ?
      t("Pays for Lasna execution across all events.", "支付所有活动在 Lasna 上的执行费。") :
      t("The platform pays for the final Base transaction that returns unused ETH.", "平台为退回各场活动剩余 ETH 的最后一笔 Base 回调付费。")}</p>
    {error && <p role="status" className="problem">{error}</p>}
    {!data ? !error && <p role="status">{t("Reading chain balance…", "正在读取链上余额…")}</p> : <>
      <a className="text-action" href={net.explorer + "/address/" + data.address} target="_blank" rel="noreferrer" title={data.address}>
        {shortAddress(data.address)} <ExternalLink size={13} /></a>
      <dl className="funding-balances">
        <div><dt>{event ? t("Event balance", "活动合约余额") : t("Prepaid credit", "预存余额")}</dt><dd>{formatEther(event?.balance ?? data.credit)} {unit}</dd></div>
        <div><dt>{t("Outstanding debt", "待付费用")}</dt><dd>{formatEther(data.debt)} {unit}</dd></div>
        {event?.refunded && <div><dt>{t("Returned to organizer", "已退到主办方指定钱包")}</dt><dd>{formatEther(event.returned)} ETH</dd></div>}
        {event && data.credit > 0n && <div><dt>{t("Non-refundable proxy credit", "代理中的不可退余额")}</dt><dd>{formatEther(data.credit)} ETH</dd></div>}
      </dl>
      {event ? <p>{event.refunded ? t("Unused ETH returned.", "剩余 ETH 已退回。") : event.closing ?
        t("Closing callbacks", "正在结算回调") + " · " + event.delivered + " / " + event.expected :
        t("Unused ETH returns automatically after opening and callback settlement.", "开场且回调结清后，剩余 ETH 自动退回。")}{" "}
        {t("Refund wallet", "退款钱包")} <a className="text-action" href={net.explorer + "/address/" + event.recipient}
          title={event.recipient} target="_blank" rel="noreferrer">{shortAddress(event.recipient)}</a></p> :
        <p>{t("Prepaid network credit is non-refundable.", "网络预存费用不可退回。")}</p>}
      {event?.refunded && <a className="text-action" href={"?event=" + data.address + "#activity"}>{t("View refund in event activity", "查看活动退款记录")}</a>}
      {!event?.refunded && <form className="publish-form" onSubmit={e => {
        e.preventDefault();
        if (!account) { connect(); return; }
        if (error || !value || (event && !owner)) return;
        void run(async () => {
          notify(t("Confirm the top-up on ", "请在钱包中确认充值到 ") + net.label);
          const hash = await fundBudget(fund, source, data, value, account, notify);
          setAmount(""); return hash;
        }, success, chain);
      }}>
        <label>{t("Top-up amount", "充值金额")} ({unit})<input inputMode="decimal" value={amount} placeholder="0.0"
          onChange={e => setAmount(e.target.value)} disabled={busy || Boolean(account && event && !owner)} /></label>
        {amount && !value && <span className="problem">{t("Enter a positive amount with up to 18 decimal places.", "请输入正数，最多 18 位小数。")}</span>}
        <button className="secondary" disabled={busy || Boolean(error) || Boolean(account && (!value || (event && !owner)))}>
          {!account ? t("Connect wallet to fund", "连接钱包充值") : event && !owner ? t("Organizer funding only", "仅限主办方充值") :
            t("Add ", "充值 ") + (value ? formatEther(value) + " " : "") + unit}</button>
      </form>}
      {event?.started && !event.refunded && owner && <details><summary>{t("Refund recovery", "退款恢复")}</summary>
        <div className="publish-form"><label>{t("Alternative refund wallet", "备用退款钱包")}<input value={recipient} onChange={e => setRecipient(e.target.value)} /></label>
          <button className="text-action" disabled={busy || Boolean(error) || !isAddress(recipient) || recipient.toLowerCase() === ZeroAddress}
            onClick={() => recovery(true)}>{t("Update refund wallet", "更新退款钱包")}</button>
          <button className="text-action" disabled={busy || Boolean(error) || !event.retryDue}
            onClick={() => recovery(false)}>{t("Retry refund check", "重试退款检查")}</button></div></details>}
    </>}
  </section>;
}

export function Funding({ source, ...session }: Session & { source: string | null }) {
  const valid = source && isAddress(source);
  return <div className="directory"><div className="directory-title"><a className="text-action" href={valid ? "?event=" + source : "?"}>
    {valid ? t("Back to event", "返回活动") : t("All events", "所有活动")}</a>
    <h1>{t("Automation funding", "自动化运行经费")}</h1></div>
    <div className="funding-grid">{valid ? <FundCard {...session} fund="event" source={source} /> :
      <section className="panel funding-card"><div className="section-heading"><h2>{t("Event callbacks", "本场活动回调")}</h2><Wallet size={20} /></div>
        <form className="publish-form" method="get"><input type="hidden" name="funding" value="" />
          <label>{t("Base event address", "Base 活动地址")}<input name="event" placeholder="0x…" pattern="0x[0-9a-fA-F]{40}" required /></label>
          <button className="secondary">{t("View event balance", "查看活动余额")}</button></form>
        <a className="text-action" href="?">{t("Browse events", "浏览活动")}</a></section>}
      <FundCard {...session} fund="watcher" source={null} /><FundCard {...session} fund="refunds" source={null} />
    </div></div>;
}
