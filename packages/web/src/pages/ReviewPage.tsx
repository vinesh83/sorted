import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useDocuments, useDocument } from '../hooks/useDocuments';
import { api } from '../api/client';
import { DocumentQueue } from '../components/DocumentQueue';
import { DocumentViewer } from '../components/DocumentViewer';
import { ClassificationPanel } from '../components/ClassificationPanel';
import { PARALEGALS, type Document, type ParalegalName } from 'shared/types';

function useServerStatus() {
  const [processingCount, setProcessingCount] = useState(0);
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await api.get<{ processingCount: number }>('/status');
        setProcessingCount(data.processingCount);
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);
  return { processingCount };
}

export function ReviewPage() {
  const { paralegal, selectParalegal, logout } = useAuth();
  const { documents, loading: docsLoading, refresh } = useDocuments(paralegal, 'pending');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { document: selectedDoc, updateField, claim, skip, approve, retryClassify, retryAttach } = useDocument(selectedId);
  const { processingCount } = useServerStatus();

  // Find the processed_file_id for the selected document
  const processedFileId = selectedDoc?.processed_file_id ?? null;
  const mimeType = selectedDoc?.mime_type ?? null;
  const fileName = selectedDoc?.file_name ?? null;

  const handleSelect = useCallback(async (doc: Document) => {
    setSelectedId(doc.id);
    // Claim the document directly (can't use hook's claim since selectedId hasn't updated yet)
    try {
      await api.post(`/documents/${doc.id}/claim`);
    } catch {
      // Ignore claim errors (e.g., already claimed by us)
    }
  }, []);

  const handleSkip = useCallback(async () => {
    await skip();
    setSelectedId(null);
    refresh();
  }, [skip, refresh]);

  const handleApprove = useCallback(async () => {
    const result = await approve();
    refresh();
    return result;
  }, [approve, refresh]);

  const handleNext = useCallback(() => {
    // Find next pending document
    const currentIdx = documents.findIndex((d) => d.id === selectedId);
    const remaining = documents.filter((d) => d.id !== selectedId && d.status === 'pending');
    if (remaining.length > 0) {
      setSelectedId(remaining[0].id);
    } else {
      setSelectedId(null);
    }
    refresh();
  }, [documents, selectedId, refresh]);

  const pendingCount = documents.filter((d) => d.status === 'pending' || d.status === 'unclassified').length;

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <a href="/select" style={styles.logoLink}><h1 style={styles.logo}>Doc Triage</h1></a>
          <select
            value={paralegal || ''}
            onChange={(e) => { setSelectedId(null); selectParalegal(e.target.value as ParalegalName); }}
            style={styles.paralegalSelect}
          >
            {PARALEGALS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <span style={styles.count}>
            {docsLoading && documents.length === 0 ? 'Loading documents...' : `${pendingCount} to review`}
          </span>
          {processingCount > 0 && (
            <span style={styles.processingBadge}>
              <span style={styles.processingDot} />
              New files processing...
            </span>
          )}
        </div>
        <div style={styles.headerRight}>
          <a href="/history" style={styles.link}>History</a>
          <a href="/admin" style={styles.link}>Admin</a>
          <a href="/history?tab=usage" style={styles.link}>API Usage</a>
          <button onClick={logout} style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>
      <div style={styles.body}>
        {/* Left sidebar: queue */}
        <aside style={styles.sidebar}>
          <div style={styles.sidebarHeader}>Document Queue</div>
          <DocumentQueue
            documents={documents}
            selectedId={selectedId}
            onSelect={handleSelect}
            loading={docsLoading}
          />
        </aside>

        {/* Main area: split screen */}
        {selectedDoc ? (
          <div style={styles.splitScreen}>
            {/* Left: Document viewer */}
            <div style={styles.viewerPane}>
              <DocumentViewer
                processedFileId={processedFileId}
                mimeType={mimeType}
                fileName={fileName}
                documentId={selectedId}
              />
            </div>
            {/* Right: Classification panel */}
            <div style={styles.classificationPane}>
              <ClassificationPanel
                document={selectedDoc}
                onUpdate={updateField}
                onApprove={handleApprove}
                onSkip={handleSkip}
                onNext={handleNext}
                onRefreshQueue={refresh}
                onRetryClassify={retryClassify}
                onRetryAttach={retryAttach}
              />
            </div>
          </div>
        ) : (
          <div style={styles.emptyState}>
            {pendingCount > 0 ? (
              <p style={styles.emptyText}>Select a document from the queue</p>
            ) : (
              <>
                <p style={styles.emptyText}>No documents in queue</p>
                <p style={styles.emptySubtext}>
                  New documents will appear here automatically when they arrive in Dropbox
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 20px', background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)', flexShrink: 0,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: '12px' },
  headerRight: { display: 'flex', alignItems: 'center', gap: '12px' },
  logo: { fontSize: '18px', fontWeight: 700, margin: 0 },
  logoLink: { textDecoration: 'none', color: 'inherit' },
  badge: {
    padding: '3px 10px', borderRadius: '999px', background: 'var(--color-primary)',
    color: '#fff', fontSize: '12px', fontWeight: 600,
  },
  paralegalSelect: {
    padding: '4px 8px', borderRadius: '6px', border: '2px solid var(--color-primary)',
    background: 'var(--color-primary)', color: '#fff', fontSize: '13px', fontWeight: 600,
    cursor: 'pointer',
  },
  count: { color: 'var(--color-text-secondary)', fontSize: '13px' },
  processingBadge: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '3px 10px', borderRadius: '999px', background: '#fef3c7',
    color: '#92400e', fontSize: '12px', fontWeight: 500,
  },
  processingDot: {
    width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  link: { color: 'var(--color-primary)', fontSize: '13px', textDecoration: 'none' },
  logoutBtn: {
    background: 'none', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)', padding: '5px 10px', fontSize: '12px',
    color: 'var(--color-text-secondary)',
  },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: {
    width: '280px', flexShrink: 0, display: 'flex', flexDirection: 'column',
    borderRight: '1px solid var(--color-border)', background: 'var(--color-bg)',
  },
  sidebarHeader: {
    padding: '12px', fontSize: '13px', fontWeight: 600,
    color: 'var(--color-text-secondary)', borderBottom: '1px solid var(--color-border)',
  },
  splitScreen: { flex: 1, display: 'flex', overflow: 'hidden' },
  viewerPane: { flex: '1 1 55%', minWidth: 0, overflow: 'hidden' },
  classificationPane: {
    flex: '1 1 45%', minWidth: '340px', maxWidth: '480px',
    borderLeft: '1px solid var(--color-border)', background: 'var(--color-surface)',
    overflow: 'hidden', display: 'flex', flexDirection: 'column',
  },
  emptyState: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
  },
  emptyText: { fontSize: '16px', fontWeight: 600, marginBottom: '4px' },
  emptySubtext: { color: 'var(--color-text-secondary)', fontSize: '13px' },
};
