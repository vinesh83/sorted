import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useDocuments } from '../hooks/useDocuments';
import { UsageDashboard } from '../components/UsageDashboard';
import type { Document } from 'shared/types';

export function HistoryPage() {
  const { paralegal, logout } = useAuth();
  const { documents, loading } = useDocuments(paralegal, 'history');
  const [showUsage, setShowUsage] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('tab') === 'usage';
  });

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <a href="/" style={{ textDecoration: 'none', color: 'inherit' }}><h1 style={styles.logo}>Doc Triage</h1></a>
          <span style={styles.badge}>{paralegal}</span>
        </div>
        <div style={styles.headerRight}>
          <button onClick={() => setShowUsage(!showUsage)} style={styles.linkBtn}>
            {showUsage ? 'History' : 'API Usage'}
          </button>
          <a href="/" style={styles.link}>Queue</a>
          <a href="/admin" style={styles.link}>Admin</a>
          <button onClick={logout} style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>
      <main style={styles.main}>
        {showUsage ? (
          <UsageDashboard />
        ) : (
          <>
            <h2 style={{ marginBottom: '16px', fontSize: '18px' }}>
              History ({documents.length})
            </h2>
            {loading && documents.length === 0 ? (
              <p style={styles.emptyText}>Loading...</p>
            ) : documents.length === 0 ? (
              <p style={styles.emptyText}>No approved or skipped documents yet</p>
            ) : (
              <div style={styles.table}>
                <div style={styles.tableHeader}>
                  <span style={{ flex: 2 }}>Document</span>
                  <span style={{ flex: 1 }}>Event Type</span>
                  <span style={{ flex: 1 }}>Date</span>
                  <span style={{ flex: 1 }}>Status</span>
                  <span style={{ flex: 1 }}>Asana</span>
                </div>
                {documents.map((doc: Document) => (
                  <div key={doc.id} style={styles.tableRow}>
                    <span style={{ flex: 2 }}>
                      <div style={{ fontWeight: 500 }}>
                        {doc.edited_label || doc.document_label || doc.file_name || 'Untitled'}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                        {doc.edited_client_name || doc.client_name || ''}
                      </div>
                    </span>
                    <span style={{ flex: 1, fontSize: '13px' }}>
                      {doc.edited_event_type || doc.event_type || '-'}
                    </span>
                    <span style={{ flex: 1, fontSize: '13px' }}>
                      {doc.approved_at
                        ? new Date(doc.approved_at).toLocaleDateString()
                        : '-'}
                    </span>
                    <span style={{ flex: 1 }}>
                      <span
                        style={{
                          ...styles.statusBadge,
                          background:
                            doc.status === 'approved'
                              ? 'var(--color-success)'
                              : 'var(--color-text-secondary)',
                        }}
                      >
                        {doc.status}
                      </span>
                    </span>
                    <span style={{ flex: 1 }}>
                      {doc.asana_task_url ? (
                        <a
                          href={doc.asana_task_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={styles.link}
                        >
                          View task
                        </a>
                      ) : (
                        <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>-</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 24px',
    background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: '16px' },
  headerRight: { display: 'flex', alignItems: 'center', gap: '16px' },
  logo: { fontSize: '18px', fontWeight: 700 },
  badge: {
    padding: '4px 12px',
    borderRadius: '999px',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: '13px',
    fontWeight: 600,
  },
  link: { color: 'var(--color-primary)', fontSize: '14px', textDecoration: 'none' },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-primary)',
    fontSize: '14px',
    cursor: 'pointer',
    padding: 0,
  },
  logoutBtn: {
    background: 'none',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '6px 12px',
    fontSize: '13px',
    color: 'var(--color-text-secondary)',
  },
  main: { flex: 1, padding: '24px', overflowY: 'auto' },
  emptyText: { color: 'var(--color-text-secondary)' },
  table: { display: 'flex', flexDirection: 'column', gap: '1px', background: 'var(--color-border)' },
  tableHeader: {
    display: 'flex',
    gap: '12px',
    padding: '10px 16px',
    background: 'var(--color-bg)',
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  tableRow: {
    display: 'flex',
    gap: '12px',
    padding: '12px 16px',
    background: 'var(--color-surface)',
    alignItems: 'center',
    fontSize: '14px',
  },
  statusBadge: {
    padding: '2px 8px',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '11px',
    fontWeight: 600,
  },
};
