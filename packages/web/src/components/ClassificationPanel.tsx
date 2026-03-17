import { useState, useEffect, useCallback } from 'react';
import type { Document, AsanaProject, AsanaSection, EventType } from 'shared/types';
import { EVENT_TYPES, EVENT_TYPE_TO_SECTION } from 'shared/types';
import { AsanaProjectSearch } from './AsanaProjectSearch';
import { SectionPicker } from './SectionPicker';
import { SplitSuggestion } from './SplitSuggestion';

interface Props {
  document: Document;
  onUpdate: (fields: Record<string, unknown>) => Promise<Document | undefined>;
  onApprove: () => Promise<unknown>;
  onSkip: () => Promise<void>;
  onNext: () => void;
  onRefreshQueue?: () => void;
  onRetryClassify?: () => Promise<void>;
  onRetryAttach?: () => Promise<void>;
}

export function ClassificationPanel({ document: doc, onUpdate, onApprove, onSkip, onNext, onRefreshQueue, onRetryClassify, onRetryAttach }: Props) {
  const [label, setLabel] = useState('');
  const [clientName, setClientName] = useState('');
  const [description, setDescription] = useState('');
  const [eventType, setEventType] = useState<EventType | ''>('');
  const [docDate, setDocDate] = useState('');
  const [selectedProject, setSelectedProject] = useState<AsanaProject | null>(null);
  const [selectedSection, setSelectedSection] = useState<AsanaSection | null>(null);
  const [approving, setApproving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; taskUrl?: string; errors: string[] } | null>(null);

  // Populate fields from document
  useEffect(() => {
    setLabel(doc.edited_label || doc.document_label || '');
    setClientName(doc.edited_client_name || doc.client_name || '');
    setDescription(doc.edited_description || doc.description || '');
    setEventType((doc.edited_event_type || doc.event_type || '') as EventType | '');
    setDocDate(doc.edited_date || doc.document_date || new Date().toISOString().split('T')[0]);
    setSelectedProject(
      doc.asana_project_gid ? { gid: doc.asana_project_gid, name: doc.asana_project_name || '' } : null,
    );
    setSelectedSection(
      doc.asana_section_gid ? { gid: doc.asana_section_gid, name: doc.asana_section_name || '' } : null,
    );
    setResult(null);
  }, [doc.id]);

  // Save edits on blur
  const saveField = useCallback(
    async (field: string, value: string) => {
      await onUpdate({ [field]: value || null });
    },
    [onUpdate],
  );

  const handleProjectSelect = useCallback(
    async (project: AsanaProject) => {
      setSelectedProject(project);
      setSelectedSection(null);
      await onUpdate({
        asana_project_gid: project.gid,
        asana_project_name: project.name,
        asana_section_gid: null,
        asana_section_name: null,
      });
    },
    [onUpdate],
  );

  const handleSectionSelect = useCallback(
    async (section: AsanaSection) => {
      setSelectedSection(section);
      await onUpdate({
        asana_section_gid: section.gid,
        asana_section_name: section.name,
      });
    },
    [onUpdate],
  );

  const handleApprove = async () => {
    setApproving(true);
    try {
      // Save any pending edits first
      await onUpdate({
        edited_label: label || null,
        edited_client_name: clientName || null,
        edited_description: description || null,
        edited_event_type: eventType || null,
        edited_date: docDate || null,
      });
      const res = await onApprove() as { success: boolean; taskUrl?: string; errors: string[] } | null;
      if (res) setResult(res);
    } catch (err) {
      setResult({ success: false, taskUrl: undefined, errors: [err instanceof Error ? err.message : 'Unknown error'] });
    } finally {
      setApproving(false);
    }
  };

  // Suggested section based on event type
  const suggestedSectionName = eventType ? EVENT_TYPE_TO_SECTION[eventType as EventType] : null;

  if (result) {
    return (
      <div style={styles.container}>
        <div style={styles.result}>
          {result.success ? (
            <>
              <div style={styles.successIcon}>✓</div>
              <h3 style={{ color: 'var(--color-success)' }}>Task Created</h3>
              {result.taskUrl && (
                <a href={result.taskUrl} target="_blank" rel="noopener noreferrer" style={styles.taskLink}>
                  Open in Asana
                </a>
              )}
              {result.errors.length > 0 && (
                <div style={{ marginTop: '8px', textAlign: 'center' as const }}>
                  {result.errors.map((e, i) => (
                    <p key={i} style={{ color: 'var(--color-warning)', fontSize: '13px' }}>{e}</p>
                  ))}
                  {result.errors.some((e) => e.includes('attachment')) && onRetryAttach && (
                    <button
                      onClick={async () => { try { await onRetryAttach(); setResult({ ...result, errors: result.errors.filter((e) => !e.includes('attachment')) }); } catch {} }}
                      style={styles.retryBtn}
                    >
                      Retry Attachment
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={styles.errorIcon}>!</div>
              <h3 style={{ color: 'var(--color-error)' }}>Error</h3>
              {result.errors.map((e, i) => (
                <p key={i} style={{ color: 'var(--color-error)', fontSize: '13px' }}>{e}</p>
              ))}
            </>
          )}
          <button onClick={onNext} style={styles.nextButton}>
            Next Document
          </button>
        </div>
      </div>
    );
  }

  const confidence = doc.confidence;
  const confidenceColor =
    confidence && confidence >= 0.7 ? 'var(--color-confidence-high)' :
    confidence && confidence >= 0.4 ? 'var(--color-confidence-medium)' :
    'var(--color-confidence-low)';

  return (
    <div style={styles.container}>
      {/* Confidence */}
      {confidence !== null && (
        <div style={styles.confidenceRow}>
          <span style={{ color: confidenceColor, fontWeight: 600 }}>
            {Math.round((confidence || 0) * 100)}% confidence
          </span>
          {!doc.is_legal_document && (
            <span style={styles.notLegalBadge}>Not a legal document</span>
          )}
        </div>
      )}

      {doc.classification_error && (
        <div style={styles.errorBanner}>
          Classification failed: {doc.classification_error}
          {onRetryClassify && (
            <button
              onClick={async () => { try { await onRetryClassify(); } catch {} }}
              style={styles.retryBtn}
            >
              Retry Classification
            </button>
          )}
        </div>
      )}

      {doc.ocr_partial && (
        <div style={styles.warningBanner}>
          Partial OCR — only first 20 pages analyzed
        </div>
      )}

      <SplitSuggestion
        processedFileId={doc.processed_file_id}
        onSplitAccepted={() => { onRefreshQueue?.(); onNext(); }}
      />

      {/* Classification fields */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>Classification</h4>
        <FieldRow label="Document Type">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => saveField('edited_label', label)}
            style={styles.input}
            placeholder="e.g., Bond Hearing Notice"
          />
        </FieldRow>
        <FieldRow label="Client Name">
          <input
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            onBlur={() => saveField('edited_client_name', clientName)}
            style={styles.input}
            placeholder="Last, First"
          />
        </FieldRow>
        <FieldRow label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => saveField('edited_description', description)}
            style={styles.input}
            placeholder="Task name description"
          />
        </FieldRow>
        <FieldRow label="Event Type">
          <select
            value={eventType}
            onChange={(e) => {
              setEventType(e.target.value as EventType);
              saveField('edited_event_type', e.target.value);
            }}
            style={styles.select}
          >
            <option value="">Select event type...</option>
            {EVENT_TYPES.map((et) => (
              <option key={et} value={et}>{et}</option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="Date">
          <input
            type="date"
            value={docDate}
            onChange={(e) => {
              setDocDate(e.target.value);
              saveField('edited_date', e.target.value);
            }}
            style={styles.input}
          />
        </FieldRow>
      </div>

      {/* Asana targeting */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>Asana Project</h4>
        <AsanaProjectSearch
          selectedProject={selectedProject}
          onSelect={handleProjectSelect}
        />
      </div>

      {selectedProject && (
        <div style={styles.section}>
          <h4 style={styles.sectionTitle}>Section</h4>
          <SectionPicker
            projectGid={selectedProject.gid}
            selectedSection={selectedSection}
            suggestedSectionName={suggestedSectionName}
            onSelect={handleSectionSelect}
          />
        </div>
      )}

      {/* Actions */}
      <div style={styles.actions}>
        <button onClick={() => onSkip()} style={styles.skipButton}>
          Skip
        </button>
        <button
          onClick={handleApprove}
          disabled={approving || !selectedProject || !eventType}
          style={{
            ...styles.approveButton,
            opacity: approving || !selectedProject || !eventType ? 0.5 : 1,
          }}
        >
          {approving ? 'Creating task...' : 'Approve & Create Task'}
        </button>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.fieldRow}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', overflowY: 'auto', height: '100%' },
  confidenceRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' },
  notLegalBadge: { background: 'var(--color-warning)', color: '#fff', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600 },
  errorBanner: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', padding: '8px 12px', color: 'var(--color-error)', fontSize: '13px' },
  warningBanner: { background: '#fffbeb', border: '1px solid #fed7aa', borderRadius: '6px', padding: '8px 12px', color: 'var(--color-warning)', fontSize: '13px' },
  section: { borderBottom: '1px solid var(--color-border)', paddingBottom: '12px' },
  sectionTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' },
  fieldRow: { marginBottom: '8px' },
  fieldLabel: { display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' },
  input: { width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', fontSize: '14px', boxSizing: 'border-box' as const },
  select: { width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', fontSize: '14px', background: '#fff' },
  actions: { display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '12px' },
  skipButton: { flex: '0 0 auto', padding: '10px 16px', borderRadius: '6px', border: '1px solid var(--color-border)', background: '#fff', fontSize: '14px', fontWeight: 500 },
  approveButton: { flex: 1, padding: '10px 16px', borderRadius: '6px', border: 'none', background: 'var(--color-primary)', color: '#fff', fontSize: '14px', fontWeight: 600 },
  result: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', flex: 1 },
  successIcon: { width: '48px', height: '48px', borderRadius: '50%', background: 'var(--color-success)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', fontWeight: 700 },
  errorIcon: { width: '48px', height: '48px', borderRadius: '50%', background: 'var(--color-error)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', fontWeight: 700 },
  taskLink: { color: 'var(--color-primary)', fontSize: '14px' },
  nextButton: { padding: '10px 24px', borderRadius: '6px', border: 'none', background: 'var(--color-primary)', color: '#fff', fontSize: '14px', fontWeight: 600, marginTop: '8px' },
  retryBtn: { display: 'inline-block', marginTop: '6px', padding: '4px 12px', borderRadius: '4px', border: '1px solid var(--color-primary)', background: '#fff', color: 'var(--color-primary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
};
