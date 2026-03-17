import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { PARALEGALS, type ParalegalName } from 'shared/types';

export function SelectParalegal() {
  const { selectParalegal, loading, logout } = useAuth();
  const navigate = useNavigate();

  const handleSelect = async (name: ParalegalName) => {
    await selectParalegal(name);
    navigate('/');
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Who's sorting?</h1>
        <p style={styles.subtitle}>Select your name to view your document queue</p>
        <div style={styles.grid}>
          {PARALEGALS.map((name) => (
            <button
              key={name}
              onClick={() => handleSelect(name)}
              disabled={loading}
              style={styles.nameButton}
            >
              <span style={styles.avatar}>{name[0]}</span>
              <span>{name}</span>
            </button>
          ))}
        </div>
        <button onClick={logout} style={styles.logoutLink}>
          Sign out
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: 'var(--color-bg)',
  },
  card: {
    background: 'var(--color-surface)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)',
    padding: '48px',
    width: '100%',
    maxWidth: '480px',
    textAlign: 'center' as const,
  },
  title: {
    fontSize: '24px',
    fontWeight: 700,
    marginBottom: '4px',
  },
  subtitle: {
    color: 'var(--color-text-secondary)',
    marginBottom: '32px',
  },
  grid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  nameButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '16px 24px',
    borderRadius: 'var(--radius)',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    fontSize: '18px',
    fontWeight: 500,
    transition: 'border-color 0.15s, background 0.15s',
    cursor: 'pointer',
  },
  avatar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    background: 'var(--color-primary)',
    color: '#fff',
    fontWeight: 700,
    fontSize: '16px',
  },
  logoutLink: {
    marginTop: '24px',
    background: 'none',
    border: 'none',
    color: 'var(--color-text-secondary)',
    fontSize: '14px',
    cursor: 'pointer',
    textDecoration: 'underline',
  },
};
