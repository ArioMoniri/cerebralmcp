'use client';

import { useState, useRef, useCallback } from 'react';

interface VoiceInputProps {
  sessionId: string;
  onTranscript: (text: string) => void;
  disabled: boolean;
}

export default function VoiceInput({ sessionId, onTranscript, disabled }: VoiceInputProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      // Connect WebSocket for real-time processing
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/voice/${sessionId}`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'transcript') {
          setTranscript(data.text);
          if (data.is_final) {
            onTranscript(data.text);
            setTranscript('');
          }
        } else if (data.type === 'audio') {
          // Play TTS audio
          const audioData = atob(data.data);
          const audioArray = new Uint8Array(audioData.length);
          for (let i = 0; i < audioData.length; i++) {
            audioArray[i] = audioData.charCodeAt(i);
          }
          const blob = new Blob([audioArray], { type: 'audio/mp3' });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.play().catch(console.error);
        }
      };

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      mediaRecorder.start(250); // Send chunks every 250ms
      setIsRecording(true);
    } catch (err) {
      console.error('Microphone access denied:', err);
    }
  }, [sessionId, onTranscript]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      mediaRecorderRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsRecording(false);
  }, []);

  return (
    <div className="flex-1 flex items-center gap-3">
      {/* Waveform / Status */}
      <div className="flex-1 flex items-center gap-3 px-4 py-3 bg-cerebral-card border border-cerebral-border rounded-xl">
        {isRecording ? (
          <>
            <div className="flex items-center gap-1">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="w-1 bg-cerebral-accent rounded-full animate-pulse"
                  style={{
                    height: `${12 + Math.random() * 16}px`,
                    animationDelay: `${i * 0.15}s`,
                  }}
                />
              ))}
            </div>
            <span className="text-sm text-cerebral-accent">Listening...</span>
            {transcript && (
              <span className="text-sm text-cerebral-muted italic ml-2 truncate">{transcript}</span>
            )}
          </>
        ) : (
          <span className="text-sm text-cerebral-muted">
            Tap the microphone to start speaking
          </span>
        )}
      </div>

      {/* Record Button */}
      <button
        onClick={isRecording ? stopRecording : startRecording}
        disabled={disabled}
        className={`p-4 rounded-xl transition-all duration-200 flex-shrink-0
          ${isRecording
            ? 'bg-cerebral-red text-white animate-pulse'
            : 'bg-cerebral-accent text-white hover:bg-cerebral-accent/80'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {isRecording ? (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        )}
      </button>
    </div>
  );
}
