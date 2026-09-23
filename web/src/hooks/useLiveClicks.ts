import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ClickEvent } from '../api/types';

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to the per-link Server-Sent Events stream. Calls `onClick` for every
 * `click` event; EventSource reconnects on its own, we only surface the state.
 */
export function useLiveClicks(linkId: string | undefined, onClick: (e: ClickEvent) => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const cb = useRef(onClick);
  cb.current = onClick;

  useEffect(() => {
    if (!linkId || typeof EventSource === 'undefined') {
      setState('offline');
      return;
    }
    setState('connecting');
    const es = new EventSource(api.eventsUrl(linkId), { withCredentials: true });
    es.onopen = () => setState('live');
    es.onerror = () => setState(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    const handler = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as ClickEvent;
        if (data.linkId === linkId) cb.current(data);
      } catch {
        /* ignore malformed frames */
      }
    };
    es.addEventListener('click', handler as EventListener);
    return () => {
      es.removeEventListener('click', handler as EventListener);
      es.close();
    };
  }, [linkId]);

  return state;
}
