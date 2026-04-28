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
      <div
        className={`hpi-card relative rounded-2xl p-5 overflow-hidden transition-all duration-500
          ${isLoading || showDiff ? 'hpi-card-glow' : ''}`}
      >
        {/* Animated gradient border on update */}
        <div className="hpi-card-border" aria-hidden />

        <div className="relative">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cerebral-teal opacity-60" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cerebral-teal" />
              </span>
              <h3 className="text-sm font-semibold tracking-wide text-cerebral-text">
                {heading}
              </h3>
            </div>
            <div className="flex items-center gap-2 text-xs">
              {isLoading && (
                <span className="text-cerebral-muted flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-cerebral-teal animate-pulse" />
                  {updatingLabel}
                </span>
              )}
            </div>
          </div>

          {/* 5-dot turn indicator — fills as the patient progresses */}
          <div className="flex items-center justify-between mb-4 px-1">
            <div className="flex items-center gap-1.5 flex-1">
              {Array.from({ length: maxTurns }).map((_, i) => {
                const completed = i < turnCount;
                const active = i === turnCount && turnCount < maxTurns;
                return (
                  <div key={i} className="flex items-center flex-1 last:flex-initial">
                    <div
                      className={`relative w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold transition-all duration-500
                        ${completed
                          ? 'bg-gradient-to-br from-cerebral-accent to-cerebral-teal text-white shadow-lg shadow-cerebral-accent/30'
                          : active
                            ? 'bg-cerebral-accent/20 text-cerebral-accent border-2 border-cerebral-accent animate-pulse'
                            : 'bg-cerebral-bg text-cerebral-muted border border-cerebral-border'}`}
                    >
                      {completed ? (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        i + 1
                      )}
                    </div>
                    {i < maxTurns - 1 && (
                      <div
                        className={`flex-1 h-[2px] mx-1 rounded transition-all duration-700
                          ${i < turnCount - 1
                            ? 'bg-gradient-to-r from-cerebral-accent to-cerebral-teal'
                            : 'bg-cerebral-border'}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <span className="ml-3 px-2.5 py-1 rounded-full bg-cerebral-accent/10 text-cerebral-accent border border-cerebral-accent/30 text-[11px] font-semibold">
              {turnLabel} {turnCount}/{maxTurns}
            </span>
          </div>

          {!currentReport ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="w-12 h-12 rounded-full bg-cerebral-accent/10 flex items-center justify-center">
                <svg className="w-6 h-6 text-cerebral-accent/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="text-xs text-cerebral-muted italic max-w-[260px]">
                {waitingLabel}
              </div>
            </div>
          ) : (
            <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none hpi-report relative">
              {showDiff && previousReport ? (
                <DiffRender oldText={previousReport} newText={currentReport} />
              ) : (
                <ReactMarkdown>{currentReport}</ReactMarkdown>
              )}
            </div>
          )}
        </div>
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
  // Word-level diff with intra-word fallback so punctuation and newlines are
  // preserved. The `diff` package returns parts in document order.
  const parts = diffWords(oldText, newText);

  // Render each part with a staggered fade-in so the editorial mark-up feels
  // like the report is being typed/edited live rather than appearing all at once.
  let staggerIdx = 0;
  return (
    <div className="whitespace-pre-wrap">
      {parts.map((p, i) => {
        if (p.added) {
          const delay = `${Math.min(40, staggerIdx++) * 25}ms`;
          return (
            <span
              key={i}
              className="hpi-diff-add"
              style={{ animationDelay: delay }}
            >
              {p.value}
            </span>
          );
        }
        if (p.removed) {
          return (
            <span key={i} className="hpi-diff-del">
              {p.value}
            </span>
          );
        }
        return <span key={i}>{p.value}</span>;
      })}
    </div>
  );
}
