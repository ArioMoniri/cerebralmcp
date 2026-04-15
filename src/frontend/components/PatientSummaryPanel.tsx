'use client';

import { useState } from 'react';
import { Locale, t } from '@/lib/i18n';
import { PatientIdentity, PatientSummary } from '@/lib/types';

interface Props {
  locale: Locale;
  summary: PatientSummary | null;
  sessionId: string;
  identity: PatientIdentity;
}

type Tab = 'overview' | 'history' | 'medications' | 'labs';

export default function PatientSummaryPanel({ locale, summary, sessionId, identity }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [copied, setCopied] = useState(false);

  if (!summary) return null;

  const p = summary.patient || {};

  const handleCopy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = (format: 'json' | 'markdown' | 'pdf') => {
    if (format === 'json') {
      const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `patient_${p.patient_id || 'export'}.json`;
      a.click();
    } else if (format === 'markdown') {
      fetch(`/api/export/${sessionId}/markdown`)
        .then(r => r.text())
        .then(text => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
          a.download = `patient_${p.patient_id || 'export'}.md`;
          a.click();
        });
    } else if (format === 'pdf') {
      import('jspdf').then(({ jsPDF }) => {
        const doc = new jsPDF();
        doc.setFontSize(14);
        doc.text(`Patient Summary — ${p.name || identity.firstName + ' ' + identity.lastName}`, 20, 20);
        doc.setFontSize(10);
        const lines = [
          `Age: ${p.age || 'N/A'} | ID: ${p.patient_id || 'N/A'}`,
          '', 'Active Problems:',
          ...(summary.active_problems || []).map(x => `  - ${x}`),
          '', 'Chronic Conditions:',
          ...(summary.chronic_conditions || []).map(x => `  - ${x}`),
          '', 'Medications:',
          ...(summary.current_medications || []).map(m => `  - ${m.name} ${m.dose} ${m.frequency}`),
          '', 'Allergies:',
          ...(summary.allergies?.length ? summary.allergies.map(a => `  - ${a}`) : ['  None known']),
          '', 'Timeline:', summary.clinical_timeline_summary || 'N/A',
        ];
        let y = 35;
        for (const line of lines) {
          if (y > 280) { doc.addPage(); y = 20; }
          doc.text(line, 20, y);
          y += 6;
        }
        doc.save(`patient_${p.patient_id || 'export'}.pdf`);
      });
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: t(locale, 'overview') },
    { key: 'history', label: t(locale, 'visitHistory') },
    { key: 'medications', label: t(locale, 'medications') },
    { key: 'labs', label: t(locale, 'labs') },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {/* Patient Card */}
      <div className="glass-card p-4 mb-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-cerebral-accent/20 flex items-center justify-center">
            <svg className="w-5 h-5 text-cerebral-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-cerebral-text">{p.name || `${identity.firstName} ${identity.lastName}`}</h3>
            <p className="text-xs text-cerebral-muted">
              {p.age && `${p.age} ${locale === 'tr' ? 'yaş' : 'y/o'}`} {p.sex && `| ${p.sex}`} | ID: {p.patient_id}
            </p>
          </div>
        </div>

        {/* Export Row */}
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={handleCopy} className="action-btn">
            {copied ? t(locale, 'copied') : t(locale, 'copy')}
          </button>
          <button onClick={() => handleExport('json')} className="action-btn">{t(locale, 'exportJSON')}</button>
          <button onClick={() => handleExport('markdown')} className="action-btn">{t(locale, 'exportMarkdown')}</button>
          <button onClick={() => handleExport('pdf')} className="action-btn">{t(locale, 'exportPDF')}</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-3 p-1 bg-cerebral-bg rounded-lg">
        {tabs.map(tb => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200
              ${tab === tb.key ? 'bg-cerebral-card text-cerebral-text' : 'text-cerebral-muted hover:text-cerebral-text'}`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="space-y-3">
        {tab === 'overview' && (
          <>
            {summary.clinical_timeline_summary && (
              <Section title={t(locale, 'clinicalTimeline')} color="teal">
                <p className="text-sm text-cerebral-muted leading-relaxed">{summary.clinical_timeline_summary}</p>
              </Section>
            )}
            {(summary.active_problems?.length ?? 0) > 0 && (
              <Section title={t(locale, 'activeProblems')} color="orange">
                {summary.active_problems!.map((x, i) => <Bullet key={i} color="orange" text={x} />)}
              </Section>
            )}
            {(summary.chronic_conditions?.length ?? 0) > 0 && (
              <Section title={t(locale, 'chronicConditions')} color="accent">
                {summary.chronic_conditions!.map((x, i) => <Bullet key={i} color="accent" text={x} />)}
              </Section>
            )}
            <Section title={t(locale, 'allergies')} color="red">
              {(summary.allergies?.length ?? 0) > 0
                ? summary.allergies!.map((x, i) => <Bullet key={i} color="red" text={x} />)
                : <p className="text-sm text-cerebral-green">{t(locale, 'noKnownAllergies')}</p>}
            </Section>
            {(summary.risk_factors?.length ?? 0) > 0 && (
              <Section title={t(locale, 'riskFactors')} color="orange">
                {summary.risk_factors!.map((x, i) => <Bullet key={i} color="orange" text={x} />)}
              </Section>
            )}
            {(summary.pre_visit_focus_areas?.length ?? 0) > 0 && (
              <Section title={t(locale, 'preVisitFocus')} color="green">
                {summary.pre_visit_focus_areas!.map((x, i) => <Bullet key={i} color="green" text={x} />)}
              </Section>
            )}
          </>
        )}

        {tab === 'history' && (summary.visit_history || []).map((v, i) => (
          <div key={i} className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-mono text-cerebral-teal">{v.date}</span>
              <span className="text-xs text-cerebral-muted">{v.department}</span>
            </div>
            <p className="text-xs text-cerebral-muted mb-1">{v.facility} — {v.doctor}</p>
            {v.diagnoses?.map((d, j) => (
              <div key={j} className="text-xs text-cerebral-text">
                <span className="text-cerebral-orange font-mono">[{d.icd_code}]</span> {d.name}
              </div>
            ))}
            {v.key_findings && <p className="text-xs text-cerebral-muted mt-1 italic">{v.key_findings}</p>}
          </div>
        ))}

        {tab === 'medications' && (
          <Section title={t(locale, 'currentMedications')} color="accent">
            {(summary.current_medications?.length ?? 0) > 0
              ? summary.current_medications!.map((m, i) => (
                  <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-cerebral-border/30 last:border-0">
                    <span className="text-cerebral-text font-medium">{m.name}</span>
                    <span className="text-cerebral-muted text-xs">{m.dose} — {m.frequency}</span>
                  </div>
                ))
              : <p className="text-sm text-cerebral-muted">{t(locale, 'noMedications')}</p>}
          </Section>
        )}

        {tab === 'labs' && (
          <>
            {(summary.recent_labs?.length ?? 0) > 0 ? (
              <Section title={t(locale, 'recentLabs')} color="teal">
                {summary.recent_labs!.map((l, i) => (
                  <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-cerebral-border/30 last:border-0">
                    <div>
                      <span className="text-cerebral-text">{l.test}</span>
                      <span className="text-xs text-cerebral-muted ml-2">{l.date}</span>
                    </div>
                    <span className={`font-mono text-xs px-2 py-0.5 rounded
                      ${l.flag === 'high' ? 'bg-cerebral-red/20 text-cerebral-red' :
                        l.flag === 'low' ? 'bg-cerebral-orange/20 text-cerebral-orange' :
                        'bg-cerebral-green/20 text-cerebral-green'}`}>
                      {l.value}
                    </span>
                  </div>
                ))}
              </Section>
            ) : (
              <div className="glass-card p-4 text-center text-sm text-cerebral-muted">{t(locale, 'noLabResults')}</div>
            )}
            {(summary.recent_imaging?.length ?? 0) > 0 && (
              <Section title={t(locale, 'recentImaging')} color="accent">
                {summary.recent_imaging!.map((img, i) => (
                  <div key={i} className="text-sm py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-cerebral-text font-medium">{img.type}</span>
                      <span className="text-xs text-cerebral-muted">{img.date}</span>
                    </div>
                    <p className="text-xs text-cerebral-muted mt-0.5">{img.findings}</p>
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  const colors: Record<string, string> = {
    accent: 'border-l-cerebral-accent', teal: 'border-l-cerebral-teal',
    green: 'border-l-cerebral-green', orange: 'border-l-cerebral-orange', red: 'border-l-cerebral-red',
  };
  return (
    <div className={`glass-card p-3 border-l-2 ${colors[color] || colors.accent}`}>
      <h4 className="text-xs font-semibold text-cerebral-text uppercase tracking-wider mb-2">{title}</h4>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Bullet({ color, text }: { color: string; text: string }) {
  const colors: Record<string, string> = {
    accent: 'bg-cerebral-accent', teal: 'bg-cerebral-teal',
    green: 'bg-cerebral-green', orange: 'bg-cerebral-orange', red: 'bg-cerebral-red',
  };
  return (
    <div className="flex items-start gap-2 text-sm text-cerebral-muted">
      <span className={`w-1.5 h-1.5 rounded-full ${colors[color] || colors.accent} mt-1.5 flex-shrink-0`} />
      {text}
    </div>
  );
}
