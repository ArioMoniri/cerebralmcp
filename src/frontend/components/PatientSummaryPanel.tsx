'use client';

import { useState } from 'react';

interface PatientSummaryPanelProps {
  summary: any;
  sessionId: string;
}

type ExportFormat = 'json' | 'markdown' | 'pdf' | 'copy';
type ActiveTab = 'overview' | 'history' | 'medications' | 'labs';

export default function PatientSummaryPanel({ summary, sessionId }: PatientSummaryPanelProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [copied, setCopied] = useState(false);

  if (!summary) return null;

  const patient = summary.patient || {};

  const handleExport = async (format: ExportFormat) => {
    if (format === 'copy') {
      await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    }

    if (format === 'json') {
      const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `patient_${patient.patient_id || 'export'}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (format === 'markdown') {
      try {
        const res = await fetch(`/api/export/${sessionId}/markdown`);
        const text = await res.text();
        const blob = new Blob([text], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `patient_${patient.patient_id || 'export'}.md`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Export failed:', err);
      }
      return;
    }

    if (format === 'pdf') {
      try {
        const { jsPDF } = await import('jspdf');
        const doc = new jsPDF();
        doc.setFontSize(16);
        doc.text('Patient Summary', 20, 20);
        doc.setFontSize(10);

        const lines = [
          `Patient: ${patient.name || 'N/A'}`,
          `Age: ${patient.age || 'N/A'}`,
          `ID: ${patient.patient_id || 'N/A'}`,
          '',
          'Active Problems:',
          ...(summary.active_problems || []).map((p: string) => `  - ${p}`),
          '',
          'Chronic Conditions:',
          ...(summary.chronic_conditions || []).map((c: string) => `  - ${c}`),
          '',
          'Medications:',
          ...(summary.current_medications || []).map((m: any) =>
            `  - ${m.name} ${m.dose} ${m.frequency}`
          ),
          '',
          'Timeline:',
          summary.clinical_timeline_summary || 'N/A',
        ];

        let y = 35;
        for (const line of lines) {
          if (y > 280) {
            doc.addPage();
            y = 20;
          }
          doc.text(line, 20, y);
          y += 6;
        }

        doc.save(`patient_${patient.patient_id || 'export'}.pdf`);
      } catch (err) {
        console.error('PDF generation failed:', err);
      }
    }
  };

  const tabs = [
    { key: 'overview' as ActiveTab, label: 'Overview' },
    { key: 'history' as ActiveTab, label: 'History' },
    { key: 'medications' as ActiveTab, label: 'Meds' },
    { key: 'labs' as ActiveTab, label: 'Labs' },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {/* Patient Header Card */}
      <div className="glass-card p-4 mb-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-cerebral-accent/20 flex items-center justify-center">
            <svg className="w-5 h-5 text-cerebral-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-cerebral-text">{patient.name || 'Patient'}</h3>
            <p className="text-xs text-cerebral-muted">
              {patient.age && `${patient.age} yaş`} {patient.sex && `| ${patient.sex}`} | ID: {patient.patient_id}
            </p>
          </div>
        </div>

        {/* Export Buttons */}
        <div className="flex gap-1.5 flex-wrap">
          {[
            { format: 'copy' as ExportFormat, label: copied ? 'Copied!' : 'Copy', icon: '📋' },
            { format: 'json' as ExportFormat, label: 'JSON', icon: '{ }' },
            { format: 'markdown' as ExportFormat, label: 'MD', icon: '📝' },
            { format: 'pdf' as ExportFormat, label: 'PDF', icon: '📄' },
          ].map(({ format, label, icon }) => (
            <button
              key={format}
              onClick={() => handleExport(format)}
              className="px-2.5 py-1 text-xs bg-cerebral-bg border border-cerebral-border rounded-lg
                         text-cerebral-muted hover:text-cerebral-text hover:border-cerebral-accent/50
                         transition-all duration-200"
            >
              <span className="mr-1">{icon}</span>{label}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-3 p-1 bg-cerebral-bg rounded-lg">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200
              ${activeTab === tab.key
                ? 'bg-cerebral-card text-cerebral-text'
                : 'text-cerebral-muted hover:text-cerebral-text'
              }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="space-y-3">
        {activeTab === 'overview' && (
          <>
            {/* Timeline Summary */}
            {summary.clinical_timeline_summary && (
              <SummarySection title="Clinical Timeline" color="teal">
                <p className="text-sm text-cerebral-muted leading-relaxed">
                  {summary.clinical_timeline_summary}
                </p>
              </SummarySection>
            )}

            {/* Active Problems */}
            {summary.active_problems?.length > 0 && (
              <SummarySection title="Active Problems" color="orange">
                {summary.active_problems.map((p: string, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-cerebral-muted">
                    <span className="w-1.5 h-1.5 rounded-full bg-cerebral-orange mt-1.5 flex-shrink-0" />
                    {p}
                  </div>
                ))}
              </SummarySection>
            )}

            {/* Chronic Conditions */}
            {summary.chronic_conditions?.length > 0 && (
              <SummarySection title="Chronic Conditions" color="accent">
                {summary.chronic_conditions.map((c: string, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-cerebral-muted">
                    <span className="w-1.5 h-1.5 rounded-full bg-cerebral-accent mt-1.5 flex-shrink-0" />
                    {c}
                  </div>
                ))}
              </SummarySection>
            )}

            {/* Allergies */}
            <SummarySection title="Allergies" color="red">
              {(summary.allergies?.length > 0) ? (
                summary.allergies.map((a: string, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-cerebral-muted">
                    <span className="w-1.5 h-1.5 rounded-full bg-cerebral-red mt-1.5 flex-shrink-0" />
                    {a}
                  </div>
                ))
              ) : (
                <p className="text-sm text-cerebral-green">Bilinen alerji yok</p>
              )}
            </SummarySection>

            {/* Focus Areas */}
            {summary.pre_visit_focus_areas?.length > 0 && (
              <SummarySection title="Pre-Visit Focus Areas" color="green">
                {summary.pre_visit_focus_areas.map((f: string, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-cerebral-muted">
                    <span className="w-1.5 h-1.5 rounded-full bg-cerebral-green mt-1.5 flex-shrink-0" />
                    {f}
                  </div>
                ))}
              </SummarySection>
            )}
          </>
        )}

        {activeTab === 'history' && (
          <>
            {(summary.visit_history || []).map((v: any, i: number) => (
              <div key={i} className="glass-card p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-mono text-cerebral-teal">{v.date}</span>
                  <span className="text-xs text-cerebral-muted">{v.department}</span>
                </div>
                <p className="text-xs text-cerebral-muted mb-1">{v.facility} — {v.doctor}</p>
                {v.diagnoses?.map((d: any, j: number) => (
                  <div key={j} className="text-xs text-cerebral-text">
                    <span className="text-cerebral-orange font-mono">[{d.icd_code}]</span> {d.name}
                  </div>
                ))}
                {v.key_findings && (
                  <p className="text-xs text-cerebral-muted mt-1 italic">{v.key_findings}</p>
                )}
              </div>
            ))}
          </>
        )}

        {activeTab === 'medications' && (
          <SummarySection title="Current Medications" color="accent">
            {(summary.current_medications || []).map((m: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-cerebral-border/30 last:border-0">
                <span className="text-cerebral-text font-medium">{m.name}</span>
                <span className="text-cerebral-muted text-xs">{m.dose} — {m.frequency}</span>
              </div>
            ))}
            {(!summary.current_medications || summary.current_medications.length === 0) && (
              <p className="text-sm text-cerebral-muted">Düzenli ilaç kullanımı yok</p>
            )}
          </SummarySection>
        )}

        {activeTab === 'labs' && (
          <>
            {(summary.recent_labs || []).length > 0 ? (
              <SummarySection title="Recent Lab Results" color="teal">
                {summary.recent_labs.map((l: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-cerebral-border/30 last:border-0">
                    <div>
                      <span className="text-cerebral-text">{l.test}</span>
                      <span className="text-xs text-cerebral-muted ml-2">{l.date}</span>
                    </div>
                    <span className={`font-mono text-xs px-2 py-0.5 rounded
                      ${l.flag === 'high' ? 'bg-cerebral-red/20 text-cerebral-red' :
                        l.flag === 'low' ? 'bg-cerebral-orange/20 text-cerebral-orange' :
                        'bg-cerebral-green/20 text-cerebral-green'}`}
                    >
                      {l.value}
                    </span>
                  </div>
                ))}
              </SummarySection>
            ) : (
              <div className="glass-card p-4 text-center text-sm text-cerebral-muted">
                No recent lab results available
              </div>
            )}

            {(summary.recent_imaging || []).length > 0 && (
              <SummarySection title="Recent Imaging" color="accent">
                {summary.recent_imaging.map((img: any, i: number) => (
                  <div key={i} className="text-sm py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-cerebral-text font-medium">{img.type}</span>
                      <span className="text-xs text-cerebral-muted">{img.date}</span>
                    </div>
                    <p className="text-xs text-cerebral-muted mt-0.5">{img.findings}</p>
                  </div>
                ))}
              </SummarySection>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SummarySection({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  const colorMap: Record<string, string> = {
    accent: 'border-l-cerebral-accent',
    teal: 'border-l-cerebral-teal',
    green: 'border-l-cerebral-green',
    orange: 'border-l-cerebral-orange',
    red: 'border-l-cerebral-red',
  };

  return (
    <div className={`glass-card p-3 border-l-2 ${colorMap[color] || 'border-l-cerebral-accent'}`}>
      <h4 className="text-xs font-semibold text-cerebral-text uppercase tracking-wider mb-2">{title}</h4>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
