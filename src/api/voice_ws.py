"""
WebSocket endpoint for real-time voice communication.

Protocol:
  Client -> Server: Binary audio chunks (WebM/Opus)
  Server -> Client: JSON control messages + binary audio chunks

JSON messages from server:
  {"type": "transcript", "text": "...", "is_final": true}
  {"type": "response_start", "text": "..."}
  {"type": "response_end", "is_complete": false}
  {"type": "error", "message": "..."}

Binary messages from server:
  Raw MP3 audio chunks for playback
"""

from __future__ import annotations

import asyncio
import json
import base64
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..voice.agent import VoiceAgent

router = APIRouter()

# Track active voice sessions
active_agents: dict[str, VoiceAgent] = {}


@router.websocket("/ws/voice/{session_id}")
async def voice_websocket(websocket: WebSocket, session_id: str):
    """Real-time voice WebSocket for patient intake interview."""
    await websocket.accept()

    agent = VoiceAgent(session_id)
    active_agents[session_id] = agent

    # Audio buffer for accumulating chunks before STT
    audio_buffer = bytearray()
    silence_timer: asyncio.Task | None = None

    async def process_buffer():
        """Process accumulated audio buffer through STT."""
        nonlocal audio_buffer
        if not audio_buffer:
            return

        audio_data = bytes(audio_buffer)
        audio_buffer = bytearray()

        result = await agent.process_audio_chunk(audio_data)
        if result and result.get("transcript"):
            transcript = result["transcript"]

            # Send transcript to client
            await websocket.send_json({
                "type": "transcript",
                "text": transcript,
                "is_final": True,
            })

            # Generate AI response
            try:
                response = await agent.generate_response(transcript)

                # Send response text
                await websocket.send_json({
                    "type": "response_start",
                    "text": response["text"],
                })

                # Stream TTS audio
                if response.get("audio_chunks"):
                    for chunk in response["audio_chunks"]:
                        if agent.interrupt_flag:
                            break
                        # Send audio as base64 in JSON for simpler handling
                        await websocket.send_json({
                            "type": "audio",
                            "data": base64.b64encode(chunk).decode(),
                            "format": "mp3",
                        })

                await websocket.send_json({
                    "type": "response_end",
                    "is_complete": response.get("is_complete", False),
                })

            except Exception as e:
                await websocket.send_json({
                    "type": "error",
                    "message": str(e),
                })

    try:
        while True:
            data = await websocket.receive()

            if "bytes" in data:
                # Accumulate audio data
                audio_buffer.extend(data["bytes"])

                # Reset silence timer (process after 500ms of silence)
                if silence_timer and not silence_timer.done():
                    silence_timer.cancel()
                silence_timer = asyncio.create_task(_delayed_process(process_buffer, 0.5))

            elif "text" in data:
                msg = json.loads(data["text"])

                if msg.get("type") == "text_input":
                    # Direct text input (fallback for no-mic)
                    transcript = msg["text"]
                    await websocket.send_json({
                        "type": "transcript",
                        "text": transcript,
                        "is_final": True,
                    })

                    response = await agent.generate_response(transcript)
                    await websocket.send_json({
                        "type": "response_start",
                        "text": response["text"],
                    })

                    if response.get("audio_chunks"):
                        for chunk in response["audio_chunks"]:
                            await websocket.send_json({
                                "type": "audio",
                                "data": base64.b64encode(chunk).decode(),
                                "format": "mp3",
                            })

                    await websocket.send_json({
                        "type": "response_end",
                        "is_complete": response.get("is_complete", False),
                    })

                elif msg.get("type") == "interrupt":
                    agent.interrupt_flag = True

                elif msg.get("type") == "end_session":
                    break

    except WebSocketDisconnect:
        pass
    finally:
        active_agents.pop(session_id, None)


async def _delayed_process(callback, delay: float):
    """Wait for delay seconds then call the callback."""
    await asyncio.sleep(delay)
    await callback()
