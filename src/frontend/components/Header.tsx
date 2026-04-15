'use client';

import { useState } from 'react';

export default function Header() {
  const [showLegend, setShowLegend] = useState(false);

  return (
    <header className="flex items-center justify-between px-6 py-3 bg-cerebral-surface border-b border-cerebral-border">
      {/* Logo */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-gradient-to-br from-cerebral-accent to-cerebral-teal rounded-lg flex items-center justify-center">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <div>
          <h1 className="text-lg font-semibold text-cerebral-text">CerebraLink</h1>
          <p className="text-xs text-cerebral-muted">Medical AI Assistant</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex items-center gap-2">
        {[
          { label: 'New Chat', icon: '+' },
          { label: 'History', icon: '⏱' },
          { label: 'Knowledge Graph', icon: '✨' },
          { label: 'Lab Trends', icon: '📈' },
        ].map((item) => (
          <button
            key={item.label}
            className="px-3 py-1.5 text-sm text-cerebral-muted hover:text-cerebral-text
                       border border-cerebral-border rounded-lg hover:bg-cerebral-card
                       transition-all duration-200"
          >
            <span className="mr-1.5">{item.icon}</span>
            {item.label}
          </button>
        ))}

        {/* Legend Toggle */}
        <div className="relative">
          <button
            onClick={() => setShowLegend(!showLegend)}
            className="px-3 py-1.5 text-sm text-cerebral-muted hover:text-cerebral-text
                       border border-cerebral-border rounded-lg hover:bg-cerebral-card
                       transition-all duration-200 flex items-center gap-1.5"
          >
            <span className="w-4 h-4 rounded-full bg-cerebral-accent flex items-center justify-center text-[10px] text-white font-bold">i</span>
            Legend
            <svg className={`w-3 h-3 transition-transform ${showLegend ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showLegend && (
            <div className="absolute right-0 top-full mt-2 w-64 glass-card p-4 z-50">
              <h3 className="text-sm font-semibold mb-3">Diagnostic Importance</h3>
              <div className="space-y-2">
                {[
                  { color: 'bg-red-500', label: 'Critical / Primary Diagnosis' },
                  { color: 'bg-orange-400', label: 'Important / Active Problem' },
                  { color: 'bg-yellow-400', label: 'Moderate / Under Investigation' },
                  { color: 'bg-green-400', label: 'Resolved / Preventive' },
                  { color: 'bg-blue-400', label: 'Informational / Follow-up' },
                ].map(({ color, label }) => (
                  <div key={label} className="flex items-center gap-2 text-xs text-cerebral-muted">
                    <span className={`w-3 h-3 rounded-full ${color}`} />
                    {label}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}
