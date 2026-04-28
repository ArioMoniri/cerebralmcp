'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { diffWords } from 'diff';
import { Locale } from '@/lib/i18n';

interface Props {
  locale: Locale;
  sessionId: string;
  /** Bumped by ChatInterface after each completed turn — triggers a refetch. */
  refreshKey: number;
  /** Total user turns required (5 in our protocol). */
  maxTurns?: number;
}

/**
 * Live, progressively-built HPI report panel.
 *
 * After every chat turn the parent bumps `refreshKey`, which triggers a POST
 * to /api/session/{id}/hpi-draft. The new markdown is diffed against the
 * previous version with word-level granularity and rendered inline:
 *   - additions     → green
 *   - deletions     → red strikethrough
 *   - unchanged     → normal
 *
 * After ~4 seconds the diff "settles" into a clean rendered view (so the
 * doctor can read the final report without diff noise) — the next turn
 * reintroduces the diff highlights. This matches the editorial mark-up
 * style in the screenshot the user provided.
 */
export default function LiveHPIReport({ locale, sessionId, refreshKey, maxTurns = 5 }: Props) {
  const [currentReport, setCurrentReport] = useState<string>('');
  const [previousReport, setPreviousReport] = useState<string>('');
  const [turnCount, setTurnCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const settleTimerRef = useRef<number | null>(null);
  const isFirstFetch = useRef(true);

  useEffect(() => {
    if (refreshKey === 0) return; // skip the very first render before any turn

    let cancelled = false;
    setIsLoading(true);

    const apiBase =
      process.env.NEXT_PUBLIC_API_URL ||
      (typeof window !== 'undefined'
        ? `${window.location.protocol}//${window.location.hostname}:8000`
        : 'http://localhost:8000');

    fetch(`${apiBase}/api/session/${sessionId}/hpi-draft`, { method: 'POST' })
      .then(r => (r.ok ? r.json() : null))
      .then(payload => {
        if (cancelled || !payload) return;
        const newReport: string = payload.report || '';
        const newTurnCount: number = payload.turn_count ?? 0;

        setPreviousReport(currentReport);
        setCurrentReport(newReport);
        setTurnCount(newTurnCount);

        // Show the diff highlights briefly, then settle to a clean read.
        setShowDiff(true);
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = window.setTimeout(() => {
          setShowDiff(false);
        }, 6000);

        isFirstFetch.current = false;
      })
      .catch(() => { /* silent */ })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, sessionId]);

  const heading = locale === 'tr' ? 'Canlı Ön-Görüşme Raporu' : 'Live Pre-Visit Report';
  const turnLabel = locale === 'tr' ? 'Tur' : 'Turn';
  const updatingLabel = locale === 'tr' ? 'Güncelleniyor…' : 'Updating…';
  const waitingLabel =
    locale === 'tr'
      ? 'Hasta konuştukça rapor burada oluşturulacak.'
      : 'The report will build here as the patient speaks.';

  return (
    <div className="p-4 border-b border-cerebral-border">
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-cerebral-text flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-cerebral-teal animate-pulse" />
            {heading}
          </h3>
          <div className="flex items-center gap-2 text-xs">
            {isLoading && <span className="text-cerebral-muted">{updatingLabel}</span>}
            <span className="px-2 py-0.5 rounded-full bg-cerebral-accent/10 text-cerebral-accent border border-cerebral-accent/20">
              {turnLabel} {turnCount} / {maxTurns}
            </span>
          </div>
        </div>

        <div className="w-full h-1 bg-cerebral-bg rounded-full mb-4 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cerebral-accent to-cerebral-teal rounded-full transition-all duration-700"
            style={{ width: `${Math.min(100, (turnCount / maxTurns) * 100)}%` }}
          />
        </div>

        {!currentReport ? (
          <div className="text-xs text-cerebral-muted italic py-6 text-center">
            {waitingLabel}
          </div>
        ) : (
          <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none hpi-report">
            {showDiff && previousReport ? (
              <DiffRender oldText={previousReport} newText={currentReport} />
            ) : (
              <ReactMarkdown>{currentReport}</ReactMarkdown>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Word-level diff renderer. Walks the markdown as plain text (preserving
 * paragraph breaks and bold/header markers) and inlines <ins>/<del> tags.
 * The added/removed runs are styled in globals.css under .hpi-report.
 */
function DiffRender({ oldText, newText }: { oldText: string; newText: string }) {
  // Word-level diff with intra-word fallback so punctuation and newlines
  // are preserved. The `diff` package returns a list of {value, added,
  // removed} parts in document order.
  const parts = diffWords(oldText, newText);

  // Convert each part into raw markdown wrapped in HTML-ish span markers,
  // then run the assembled string through ReactMarkdown with rehype-raw.
  // Simpler approach: emit React nodes directly, but split on newlines so
  // blank lines still produce paragraph breaks visually.
  return (
    <div className="whitespace-pre-wrap">
      {parts.map((p, i) => {
        if (p.added) {
          return (
            <span
              key={i}
              className="text-emerald-400 bg-emerald-500/10 rounded px-0.5"
            >
              {p.value}
            </span>
          );
        }
        if (p.removed) {
          return (
            <span
              key={i}
              className="text-red-400 line-through bg-red-500/10 rounded px-0.5"
            >
              {p.value}
            </span>
          );
        }
        return <span key={i}>{p.value}</span>;
      })}
    </div>
  );
}
