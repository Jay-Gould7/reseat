import { useCallback, useEffect, useMemo, useState } from "react";
import { cachedPreview, networks, readBase, readLasna, type Chain, type TicketCursor } from "./chain";
import { createLedger, type Entry } from "./ledger";
import { createQueueReader, type QueueSnapshot } from "./orders";
const emptyEntries: Entry[] = [];

export const signalConfirmation = () => window.dispatchEvent(new Event("reseat:confirmed"));

function message(error: unknown) {
  if (error instanceof Error && error.message.length < 150) return error.message;
  return "The public RPC is unavailable. Retrying automatically.";
}

export function usePolling<T>(load: (stale: () => boolean, partial: (data: T) => void) => Promise<T>) {
  const [snapshot, setSnapshot] = useState<{ load: typeof load; data?: T; error: string }>();
  useEffect(() => {
    let stopped = false, running = false, pending = false, hasResult = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      clearTimeout(timer);
      if (running) { pending = true; return; }
      running = true;
      try {
        const value = await load(() => stopped, data => {
          if (!stopped && !hasResult) setSnapshot({ load, data, error: "" });
        });
        hasResult = true;
        if (!stopped) setSnapshot({ load, data: value, error: "" });
      } catch (reason) {
        if (!stopped) setSnapshot(prev => ({ load, data: prev?.load === load ? prev.data : undefined, error: message(reason) }));
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
  return snapshot?.load === load ? snapshot : { data: undefined, error: "" };
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
  return { entries: data?.entries ?? emptyEntries, through: data?.through ?? -1, error, syncing: Boolean(networks[chain].address && !error && (syncing || !data)) };
}

export function useWorkshop(source: string, account: string, cursor: TicketCursor) {
  const [preview, setPreview] = useState(() => cachedPreview(source));
  const loadBase = useCallback((stale: () => boolean) => readBase(source, account, cursor, value => {
    if (!stale()) setPreview(value);
  }), [source, account, cursor]);
  const base = usePolling(loadBase);
  const verified = base.data?.event.binding.source ?? (preview ? source : undefined);
  const loadQueue = useMemo(() => verified ? createQueueReader(verified) : async () => undefined, [verified]);
  const queue = usePolling<QueueSnapshot | undefined>(loadQueue);
  const loadLasna = useCallback(() => readLasna(source), [source]);
  const lasna = usePolling(loadLasna);
  const baseHistory = useHistory("base", source);
  const lasnaHistory = useHistory("lasna", source);
  return { base, preview, lasna, queue, baseHistory, lasnaHistory };
}
