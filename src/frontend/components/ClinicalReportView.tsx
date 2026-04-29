'use client';

import ReactMarkdown, { Components } from 'react-markdown';
import { Locale } from '@/lib/i18n';
import { PatientIdentity, PatientSummary } from '@/lib/types';
import { useMemo } from 'react';

interface Props {
  locale: Locale;
  report: string;
  identity: PatientIdentity;
  summary: PatientSummary | null;
  department?: string;
}

/**
 * Polished clinical report view — replaces the old <pre> mono-font dump.
 *
 * Structure recognized:
 *   - H1/H2 = section headings (we render with icon + accent)
 *   - "[EHR]" / "[Görüşme]" / "[Tutarsızlık]" inline tags → coloured pills
 *   - sections by title (warnings, focus areas, etc.) get their own
 *     border/background tint
 *
 * The agent's output is markdown so ReactMarkdown handles it natively;
 * we only override headings + paragraphs + lists for visual polish.
 */
export default function ClinicalReportView({ locale, report, identity, summary, department }: Props) {
  const patient = summary?.patient || {};
  const today = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString(locale === 'tr' ? 'tr-TR' : 'en-US', {
      day: '2-digit', month: 'long', year: 'numeric',
    });
  }, [locale]);

  // Split markdown into sections by H3 (### Başvuru Yakınması ...) so each
  // section can render in its own card.
  const sections = useMemo(() => splitSections(report), [report]);

  return (
    <div className="report-view w-full max-w-3xl mx-auto fade-in space-y-4">
      {/* ─── Header card ─── */}
      <div className="report-card-hero">
        <div className="flex items-start gap-4">
          <div className="hero-avatar">
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-cerebral-muted/70 font-semibold">
              {locale === 'tr' ? 'Pre-Vizit Hasta Ön-Görüşme Özeti' : 'Pre-Visit Patient Summary'}
            </div>
            <div className="mt-1 flex items-baseline gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-cerebral-text">
                {patient.name || `${identity.firstName} ${identity.lastName}`}
              </h1>
              {patient.age && (
                <span className="text-sm text-cerebral-muted">
                  {patient.age} {locale === 'tr' ? 'yaş' : 'yo'}
                </span>
              )}
              {patient.sex && patient.sex !== 'Not specified' && (
                <span className="text-sm text-cerebral-muted">· {patient.sex}</span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {patient.patient_id && (
                <Pill label={locale === 'tr' ? 'Hasta No' : 'Patient ID'} value={patient.patient_id} accent="slate" />
              )}
              {department && (
                <Pill label={locale === 'tr' ? 'Poliklinik' : 'Clinic'} value={department} accent="indigo" />
              )}
              <Pill label={locale === 'tr' ? 'Tarih' : 'Date'} value={today} accent="slate" />
              <Pill
                label={locale === 'tr' ? 'Yöntem' : 'Method'}
                value={locale === 'tr' ? 'AI Ön-Görüşme (3 soru)' : 'AI Pre-Visit (3 Q)'}
                accent="teal"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ─── Section cards ─── */}
      {sections.map((section, i) => (
        <SectionCard
          key={i}
          locale={locale}
          title={section.title}
          body={section.body}
        />
      ))}

      {/* ─── EHR snapshot (compact pills) ─── */}
      {summary && (
        <EhrSnapshotCard locale={locale} summary={summary} />
      )}

      <div className="text-[10px] text-cerebral-muted/60 text-center pt-2 pb-1">
        {locale === 'tr'
          ? 'Bu rapor AI tarafından oluşturulmuştur · Tedavi eden hekim için referans amaçlıdır'
          : 'AI-generated · Reference for the treating physician'}
      </div>
    </div>
  );
}

// ── Section card with icon + tinted accent based on title ──────────────
function SectionCard({ locale, title, body }: { locale: Locale; title: string; body: string }) {
  const variant = sectionVariant(title);
  return (
    <div className={`report-card report-card-${variant.tint}`}>
      <div className="flex items-center gap-2 mb-3">
        <div className={`section-icon section-icon-${variant.tint}`}>
          {variant.icon}
        </div>
        <h2 className="text-sm font-semibold tracking-wide text-cerebral-text">
          {cleanTitle(title)}
        </h2>
        {extractTag(title) && (
          <span className={`ml-auto text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full
            ${tagColor(extractTag(title)!)}`}>
            {extractTag(title)}
          </span>
        )}
      </div>
      <div className="text-sm leading-relaxed prose prose-sm prose-invert max-w-none report-prose">
        <ReactMarkdown components={mdComponents}>{body.trim()}</ReactMarkdown>
      </div>
    </div>
  );
}

