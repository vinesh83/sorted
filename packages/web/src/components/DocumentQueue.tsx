import type { Document } from 'shared/types';

interface Props {
  documents: Document[];
  selectedId: number | null;
  onSelect: (doc: Document) => void;
}

export function DocumentQueue({ documents, selectedId, onSelect }: Props) {
  if (documents.length === 0) {
    return <div style={styles.empty}>No documents in queue</div>;
  }

  return (
    <div style={styles.list}>
      {documents.map((doc) => (
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
  list: { display: 'flex', flexDirection: 'column', gap: '4px', overflowY: 'auto', flex: 1 },
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
