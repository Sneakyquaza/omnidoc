import { useEffect, useState } from "react";
import { commands } from "../ipc/bindings";
import type { HandlerInfo } from "../ipc/bindings";

let cache: Promise<HandlerInfo[]> | null = null;

/** Liste des handlers (mise en cache, elle ne change pas pendant la session). */
export function getHandlers(): Promise<HandlerInfo[]> {
  cache ??= commands.listHandlers().catch((e: unknown) => {
    cache = null;
    throw e;
  });
  return cache;
}

export function useHandlers(): HandlerInfo[] {
  const [handlers, setHandlers] = useState<HandlerInfo[]>([]);
  useEffect(() => {
    let alive = true;
    getHandlers()
      .then((h) => alive && setHandlers(h))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return handlers;
}
