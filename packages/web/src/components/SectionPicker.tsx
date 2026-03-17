import { useEffect } from 'react';
import { useAsanaSections } from '../hooks/useAsana';
import type { AsanaSection } from 'shared/types';

interface Props {
  projectGid: string;
  selectedSection: AsanaSection | null;
  suggestedSectionName: string | null;
  onSelect: (section: AsanaSection) => void;
}

export function SectionPicker({ projectGid, selectedSection, suggestedSectionName, onSelect }: Props) {
  const { sections, loading, loadSections } = useAsanaSections(projectGid);

  useEffect(() => {
    loadSections();
  }, [loadSections]);

  // Auto-select suggested section if available and nothing selected yet
  useEffect(() => {
    if (suggestedSectionName && sections.length > 0 && !selectedSection) {
      const match = sections.find((s) =>
        s.name.toLowerCase() === suggestedSectionName.toLowerCase(),
      );
      if (match) {
        onSelect(match);
      }
    }
  }, [suggestedSectionName, sections, selectedSection, onSelect]);

  if (loading) {
    return <div style={styles.loading}>Loading sections...</div>;
  }

  if (sections.length === 0) {
    return (
      <div style={styles.warning}>
        No sections found in this project. Task will be added without a section.
      </div>
    );
  }

  return (
    <div style={styles.list}>
      {sections.map((section) => {
        const isSelected = selectedSection?.gid === section.gid;
        const isSuggested = suggestedSectionName?.toLowerCase() === section.name.toLowerCase();

        return (
          <button
            key={section.gid}
            onClick={() => onSelect(section)}
            style={{
              ...styles.item,
              ...(isSelected ? styles.itemSelected : {}),
            }}
          >
            <span style={styles.radio}>{isSelected ? '●' : '○'}</span>
            <span style={styles.name}>{section.name}</span>
            {isSuggested && <span style={styles.suggestedBadge}>AI suggested</span>}
          </button>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: '4px' },
  loading: { fontSize: '13px', color: 'var(--color-text-secondary)', padding: '8px 0' },
  warning: {
    fontSize: '13px', color: 'var(--color-warning)',
    background: '#fffbeb', border: '1px solid #fed7aa',
    borderRadius: '6px', padding: '8px 12px',
  },
  item: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '8px 10px', borderRadius: '6px',
    border: '1px solid var(--color-border)', background: '#fff',
    cursor: 'pointer', textAlign: 'left',
    fontSize: '13px', transition: 'border-color 0.15s',
  },
  itemSelected: { borderColor: 'var(--color-primary)', background: '#eff6ff' },
  radio: { fontSize: '14px', color: 'var(--color-primary)' },
  name: { flex: 1 },
  suggestedBadge: {
    fontSize: '11px', color: 'var(--color-primary)', fontWeight: 600,
    background: '#dbeafe', padding: '2px 6px', borderRadius: '4px',
  },
};
