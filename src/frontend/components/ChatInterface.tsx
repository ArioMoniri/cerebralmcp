'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Locale, t } from '@/lib/i18n';
import { Message } from '@/lib/types';
import { apiFetch, parseError } from '@/lib/api';
import VoiceInput from './VoiceInput';

interface ChatInterfaceProps {
  locale: Locale;
  sessionId: string;
  patientName: string;
  chatHistory: Message[];
  setChatHistory: React.Dispatch<React.SetStateAction<Message[]>>;
  onInterviewComplete: () => void;
}

export default function ChatInterface({
  locale, sessionId, patientName, chatHistory, setChatHistory, onInterviewComplete,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  // Auto-start interview in the browser's language
  useEffect(() => {
    if (chatHistory.length === 0) {
      const browserLang = typeof navigator !== 'undefined'
        ? (navigator.language || 'tr').toLowerCase()
        : 'tr';
      // Use BCP-47 tag (e.g. "tr-TR", "en-US", "de-DE", "fr-FR")
      sendMessage(`__START_INTERVIEW__:${browserLang}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const isSystemStart = text.startsWith('__START_INTERVIEW__:');
    const userMsg: Message = { role: 'user', content: text.trim(), timestamp: new Date().toISOString() };
    if (!isSystemStart) {
      setChatHistory(prev => [...prev, userMsg]);
    }
    setInput('');
    setIsStreaming(true);

    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, message: text.trim(), language: locale }),
      });

      if (!res.ok) throw new Error(await parseError(res));
      const data = await res.json();

      setChatHistory(prev => [...prev, {
        role: 'assistant', content: data.response, timestamp: new Date().toISOString(),
      }]);

      if (data.is_complete) {
        onInterviewComplete();
      }
    } catch {
      setChatHistory(prev => [...prev, {
        role: 'assistant', content: t(locale, 'connectionError'), timestamp: new Date().toISOString(),
      }]);
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {chatHistory.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} fade-in`}>
            <div className="max-w-[80%]">
              <div className={`flex items-start gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                {/* Avatar */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0
                  ${msg.role === 'user' ? 'bg-cerebral-accent/20 text-cerebral-accent' : 'bg-cerebral-teal/20 text-cerebral-teal'}`}>
                  {msg.role === 'user' ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  )}
                </div>

                {/* Bubble */}
                <div className={`px-4 py-3 ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'}`}>
                  <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                  <div className="text-[10px] text-cerebral-muted mt-1.5 opacity-60">
                    {new Date(msg.timestamp).toLocaleTimeString(locale === 'tr' ? 'tr-TR' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}

        {isStreaming && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-cerebral-teal/20 text-cerebral-teal flex items-center justify-center">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div className="chat-bubble-ai px-4 py-3">
              <div className="typing-indicator flex gap-1"><span /><span /><span /></div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-cerebral-border bg-cerebral-surface/50">
        <div className="flex items-end gap-3 max-w-4xl mx-auto">
          <button
            onClick={() => setIsVoiceMode(!isVoiceMode)}
            className={`p-3 rounded-xl border transition-all duration-200 flex-shrink-0
              ${isVoiceMode ? 'bg-cerebral-accent/20 border-cerebral-accent text-cerebral-accent' : 'bg-cerebral-card border-cerebral-border text-cerebral-muted hover:text-cerebral-text'}`}
            title={isVoiceMode ? t(locale, 'switchToText') : t(locale, 'switchToVoice')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </button>

          {isVoiceMode ? (
            <VoiceInput locale={locale} sessionId={sessionId} onTranscript={sendMessage} disabled={isStreaming} />
          ) : (
            <>
              <div className="flex-1">
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t(locale, 'chatPlaceholder')}
                  rows={1}
                  className="w-full px-4 py-3 bg-cerebral-card border border-cerebral-border rounded-xl
                             text-cerebral-text placeholder-cerebral-muted/50 resize-none
                             focus:outline-none focus:border-cerebral-accent focus:ring-1 focus:ring-cerebral-accent/50
                             transition-all duration-200"
                  disabled={isStreaming}
                />
              </div>
              <button
                onClick={() => sendMessage(input)}
                disabled={isStreaming || !input.trim()}
                className="p-3 bg-cerebral-accent text-white rounded-xl hover:bg-cerebral-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex-shrink-0"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
