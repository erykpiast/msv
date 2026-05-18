import { useEffect, useRef } from 'react';

export type SseHandlers = {
  onView: (view: unknown) => void;
  onEvent: (env: unknown) => void;
  onOpen?: () => void;
  onError?: () => void;
};

export function useEventSource(url: string, handlers: SseHandlers): void {
  const ref = useRef<SseHandlers>(handlers);
  ref.current = handlers;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect() {
      es = new EventSource(url);
      es.addEventListener('view', (e) => {
        try { ref.current.onView(JSON.parse((e as MessageEvent).data)); } catch {}
      });
      es.addEventListener('event', (e) => {
        try { ref.current.onEvent(JSON.parse((e as MessageEvent).data)); } catch {}
      });
      es.onopen = () => ref.current.onOpen?.();
      es.onerror = () => {
        ref.current.onError?.();
        es?.close();
        if (!closed) retryTimer = setTimeout(connect, 3_000);
      };
    }

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [url]);
}
