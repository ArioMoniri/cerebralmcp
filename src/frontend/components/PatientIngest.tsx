'use client';

import { useState } from 'react';

interface PatientIngestProps {
  onIngested: (sessionId: string, summary: any) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

export default function PatientIngest({ onIngested, isLoading, setIsLoading }: PatientIngestProps) {
  const [patientId, setPatientId] = useState('');
  const [department, setDepartment] = useState('Kardiyoloji');
  const [error, setError] = useState('');

  const departments = [
    'Kardiyoloji', 'Nöroloji', 'Gastroenteroloji', 'Ortopedi',
    'Göğüs Hastalıkları', 'Göz Hastalıkları', 'Enfeksiyon Hastalıkları',
    'Üroloji', 'Genel Cerrahi', 'Kadın Hastalıkları', 'Psikiyatri',
    'Beyin-Sinir Cerrahisi', 'Dermatoloji', 'KBB', 'Endokrinoloji',
  ];

  const handleSubmit = async (e: React.FormEvent) => {
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
      onIngested(data.session_id, data.patient_summary);
    } catch (err: any) {
      setError(err.message || 'Connection failed. Is the backend running?');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="glass-card glow-accent max-w-lg w-full p-8">
      <div className="text-center mb-8">
        <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-cerebral-accent to-cerebral-teal rounded-2xl flex items-center justify-center">
          <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-cerebral-text">Patient Intake</h2>
        <p className="text-sm text-cerebral-muted mt-2">
          Enter the patient protocol number to begin the pre-visit interview
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-cerebral-muted mb-2">
            Protocol Number
          </label>
          <input
            type="text"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            placeholder="e.g. 30256609"
            className="w-full px-4 py-3 bg-cerebral-bg border border-cerebral-border rounded-xl
                       text-cerebral-text placeholder-cerebral-muted/50 font-mono text-lg
                       focus:outline-none focus:border-cerebral-accent focus:ring-1 focus:ring-cerebral-accent/50
                       transition-all duration-200"
            disabled={isLoading}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-cerebral-muted mb-2">
            Department
          </label>
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="w-full px-4 py-3 bg-cerebral-bg border border-cerebral-border rounded-xl
                       text-cerebral-text focus:outline-none focus:border-cerebral-accent
                       focus:ring-1 focus:ring-cerebral-accent/50 transition-all duration-200"
            disabled={isLoading}
          >
            {departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {error && (
          <div className="px-4 py-3 bg-cerebral-red/10 border border-cerebral-red/30 rounded-xl text-sm text-cerebral-red">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading || !patientId.trim()}
          className="w-full py-3 bg-gradient-to-r from-cerebral-accent to-cerebral-teal
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
              Fetching patient data...
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Start Pre-Visit Interview
            </>
          )}
        </button>
      </form>
    </div>
  );
}
