import { useCallback, useEffect, useMemo, useState } from "react";
import { networks, readBase, readLasna, type Chain, type TicketCursor } from "./chain";
import { createLedger } from "./ledger";

export const signalConfirmation = () => window.dispatchEvent(new Event("reseat:confirmed"));

function message(error: unknown) {
  if (error instanceof Error && error.message.length < 150) return error.message;
  return "The public RPC is unavailable. Retrying automatically.";
}

export function usePolling<T>(load: (stale: () => boolean) => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false, running = false, pending = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      clearTimeout(timer);
      if (running) { pending = true; return; }
      running = true;
      try {
        const value = await load(() => stopped);
        if (!stopped) { setData(value); setError(""); }
      } catch (reason) {
        if (!stopped) setError(message(reason));
      } finally {
        running = false;
        if (!stopped) {
          timer = setTimeout(tick, pending ? 0 : 8000);
          pending = false;
        }
      }
    }
    void tick();
    window.addEventListener("reseat:confirmed", tick);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener("reseat:confirmed", tick); };
  }, [load]);
  return { data, error };
}

function useHistory(chain: Chain, source: string) {
  const index = useMemo(() => createLedger(chain, source), [chain, source]);
  const [syncing, setSyncing] = useState(false);
  const read = useCallback(async (stale: () => boolean) => {
    const rows = await index(() => { if (!stale()) setSyncing(true); }, stale);
    if (!stale()) setSyncing(false);
    return rows;
  }, [index]);
  const { data, error } = usePolling(read);
  return { entries: data ?? [], error, syncing: Boolean(networks[chain].address && !error && (syncing || !data)) };
}

export function useWorkshop(source: string, account: string, cursor: TicketCursor) {
  const loadBase = useCallback(() => readBase(source, account, cursor), [source, account, cursor]);
  const base = usePolling(loadBase);
  const loadLasna = useCallback(() => readLasna(source), [source]);
  const lasna = usePolling(loadLasna);
  const baseHistory = useHistory("base", source);
  const lasnaHistory = useHistory("lasna", source);
  return { base, lasna, baseHistory, lasnaHistory };
}
