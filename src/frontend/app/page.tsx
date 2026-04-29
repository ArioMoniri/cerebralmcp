'use client';

import { useState, useCallback } from 'react';
import { Locale } from '@/lib/i18n';
import { AppStep, Message, PatientIdentity, PatientSummary } from '@/lib/types';
import Header from '@/components/Header';
import PatientIngest from '@/components/PatientIngest';
import ChatInterface from '@/components/ChatInterface';
import PatientSummaryPanel from '@/components/PatientSummaryPanel';
import InterviewProgress from '@/components/InterviewProgress';
import LiveHPIReport from '@/components/LiveHPIReport';
import CompletionScreen from '@/components/CompletionScreen';

export default function Home() {
  const [locale, setLocale] = useState<Locale>('tr');
  const [step, setStep] = useState<AppStep>('identity');
  const [identity, setIdentity] = useState<PatientIdentity>({ firstName: '', lastName: '' });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [patientSummary, setPatientSummary] = useState<PatientSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  const [interviewComplete, setInterviewComplete] = useState(false);
  const [department, setDepartment] = useState('Kardiyoloji');
  const [clinicalReport, setClinicalReport] = useState<string | null>(null);
  const [hpiRefreshKey, setHpiRefreshKey] = useState(0);

  const handleIdentitySubmit = useCallback((id: PatientIdentity) => {
    setIdentity(id);
    setStep('protocol');
  }, []);

  const handlePatientIngested = useCallback((sid: string, summary: PatientSummary, dept: string) => {
    setSessionId(sid);
    setPatientSummary(summary);
    setDepartment(dept);
    setStep('interview');
  }, []);

  const handleInterviewComplete = useCallback(() => {
    setInterviewComplete(true);
    setStep('complete');
  }, []);

  const handleNewInterview = useCallback(() => {
    setStep('identity');
    setIdentity({ firstName: '', lastName: '' });
    setSessionId(null);
    setPatientSummary(null);
    setChatHistory([]);
    setInterviewComplete(false);
    setClinicalReport(null);
  }, []);

  return (
    <div className="flex flex-col h-screen">
      <Header locale={locale} setLocale={setLocale} />

      {/* Patient Context Bar */}
      {sessionId && step !== 'identity' && step !== 'protocol' && (
        <div className="px-4 py-2 bg-cerebral-surface/50 border-b border-cerebral-border">
          <div className="flex items-center justify-between max-w-7xl mx-auto">
            <div className="flex items-center gap-2">
              <span className="pulse-dot" />
              <span className="text-sm text-cerebral-green font-medium">
                {locale === 'tr' ? 'Hasta Bağlamı Aktif' : 'Patient Context Active'}
              </span>
              <span className="text-sm text-cerebral-muted ml-2">
                {identity.firstName} {identity.lastName} — {patientSummary?.patient?.patient_id}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="priority-badge bg-red-500/10 text-red-400 border border-red-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                {locale === 'tr' ? 'Öncelik:' : 'Priority:'} <strong>TR</strong> {locale === 'tr' ? 'kılavuzları' : 'guidelines'}
              </span>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        {/* Step 1 & 2: Identity + Protocol */}
        {(step === 'identity' || step === 'protocol') && (
          <div className="flex-1 flex items-center justify-center p-8">
            <PatientIngest
              locale={locale}
              step={step}
              identity={identity}
              onIdentitySubmit={handleIdentitySubmit}
              onIngested={handlePatientIngested}
              onBack={() => setStep('identity')}
              isLoading={isLoading}
              setIsLoading={setIsLoading}
            />
          </div>
        )}

        {/* Step 3: Interview */}
        {step === 'interview' && sessionId && (
          <>
            <div className="flex-1 flex flex-col min-w-0">
              <ChatInterface
                locale={locale}
                sessionId={sessionId}
                patientName={`${identity.firstName} ${identity.lastName}`}
                chatHistory={chatHistory}
                setChatHistory={setChatHistory}
                onInterviewComplete={handleInterviewComplete}
                onSummaryUpdate={setPatientSummary}
                onTurnComplete={() => setHpiRefreshKey(k => k + 1)}
              />
            </div>

            {/*
              Right rail: must scroll independently of the chat. The flex
              parent needs min-h-0 so its overflow-y-auto child can actually
              scroll inside the viewport, otherwise tall content (long HPI
              report + interview progress + patient summary) silently grows
              past the screen with no scrollbar.
            */}
            <div className="w-[460px] border-l border-cerebral-border flex flex-col min-h-0 overflow-y-auto custom-scroll">
              <LiveHPIReport
                locale={locale}
                sessionId={sessionId}
                refreshKey={hpiRefreshKey}
                maxTurns={3}
              />
              <InterviewProgress
                locale={locale}
                chatHistory={chatHistory}
                isComplete={interviewComplete}
              />
              <PatientSummaryPanel
                locale={locale}
                summary={patientSummary}
                sessionId={sessionId}
                identity={identity}
              />
            </div>
          </>
        )}

        {/* Step 4: Completion */}
        {step === 'complete' && sessionId && (
          <CompletionScreen
            locale={locale}
            sessionId={sessionId}
            identity={identity}
            summary={patientSummary}
            chatHistory={chatHistory}
            clinicalReport={clinicalReport}
            setClinicalReport={setClinicalReport}
            onNewInterview={handleNewInterview}
          />
        )}
      </main>
    </div>
  );
}
