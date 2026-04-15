'use client';

import { useState } from 'react';
import Header from '@/components/Header';
import PatientIngest from '@/components/PatientIngest';
import ChatInterface from '@/components/ChatInterface';
import PatientSummaryPanel from '@/components/PatientSummaryPanel';
import InterviewProgress from '@/components/InterviewProgress';

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [patientSummary, setPatientSummary] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<Array<{ role: string; content: string; timestamp: string }>>([]);
  const [interviewComplete, setInterviewComplete] = useState(false);

  const handlePatientIngested = (sid: string, summary: any) => {
    setSessionId(sid);
    setPatientSummary(summary);
  };

  return (
    <div className="flex flex-col h-screen">
      <Header />

      {/* Patient Context Bar */}
      {sessionId && (
        <div className="px-4 py-2 bg-cerebral-surface/50 border-b border-cerebral-border">
          <div className="flex items-center gap-2 max-w-7xl mx-auto">
            <span className="pulse-dot" />
            <span className="text-sm text-cerebral-green font-medium">Patient Context Active</span>
            <span className="text-sm text-cerebral-muted ml-2">
              {patientSummary?.patient?.name} — {patientSummary?.patient?.patient_id}
            </span>
          </div>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        {!sessionId ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <PatientIngest
              onIngested={handlePatientIngested}
              isLoading={isLoading}
              setIsLoading={setIsLoading}
            />
          </div>
        ) : (
          <>
            {/* Chat Area */}
            <div className="flex-1 flex flex-col min-w-0">
              <ChatInterface
                sessionId={sessionId}
                chatHistory={chatHistory}
                setChatHistory={setChatHistory}
                onInterviewComplete={() => setInterviewComplete(true)}
              />
            </div>

            {/* Right Sidebar — Patient Summary + Progress */}
            <div className="w-96 border-l border-cerebral-border flex flex-col overflow-y-auto">
              <InterviewProgress
                chatHistory={chatHistory}
                isComplete={interviewComplete}
              />
              <PatientSummaryPanel
                summary={patientSummary}
                sessionId={sessionId}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
