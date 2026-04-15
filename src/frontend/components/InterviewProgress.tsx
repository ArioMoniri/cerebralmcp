'use client';

import { Locale, t } from '@/lib/i18n';
import { Message } from '@/lib/types';

interface InterviewProgressProps {
  locale: Locale;
  chatHistory: Message[];
  isComplete: boolean;
}

const SECTIONS = [
  { key: 'demographics', keywords: ['yaş', 'isim', 'ad', 'cinsiyet', 'name', 'age', 'adınız'] },
  { key: 'chief_complaint', keywords: ['yakınma', 'şikayet', 'neden', 'complaint', 'bugün', 'ziyaret'] },
  { key: 'hpi', keywords: ['ne zaman', 'başladı', 'nasıl', 'süre', 'şiddet', 'ağrı', 'karakter'] },
  { key: 'pmh', keywords: ['kronik', 'hastalık', 'ameliyat', 'geçmiş', 'öykü', 'yatış'] },
  { key: 'medications', keywords: ['ilaç', 'tedavi', 'kullan', 'doz', 'medication', 'reçete'] },
  { key: 'allergies', keywords: ['alerji', 'allergy', 'reaksiyon', 'alerjiniz'] },
  { key: 'social', keywords: ['sigara', 'alkol', 'meslek', 'smoking', 'alcohol'] },
  { key: 'ros', keywords: ['sistem', 'sorgulama', 'nefes', 'ödem', 'baş ağrısı', 'çarpıntı'] },
] as const;

function detectCompleted(messages: Message[]): Set<string> {
  const completed = new Set<string>();
  const allText = messages.map(m => m.content.toLowerCase()).join(' ');
  for (const s of SECTIONS) {
    if (s.keywords.filter(kw => allText.includes(kw)).length >= 2) completed.add(s.key);
  }
  return completed;
}

export default function InterviewProgress({ locale, chatHistory, isComplete }: InterviewProgressProps) {
  const completed = detectCompleted(chatHistory);
  const userMsgs = chatHistory.filter(m => m.role === 'user').length;

  return (
    <div className="p-4 border-b border-cerebral-border">
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-cerebral-text">{t(locale, 'interviewProgress')}</h3>
          <span className="text-xs text-cerebral-muted">{completed.size}/{SECTIONS.length} {t(locale, 'sections')}</span>
        </div>

        <div className="w-full h-1.5 bg-cerebral-bg rounded-full mb-4 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cerebral-accent to-cerebral-teal rounded-full transition-all duration-500"
            style={{ width: `${isComplete ? 100 : (completed.size / SECTIONS.length) * 100}%` }}
          />
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-medium text-cerebral-muted uppercase tracking-wider">{t(locale, 'infoCollected')}</h4>
          {SECTIONS.map(s => (
            <div key={s.key} className="flex items-center gap-2.5">
              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0
                ${completed.has(s.key) ? 'border-cerebral-green bg-cerebral-green/20' : 'border-cerebral-border'}`}>
                {completed.has(s.key) && (
                  <svg className="w-2.5 h-2.5 text-cerebral-green" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </div>
              <span className={`text-sm ${completed.has(s.key) ? 'text-cerebral-text' : 'text-cerebral-muted'}`}>
                {t(locale, `section.${s.key}` as any)}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-3 border-t border-cerebral-border/50 flex items-center justify-between">
          <span className="text-xs text-cerebral-muted">{t(locale, 'questionsAnswered')}</span>
          <span className="text-sm font-mono font-semibold text-cerebral-text">{userMsgs}</span>
        </div>
      </div>
    </div>
  );
}