// ── EHR snapshot — quick-scan pills for active problems / meds / allergies ─
function EhrSnapshotCard({ locale, summary }: { locale: Locale; summary: PatientSummary }) {
  const hasAnything =
    (summary.active_problems?.length ?? 0) > 0 ||
    (summary.chronic_conditions?.length ?? 0) > 0 ||
    (summary.current_medications?.length ?? 0) > 0 ||
    (summary.allergies?.length ?? 0) > 0;
  if (!hasAnything) return null;

  return (
    <div className="report-card report-card-slate">
      <div className="flex items-center gap-2 mb-3">
        <div className="section-icon section-icon-slate">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
          </svg>
        </div>
        <h2 className="text-sm font-semibold tracking-wide text-cerebral-text">
          {locale === 'tr' ? 'EHR Anlık Görüntü' : 'EHR Snapshot'}
        </h2>
        <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-300 border border-slate-500/30">
          EHR
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        {(summary.active_problems?.length ?? 0) > 0 && (
          <Block title={locale === 'tr' ? 'Aktif Problemler' : 'Active Problems'} accent="rose">
            {summary.active_problems!.map((p, i) => <Tag key={i} variant="rose">{p}</Tag>)}
          </Block>
        )}
        {(summary.chronic_conditions?.length ?? 0) > 0 && (
          <Block title={locale === 'tr' ? 'Kronik Hastalıklar' : 'Chronic Conditions'} accent="amber">
            {summary.chronic_conditions!.map((c, i) => <Tag key={i} variant="amber">{c}</Tag>)}
          </Block>
        )}
        {(summary.current_medications?.length ?? 0) > 0 && (
          <Block title={locale === 'tr' ? 'Düzenli İlaçlar' : 'Current Medications'} accent="indigo">
            {summary.current_medications!.map((m, i) => (
              <Tag key={i} variant="indigo">
                {m.name} {m.dose && <span className="opacity-70">{m.dose}</span>} {m.frequency && <span className="opacity-70">· {m.frequency}</span>}
              </Tag>
            ))}
          </Block>
        )}
        {(summary.allergies?.length ?? 0) > 0 && (
          <Block title={locale === 'tr' ? 'Alerjiler' : 'Allergies'} accent="rose">
            {summary.allergies!.map((a, i) => <Tag key={i} variant="rose">{a}</Tag>)}
          </Block>
        )}
      </div>
    </div>
  );
}

function Block({ title, accent: _accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div className="bg-cerebral-bg/40 border border-cerebral-border/50 rounded-lg p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-cerebral-muted mb-2">{title}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Tag({ variant, children }: { variant: 'rose' | 'amber' | 'indigo' | 'teal' | 'slate'; children: React.ReactNode }) {
  const styles = {
    rose:  'bg-rose-500/10 text-rose-300 border-rose-500/30',
    amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    indigo: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30',
    teal:  'bg-teal-500/10 text-teal-300 border-teal-500/30',
    slate: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  }[variant];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] rounded-md border ${styles}`}>
      {children}
    </span>
  );
}

function Pill({ label, value, accent }: { label: string; value: string; accent: 'slate' | 'indigo' | 'teal' }) {
  const colour = {
    slate: 'border-slate-500/30 bg-slate-500/5',
    indigo: 'border-cerebral-accent/40 bg-cerebral-accent/5',
    teal: 'border-cerebral-teal/40 bg-cerebral-teal/5',
  }[accent];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${colour}`}>
      <span className="text-[9px] uppercase tracking-wider text-cerebral-muted/70 font-semibold">{label}</span>
      <span className="text-cerebral-text font-medium">{value}</span>
    </span>
  );
}

