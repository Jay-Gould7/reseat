import { useCallback, useState } from "react";
import { formatEther, isAddress } from "ethers";
import { ExternalLink, Wallet } from "lucide-react";
import { localText as t, networks, shortAddress } from "./chain";
import { fundBudget, fundChain, nativeAmount, readFunding, type Fund } from "./feeBudget";
import { usePolling } from "./useWorkshop";
import { AppLink, navigate } from "./navigation";
import type { Session } from "./App";

function FundCard({ fund, source, account, busy, connect, run, notify, getSigner }: Session & { fund: Fund; source: string | null }) {
  const chain = fundChain(fund), net = networks[chain], unit = chain === "base" ? "ETH" : "lREACT";
  const load = useCallback(() => readFunding(fund, source), [fund, source]);
  const { data, error } = usePolling(load);
  const [amount, setAmount] = useState("");
  const value = nativeAmount(amount);
  const title = fund === "event" ? t("Event callbacks", "本场活动回调") : fund === "relay" ? t("Lasna relay wallet", "Lasna 转发钱包") : t("Platform watcher", "平台自动候补");
  const success = t("Funding confirmed.", "充值已确认。");
  return <section className="panel funding-card" aria-label={title}>
    <div className="section-heading"><h2>{title}</h2><span className="pill pill-blue">{net.label}</span></div>
    <p>{fund === "event" ? t("Pays for automatic seating and, on sponsorship-enabled events, for guests to join or cancel.", "用于自动补票；支持代付的活动也从这里支付来宾加入和取消候补的手续费。") :
      fund === "relay" ? t("Pays the Lasna gas to submit signed waitlist requests.", "支付向 Lasna 提交候补签名请求的手续费。") :
      t("Pays for Lasna execution across all events.", "支付所有活动在 Lasna 上的执行费。")}</p>
    {error && <p role="status" className="problem">{error}</p>}
    {!data ? !error && <p role="status">{t("Reading chain balance…", "正在读取链上余额…")}</p> : <>
      <a className="text-action" href={net.explorer + "/address/" + data.address} target="_blank" rel="noreferrer" title={data.address}>
        {shortAddress(data.address)} <ExternalLink size={13} /></a>
      <dl className="funding-balances">
        <div><dt>{fund === "relay" ? t("Wallet balance", "钱包余额") : t("Prepaid credit", "预存余额")}</dt><dd>{formatEther(data.credit)} {unit}</dd></div>
        {fund !== "relay" && <div><dt>{t("Outstanding debt", "待付费用")}</dt><dd>{formatEther(data.debt)} {unit}</dd></div>}
      </dl>
      {fund !== "relay" && <p>{t("Prepaid network credit is non-refundable.", "网络预存费用不可退回。")}</p>}
      <form className="publish-form" onSubmit={e => {
        e.preventDefault();
        if (!account) { connect(); return; }
        if (error || !value) return;
        void run(async () => {
          notify(t("Confirm the top-up on ", "请在钱包中确认充值到 ") + net.label);
          const hash = await fundBudget(fund, source, data, value, getSigner, notify);
          setAmount(""); return hash;
        }, success, chain);
      }}>
        <label>{t("Top-up amount", "充值金额")} ({unit})<input inputMode="decimal" value={amount} placeholder="0.0"
          onChange={e => setAmount(e.target.value)} disabled={busy} /></label>
        {amount && !value && <span className="problem">{t("Enter a positive amount with up to 18 decimal places.", "请输入正数，最多 18 位小数。")}</span>}
        <button className="secondary" disabled={busy || Boolean(error) || Boolean(account && !value)}>
          {!account ? t("Connect wallet to fund", "连接钱包充值") :
            t("Add ", "充值 ") + (value ? formatEther(value) + " " : "") + unit}</button>
      </form>
    </>}
  </section>;
}

export function Funding({ source, ...session }: Session & { source: string | null }) {
  const valid = source && isAddress(source);
  return <div className="directory"><div className="directory-title"><AppLink className="text-action" href={valid ? "?event=" + source : "?events"}>
    {valid ? t("Back to event", "返回活动") : t("All events", "所有活动")}</AppLink>
    <h1>{t("Automation funding", "自动化运行经费")}</h1></div>
    <div className="funding-grid">{valid ? <FundCard {...session} fund="event" source={source} /> :
      <section className="panel funding-card"><div className="section-heading"><h2>{t("Event callbacks", "本场活动回调")}</h2><Wallet size={20} /></div>
        <form className="publish-form" method="get" onSubmit={e => {
          e.preventDefault();
          const event = String(new FormData(e.currentTarget).get("event") || "").trim();
          if (isAddress(event)) navigate("?funding&event=" + event);
          else {
            const field = e.currentTarget.elements.namedItem("event") as HTMLInputElement;
            field.setCustomValidity(t("Check the event address.", "请核对活动合约地址。"));
            field.reportValidity();
          }
        }}><input type="hidden" name="funding" value="" />
          <label>{t("Base event address", "Base 活动地址")}<input name="event" placeholder="0x…" pattern="0x[0-9a-fA-F]{40}" required
            onInput={e => e.currentTarget.setCustomValidity("")} /></label>
          <button className="secondary">{t("View event balance", "查看活动余额")}</button></form>
        <AppLink className="text-action" href="?events">{t("Browse events", "浏览活动")}</AppLink></section>}
      <FundCard {...session} fund="watcher" source={valid ? source : null} />
      <FundCard {...session} fund="relay" source={valid ? source : null} />
    </div></div>;
}
