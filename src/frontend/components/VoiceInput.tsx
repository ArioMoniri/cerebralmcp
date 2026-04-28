'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Locale, t } from '@/lib/i18n';
import { apiFetch } from '@/lib/api';

interface VoiceInputProps {
  locale: Locale;
  sessionId: string;
  onTranscript: (text: string) => void;
  onInterim?: (text: string) => void;
  disabled: boolean;
  autoStart?: boolean;
  isAgentSpeaking?: boolean;
}

/**
 * Voice input with real-time interim transcription.
 *
 * Primary path: Web Speech API (browser built-in) — streams interim + final
 *   results with no backend roundtrip. Lowest latency. Works in Chrome/Edge/Safari.
 * Fallback path: MediaRecorder + VAD + POST /api/stt — used if Web Speech API
 *   is not available (Firefox). Silence detection commits the utterance.
 *
 * Mic is automatically paused while the agent is speaking (echo avoidance).
 */
export default function VoiceInput({
  locale, sessionId, onTranscript, onInterim, disabled, autoStart = false, isAgentSpeaking = false,
}: VoiceInputProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');

  // Web Speech API refs
  const recognitionRef = useRef<any>(null);
  const shouldRestartRef = useRef(false);

  // Fallback MediaRecorder refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const hasSpokenRef = useRef(false);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);

  const pausedRef = useRef(false);
  const useWebSpeechRef = useRef(false);
  // If the browser's Web Speech API hits a 'network' error (common when
  // Google's STT backend is unreachable from the user's network or region —
  // e.g. behind firewalls, VPNs, or in regions where Chrome can't reach
  // google.com STT endpoints), permanently disable it for this session and
  // route through the backend Deepgram fallback instead.
  const webSpeechBlockedRef = useRef(false);
  // Forward reference to startMediaRecorder — declared below, but the
  // Web Speech error handler needs to invoke it. Updated by an effect.
  const startMediaRecorderRef = useRef<(() => void) | null>(null);

  // Silence-based commit: if interim text hasn't changed for N ms, treat it as final.
  // Web Speech API with continuous:true is inconsistent about firing isFinal, so we
  // force-commit pending interim after a short silence.
  const interimBufferRef = useRef('');
  const commitTimerRef = useRef<number | null>(null);
  const SILENCE_COMMIT_MS = 1200;

  // continuous:true keeps every result (interim + final) in event.results FOREVER,
  // so subsequent onresult events contain already-committed text. We track what we
  // last emitted and strip it as a prefix from new events, so each commit is only
  // the *delta* of what's been said since the last commit.
  const allTextRef = useRef('');
  const lastCommittedTextRef = useRef('');
  // Suppress onresult events while the mic is in a teardown/restart cycle.
  const suppressResultsRef = useRef(false);

  // Map frontend locale to BCP-47 for Web Speech API
  const speechLang = locale === 'tr' ? 'tr-TR' : 'en-US';

  // Commit pending interim text as a final transcript (used by silence timer + pause).
  const flushInterim = useCallback(() => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    const pending = interimBufferRef.current.trim();
    if (pending) {
      interimBufferRef.current = '';
      setLiveText('');
      onInterim?.('');
      onTranscript(pending);
    }
  }, [onInterim, onTranscript]);

  // ── Web Speech API (primary) ─────────────────────────────────────────
  const startWebSpeech = useCallback(() => {
    // Hard skip if a previous attempt errored with 'network' — the browser's
    // STT route to Google is blocked, so we use Deepgram via /api/stt instead.
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

      rec.onresult = (event: any) => {
        if (suppressResultsRef.current) return;

        // Walk ALL results and build the full accumulated transcript — this
        // includes every result the browser has kept since rec.start().
        let allText = '';
        for (let i = 0; i < event.results.length; i++) {
          allText += event.results[i][0].transcript + ' ';
        }
        allText = allText.trim();
        allTextRef.current = allText;

        // Strip already-committed prefix so we only react to NEW speech.
        const committed = lastCommittedTextRef.current;
        let newText = allText;
        if (committed && allText.startsWith(committed)) {
          newText = allText.slice(committed.length).trim();
        } else if (committed && allText.length < committed.length) {
          // Rec result buffer was reset (fresh rec instance) — clear tracker.
          lastCommittedTextRef.current = '';
          newText = allText;
        }

        if (!newText) return;

        interimBufferRef.current = newText;
        setLiveText(newText);
        onInterim?.(newText);

        // Arm the silence-commit timer on every interim update.
        if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
        commitTimerRef.current = window.setTimeout(() => {
          commitTimerRef.current = null;
          const pending = interimBufferRef.current.trim();
          if (!pending) return;
          interimBufferRef.current = '';
          setLiveText('');
          onInterim?.('');
          // Snapshot the current accumulated text as "committed" so the next
          // onresult event (which will still contain this text) is ignored.
          lastCommittedTextRef.current = allTextRef.current;
          // Do NOT stop the rec here — let the parent's setIsStreaming(true)
          // cycle drive teardown via stopWebSpeech. Stopping here races with
          // that and leaves Chrome's SR engine in a bad state.
          onTranscript(pending);
        }, SILENCE_COMMIT_MS);
      };

      rec.onerror = (e: any) => {
        console.warn('SpeechRecognition error:', e.error);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          setError(t(locale, 'micDenied'));
          shouldRestartRef.current = false;
          return;
        }
        // 'network' = browser cannot reach Google's STT backend.
        // 'audio-capture' = mic hardware/access issue but user already granted.
        // 'service-not-allowed' = enterprise policy blocks STT.
        // For any of these, permanently disable Web Speech API for this
        // session and switch to MediaRecorder + Deepgram fallback.
        if (e.error === 'network' || e.error === 'audio-capture' || e.error === 'aborted') {
          console.warn('Web Speech unavailable — falling back to Deepgram via /api/stt');
          webSpeechBlockedRef.current = true;
          shouldRestartRef.current = false;
          suppressResultsRef.current = true;
          // Tear down the current rec instance, then bring up MediaRecorder.
          try { rec.stop(); } catch {}
          recognitionRef.current = null;
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
          }
          if (audioCtxRef.current) {
            audioCtxRef.current.close().catch(() => {});
            audioCtxRef.current = null;
          }
          if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          analyserRef.current = null;
          setIsRecording(false);
          // Honor the parent's pause/disabled gates before starting fallback.
          if (!pausedRef.current && !disabled) {
            useWebSpeechRef.current = false;
            // Small delay so Chrome fully releases the previous mic stream.
            setTimeout(() => {
              if (!pausedRef.current && !disabled) {
                startMediaRecorderRef.current?.();
              }
            }, 200);
          }
        }
        // 'no-speech' is fine — onend will fire and we'll restart cleanly.
      };

      rec.onend = () => {
        setIsRecording(false);
        // Chrome auto-ends continuous recognition after long silence. If we
        // still want to be listening, recreate a fresh rec (not the same
        // instance — that leaves Chrome's SR engine in a dead state).
        // Use refs (not the closed-over `disabled` prop) so the gate stays
        // fresh across renders.
        if (shouldRestartRef.current && !pausedRef.current) {
          setTimeout(() => {
            if (!shouldRestartRef.current || pausedRef.current) return;
            // Tear down this rec fully and start a fresh one so the result
            // buffer is clean and we don't hit "already started" errors.
            recognitionRef.current = null;
            startWebSpeech();
          }, 150);
        }
      };

      // Reset per-session trackers for the new rec instance.
      allTextRef.current = '';
      lastCommittedTextRef.current = '';
      interimBufferRef.current = '';
      suppressResultsRef.current = false;

      rec.start();
      recognitionRef.current = rec;
      shouldRestartRef.current = true;
      setIsRecording(true);

      // Setup audio context for level meter
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        streamRef.current = stream;
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
      }).catch(() => {});

      return true;
    } catch {
      return false;
    }
  }, [speechLang, onInterim, onTranscript, disabled, locale]);

  const stopWebSpeech = useCallback(() => {
    shouldRestartRef.current = false;
    suppressResultsRef.current = true;
    // Flush any pending interim before tearing down — prevents losing the
    // last utterance when the agent starts speaking mid-sentence.
    flushInterim();
    try { recognitionRef.current?.stop(); } catch {}
    recognitionRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    // Reset commit-tracking so the next fresh rec isn't confused by stale
    // prefixes from the previous session.
    allTextRef.current = '';
    lastCommittedTextRef.current = '';
    interimBufferRef.current = '';
    setIsRecording(false);
    setLiveText('');
  }, [flushInterim]);

  // ── Fallback: MediaRecorder + /api/stt ───────────────────────────────
  const sendAudio = useCallback(async (blob: Blob) => {
    if (blob.size < 1500) return;
    setIsProcessing(true);
    try {
      const fd = new FormData();
      fd.append('audio', blob, 'utterance.webm');
      const res = await apiFetch('/api/stt', { method: 'POST', body: fd }, 60_000);
      if (res.ok) {
        const data = await res.json();
        const text = (data.transcript || '').trim();
        if (text) onTranscript(text);
      }
    } finally { setIsProcessing(false); }
  }, [onTranscript]);

  const startMediaRecorder = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      hasSpokenRef.current = false;

      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        if (hasSpokenRef.current) await sendAudio(blob);
        hasSpokenRef.current = false;
        if (!pausedRef.current && !disabled) {
          setTimeout(() => { mediaRecorderRef.current = null; startMediaRecorder(); }, 100);
        } else { mediaRecorderRef.current = null; }
      };

      mr.start(250);
      setIsRecording(true);

      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const SPEECH_THRESHOLD = 18;
      const SILENCE_MS = 1200;
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        setLevel(avg);
        if (avg > SPEECH_THRESHOLD) {
          hasSpokenRef.current = true;
          if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        } else if (hasSpokenRef.current && !silenceTimerRef.current) {
          silenceTimerRef.current = window.setTimeout(() => {
            try { mediaRecorderRef.current?.stop(); } catch {}
          }, SILENCE_MS);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e: any) {
      setError(e?.message || t(locale, 'micDenied'));
    }
  }, [disabled, locale, sendAudio]);

  const stopMediaRecorder = useCallback(() => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    try { mediaRecorderRef.current?.stop(); } catch {}
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    mediaRecorderRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    setIsRecording(false);
  }, []);

  // Keep the forward-reference ref pointed at the latest startMediaRecorder
  // so the Web Speech error handler can fall through to it without a TDZ
  // forward-reference error.
  useEffect(() => {
    startMediaRecorderRef.current = startMediaRecorder;
  }, [startMediaRecorder]);

  // ── Unified start/stop ───────────────────────────────────────────────
  const start = useCallback(() => {
    pausedRef.current = false;
    setError(null);
    if (startWebSpeech()) {
      useWebSpeechRef.current = true;
    } else {
      useWebSpeechRef.current = false;
      startMediaRecorder();
    }
  }, [startWebSpeech, startMediaRecorder]);

  const stop = useCallback(() => {
    pausedRef.current = true;
    if (useWebSpeechRef.current) stopWebSpeech();
    else stopMediaRecorder();
    setLiveText('');
    onInterim?.('');
  }, [stopWebSpeech, stopMediaRecorder, onInterim]);

  // Pause mic while agent speaks
  useEffect(() => {
    if (isAgentSpeaking) {
      if (useWebSpeechRef.current) stopWebSpeech();
      else stopMediaRecorder();
    } else if (autoStart && !disabled) {
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAgentSpeaking, autoStart, disabled]);

  // Auto-start on mount
  useEffect(() => {
    if (autoStart && !isAgentSpeaking && !disabled) start();
    return () => { pausedRef.current = true; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    if (isRecording) stop();
    else start();
  };

  const statusText = error
    ? error
    : isAgentSpeaking
      ? t(locale, 'agentSpeaking')
      : isProcessing
        ? t(locale, 'processing')
        : isRecording
          ? (liveText || t(locale, 'listening'))
          : t(locale, 'tapToSpeak');

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
              : isAgentSpeaking
                ? 'text-cerebral-teal'
                : liveText
                  ? 'text-cerebral-text italic'
                  : 'text-cerebral-accent'
          }`}
        >
          {statusText}
        </span>
      </div>

      <button
        onClick={toggle}
        disabled={disabled || isAgentSpeaking}
        title={isRecording ? t(locale, 'stop') : t(locale, 'start')}
        className={`p-4 rounded-xl transition-all duration-200 flex-shrink-0
          ${isRecording ? 'bg-cerebral-red text-white' : 'bg-cerebral-accent text-white hover:bg-cerebral-accent/80'}
          ${isRecording && !isAgentSpeaking ? 'animate-pulse' : ''}
          disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {isRecording ? (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
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
