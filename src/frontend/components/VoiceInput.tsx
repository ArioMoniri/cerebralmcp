'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Locale, t } from '@/lib/i18n';
import { apiFetch } from '@/lib/api';

interface VoiceInputProps {
  locale: Locale;
  sessionId: string;
  onTranscript: (text: string) => void;
  onInterim?: (text: string) => void;
  /** Called when the user taps the mic while the agent is speaking — parent
   *  should stop the current TTS audio so the patient can talk over it. */
  onInterrupt?: () => void;
  disabled: boolean;
  isAgentSpeaking?: boolean;
}

/**
 * Push-to-talk voice input.
 *
 * Tap mic → record. Tap again → stop, transcribe, send. Tap during agent
 * speech → interrupt agent + start recording immediately.
 *
 * Primary STT: Web Speech API (Chrome/Edge/Safari) — streams interim text.
 * Fallback STT: MediaRecorder → POST /api/stt → Deepgram. Used when the
 * Web Speech API errors with 'network' (Firefox, blocked Google endpoints).
 */
export default function VoiceInput({
  locale, sessionId, onTranscript, onInterim, onInterrupt, disabled, isAgentSpeaking = false,
}: VoiceInputProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');

  // ── Web Speech API refs ─────────────────────────────────────────────
  const recognitionRef = useRef<any>(null);
  const accumulatedTextRef = useRef('');
  const webSpeechBlockedRef = useRef(false);
  // Set to true when the user has tapped stop. The Web Speech engine fires
  // one final `onresult` between rec.stop() and onend, so we wait for onend
  // before emitting the transcript — otherwise the last 1-2s of speech are
  // missing from the user's message.
  const stopRequestedRef = useRef(false);

  // ── MediaRecorder fallback refs ─────────────────────────────────────
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // ── Shared (mic stream + level meter) ───────────────────────────────
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const usingWebSpeechRef = useRef(false);

  const speechLang = locale === 'tr' ? 'tr-TR' : 'en-US';

  // ── Level meter — runs while mic is open ────────────────────────────
  const startLevelMeter = useCallback((stream: MediaStream) => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        setLevel(sum / data.length);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch { /* analyser is non-critical */ }
  }, []);

  const teardownMic = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setLevel(0);
  }, []);

  // ── Web Speech path ─────────────────────────────────────────────────
  const startWebSpeech = useCallback(async (): Promise<boolean> => {
    if (webSpeechBlockedRef.current) return false;
    const SR: any =
      (typeof window !== 'undefined' && (window as any).SpeechRecognition) ||
      (typeof window !== 'undefined' && (window as any).webkitSpeechRecognition);
    if (!SR) return false;

    try {
      const rec = new SR();
      rec.lang = speechLang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      accumulatedTextRef.current = '';

      rec.onresult = (event: any) => {
        let allText = '';
        for (let i = 0; i < event.results.length; i++) {
          allText += event.results[i][0].transcript + ' ';
        }
        const trimmed = allText.trim();
        accumulatedTextRef.current = trimmed;
        setLiveText(trimmed);
        onInterim?.(trimmed);
      };

      rec.onerror = (e: any) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          setError(t(locale, 'micDenied'));
          stopRecordingInternal();
          return;
        }
        if (e.error === 'network' || e.error === 'audio-capture' || e.error === 'aborted') {
          // Fall back to MediaRecorder for the rest of the session.
          webSpeechBlockedRef.current = true;
          // Don't stop the mic — we'll switch to MediaRecorder mid-flight.
          // Easiest path: stop everything and prompt the user to tap again.
          stopRecordingInternal();
        }
      };

      rec.onend = () => {
        // Fired after rec.stop() once the engine has flushed any final
        // results. accumulatedTextRef now has EVERY word the engine
        // recognized (including the last ones that might have been mid-
        // processing when the user tapped stop). This is the correct
        // moment to emit the transcript — emitting on the click handler
        // would lose the trailing words.
        if (!stopRequestedRef.current) return;
        stopRequestedRef.current = false;
        const finalText = accumulatedTextRef.current.trim();
        accumulatedTextRef.current = '';
        recognitionRef.current = null;
        teardownMic();
        setIsRecording(false);
        setLiveText('');
        onInterim?.('');
        if (finalText) onTranscript(finalText);
      };

      // Open the mic for level meter, then start recognition
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      startLevelMeter(stream);

      rec.start();
      recognitionRef.current = rec;
      usingWebSpeechRef.current = true;
      return true;
    } catch {
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechLang, locale, onInterim, startLevelMeter]);

  // ── MediaRecorder fallback ──────────────────────────────────────────
  const sendAudio = useCallback(async (blob: Blob) => {
    if (blob.size < 1500) {
      setIsProcessing(false);
      setLiveText('');
      onInterim?.('');
      return;
    }
    setIsProcessing(true);
    try {
      const fd = new FormData();
      fd.append('audio', blob, 'utterance.webm');
      const res = await apiFetch('/api/stt', { method: 'POST', body: fd }, 60_000);
      if (res.ok) {
        const data = await res.json();
        const text = (data.transcript || '').trim();
        // Clear the "transcribing..." placeholder before emitting — the
        // chat bubble will replace it.
        setLiveText('');
        onInterim?.('');
        if (text) onTranscript(text);
      } else {
        setLiveText('');
        onInterim?.('');
      }
    } finally { setIsProcessing(false); }
  }, [onTranscript, onInterim]);

  const startMediaRecorder = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      startLevelMeter(stream);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        await sendAudio(blob);
      };

      mr.start(250);
      usingWebSpeechRef.current = false;
      return true;
    } catch (e: any) {
      setError(e?.message || t(locale, 'micDenied'));
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, sendAudio, startLevelMeter]);

  // ── Public start/stop ──────────────────────────────────────────────
  const stopRecordingInternal = useCallback(() => {
    if (usingWebSpeechRef.current) {
      // Mark that we're stopping intentionally. The engine will fire one
      // last onresult, then onend — onend reads accumulatedTextRef and
      // emits onTranscript. We do NOT clear interim text here, so the
      // user keeps seeing what they said until the real chat bubble
      // replaces it.
      stopRequestedRef.current = true;
      setIsRecording(false);
      try { recognitionRef.current?.stop(); } catch {
        // If stop() throws, fall back to immediate emit
        const finalText = accumulatedTextRef.current.trim();
        accumulatedTextRef.current = '';
        recognitionRef.current = null;
        teardownMic();
        setLiveText('');
        onInterim?.('');
        if (finalText) onTranscript(finalText);
      }
    } else {
      // MediaRecorder.onstop will fire and POST to /api/stt. While
      // Deepgram processes, show a "transcribing" placeholder so the
      // user has feedback (otherwise they'd see nothing for 2-5s).
      setIsRecording(false);
      setIsProcessing(true);
      const placeholder = t(locale, 'transcribingHint');
      setLiveText(placeholder);
      onInterim?.(placeholder);
      try { mediaRecorderRef.current?.stop(); } catch {}
      mediaRecorderRef.current = null;
      teardownMic();
    }
  }, [onTranscript, onInterim, teardownMic, locale]);

  const startRecording = useCallback(async () => {
    setError(null);
    setLiveText('');
    onInterim?.('');
    setIsRecording(true);
    const ok = await startWebSpeech();
    if (!ok) {
      const ok2 = await startMediaRecorder();
      if (!ok2) {
        setIsRecording(false);
        return;
      }
    }
  }, [startWebSpeech, startMediaRecorder, onInterim]);

  const handleClick = useCallback(async () => {
    if (disabled && !isRecording) return;
    if (isRecording) {
      stopRecordingInternal();
      return;
    }
    // Tap-to-interrupt: if the agent is speaking, ask the parent to stop
    // the TTS audio, then immediately start recording.
    if (isAgentSpeaking && onInterrupt) {
      onInterrupt();
    }
    await startRecording();
  }, [disabled, isRecording, isAgentSpeaking, onInterrupt, startRecording, stopRecordingInternal]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try { recognitionRef.current?.stop(); } catch {}
      try { mediaRecorderRef.current?.stop(); } catch {}
      teardownMic();
    };
  }, [teardownMic]);

  // ── UI ──────────────────────────────────────────────────────────────
  const statusText = error
    ? error
    : isRecording
      ? (liveText || t(locale, 'recordingTapToSend'))
      : isProcessing
        ? (liveText || t(locale, 'processing'))
        : isAgentSpeaking
          ? t(locale, 'agentSpeakingTapInterrupt')
          : t(locale, 'tapToSpeak');

  const buttonState =
    isRecording ? 'recording' :
    isAgentSpeaking ? 'interrupt' :
    'idle';

  return (
    <div className="flex-1 flex items-center gap-3">
      <div className="flex-1 flex items-center gap-3 px-4 py-3 bg-cerebral-card border border-cerebral-border rounded-xl min-h-[52px]">
        {(isRecording || isAgentSpeaking) && (
          <div className="flex items-center gap-1">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="wave-bar"
                style={{
                  height: `${Math.max(6, Math.min(28, level * 0.6 + i * 2))}px`,
                  opacity: isAgentSpeaking ? 0.9 : 1,
                }}
              />
            ))}
          </div>
        )}
        <span
          className={`text-sm truncate flex-1 ${
            error
              ? 'text-cerebral-red'
              : isRecording && liveText
                ? 'text-cerebral-text italic'
                : isAgentSpeaking
                  ? 'text-cerebral-teal'
                  : 'text-cerebral-accent'
          }`}
        >
          {statusText}
        </span>
      </div>

      <button
        onClick={handleClick}
        disabled={disabled && !isRecording && !isAgentSpeaking}
        title={
          buttonState === 'recording' ? t(locale, 'stopAndSend') :
          buttonState === 'interrupt' ? t(locale, 'tapToInterrupt') :
          t(locale, 'tapToSpeak')
        }
        className={`relative p-4 rounded-xl transition-all duration-200 flex-shrink-0
          ${buttonState === 'recording'
            ? 'bg-cerebral-red text-white animate-pulse shadow-lg shadow-red-500/30'
            : buttonState === 'interrupt'
              ? 'bg-gradient-to-br from-cerebral-teal to-cerebral-accent text-white shadow-lg shadow-cyan-500/30'
              : 'bg-gradient-to-br from-cerebral-accent to-cerebral-teal text-white hover:opacity-90'}
          disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {buttonState === 'recording' ? (
          // Stop icon (filled square)
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          // Mic icon
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        )}
        {/* Pulse ring when agent is speaking — invites tap-to-interrupt */}
        {buttonState === 'interrupt' && (
          <span className="absolute inset-0 rounded-xl border-2 border-cerebral-teal animate-ping pointer-events-none" />
        )}
      </button>
    </div>
  );
}
