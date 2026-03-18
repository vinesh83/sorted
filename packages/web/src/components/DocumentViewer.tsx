import { useState } from 'react';
import { api } from '../api/client';

interface Props {
  processedFileId: number | null;
  mimeType: string | null;
  fileName: string | null;
  documentId: number | null;
}

export function DocumentViewer({ processedFileId, mimeType, fileName, documentId }: Props) {
  const [showText, setShowText] = useState(false);
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);

  if (!processedFileId) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyText}>Select a document to view</p>
      </div>
    );
  }

  const fileUrl = `/api/files/${processedFileId}/content`;

  const loadExtractedText = async () => {
    if (extractedText !== null || !documentId) return;
    setLoadingText(true);
    try {
      const res = await api.get<{ document: { extracted_text?: string } }>(`/documents/${documentId}`);
      setExtractedText(res.document.extracted_text || 'No text extracted.');
    } catch {
      setExtractedText('Failed to load text.');
    } finally {
      setLoadingText(false);
    }
  };

  const handleShowText = () => {
    setShowText(!showText);
    if (!showText) loadExtractedText();
  };

  // Text toggle button
  const textToggle = (
    <button onClick={handleShowText} style={styles.textToggle}>
      {showText ? 'Show File' : 'Show Extracted Text'}
    </button>
  );

  // Extracted text view
  if (showText) {
    return (
      <div style={styles.container}>
        {textToggle}
        <div style={styles.textView}>
          {loadingText ? (
            <p style={styles.loadingText}>Loading...</p>
          ) : (
            <pre style={styles.extractedText}>{extractedText}</pre>
          )}
        </div>
      </div>
    );
  }

  // Image files
  if (mimeType?.startsWith('image/')) {
    return (
      <div style={styles.container}>
        {textToggle}
        <img src={fileUrl} alt={fileName || 'Document'} style={styles.image} />
      </div>
    );
  }

  // PDF files
  if (mimeType === 'application/pdf') {
    return (
      <div style={styles.container}>
        {textToggle}
        <iframe
          src={fileUrl}
          title={fileName || 'Document'}
          style={styles.iframe}
        />
      </div>
    );
  }

  // DOCX files — convert to HTML on server and render in iframe
  const isDocx = fileName?.toLowerCase().endsWith('.docx') || fileName?.toLowerCase().endsWith('.doc');

  if (isDocx) {
    const previewUrl = `/api/files/${processedFileId}/preview`;
    return (
      <div style={styles.container}>
        {textToggle}
        <iframe
          src={previewUrl}
          title={fileName || 'Document'}
          style={{ ...styles.iframe, background: '#fff' }}
        />
      </div>
    );
  }

  // All other file types
  return (
    <div style={styles.container}>
      {textToggle}
      <div style={styles.docxView}>
        <p style={styles.fileName}>{fileName}</p>
        <p style={styles.note}>Preview not available for this file type.</p>
        <div style={styles.docxActions}>
          <a href={fileUrl} target="_blank" rel="noopener noreferrer" style={styles.downloadBtn}>
            Download File
          </a>
          <button onClick={() => { setShowText(true); loadExtractedText(); }} style={styles.viewTextBtn}>
            View Extracted Text
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: '100%', height: '100%', overflow: 'auto', background: '#525659', position: 'relative' },
  empty: {
    width: '100%', height: '100%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: '#f0f0f0',
  },
  emptyText: { color: 'var(--color-text-secondary)', fontSize: '14px' },
  iframe: { width: '100%', height: '100%', border: 'none' },
  image: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', margin: '0 auto' },
  textToggle: {
    position: 'absolute', top: '8px', right: '8px', zIndex: 10,
    padding: '6px 12px', borderRadius: '6px', border: 'none',
    background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '12px',
    fontWeight: 600, cursor: 'pointer',
  },
  textView: { padding: '16px', height: '100%', overflow: 'auto' },
  loadingText: { color: '#ccc', fontSize: '14px' },
  extractedText: {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    color: '#e0e0e0', fontSize: '13px', lineHeight: '1.6',
    fontFamily: 'monospace', margin: 0,
  },
  docxView: { padding: '48px', textAlign: 'center' as const, color: '#fff' },
  fileName: { fontSize: '16px', fontWeight: 600, marginBottom: '8px' },
  note: { fontSize: '14px', opacity: 0.7, marginBottom: '20px' },
  docxActions: { display: 'flex', gap: '12px', justifyContent: 'center' },
  downloadBtn: {
    padding: '10px 20px', borderRadius: '6px', background: 'var(--color-primary)',
    color: '#fff', textDecoration: 'none', fontSize: '14px', fontWeight: 600,
  },
  viewTextBtn: {
    padding: '10px 20px', borderRadius: '6px', border: '1px solid #fff',
    background: 'transparent', color: '#fff', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
  },
};
