import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

interface SplitRange {
  pageStart: number;
  pageEnd: number;
  reason?: string;
}

interface SplitData {
  id: number;
  processedFileId: number;
  suggestedSplits: SplitRange[];
  status: string;
  finalSplits: SplitRange[] | null;
}

interface Props {
  processedFileId: number;
  onSplitAccepted: () => void;
}

export function SplitSuggestion({ processedFileId, onSplitAccepted }: Props) {
  const [splits, setSplits] = useState<SplitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ splits: SplitData | null }>(`/splits/${processedFileId}`);
      setSplits(res.splits);
    } catch {
      setSplits(null);
    } finally {
      setLoading(false);
    }
  }, [processedFileId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !splits || splits.status !== 'pending') return null;

  const handleAccept = async () => {
    setProcessing(true);
    setError(null);
    try {
      await api.post(`/splits/${processedFileId}/accept`);
      onSplitAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process splits');
    } finally {
      setProcessing(false);
    }
  };

  const handleReject = async () => {
    setProcessing(true);
    try {
      await api.post(`/splits/${processedFileId}/reject`);
      setSplits({ ...splits, status: 'rejected' });
    } catch {
      // ignore
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.icon}>&#x2702;</span>
        <strong>Multiple documents detected</strong>
      </div>
      <p style={styles.description}>
        AI detected {splits.suggestedSplits.length} separate documents in this file.
        Accept to split and classify each individually.
      </p>
      <div style={styles.splitList}>
        {splits.suggestedSplits.map((s, i) => (
          <div key={i} style={styles.splitItem}>
            <span style={styles.pages}>Pages {s.pageStart}–{s.pageEnd}</span>
            {s.reason && <span style={styles.reason}>{s.reason}</span>}
          </div>
        ))}
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.actions}>
        <button onClick={handleReject} disabled={processing} style={styles.rejectBtn}>
          Keep as one
        </button>
        <button onClick={handleAccept} disabled={processing} style={styles.acceptBtn}>
          {processing ? 'Splitting...' : 'Split & Classify'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#eff6ff',
    border: '1px solid #bfdbfe',
    borderRadius: '8px',
    padding: '12px',
    fontSize: '13px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '6px',
    fontSize: '14px',
  },
  icon: { fontSize: '16px' },
  description: {
    color: 'var(--color-text-secondary)',
    marginBottom: '8px',
  },
  splitList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '10px',
  },
  splitItem: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 8px',
    background: '#fff',
    borderRadius: '4px',
    border: '1px solid #e2e8f0',
  },
  pages: { fontWeight: 500 },
  reason: { color: 'var(--color-text-secondary)', fontSize: '12px' },
  error: { color: 'var(--color-error)', fontSize: '12px', marginBottom: '8px' },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
  rejectBtn: {
    padding: '6px 12px',
    borderRadius: '6px',
    border: '1px solid var(--color-border)',
    background: '#fff',
    fontSize: '13px',
    cursor: 'pointer',
  },
  acceptBtn: {
    padding: '6px 12px',
    borderRadius: '6px',
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
  },
};
