import { useSyncExternalStore, type ComponentPropsWithoutRef } from "react";

const change = "reseat:navigate";
function subscribe(refresh: () => void) {
  window.addEventListener(change, refresh);
  window.addEventListener("popstate", refresh);
  return () => {
    window.removeEventListener(change, refresh);
    window.removeEventListener("popstate", refresh);
  };
}
export function useSearch() {
  return useSyncExternalStore(subscribe, () => window.location.search);
}

export function navigate(href: string) {
  const url = new URL(href, window.location.href);
  if (url.href === window.location.href) return;
  window.history.pushState(null, "", url.href);
  window.dispatchEvent(new Event(change));
  window.scrollTo({ top: 0, behavior: "instant" });
  document.getElementById("main")?.focus({ preventScroll: true });
}

export function AppLink({ href, onClick, ...props }: ComponentPropsWithoutRef<"a"> & { href: string }) {
  return <a {...props} href={href} onClick={e => {
    onClick?.(e);
    const link = e.currentTarget;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey ||
      (link.target && link.target !== "_self") || link.hasAttribute("download") || link.hash ||
      link.origin !== window.location.origin || link.pathname !== window.location.pathname) return;
    e.preventDefault();
    navigate(link.href);
  }} />;
}
