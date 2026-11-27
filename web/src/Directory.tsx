import { useCallback, useState } from "react";
import { CalendarDays, MapPin } from "lucide-react";
import { eventUrl, formatTime, localText, networks, readDirectory, usdc } from "./chain";
import { usePolling } from "./useWorkshop";
import { AppLink } from "./navigation";

export function Directory({ home }: { home: boolean }) {
  const [page, setPage] = useState(0);
  const load = useCallback(() => readDirectory(page), [page]);
  const { data, error } = usePolling(load);
  return <section className="directory"><div className="directory-title">
    <h1>{home ? localText("Latest events", "最近发布的活动") : localText("Events", "活动")}</h1>
    {home && <AppLink className="text-action" href="?events">{localText("All events", "查看全部活动")}</AppLink>}</div>
    {error && <p className="connection-note" role="status">{error}</p>}
    {data?.items.length ? <div className="event-cards">{(home ? data.items.slice(0, 3) : data.items).map(item =>
      <AppLink className="event-card" key={item.source} href={eventUrl(item.source)}>
        <img src={item.cover || "/workshop.jpg"} alt="" referrerPolicy="no-referrer" onError={e => { e.currentTarget.onerror = null; e.currentTarget.src = "/workshop.jpg"; }} />
        <div><span className="pill pill-blue">{localText(`${item.seats} available · ${item.capacity} total`, `可售 ${item.seats} 张 · 共 ${item.capacity} 张`)}</span>
          <h2>{item.name}</h2><p><CalendarDays size={15} />{formatTime(item.start)}</p>
          {item.location && <p><MapPin size={15} />{item.location}</p>}<strong>{usdc(item.price)} USDC / ticket</strong></div>
      </AppLink>)}</div> : !data ? !error && <p className="route-loading" role="status">{localText("Loading events…", "正在加载活动…")}</p> :
      <div className="hero catalog-empty"><img className="poster" src="/workshop.jpg" alt="Orange workshop chair" />
        <div className="hero-copy"><h2>{localText("No published events yet", "还没有已发布的活动")}</h2>
          <p>{networks.base.address ? "Your published events appear here and each has its own share link." : "Browse the publishing form while the testnet factory is being set up."}</p>
          <AppLink className="text-action" href="?publish">{localText("Publish an event", "发布活动")}</AppLink></div></div>}
    {!home && (page > 0 || (data?.count ?? 0) > (page + 1) * 6) && <div className="pager"><button disabled={!page} onClick={() => setPage(page - 1)}>Previous events</button>
      <button disabled={(data?.count ?? 0) <= (page + 1) * 6} onClick={() => setPage(page + 1)}>More events</button></div>}
  </section>;
}
