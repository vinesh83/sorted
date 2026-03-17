interface Props {
  processedFileId: number | null;
  mimeType: string | null;
  fileName: string | null;
}

export function DocumentViewer({ processedFileId, mimeType, fileName }: Props) {
  if (!processedFileId) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyText}>Select a document to view</p>
      </div>
    );
  }

  const fileUrl = `/api/files/${processedFileId}/content`;

  // Image files
  if (mimeType?.startsWith('image/')) {
    return (
      <div style={styles.container}>
        <img src={fileUrl} alt={fileName || 'Document'} style={styles.image} />
      </div>
    );
  }

  // PDF files - use iframe for native browser rendering
  if (mimeType === 'application/pdf') {
    return (
      <div style={styles.container}>
        <iframe
          src={fileUrl}
          title={fileName || 'Document'}
          style={styles.iframe}
        />
      </div>
    );
  }

  // DOCX / other - show a download link + note about text extraction
  return (
    <div style={styles.container}>
      <div style={styles.unsupported}>
        <p style={styles.fileName}>{fileName}</p>
        <p style={styles.note}>Preview not available for this file type.</p>
        <a href={fileUrl} target="_blank" rel="noopener noreferrer" style={styles.download}>
          Download file
        </a>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: '100%', height: '100%', overflow: 'auto', background: '#525659' },
  empty: {
    width: '100%', height: '100%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: '#f0f0f0',
  },
  emptyText: { color: 'var(--color-text-secondary)', fontSize: '14px' },
  iframe: { width: '100%', height: '100%', border: 'none' },
  image: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', margin: '0 auto' },
  unsupported: { padding: '48px', textAlign: 'center' as const, color: '#fff' },
  fileName: { fontSize: '16px', fontWeight: 600, marginBottom: '8px' },
  note: { fontSize: '14px', opacity: 0.7, marginBottom: '16px' },
  download: { color: 'var(--color-primary)', textDecoration: 'underline' },
};
