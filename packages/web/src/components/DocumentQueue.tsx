import { useState } from 'react';
import type { Document } from 'shared/types';

type SortOrder = 'oldest' | 'newest';

interface Props {
  documents: Document[];
  selectedId: number | null;
  onSelect: (doc: Document) => void;
}

export function DocumentQueue({ documents, selectedId, onSelect }: Props) {
  const [sortOrder, setSortOrder] = useState<SortOrder>('oldest');

  const sorted = [...documents].sort((a, b) => {
    const dateA = new Date(a.created_at || 0).getTime();
    const dateB = new Date(b.created_at || 0).getTime();
    return sortOrder === 'oldest' ? dateA - dateB : dateB - dateA;
  });

  if (documents.length === 0) {
    return <div style={styles.empty}>No documents in queue</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.sortRow}>
        <button
          onClick={() => setSortOrder(sortOrder === 'oldest' ? 'newest' : 'oldest')}
          style={styles.sortBtn}
        >
          {sortOrder === 'oldest' ? 'Oldest first' : 'Newest first'} ▾
        </button>
      </div>
      <div style={styles.list}>
        {sorted.map((doc) => (
          <button
            key={doc.id}
            onClick={() => onSelect(doc)}
            style={{
              ...styles.item,
              ...(doc.id === selectedId ? styles.itemActive : {}),
            }}
          >
            <div style={styles.itemTop}>
              <span style={styles.fileName}>{doc.file_name || `Document #${doc.id}`}</span>
              <ConfidenceBadge confidence={doc.confidence} />
            </div>
            <div style={styles.itemBottom}>
              {doc.document_label ? (
                <span style={styles.label}>{doc.document_label}</span>
              ) : (
                <span style={styles.unclassified}>Unclassified</span>
              )}
              <StatusBadge status={doc.status} />
            </div>
            {doc.claimed_by && (
              <div style={styles.claimed}>Reviewing: {doc.claimed_by}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return null;
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 70 ? 'var(--color-confidence-high)' :
    pct >= 40 ? 'var(--color-confidence-medium)' :
    'var(--color-confidence-low)';
  return <span style={{ ...styles.badge, background: color }}>{pct}%</span>;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'pending') return null;
  const colors: Record<string, string> = {
    unclassified: 'var(--color-warning)',
    approved: 'var(--color-success)',
    skipped: 'var(--color-text-secondary)',
    error: 'var(--color-error)',
  };
  return (
    <span style={{ ...styles.statusBadge, color: colors[status] || 'inherit' }}>
      {status}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  sortRow: { padding: '6px 8px', borderBottom: '1px solid var(--color-border)' },
  sortBtn: {
    background: 'none', border: 'none', fontSize: '12px', color: 'var(--color-text-secondary)',
    cursor: 'pointer', fontWeight: 500, padding: '2px 4px',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', overflowY: 'auto', flex: 1, padding: '4px 0' },
  empty: { padding: '24px', color: 'var(--color-text-secondary)', textAlign: 'center', fontSize: '14px' },
  item: {
    display: 'flex', flexDirection: 'column', gap: '4px',
    padding: '10px 12px', borderRadius: '6px',
    border: '1px solid var(--color-border)', background: 'var(--color-surface)',
    textAlign: 'left', cursor: 'pointer', transition: 'border-color 0.15s',
  },
  itemActive: { borderColor: 'var(--color-primary)', background: '#eff6ff' },
  itemTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  itemBottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  fileName: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' },
  label: { fontSize: '12px', color: 'var(--color-text-secondary)' },
  unclassified: { fontSize: '12px', color: 'var(--color-warning)', fontStyle: 'italic' },
  badge: { fontSize: '11px', fontWeight: 600, color: '#fff', padding: '2px 6px', borderRadius: '4px' },
  statusBadge: { fontSize: '11px', fontWeight: 500, textTransform: 'capitalize' },
  claimed: { fontSize: '11px', color: 'var(--color-warning)', fontStyle: 'italic' },
};
