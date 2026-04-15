"""
Voice Agent — Real-time conversational voice interface for patient intake.

Uses ElevenLabs for TTS, Deepgram for STT (fast, multilingual),
and Claude for the conversational AI backbone.

Architecture:
  Browser <-> WebSocket <-> This Agent <-> Claude API (reasoning)
                                       <-> Deepgram (STT)
                                       <-> ElevenLabs (TTS)

Features:
  - Ultra-low latency: streaming STT + streaming TTS
  - Interruption support: patient can interrupt at any time
  - Multilingual: auto-detects language, responds in Turkish
  - Emotion-aware: ElevenLabs voice with warmth settings
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Optional

import httpx

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "pFZP5JQG7iQjIQuC4Bku")  # Warm Turkish female
# eleven_v3 supports emotion/action audio tags like [warmly], [gently], [reassuring].
# Fallback to turbo for speed if the v3 model is not accessible on your account.
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_v3")

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")


class VoiceAgent:
    """Manages a single voice interview session."""

    def __init__(self, session_id: str, api_base: str = "http://localhost:8000"):
        self.session_id = session_id
        self.api_base = api_base
        self.is_speaking = False
        self.is_listening = True
        self.interrupt_flag = False
        self._tts_task: Optional[asyncio.Task] = None

    async def process_audio_chunk(self, audio_bytes: bytes) -> Optional[dict]:
        """Process incoming audio from the browser.

        Returns: {"transcript": str} when speech is finalized, None while buffering.
        """
        # Use Deepgram for STT
        transcript = await self._transcribe(audio_bytes)
        if transcript:
            # If the agent is currently speaking, this is an interruption
            if self.is_speaking:
                self.interrupt_flag = True
                self.is_speaking = False
                if self._tts_task and not self._tts_task.done():
                    self._tts_task.cancel()

            return {"transcript": transcript}
        return None

    async def generate_response(self, user_text: str) -> dict:
        """Send user text to the chat API and get response + TTS audio."""
        # Get text response from Claude
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{self.api_base}/api/chat",
                json={
                    "session_id": self.session_id,
                    "message": user_text,
                    "language": "tr",
                },
            )
            resp.raise_for_status()
            data = resp.json()

        response_text = data["response"]  # clean, tag-free, for display
        tts_text = data.get("tts_text", response_text)  # with emotion tags for TTS
        is_complete = data.get("is_complete", False)

        # Generate TTS audio using the tagged text for emotional inflection
        audio_chunks = []
        if ELEVENLABS_API_KEY:
            audio_chunks = await self._text_to_speech(tts_text)

        return {
            "text": response_text,
            "audio_chunks": audio_chunks,
            "is_complete": is_complete,
        }

    async def _transcribe(self, audio_bytes: bytes) -> Optional[str]:
        """Transcribe audio using Deepgram."""
        if not DEEPGRAM_API_KEY:
            return None

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://api.deepgram.com/v1/listen",
                params={
                    "model": "nova-2",
                    "language": "tr",
                    "smart_format": "true",
                    "detect_language": "true",
                },
                headers={
                    "Authorization": f"Token {DEEPGRAM_API_KEY}",
                    "Content-Type": "audio/webm",
                },
                content=audio_bytes,
            )
            if resp.status_code == 200:
                data = resp.json()
                alternatives = (
                    data.get("results", {})
                    .get("channels", [{}])[0]
                    .get("alternatives", [{}])
                )
                if alternatives and alternatives[0].get("transcript"):
                    return alternatives[0]["transcript"]
        return None

    async def _text_to_speech(self, text: str) -> list[bytes]:
        """Convert text to speech using ElevenLabs streaming."""
        if not ELEVENLABS_API_KEY:
            return []

        chunks = []
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream",
                headers={
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                },
                json={
                    "text": text,
                    "model_id": ELEVENLABS_MODEL,
                    "voice_settings": {
                        # Lower stability = more expressive/emotional range
                        "stability": 0.35,
                        "similarity_boost": 0.85,
                        # Higher style = stronger emotional inflection from tags
                        "style": 0.75,
                        "use_speaker_boost": True,
                    },
                    "output_format": "mp3_44100_128",
                },
            )
            if resp.status_code == 200:
                chunks.append(resp.content)

        self.is_speaking = True
        return chunks

    async def stream_tts(self, text: str):
        """Generator that yields audio chunks for streaming TTS."""
        if not ELEVENLABS_API_KEY:
            return

        self.is_speaking = True
        self.interrupt_flag = False

        async with httpx.AsyncClient(timeout=30) as client:
            async with client.stream(
                "POST",
                f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream",
                headers={
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                },
                json={
                    "text": text,
                    "model_id": ELEVENLABS_MODEL,
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.8,
                        "style": 0.3,
                        "use_speaker_boost": True,
                    },
                    "output_format": "mp3_44100_128",
                },
            ) as response:
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    if self.interrupt_flag:
                        self.is_speaking = False
                        return
                    yield chunk

        self.is_speaking = False
