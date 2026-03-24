import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// useOrders — place, list, cancel orders
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function useOrders() {
  const { authFetch } = useAuth();
  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const fetchOrders = useCallback(async (params = {}) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams(params).toString();
      const res = await authFetch(`/api/orders${qs ? `?${qs}` : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setOrders(data.orders);
      return data;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { fetchOrders(); }, []);

  const placeOrder = useCallback(async (orderPayload) => {
    setError(null);
    const res = await authFetch('/api/orders/place', {
      method: 'POST',
      body: JSON.stringify(orderPayload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Order failed');
    setOrders(prev => [data.order, ...prev]);
    return data.order;
  }, [authFetch]);

  const cancelOrder = useCallback(async (orderId) => {
    const res = await authFetch(`/api/orders/${orderId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: 'CANCELLED' } : o));
    return data;
  }, [authFetch]);

  const modifyOrder = useCallback(async (orderId, changes) => {
    const res = await authFetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      body: JSON.stringify(changes),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setOrders(prev => prev.map(o => o.id === orderId ? data : o));
    return data;
  }, [authFetch]);

  return { orders, loading, error, fetchOrders, placeOrder, cancelOrder, modifyOrder };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// usePortfolio — holdings, positions, funds, mutual funds, P&L
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function usePortfolio() {
  const { authFetch } = useAuth();
  const [holdings,     setHoldings]     = useState(null);
  const [positions,    setPositions]    = useState(null);
  const [funds,        setFunds]        = useState(null);
  const [mutualFunds,  setMutualFunds]  = useState(null);
  const [pnl,          setPnl]          = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [h, pos, f, mf, p] = await Promise.all([
        authFetch('/api/portfolio/holdings').then(r => r.json()),
        authFetch('/api/portfolio/positions').then(r => r.json()),
        authFetch('/api/portfolio/funds').then(r => r.json()),
        authFetch('/api/portfolio/mutual-funds').then(r => r.json()),
        authFetch('/api/portfolio/pnl?period=today').then(r => r.json()),
      ]);
      setHoldings(h);
      setPositions(pos);
      setFunds(f);
      setMutualFunds(mf);
      setPnl(p);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { fetchAll(); }, []);

  return { holdings, positions, funds, mutualFunds, pnl, loading, error, refresh: fetchAll };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// useQuote — fetch LTP for a single instrument (REST fallback)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function useQuote(instrumentKey) {
  const { authFetch } = useAuth();
  const [quote,   setQuote]   = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!instrumentKey) return;
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/market/quote/${encodeURIComponent(instrumentKey)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { setQuote(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [instrumentKey]);

  return { quote, loading };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// useOHLC — fetch historical candles
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function useOHLC(instrumentKey, interval = '1day', from, to) {
  const { authFetch } = useAuth();
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!instrumentKey || !from || !to) return;
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ interval, from, to }).toString();
    authFetch(`/api/market/ohlc/${encodeURIComponent(instrumentKey)}?${qs}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { setCandles(d.candles || []); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [instrumentKey, interval, from, to]);

  return { candles, loading };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// useSearch — debounced instrument search
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function useSearch() {
  const { authFetch } = useAuth();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  const search = useCallback((query) => {
    clearTimeout(timerRef.current);
    if (!query || query.length < 2) { setResults([]); return; }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await authFetch(`/api/market/search?q=${encodeURIComponent(query)}`);
        setResults(await res.json());
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [authFetch]);

  return { results, loading, search };
}

// ── need useRef in useSearch ──
import { useRef } from 'react';