// ── Markdown component overrides ──────────────────────────────────────
const mdComponents: Components = {
  p: ({ children }) => <p className="my-1.5 text-cerebral-text/90">{children}</p>,
  strong: ({ children }) => <strong className="text-cerebral-text font-semibold">{children}</strong>,
  em: ({ children }) => <em className="text-cerebral-muted italic">{children}</em>,
  ul: ({ children }) => <ul className="my-2 space-y-1.5 list-none pl-0">{children}</ul>,
  li: ({ children }) => (
    <li className="flex items-start gap-2 text-cerebral-text/90">
      <span className="mt-1.5 inline-block w-1 h-1 rounded-full bg-cerebral-accent/60 flex-shrink-0" />
      <span className="flex-1">{children}</span>
    </li>
  ),
  hr: () => <div className="my-3 h-px bg-gradient-to-r from-transparent via-cerebral-border to-transparent" />,
  code: ({ children }) => (
    <code className="px-1 py-0.5 rounded bg-cerebral-bg/60 text-cerebral-accent text-[12px] font-mono">
      {children}
    </code>
  ),
};

// ── Helpers ────────────────────────────────────────────────────────────
function splitSections(md: string): { title: string; body: string }[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: { title: string; body: string }[] = [];
  let curTitle = '';
  let curBody: string[] = [];
  const flush = () => {
    if (curTitle) out.push({ title: curTitle, body: curBody.join('\n') });
    curTitle = '';
    curBody = [];
  };

  for (const line of lines) {
    // Skip the H1 title line; we render our own header
    if (/^#\s+PRE-V/i.test(line) || /^#\s+PRE-VISIT/i.test(line)) continue;
    // Skip horizontal-rule decorations (────, ====, etc.)
    if (/^[─=\-]{3,}\s*$/.test(line.trim())) continue;
    // Skip pre-section meta lines (Hasta:, Poliklinik:, Tarih:, ...)
    // We render those via our own header from `summary`/`identity`.
    if (!curTitle && /^\s*\*?\*?(Hasta|Poliklinik|Tarih|Görüşme Yöntemi|Patient|Clinic|Date|Method)\b/i.test(line)) continue;

    const headingMatch = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      curTitle = headingMatch[1];
      continue;
    }
    if (curTitle) curBody.push(line);
  }
  flush();
  return out.filter(s => s.body.trim().length > 0);
}

function cleanTitle(title: string): string {
  return title.replace(/\*?\[(EHR|Görüşme|Tutarsızlık|Interview)\]\*?/gi, '').replace(/\s+$/, '').trim();
}

function extractTag(title: string): string | null {
  const m = title.match(/\[(EHR|Görüşme|Interview|Tutarsızlık)\]/i);
  return m ? m[1] : null;
}

function tagColor(tag: string): string {
  switch (tag.toLowerCase()) {
    case 'ehr': return 'bg-slate-500/15 text-slate-300 border border-slate-500/30';
    case 'görüşme':
    case 'interview': return 'bg-teal-500/15 text-teal-300 border border-teal-500/30';
    case 'tutarsızlık': return 'bg-rose-500/15 text-rose-300 border border-rose-500/30';
    default: return 'bg-cerebral-card text-cerebral-muted border border-cerebral-border';
  }
}

function sectionVariant(title: string): { tint: 'teal' | 'amber' | 'rose' | 'indigo' | 'slate'; icon: React.ReactNode } {
  const t = title.toLowerCase();
  if (t.includes('başvuru') || t.includes('chief complaint') || t.includes('yakınma')) {
    return {
      tint: 'rose',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0l-7.1 12.25A2 2 0 005 19z" />
      </svg>,
    };
  }
  if (t.includes('hpi') || t.includes('öyküs') || t.includes('history of present')) {
    return {
      tint: 'indigo',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>,
    };
  }
  if (t.includes('endişe') || t.includes('teorisi') || t.includes('concern')) {
    return {
      tint: 'teal',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093V14m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>,
    };
  }
  if (t.includes('özgeçmiş') || t.includes('past medical') || t.includes('ilaçlar') || t.includes('medications')) {
    return {
      tint: 'slate',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
      </svg>,
    };
  }
  if (t.includes('tutarsız') || t.includes('discrepan')) {
    return {
      tint: 'rose',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>,
    };
  }
  if (t.includes('eksik') || t.includes('doğrulanması') || t.includes('missing') || t.includes('verify') || t.includes('⚠')) {
    return {
      tint: 'amber',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
      </svg>,
    };
  }
  if (t.includes('odak') || t.includes('focus') || t.includes('öneri')) {
    return {
      tint: 'teal',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M5 13l4 4L19 7" />
      </svg>,
    };
  }
  if (t.includes('klinik bağlam') || t.includes('clinical context')) {
    return {
      tint: 'indigo',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
      </svg>,
    };
  }
  return {
    tint: 'slate',
    icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h7" />
    </svg>,
  };
}
