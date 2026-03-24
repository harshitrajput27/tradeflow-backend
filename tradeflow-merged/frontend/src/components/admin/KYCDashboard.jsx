import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';

const STATUS_COLORS = {
  pending:  { bg: '#FAEEDA', color: '#854F0B' },
  verified: { bg: '#E1F5EE', color: '#0F6E56' },
  rejected: { bg: '#FCEBEB', color: '#A32D2D' },
};

export default function KYCDashboard() {
  const { authFetch } = useAuth();
  const [tab,     setTab]     = useState('pending');
  const [users,   setUsers]   = useState([]);
  const [stats,   setStats]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null); // userId for detail panel
  const [reviewNote, setReviewNote] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const LIMIT = 20;

  const fetchStats = useCallback(async () => {
    const res = await authFetch('/api/admin/stats');
    if (res.ok) setStats((await res.json()).kyc);
  }, [authFetch]);

  const fetchUsers = useCallback(async (status, p = 1) => {
    setLoading(true);
    const res = await authFetch(`/api/admin/kyc?status=${status}&page=${p}&limit=${LIMIT}`);
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users);
      setTotal(data.total);
    }
    setLoading(false);
  }, [authFetch]);

  useEffect(() => { fetchStats(); }, []);
  useEffect(() => { fetchUsers(tab, 1); setPage(1); setSelected(null); }, [tab]);

  const handleReview = async (userId, action) => {
    const res = await authFetch(`/api/admin/kyc/${userId}/review`, {
      method: 'POST',
      body: JSON.stringify({ action, reason: reviewNote }),
    });
    if (res.ok) {
      setUsers(prev => prev.filter(u => u.id !== userId));
      setSelected(null);
      setReviewNote('');
      fetchStats();
    }
  };

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>KYC Management</h1>
          <p style={styles.subtitle}>Review and approve user identity documents</p>
        </div>
      </div>

      {/* Stat cards */}
      {stats && (
        <div style={styles.statsRow}>
          {[
            { label: 'Pending review', value: stats.pending,  color: '#854F0B', bg: '#FAEEDA' },
            { label: 'Verified',       value: stats.verified, color: '#0F6E56', bg: '#E1F5EE' },
            { label: 'Rejected',       value: stats.rejected, color: '#A32D2D', bg: '#FCEBEB' },
          ].map(s => (
            <div key={s.label} style={{ ...styles.statCard, background: s.bg }}>
              <div style={{ fontSize: 24, fontWeight: 600, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 12, color: s.color, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={styles.tabs}>
        {['pending', 'verified', 'rejected'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...styles.tab,
            ...(tab === t ? styles.tabActive : {}),
          }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div style={styles.content}>
        {/* User list */}
        <div style={styles.list}>
          {loading && <p style={styles.empty}>Loading…</p>}
          {!loading && users.length === 0 && <p style={styles.empty}>No {tab} KYC requests.</p>}
          {users.map(user => (
            <div key={user.id}
              onClick={() => setSelected(user.id === selected ? null : user.id)}
              style={{ ...styles.userRow, ...(selected === user.id ? styles.userRowActive : {}) }}
            >
              <div style={styles.avatar}>
                {(user.full_name || user.email).slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.userName}>{user.full_name}</div>
                <div style={styles.userEmail}>{user.email}</div>
              </div>
              <div>
                <span style={{ ...styles.badge, ...STATUS_COLORS[user.kyc_status] }}>
                  {user.kyc_status}
                </span>
                <div style={styles.docCount}>{user.doc_count} docs</div>
              </div>
            </div>
          ))}

          {/* Pagination */}
          {total > LIMIT && (
            <div style={styles.pagination}>
              <button disabled={page === 1} onClick={() => { setPage(p => p-1); fetchUsers(tab, page-1); }} style={styles.pageBtn}>← Prev</button>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{page} / {Math.ceil(total/LIMIT)}</span>
              <button disabled={page * LIMIT >= total} onClick={() => { setPage(p => p+1); fetchUsers(tab, page+1); }} style={styles.pageBtn}>Next →</button>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <KYCDetailPanel
            userId={selected}
            authFetch={authFetch}
            tab={tab}
            reviewNote={reviewNote}
            onNoteChange={setReviewNote}
            onReview={handleReview}
          />
        )}
      </div>
    </div>
  );
}

function KYCDetailPanel({ userId, authFetch, tab, reviewNote, onNoteChange, onReview }) {
  const [detail, setDetail] = useState(null);
  const [docs,   setDocs]   = useState([]);

  useEffect(() => {
    authFetch(`/api/admin/users/${userId}`).then(r => r.json()).then(setDetail);
    authFetch(`/api/admin/kyc/${userId}/documents`).then(r => r.json()).then(setDocs);
  }, [userId]);

  if (!detail) return <div style={styles.detailPanel}><p style={styles.empty}>Loading…</p></div>;
  const { user } = detail;

  return (
    <div style={styles.detailPanel}>
      <div style={styles.detailHeader}>
        <div style={styles.avatar}>{(user.full_name || user.email).slice(0,2).toUpperCase()}</div>
        <div>
          <div style={styles.userName}>{user.full_name}</div>
          <div style={styles.userEmail}>{user.email} · {user.phone || 'no phone'}</div>
        </div>
      </div>

      <div style={styles.infoGrid}>
        <div style={styles.infoItem}><div style={styles.infoLabel}>KYC Status</div><span style={{ ...styles.badge, ...STATUS_COLORS[user.kyc_status] }}>{user.kyc_status}</span></div>
        <div style={styles.infoItem}><div style={styles.infoLabel}>Joined</div><div style={styles.infoVal}>{new Date(user.created_at).toLocaleDateString('en-IN')}</div></div>
        <div style={styles.infoItem}><div style={styles.infoLabel}>Available funds</div><div style={styles.infoVal}>₹{Number(user.available_cash || 0).toLocaleString('en-IN')}</div></div>
        <div style={styles.infoItem}><div style={styles.infoLabel}>Total orders</div><div style={styles.infoVal}>{detail.order_summary?.reduce((s, o) => s + Number(o.count), 0) || 0}</div></div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Documents ({docs.length})</div>
        {docs.length === 0 && <p style={styles.empty}>No documents uploaded</p>}
        {docs.map(doc => (
          <div key={doc.id} style={styles.docRow}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', textTransform: 'uppercase' }}>{doc.doc_type}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{new Date(doc.created_at).toLocaleString('en-IN')}</div>
            </div>
            <span style={{ ...styles.badge, ...STATUS_COLORS[doc.status] || STATUS_COLORS.pending }}>{doc.status}</span>
          </div>
        ))}
      </div>

      {tab === 'pending' && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Review</div>
          <textarea
            value={reviewNote}
            onChange={e => onNoteChange(e.target.value)}
            placeholder="Optional note (shown to user if rejected)"
            style={styles.textarea}
            rows={3}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <button onClick={() => onReview(userId, 'approved')} style={styles.approveBtn}>
              Approve KYC
            </button>
            <button onClick={() => onReview(userId, 'rejected')} style={styles.rejectBtn}>
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page:        { padding: '24px', background: 'var(--color-background-tertiary)', minHeight: '100vh' },
  header:      { marginBottom: 20 },
  title:       { fontSize: 20, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 },
  subtitle:    { fontSize: 13, color: 'var(--color-text-tertiary)', marginTop: 4 },
  statsRow:    { display: 'flex', gap: 12, marginBottom: 20 },
  statCard:    { flex: 1, borderRadius: 8, padding: '16px 20px' },
  tabs:        { display: 'flex', gap: 4, marginBottom: 16 },
  tab:         { padding: '7px 18px', borderRadius: 8, border: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-primary)', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13 },
  tabActive:   { background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontWeight: 500 },
  content:     { display: 'flex', gap: 16, alignItems: 'flex-start' },
  list:        { flex: 1, background: 'var(--color-background-primary)', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)', overflow: 'hidden' },
  userRow:     { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '0.5px solid var(--color-border-tertiary)', cursor: 'pointer', transition: 'background .1s' },
  userRowActive: { background: 'var(--color-background-secondary)' },
  avatar:      { width: 36, height: 36, borderRadius: '50%', background: '#E6F1FB', color: '#185FA5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 },
  userName:    { fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' },
  userEmail:   { fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 },
  badge:       { fontSize: 11, padding: '3px 9px', borderRadius: 99, fontWeight: 500, display: 'inline-block' },
  docCount:    { fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'right', marginTop: 4 },
  empty:       { padding: '24px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 },
  pagination:  { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '12px' },
  pageBtn:     { fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-primary)', cursor: 'pointer', color: 'var(--color-text-primary)' },
  detailPanel: { width: 360, flexShrink: 0, background: 'var(--color-background-primary)', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)', padding: '20px' },
  detailHeader: { display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' },
  infoGrid:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 },
  infoItem:    { background: 'var(--color-background-secondary)', borderRadius: 6, padding: '10px 12px' },
  infoLabel:   { fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 },
  infoVal:     { fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' },
  section:     { borderTop: '0.5px solid var(--color-border-tertiary)', paddingTop: 14, marginTop: 14 },
  sectionTitle: { fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 },
  docRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '0.5px solid var(--color-border-tertiary)' },
  textarea:    { width: '100%', padding: '8px 10px', borderRadius: 6, border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-primary)', color: 'var(--color-text-primary)', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' },
  approveBtn:  { flex: 1, padding: '9px', borderRadius: 6, background: '#0F6E56', color: '#fff', border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer' },
  rejectBtn:   { flex: 1, padding: '9px', borderRadius: 6, background: '#FCEBEB', color: '#A32D2D', border: '0.5px solid #F09595', fontSize: 13, fontWeight: 500, cursor: 'pointer' },
};
