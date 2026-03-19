import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

type Tab = 'corrections' | 'rules' | 'prompt' | 'performance';

interface Correction {
  id: number;
  document_id: number;
  field_name: string;
  ai_value: string | null;
  paralegal_value: string | null;
  paralegal_name: string | null;
  file_name: string | null;
  created_at: string;
}

interface RulesVersion {
  id: number;
  version: number;
  rules_text: string;
  opus_reasoning: string;
  corrections_analyzed: number;
  accuracy_before: number | null;
  created_at: string;
  active: number;
}

interface CorrectionsStatus {
  correctionsSinceLastAnalysis: number;
  triggerThreshold: number;
  canAutoTrigger: boolean;
  totalCorrections: number;
  totalApproved: number;
  approvedWithCorrections: number;
  accuracyRate: number | null;
  byField: Array<{ field_name: string; count: number }>;
  overTime: Array<{ date: string; count: number }>;
}

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('corrections');

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <a href="/" style={styles.backLink}>← Back to Sort Queue</a>
          <h1 style={styles.logo}>Doc Triage</h1>
          <span style={styles.adminBadge}>Admin</span>
        </div>
        <div style={styles.headerRight}>
          <a href="/history" style={styles.link}>History</a>
        </div>
      </header>

      <div style={styles.tabs}>
        {(['corrections', 'rules', 'prompt', 'performance'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}
          >
            {t === 'corrections' ? 'Corrections' : t === 'rules' ? 'Active Rules' : t === 'prompt' ? 'Prompt Preview' : 'Performance'}
          </button>
        ))}
      </div>

      <div style={styles.content}>
        {tab === 'corrections' && <CorrectionsTab />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'prompt' && <PromptTab />}
        {tab === 'performance' && <PerformanceTab />}
      </div>
    </div>
  );
}

