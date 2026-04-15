'use client';

import { useState } from 'react';
import { Locale, t } from '@/lib/i18n';
import { Message, PatientIdentity, PatientSummary } from '@/lib/types';

interface Props {
  locale: Locale;
  sessionId: string;
  identity: PatientIdentity;
  summary: PatientSummary | null;
  chatHistory: Message[];
  clinicalReport: string | null;
  setClinicalReport: (r: string) => void;
  onNewInterview: () => void;
}

export default function CompletionScreen({
  locale, sessionId, identity, summary, chatHistory, clinicalReport, setClinicalReport, onNewInterview,
}: Props) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [activeExport, setActiveExport] = useState<string | null>(null);

  const generateReport = async () => {
    setIsGenerating(true);
    try {
      const res = await fetch(`/api/session/${sessionId}/generate-report`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setClinicalReport(data.report);
        setShowReport(true);
      }
    } catch (err) {
      console.error('Report generation failed:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const exportAs = (format: string) => {
    setActiveExport(format);
    const content = clinicalReport || JSON.stringify(summary, null, 2);
    const name = `previsit_${identity.firstName}_${identity.lastName}_${summary?.patient?.patient_id || ''}`;

    if (format === 'json') {
      download(JSON.stringify({ summary, chatHistory, report: clinicalReport }, null, 2), `${name}.json`, 'application/json');
    } else if (format === 'markdown') {
      download(content, `${name}.md`, 'text/markdown');
    } else if (format === 'pdf') {
      import('jspdf').then(({ jsPDF }) => {
        const doc = new jsPDF();
        doc.setFontSize(12);
        const lines = doc.splitTextToSize(content, 170);
        let y = 20;
        for (const line of lines) {
          if (y > 280) { doc.addPage(); y = 20; }
          doc.text(line, 20, y);
          y += 6;
        }
        doc.save(`${name}.pdf`);
      });
    } else if (format === 'copy') {
      navigator.clipboard.writeText(content);
    }
    setTimeout(() => setActiveExport(null), 1500);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 fade-in">
      {/* Success Animation */}
      <div className="check-circle w-20 h-20 rounded-full bg-cerebral-green/20 flex items-center justify-center mb-6">
        <svg className="w-10 h-10 text-cerebral-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <h2 className="text-2xl font-bold text-cerebral-text mb-2">{t(locale, 'interviewComplete')}</h2>
      <p className="text-lg text-cerebral-green font-medium mb-2">{t(locale, 'thankYou')}</p>
      <p className="text-sm text-cerebral-muted text-center max-w-md mb-8">
        {t(locale, 'completeMessage')}
      </p>

      {/* Continue to doctor banner */}
      <div className="glass-card glow-green px-8 py-4 mb-8 text-center">
        <p className="text-lg font-semibold text-cerebral-green">
          {t(locale, 'continueToDoctor')}
        </p>
      </div>

      {/* Report Actions */}
      <div className="flex flex-col items-center gap-4 w-full max-w-md">
        {!clinicalReport && (
          <button
            onClick={generateReport}
            disabled={isGenerating}
            className="w-full py-3 bg-gradient-to-r from-cerebral-accent to-cerebral-teal
                       text-white font-semibold rounded-xl hover:opacity-90
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-all duration-200 flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <>
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {locale === 'tr' ? 'Rapor oluşturuluyor...' : 'Generating report...'}
              </>
            ) : t(locale, 'downloadReport')}
          </button>
        )}

        {clinicalReport && (
          <>
            <button
              onClick={() => setShowReport(!showReport)}
              className="w-full py-3 border border-cerebral-accent text-cerebral-accent rounded-xl
                         hover:bg-cerebral-accent/10 transition-all duration-200"
            >
              {showReport ? (locale === 'tr' ? 'Raporu Gizle' : 'Hide Report') : t(locale, 'viewSummary')}
            </button>

            {/* Export buttons */}
            <div className="flex gap-2 w-full">
              {['copy', 'json', 'markdown', 'pdf'].map(fmt => (
                <button
                  key={fmt}
                  onClick={() => exportAs(fmt)}
                  className="flex-1 py-2 text-sm action-btn justify-center"
                >
                  {activeExport === fmt
                    ? (fmt === 'copy' ? t(locale, 'copied') : '...')
                    : fmt === 'copy' ? t(locale, 'copy') : fmt.toUpperCase()}
                </button>
              ))}
            </div>

            {showReport && (
              <div className="w-full glass-card p-4 mt-2 max-h-96 overflow-y-auto">
                <pre className="text-xs text-cerebral-muted whitespace-pre-wrap font-mono leading-relaxed">
                  {clinicalReport}
                </pre>
              </div>
            )}
          </>
        )}

        <button
          onClick={onNewInterview}
          className="w-full py-3 border border-cerebral-border text-cerebral-muted rounded-xl
                     hover:text-cerebral-text hover:border-cerebral-accent/50
                     transition-all duration-200 mt-4"
        >
          {t(locale, 'newInterview')}
        </button>
      </div>
    </div>
  );
}

function download(content: string, filename: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
}
