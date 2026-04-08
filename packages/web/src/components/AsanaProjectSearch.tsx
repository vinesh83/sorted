import { useState, useRef, useEffect, useCallback } from 'react';
import { useAsanaSearch } from '../hooks/useAsana';
import type { AsanaProject } from 'shared/types';

interface Props {
  selectedProject: AsanaProject | null;
  onSelect: (project: AsanaProject) => void;
  onClear?: () => void;
}

export function AsanaProjectSearch({ selectedProject, onSelect, onClear }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const { projects, searching, searchProjects } = useAsanaSearch();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleInput = useCallback(
    (value: string) => {
      setQuery(value);
      setOpen(true);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => searchProjects(value), 300);
    },
    [searchProjects],
  );

  const handleSelect = (project: AsanaProject) => {
    setQuery(project.name);
    setOpen(false);
    onSelect(project);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = () => setOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return (
    <div style={styles.container} onClick={(e) => e.stopPropagation()}>
      {selectedProject ? (
        <div style={styles.selected}>
          <span style={styles.selectedName}>{selectedProject.name}</span>
          <button
            onClick={() => {
              if (onClear) onClear();
              setQuery('');
            }}
            style={styles.clearBtn}
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <input
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            onFocus={() => query.length >= 2 && setOpen(true)}
            placeholder="Search client project..."
            style={styles.input}
          />
          {open && (projects.length > 0 || searching) && (
            <div style={styles.dropdown}>
              {searching && <div style={styles.loading}>Searching...</div>}
              {projects.map((p) => (
                <button
                  key={p.gid}
                  onClick={() => handleSelect(p)}
                  style={styles.option}
                >
                  {p.name}
                </button>
              ))}
              {!searching && projects.length === 0 && query.length >= 2 && (
                <div style={styles.noResults}>No projects found</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { position: 'relative' },
  input: {
    width: '100%', padding: '8px 10px', borderRadius: '6px',
    border: '1px solid var(--color-border)', fontSize: '14px', boxSizing: 'border-box' as const,
  },
  dropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
    background: '#fff', border: '1px solid var(--color-border)',
    borderRadius: '6px', marginTop: '4px', maxHeight: '200px', overflowY: 'auto',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  },
  option: {
    display: 'block', width: '100%', padding: '8px 12px',
    border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer',
    fontSize: '14px', borderBottom: '1px solid var(--color-border)',
  },
  loading: { padding: '8px 12px', color: 'var(--color-text-secondary)', fontSize: '13px' },
  noResults: { padding: '8px 12px', color: 'var(--color-text-secondary)', fontSize: '13px' },
  selected: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-primary)',
    background: '#eff6ff',
  },
  selectedName: { fontSize: '14px', fontWeight: 500 },
  clearBtn: {
    background: 'none', border: 'none', color: 'var(--color-primary)',
    fontSize: '13px', cursor: 'pointer', textDecoration: 'underline',
  },
};