// ---- Tab 1: Corrections Feed ----
function CorrectionsTab() {
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [status, setStatus] = useState<CorrectionsStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<{ corrections: Correction[] }>('/corrections'),
      api.get<CorrectionsStatus>('/admin/corrections-status'),
    ]).then(([cRes, sRes]) => {
      setCorrections(cRes.corrections);
      setStatus(sRes);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={styles.loading}>Loading corrections...</div>;

  const progress = status ? (status.correctionsSinceLastAnalysis / status.triggerThreshold) * 100 : 0;

  return (
    <div>
      {/* Progress to next Opus analysis */}
      {status && (
        <div style={styles.progressCard}>
          <div style={styles.progressHeader}>
            <span style={styles.progressLabel}>Next Opus Analysis</span>
            <span style={styles.progressCount}>
              {status.correctionsSinceLastAnalysis} / {status.triggerThreshold} corrections
            </span>
          </div>
          <div style={styles.progressBarBg}>
            <div style={{ ...styles.progressBarFill, width: `${Math.min(progress, 100)}%` }} />
          </div>
          {status.canAutoTrigger && (
            <p style={styles.progressNote}>Threshold reached — analysis will run on next correction</p>
          )}
        </div>
      )}

      {/* Correction cards */}
      {corrections.length === 0 ? (
        <div style={styles.emptyState}>No corrections yet. Corrections are logged automatically when paralegals edit AI classifications before approving.</div>
      ) : (
        <div style={styles.cardList}>
          {corrections.map((c) => (
            <div key={c.id} style={styles.correctionCard}>
              <div style={styles.correctionHeader}>
                <span style={styles.correctionFile}>{c.file_name || `Doc #${c.document_id}`}</span>
                <span style={styles.correctionMeta}>
                  {c.paralegal_name} &middot; {new Date(c.created_at).toLocaleDateString()}
                </span>
              </div>
              <div style={styles.correctionField}>{fieldLabel(c.field_name)}</div>
              <div style={styles.diffRow}>
                <span style={styles.diffOld}>{c.ai_value || '(empty)'}</span>
                <span style={styles.diffArrow}>&rarr;</span>
                <span style={styles.diffNew}>{c.paralegal_value || '(empty)'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Tab 2: Active Rules ----
function RulesTab() {
  const [active, setActive] = useState<RulesVersion | null>(null);
  const [history, setHistory] = useState<RulesVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<{ active: RulesVersion | null; history: RulesVersion[] }>('/admin/rules')
      .then((res) => { setActive(res.active); setHistory(res.history); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleOptimize = async () => {
    setOptimizing(true);
    setOptimizeResult(null);
    try {
      const res = await api.post<{ ok: boolean; version: number; rulesText: string; correctionsAnalyzed: number; cost: number }>('/admin/optimize');
      setOptimizeResult(`v${res.version} generated from ${res.correctionsAnalyzed} corrections ($${res.cost.toFixed(4)})`);
      load();
    } catch (err) {
      setOptimizeResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOptimizing(false);
    }
  };

  if (loading) return <div style={styles.loading}>Loading rules...</div>;

  return (
    <div>
      <div style={styles.rulesActions}>
        <button onClick={handleOptimize} disabled={optimizing} style={styles.optimizeBtn}>
          {optimizing ? 'Running Opus Analysis...' : 'Run Opus Analysis Now'}
        </button>
        {optimizeResult && <span style={styles.optimizeResult}>{optimizeResult}</span>}
      </div>

      {active ? (
        <div style={styles.activeRulesCard}>
          <div style={styles.rulesCardHeader}>
            <span style={styles.activeBadge}>ACTIVE</span>
            <span>Version {active.version} &middot; {new Date(active.created_at).toLocaleDateString()}</span>
            <span>{active.corrections_analyzed} corrections analyzed</span>
          </div>
          <div style={styles.rulesList}>
            {active.rules_text.split('\n').filter((l) => l.trim()).map((rule, i) => (
              <div key={i} style={styles.ruleItem}>{rule}</div>
            ))}
          </div>
          <div style={styles.rulesReasoning}>
            <strong>Opus Reasoning:</strong>
            <p>{active.opus_reasoning}</p>
          </div>
        </div>
      ) : (
        <div style={styles.emptyState}>No rules generated yet. Rules are created when Opus analyzes accumulated paralegal corrections.</div>
      )}

      {history.length > 1 && (
        <div style={styles.historySection}>
          <h3 style={styles.sectionTitle}>Previous Versions</h3>
          {history.filter((h) => !h.active).map((h) => (
            <div key={h.id} style={styles.historyCard}>
              <div style={styles.historyHeader}>
                <span>v{h.version} &middot; {new Date(h.created_at).toLocaleDateString()}</span>
                <span>{h.corrections_analyzed} corrections</span>
              </div>
              <div style={styles.historyRules}>{h.rules_text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Tab 3: Prompt Preview ----
function PromptTab() {
  const [prompt, setPrompt] = useState('');
  const [tokens, setTokens] = useState(0);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<{ prompt: string; estimatedTokens: number; rulesVersion: number }>('/admin/prompt')
      .then((res) => { setPrompt(res.prompt); setTokens(res.estimatedTokens); setVersion(res.rulesVersion); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={styles.loading}>Loading prompt...</div>;

  // Split prompt into base + rules sections for highlighting
  const rulesIdx = prompt.indexOf('LEARNED RULES');
  const basePrompt = rulesIdx >= 0 ? prompt.slice(0, rulesIdx) : prompt;
  const rulesSection = rulesIdx >= 0 ? prompt.slice(rulesIdx) : null;

  return (
    <div>
      <div style={styles.promptMeta}>
        <span>Rules version: {version > 0 ? `v${version}` : 'None'}</span>
        <span>Estimated tokens: ~{tokens.toLocaleString()}</span>
      </div>
      <div style={styles.promptBox}>
        <pre style={styles.promptBase}>{basePrompt}</pre>
        {rulesSection && (
          <pre style={styles.promptRules}>{rulesSection}</pre>
        )}
      </div>
    </div>
  );
}

// ---- Tab 4: Performance ----
function PerformanceTab() {
  const [status, setStatus] = useState<CorrectionsStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<CorrectionsStatus>('/admin/corrections-status')
      .then(setStatus)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={styles.loading}>Loading performance data...</div>;
  if (!status) return null;

  return (
    <div>
      {/* Accuracy score card */}
      <div style={styles.statsGrid}>
        <div style={styles.statCard}>
          <div style={styles.statValue}>
            {status.accuracyRate !== null ? `${status.accuracyRate.toFixed(1)}%` : 'N/A'}
          </div>
          <div style={styles.statLabel}>Accuracy (no corrections needed)</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{status.totalApproved}</div>
          <div style={styles.statLabel}>Documents Approved</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{status.totalCorrections}</div>
          <div style={styles.statLabel}>Total Corrections</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{status.approvedWithCorrections}</div>
          <div style={styles.statLabel}>Docs Needing Corrections</div>
        </div>
      </div>

      {/* Most corrected fields */}
      <h3 style={styles.sectionTitle}>Most Corrected Fields</h3>
      <div style={styles.barChart}>
        {status.byField.map((f) => {
          const maxCount = Math.max(...status.byField.map((b) => b.count), 1);
          return (
            <div key={f.field_name} style={styles.barRow}>
              <span style={styles.barLabel}>{fieldLabel(f.field_name)}</span>
              <div style={styles.barTrack}>
                <div style={{ ...styles.barFill, width: `${(f.count / maxCount) * 100}%` }} />
              </div>
              <span style={styles.barCount}>{f.count}</span>
            </div>
          );
        })}
        {status.byField.length === 0 && <div style={styles.emptyState}>No corrections yet</div>}
      </div>

      {/* Corrections over time */}
      {status.overTime.length > 0 && (
        <>
          <h3 style={styles.sectionTitle}>Corrections Over Time</h3>
          <div style={styles.timeChart}>
            {status.overTime.map((d) => {
              const maxCount = Math.max(...status.overTime.map((t) => t.count), 1);
              const height = Math.max((d.count / maxCount) * 100, 4);
              return (
                <div key={d.date} style={styles.timeBar}>
                  <div style={{ ...styles.timeBarFill, height: `${height}%` }} title={`${d.date}: ${d.count}`} />
                  <span style={styles.timeLabel}>{d.date.slice(5)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Helpers ----
function fieldLabel(field: string): string {
  const map: Record<string, string> = {
    document_label: 'Document Type',
    client_name: 'Client Name',
    description: 'Description',
    event_type: 'Event Type',
    document_date: 'Date',
  };
  return map[field] || field;
}

// ---- Styles ----
const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 20px', background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)', flexShrink: 0,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: '12px' },
  headerRight: { display: 'flex', alignItems: 'center', gap: '12px' },
  logo: { fontSize: '18px', fontWeight: 700 },
  backLink: { color: 'var(--color-primary)', textDecoration: 'none', fontSize: '13px', fontWeight: 500 },
  adminBadge: { padding: '3px 10px', borderRadius: '999px', background: '#7c3aed', color: '#fff', fontSize: '12px', fontWeight: 600 },
  link: { color: 'var(--color-primary)', textDecoration: 'none', fontSize: '14px', cursor: 'pointer' },
  tabs: { display: 'flex', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', padding: '0 20px' },
  tab: {
    padding: '12px 20px', border: 'none', background: 'none', fontSize: '14px',
    fontWeight: 500, color: 'var(--color-text-secondary)', cursor: 'pointer',
    borderBottom: '2px solid transparent',
  },
  tabActive: { color: 'var(--color-primary)', borderBottomColor: 'var(--color-primary)', fontWeight: 600 },
  content: { flex: 1, overflow: 'auto', padding: '20px', maxWidth: '900px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--color-text-secondary)' },
  emptyState: { padding: '40px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: '14px' },

  // Progress card
  progressCard: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '16px', marginBottom: '20px' },
  progressHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: '8px' },
  progressLabel: { fontWeight: 600, fontSize: '14px' },
  progressCount: { fontSize: '13px', color: 'var(--color-text-secondary)' },
  progressBarBg: { height: '8px', borderRadius: '4px', background: '#dbeafe' },
  progressBarFill: { height: '100%', borderRadius: '4px', background: 'var(--color-primary)', transition: 'width 0.3s' },
  progressNote: { fontSize: '12px', color: 'var(--color-success)', marginTop: '6px', fontWeight: 500 },

  // Correction cards
  cardList: { display: 'flex', flexDirection: 'column', gap: '8px' },
  correctionCard: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px' },
  correctionHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' },
  correctionFile: { fontWeight: 600, fontSize: '13px' },
  correctionMeta: { fontSize: '12px', color: 'var(--color-text-secondary)' },
  correctionField: { fontSize: '11px', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: '4px' },
  diffRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
  diffOld: { background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: '4px', textDecoration: 'line-through' },
  diffArrow: { color: 'var(--color-text-secondary)' },
  diffNew: { background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: '4px', fontWeight: 600 },

  // Rules
  rulesActions: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' },
  optimizeBtn: { padding: '10px 20px', borderRadius: '8px', border: 'none', background: '#7c3aed', color: '#fff', fontSize: '14px', fontWeight: 600, cursor: 'pointer' },
  optimizeResult: { fontSize: '13px', color: 'var(--color-text-secondary)' },
  activeRulesCard: { background: 'var(--color-surface)', border: '2px solid var(--color-success)', borderRadius: '8px', padding: '16px' },
  rulesCardHeader: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '12px', fontSize: '13px', color: 'var(--color-text-secondary)' },
  activeBadge: { padding: '2px 8px', borderRadius: '4px', background: 'var(--color-success)', color: '#fff', fontSize: '11px', fontWeight: 700 },
  rulesList: { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' },
  ruleItem: { padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', fontSize: '13px' },
  rulesReasoning: { fontSize: '13px', color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)', paddingTop: '12px' },
  historySection: { marginTop: '24px' },
  sectionTitle: { fontSize: '16px', fontWeight: 600, marginBottom: '12px', marginTop: '24px' },
  historyCard: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px', marginBottom: '8px' },
  historyHeader: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '8px' },
  historyRules: { fontSize: '12px', color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' },

  // Prompt preview
  promptMeta: { display: 'flex', gap: '20px', marginBottom: '12px', fontSize: '13px', color: 'var(--color-text-secondary)' },
  promptBox: { borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--color-border)' },
  promptBase: { margin: 0, padding: '16px', fontSize: '12px', lineHeight: '1.6', whiteSpace: 'pre-wrap', background: '#1e1e1e', color: '#d4d4d4', fontFamily: 'monospace' },
  promptRules: { margin: 0, padding: '16px', fontSize: '12px', lineHeight: '1.6', whiteSpace: 'pre-wrap', background: '#1e3a5f', color: '#93c5fd', fontFamily: 'monospace', borderTop: '2px solid #3b82f6' },

  // Performance
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '24px' },
  statCard: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '16px', textAlign: 'center' },
  statValue: { fontSize: '28px', fontWeight: 700, color: 'var(--color-primary)' },
  statLabel: { fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '4px' },
  barChart: { display: 'flex', flexDirection: 'column', gap: '8px' },
  barRow: { display: 'flex', alignItems: 'center', gap: '12px' },
  barLabel: { width: '120px', fontSize: '13px', fontWeight: 500, textAlign: 'right' },
  barTrack: { flex: 1, height: '20px', background: '#f1f5f9', borderRadius: '4px', overflow: 'hidden' },
  barFill: { height: '100%', background: 'var(--color-warning)', borderRadius: '4px', transition: 'width 0.3s' },
  barCount: { width: '30px', fontSize: '13px', fontWeight: 600 },
  timeChart: { display: 'flex', alignItems: 'flex-end', gap: '2px', height: '120px', padding: '0 4px' },
  timeBar: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' },
  timeBarFill: { width: '100%', background: 'var(--color-primary)', borderRadius: '2px 2px 0 0', minHeight: '4px' },
  timeLabel: { fontSize: '10px', color: 'var(--color-text-secondary)', marginTop: '4px', transform: 'rotate(-45deg)', transformOrigin: 'top left' },
};
