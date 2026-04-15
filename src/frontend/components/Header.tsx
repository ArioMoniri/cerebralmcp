'use client';

import { Locale, t } from '@/lib/i18n';

interface HeaderProps {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export default function Header({ locale, setLocale }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 py-3 bg-cerebral-surface border-b border-cerebral-border">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-gradient-to-br from-cerebral-accent to-cerebral-teal rounded-lg flex items-center justify-center">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <div>
          <h1 className="text-lg font-semibold text-cerebral-text">{t(locale, 'appName')}</h1>
          <p className="text-xs text-cerebral-muted">{t(locale, 'appSubtitle')}</p>
        </div>
      </div>

      {/* Language Toggle */}
      <div className="flex items-center gap-1 p-1 bg-cerebral-bg rounded-lg border border-cerebral-border">
        <button
          onClick={() => setLocale('tr')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200
            ${locale === 'tr' ? 'bg-cerebral-card text-cerebral-text' : 'text-cerebral-muted hover:text-cerebral-text'}`}
        >
          TR
        </button>
        <button
          onClick={() => setLocale('en')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200
            ${locale === 'en' ? 'bg-cerebral-card text-cerebral-text' : 'text-cerebral-muted hover:text-cerebral-text'}`}
        >
          EN
        </button>
      </div>
    </header>
  );
}
