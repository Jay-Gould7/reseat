import { useCallback, useEffect, useMemo, useState } from "react";
import { networks, readBase, readLasna, type Chain } from "./chain";
import { createLedger, type Entry } from "./ledger";

export const signalConfirmation = () => window.dispatchEvent(new Event("reseat:confirmed"));

function message(error: unknown) {
  if (error instanceof Error && error.message.length < 150) return error.message;
  return "The public RPC is unavailable. Retrying automatically.";
}

function usePolling<T>(load: (stale: () => boolean) => Promise<T>) {
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

function useHistory(chain: Chain) {
  const index = useMemo(() => createLedger(chain), [chain]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const read = useCallback(async (stale: () => boolean) => {
    await index(rows => { if (!stale()) setEntries(rows); }, stale);
    return true;
  }, [index]);
  const { data, error } = usePolling(read);
  return { entries, error, syncing: Boolean(networks[chain].address && !data && !error) };
}

export function useWorkshop(account: string) {
  const loadBase = useCallback(() => readBase(account), [account]);
  const base = usePolling(loadBase);
  const lasna = usePolling(readLasna);
  const baseHistory = useHistory("base");
  const lasnaHistory = useHistory("lasna");
  return { base, lasna, baseHistory, lasnaHistory };
}
