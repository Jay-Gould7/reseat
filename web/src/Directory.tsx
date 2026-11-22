import { useCallback, useState } from "react";
import { CalendarDays, MapPin } from "lucide-react";
import { eventUrl, formatTime, localText, networks, readDirectory, usdc } from "./chain";
import { usePolling } from "./useWorkshop";

export function Directory() {
  const [page, setPage] = useState(0);
  const load = useCallback(() => readDirectory(page), [page]);
  const { data, error } = usePolling(load);
  return <section className="directory"><div className="directory-title"><h1>{localText("Events", "活动")}</h1>
    <p>Find a seat or join the waitlist for your group.</p></div>
    {error && <p className="connection-note" role="status">{error}</p>}
    {data?.items.length ? <div className="event-cards">{data.items.map(item =>
      <a className="event-card" key={item.source} href={eventUrl(item.source)}>
        <img src={item.cover || "/workshop.jpg"} alt="" referrerPolicy="no-referrer" onError={e => { e.currentTarget.onerror = null; e.currentTarget.src = "/workshop.jpg"; }} />
        <div><span className="pill pill-blue">{item.seats ? item.seats + " available" : "Public sales closed"}</span>
          <h2>{item.name}</h2><p><CalendarDays size={15} />{formatTime(item.date)}</p>
          {item.location && <p><MapPin size={15} />{item.location}</p>}<strong>{usdc(item.price)} USDC / ticket</strong></div>
      </a>)}</div> : <div className="hero catalog-empty"><img className="poster" src="/workshop.jpg" alt="Orange workshop chair" />
        <div className="hero-copy"><h2>{!data && !error ? "Reading events…" : "No published events yet"}</h2>
          <p>{networks.base.address ? "Your published events appear here and each has its own share link." : "Browse the publishing form while the testnet factory is being set up."}</p>
          <a className="text-action" href="?publish">{localText("Publish an event", "发布活动")}</a></div></div>}
    {(page > 0 || (data?.count ?? 0) > (page + 1) * 6) && <div className="pager"><button disabled={!page} onClick={() => setPage(page - 1)}>Previous events</button>
      <button disabled={(data?.count ?? 0) <= (page + 1) * 6} onClick={() => setPage(page + 1)}>More events</button></div>}
  </section>;
}
