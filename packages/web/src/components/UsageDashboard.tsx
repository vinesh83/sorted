import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

interface UsageData {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  period: string;
}

export function UsageDashboard() {
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'all'>('week');
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UsageData>(`/usage?period=${period}`);
      setUsage(data);
    } catch {
      setUsage(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  const periods: Array<{ key: typeof period; label: string }> = [
    { key: 'today', label: 'Today' },
    { key: 'week', label: '7 days' },
    { key: 'month', label: '30 days' },
    { key: 'all', label: 'All time' },
  ];

  return (
    <div>
      <h2 style={{ fontSize: '18px', marginBottom: '16px' }}>API Usage</h2>

      <div style={styles.periodTabs}>
        {periods.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            style={{
              ...styles.tab,
              ...(period === p.key ? styles.activeTab : {}),
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p style={styles.muted}>Loading...</p>
      ) : !usage ? (
        <p style={styles.muted}>Failed to load usage data</p>
      ) : (
        <div style={styles.cards}>
          <div style={styles.card}>
            <div style={styles.cardLabel}>Total Cost</div>
            <div style={styles.cardValue}>${usage.totalCost.toFixed(4)}</div>
          </div>
          <div style={styles.card}>
            <div style={styles.cardLabel}>Requests</div>
            <div style={styles.cardValue}>{usage.requestCount.toLocaleString()}</div>
          </div>
          <div style={styles.card}>
            <div style={styles.cardLabel}>Input Tokens</div>
            <div style={styles.cardValue}>{usage.totalInputTokens.toLocaleString()}</div>
          </div>
          <div style={styles.card}>
            <div style={styles.cardLabel}>Output Tokens</div>
            <div style={styles.cardValue}>{usage.totalOutputTokens.toLocaleString()}</div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  periodTabs: {
    display: 'flex',
    gap: '4px',
    marginBottom: '24px',
    background: 'var(--color-bg)',
    borderRadius: '8px',
    padding: '4px',
    width: 'fit-content',
  },
  tab: {
    padding: '6px 16px',
    borderRadius: '6px',
    border: 'none',
    background: 'transparent',
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
  },
  activeTab: {
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '16px',
  },
  card: {
    background: 'var(--color-surface)',
    borderRadius: '8px',
    padding: '20px',
    border: '1px solid var(--color-border)',
  },
  cardLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '8px',
  },
  cardValue: {
    fontSize: '28px',
    fontWeight: 700,
  },
  muted: { color: 'var(--color-text-secondary)' },
};
