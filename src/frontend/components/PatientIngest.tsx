'use client';

import { useState } from 'react';
import { Locale, t } from '@/lib/i18n';
import { AppStep, PatientIdentity } from '@/lib/types';

interface PatientIngestProps {
  locale: Locale;
  step: AppStep;
  identity: PatientIdentity;
  onIdentitySubmit: (id: PatientIdentity) => void;
  onIngested: (sessionId: string, summary: any, department: string) => void;
  onBack: () => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

const DEPARTMENTS = [
  'Kardiyoloji', 'Nöroloji', 'Gastroenteroloji', 'Ortopedi',
  'Göğüs Hastalıkları', 'Göz Hastalıkları', 'Enfeksiyon Hastalıkları',
  'Üroloji', 'Genel Cerrahi', 'Kadın Hastalıkları', 'Psikiyatri',
  'Beyin-Sinir Cerrahisi', 'Dermatoloji', 'KBB', 'Endokrinoloji',
];

export default function PatientIngest({
  locale, step, identity, onIdentitySubmit, onIngested, onBack, isLoading, setIsLoading,
}: PatientIngestProps) {
  const [firstName, setFirstName] = useState(identity.firstName);
  const [lastName, setLastName] = useState(identity.lastName);
  const [patientId, setPatientId] = useState('');
  const [department, setDepartment] = useState('Kardiyoloji');
  const [error, setError] = useState('');

  const handleIdentitySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) {
      setError(t(locale, 'nameRequired'));
      return;
    }
    setError('');
    onIdentitySubmit({ firstName: firstName.trim(), lastName: lastName.trim() });
  };

  const handleProtocolSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patientId.trim()) return;

    setIsLoading(true);
    setError('');

    try {
      const res = await fetch('/api/patient/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_id: patientId.replace(/[\s-]/g, ''),
          department,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to ingest patient');
      }

      const data = await res.json();
      onIngested(data.session_id, data.patient_summary, department);
    } catch (err: any) {
      setError(err.message || 'Connection failed');
    } finally {
      setIsLoading(false);
    }
  };

  // Step indicator
  const stepNum = step === 'identity' ? 1 : 2;

  return (
    <div className="glass-card glow-accent max-w-lg w-full p-8 fade-in">
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-3 mb-8">
        {[1, 2].map(s => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold
              ${s === stepNum
                ? 'bg-cerebral-accent text-white'
                : s < stepNum
                  ? 'bg-cerebral-green/20 text-cerebral-green border border-cerebral-green/30'
                  : 'bg-cerebral-bg text-cerebral-muted border border-cerebral-border'
              }`}>
              {s < stepNum ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              ) : s}
            </div>
            {s < 2 && <div className={`w-12 h-0.5 ${s < stepNum ? 'bg-cerebral-green' : 'bg-cerebral-border'}`} />}
          </div>
        ))}
      </div>

      {/* STEP 1: Identity */}
      {step === 'identity' && (
        <>
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-cerebral-accent to-cerebral-teal rounded-2xl flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-cerebral-text">{t(locale, 'welcome')}</h2>
            <p className="text-sm text-cerebral-muted mt-2">{t(locale, 'welcomeSubtitle')}</p>
          </div>

          <form onSubmit={handleIdentitySubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-cerebral-muted mb-1.5">{t(locale, 'firstName')}</label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder={t(locale, 'firstNamePlaceholder')}
                autoFocus
                className="w-full px-4 py-3 bg-cerebral-bg border border-cerebral-border rounded-xl
                           text-cerebral-text placeholder-cerebral-muted/50
                           focus:outline-none focus:border-cerebral-accent focus:ring-1 focus:ring-cerebral-accent/50
                           transition-all duration-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-cerebral-muted mb-1.5">{t(locale, 'lastName')}</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={t(locale, 'lastNamePlaceholder')}
                className="w-full px-4 py-3 bg-cerebral-bg border border-cerebral-border rounded-xl
                           text-cerebral-text placeholder-cerebral-muted/50
                           focus:outline-none focus:border-cerebral-accent focus:ring-1 focus:ring-cerebral-accent/50
                           transition-all duration-200"
              />
            </div>

            {error && (
              <div className="px-4 py-3 bg-cerebral-red/10 border border-cerebral-red/30 rounded-xl text-sm text-cerebral-red">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!firstName.trim() || !lastName.trim()}
              className="w-full py-3 bg-gradient-to-r from-cerebral-accent to-cerebral-teal
                         text-white font-semibold rounded-xl
                         hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed
                         transition-all duration-200"
            >
              {t(locale, 'continue')}
            </button>
          </form>
        </>
      )}

      {/* STEP 2: Protocol */}
      {step === 'protocol' && (
        <>
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-cerebral-accent to-cerebral-teal rounded-2xl flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-cerebral-text">{t(locale, 'protocolEntry')}</h2>
            <p className="text-sm text-cerebral-muted mt-2">{t(locale, 'protocolSubtitle')}</p>
            <p className="text-xs text-cerebral-accent mt-1">{identity.firstName} {identity.lastName}</p>
          </div>

          <form onSubmit={handleProtocolSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-cerebral-muted mb-1.5">{t(locale, 'protocolNumber')}</label>
              <input
                type="text"
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                placeholder={t(locale, 'protocolPlaceholder')}
                autoFocus
                className="w-full px-4 py-3 bg-cerebral-bg border border-cerebral-border rounded-xl
                           text-cerebral-text placeholder-cerebral-muted/50 font-mono text-lg
                           focus:outline-none focus:border-cerebral-accent focus:ring-1 focus:ring-cerebral-accent/50
                           transition-all duration-200"
                disabled={isLoading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-cerebral-muted mb-1.5">{t(locale, 'department')}</label>
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full px-4 py-3 bg-cerebral-bg border border-cerebral-border rounded-xl
                           text-cerebral-text focus:outline-none focus:border-cerebral-accent
                           focus:ring-1 focus:ring-cerebral-accent/50 transition-all duration-200"
                disabled={isLoading}
              >
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {t(locale, `dept.${d}` as any) || d}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <div className="px-4 py-3 bg-cerebral-red/10 border border-cerebral-red/30 rounded-xl text-sm text-cerebral-red">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onBack}
                disabled={isLoading}
                className="px-6 py-3 border border-cerebral-border rounded-xl text-cerebral-muted
                           hover:text-cerebral-text hover:border-cerebral-accent/50
                           transition-all duration-200"
              >
                {t(locale, 'back')}
              </button>
              <button
                type="submit"
                disabled={isLoading || !patientId.trim()}
                className="flex-1 py-3 bg-gradient-to-r from-cerebral-accent to-cerebral-teal
                           text-white font-semibold rounded-xl
                           hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed
                           transition-all duration-200 flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    {t(locale, 'fetchingData')}
                  </>
                ) : (
                  t(locale, 'startInterview')
                )}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
