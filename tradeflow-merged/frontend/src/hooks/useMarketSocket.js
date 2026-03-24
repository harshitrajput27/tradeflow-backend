import { useEffect, useRef, useCallback, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || 'http://localhost:3000';

// Singleton socket — shared across all hook instances
let socketInstance = null;
const subscribers = new Map(); // instrumentKey → Set of callbacks

function getSocket(token) {
  if (socketInstance?.connected) return socketInstance;

  socketInstance = io(GATEWAY_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socketInstance.on('connect', () => {
    console.log('[WS] Connected');
    // Re-subscribe all active instruments on reconnect
    const keys = [...subscribers.keys()];
    if (keys.length) socketInstance.emit('subscribe', keys);
  });

  socketInstance.on('tick', (tick) => {
    const cbs = subscribers.get(tick.instrument_key);
    if (cbs) cbs.forEach(cb => cb(tick));
  });

  socketInstance.on('disconnect', (reason) => console.warn('[WS] Disconnected:', reason));
  socketInstance.on('connect_error', (err) => console.error('[WS] Error:', err.message));

  return socketInstance;
}

/**
 * useMarketSocket — subscribe to live ticks for one or many instruments.
 *
 * @param {string|string[]} instrumentKeys  Upstox instrument keys to subscribe to
 * @returns {{ ticks: Record<string, object>, connected: boolean }}
 *
 * @example
 * const { ticks } = useMarketSocket(['NSE_EQ|INE002A01018', 'NSE_INDEX|Nifty 50']);
 * // ticks['NSE_EQ|INE002A01018'] → { ltp, volume, bid, ask, ... }
 */
export function useMarketSocket(instrumentKeys = []) {
  const { accessToken } = useAuth();
  const keys = Array.isArray(instrumentKeys) ? instrumentKeys : [instrumentKeys];
  const [ticks, setTicks] = useState({});
  const [connected, setConnected] = useState(false);
  const callbackRefs = useRef(new Map()); // key → callback ref

  useEffect(() => {
    if (!accessToken || keys.length === 0) return;
    const socket = getSocket(accessToken);

    setConnected(socket.connected);
    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    // Register per-instrument callbacks
    keys.forEach(key => {
      const cb = (tick) => {
        setTicks(prev => ({ ...prev, [key]: tick }));
      };
      callbackRefs.current.set(key, cb);

      if (!subscribers.has(key)) subscribers.set(key, new Set());
      subscribers.get(key).add(cb);
    });

    // Subscribe on server side
    socket.emit('subscribe', keys);

    return () => {
      // Cleanup: unregister callbacks; unsubscribe if no other listeners
      keys.forEach(key => {
        const cb = callbackRefs.current.get(key);
        if (cb) {
          subscribers.get(key)?.delete(cb);
          if (subscribers.get(key)?.size === 0) {
            subscribers.delete(key);
            socket.emit('unsubscribe', [key]);
          }
        }
      });
      callbackRefs.current.clear();
    };
  }, [accessToken, keys.join(',')]);

  return { ticks, connected };
}

/**
 * useSingleTick — convenience hook for a single instrument.
 *
 * @param {string} instrumentKey
 * @returns {{ tick: object|null, connected: boolean }}
 *
 * @example
 * const { tick } = useSingleTick('NSE_EQ|INE002A01018');
 * // tick → { ltp: 2941.50, volume: 1234567, change_pct: 1.23, ... }
 */
export function useSingleTick(instrumentKey) {
  const { ticks, connected } = useMarketSocket(instrumentKey ? [instrumentKey] : []);
  return { tick: instrumentKey ? ticks[instrumentKey] || null : null, connected };
}

/**
 * useWatchlistTicks — subscribe to an entire watchlist at once.
 *
 * @param {Array<{instrument_key: string}>} watchlist
 * @returns {{ ticks: Record<string, object>, connected: boolean }}
 */
export function useWatchlistTicks(watchlist = []) {
  const keys = watchlist.map(w => w.instrument_key).filter(Boolean);
  return useMarketSocket(keys);
}

/**
 * useIndexTicks — always subscribed to the three main indices.
 */
export function useIndexTicks() {
  const INDICES = ['NSE_INDEX|Nifty 50', 'BSE_INDEX|SENSEX', 'NSE_INDEX|Nifty Bank'];
  const { ticks, connected } = useMarketSocket(INDICES);
  return {
    nifty50:   ticks['NSE_INDEX|Nifty 50']   || null,
    sensex:    ticks['BSE_INDEX|SENSEX']      || null,
    bankNifty: ticks['NSE_INDEX|Nifty Bank']  || null,
    connected,
  };
}
