"""
CerebralMCP Backend API — FastAPI server for patient data, summarization, and voice agent.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

import httpx

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "pFZP5JQG7iQjIQuC4Bku")
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_v3")
DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
COOKIES_DIR = Path(__file__).resolve().parent.parent.parent / "cookies"

app = FastAPI(title="CerebralMCP", version="1.0.0")

# Include voice WebSocket router
from .voice_ws import router as voice_router
app.include_router(voice_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session store
sessions: dict[str, dict[str, Any]] = {}


# ── Models ──────────────────────────────────────────────────────────────
class PatientRequest(BaseModel):
    patient_id: str
    department: str = "Genel"


class IngestRequest(BaseModel):
    cookies_json: Optional[str] = None
    patient_id: Optional[str] = None
    department: str = "Kardiyoloji"


class ChatMessage(BaseModel):
    session_id: str
    message: str
    language: str = "tr"


class TTSRequest(BaseModel):
    text: str
    language: Optional[str] = None


# ── Helpers ─────────────────────────────────────────────────────────────
def _find_cookies() -> Path:
    candidates = sorted(COOKIES_DIR.glob("*.json"), key=os.path.getmtime, reverse=True)
    if not candidates:
        raise FileNotFoundError(f"No cookies.json in {COOKIES_DIR}")
    return candidates[0]


def _get_cookie_string() -> str:
    cookies_path = _find_cookies()
    script = SCRIPTS_DIR / "cerebral_cookie_from_json.py"
    proc = subprocess.run(
        [sys.executable, str(script), str(cookies_path)],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Cookie conversion failed: {proc.stderr}")
    return proc.stdout.strip()


def _fetch_patient_data(patient_id: str) -> dict:
    """Fetch full patient record via cerebral_fetch.py."""
    cookie = _get_cookie_string()
    script = SCRIPTS_DIR / "cerebral_fetch.py"
    proc = subprocess.run(
        [sys.executable, str(script), patient_id, "--cookie", cookie, "--stdout"],
        capture_output=True, text=True, timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Patient fetch failed: {proc.stderr[:1000]}")
    return json.loads(proc.stdout)


async def _summarize_patient(patient_data: dict, department: str) -> dict:
    """Summarize patient data using Claude."""
    try:
        import anthropic
    except ImportError:
        raise HTTPException(500, "anthropic package not installed")

    client = anthropic.Anthropic()

    prompt = f"""You are a clinical data summarizer for Acıbadem Hospital.
Analyze this patient record and produce a structured JSON summary.

Department: {department}

Patient Data:
{json.dumps(patient_data, ensure_ascii=False, indent=2)[:50000]}

Return ONLY valid JSON:
{{
  "patient": {{
    "name": "", "age": "", "sex": "", "patient_id": "", "birth_date": ""
  }},
  "allergies": [],
  "chronic_conditions": [],
  "current_medications": [{{"name": "", "dose": "", "frequency": ""}}],
  "visit_history": [{{
    "date": "", "department": "", "facility": "", "doctor": "",
    "diagnoses": [{{"icd_code": "", "name": ""}}],
    "complaints": [], "key_findings": "", "treatment": ""
  }}],
  "active_problems": [],
  "risk_factors": [],
  "recent_labs": [{{"test": "", "value": "", "date": "", "flag": ""}}],
  "recent_imaging": [{{"type": "", "date": "", "findings": ""}}],
  "surgical_history": [],
  "family_history": "",
  "social_history": "",
  "clinical_timeline_summary": "",
  "pre_visit_focus_areas": []
}}"""

    message = client.messages.create(
        model="claude-opus-4-20250514",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    text = message.content[0].text
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        return json.loads(match.group())
    return {"raw_summary": text}


# ── Endpoints ───────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


@app.post("/api/patient/ingest")
async def ingest_patient(req: IngestRequest):
    """Ingest patient data: fetch from Cerebral, summarize, create session."""
    patient_id = req.patient_id
    if not patient_id:
        raise HTTPException(400, "patient_id is required")

    patient_id = re.sub(r"[\s\-]+", "", patient_id.strip())

    try:
        # Fetch patient data
        patient_data = _fetch_patient_data(patient_id)

        # Summarize
        summary = await _summarize_patient(patient_data, req.department)

        # Create session
        session_id = str(uuid.uuid4())
        sessions[session_id] = {
            "patient_id": patient_id,
            "department": req.department,
            "patient_data": patient_data,
            "summary": summary,
            "chat_history": [],
            "interview_state": {
                "phase": "not_started",
                "collected": {},
                "sections_completed": [],
            },
            "created_at": datetime.now().isoformat(),
        }

        return {
            "success": True,
            "session_id": session_id,
            "patient_summary": summary,
        }
    except FileNotFoundError as e:
        raise HTTPException(503, f"Cookie file not found. Ensure cookies/cookies.json exists: {e}")
    except RuntimeError as e:
        raise HTTPException(502, f"Cerebral EHR connection failed: {e}")
    except json.JSONDecodeError as e:
        raise HTTPException(502, f"Invalid response from Cerebral EHR: {e}")
    except Exception as e:
        raise HTTPException(500, f"Unexpected error: {e}")


@app.get("/api/patient/{session_id}/summary")
async def get_patient_summary(session_id: str):
    """Get the structured patient summary for a session."""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session["summary"]


@app.get("/api/patient/{session_id}/data")
async def get_patient_data(session_id: str):
    """Get raw patient data for a session."""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session["patient_data"]


@app.post("/api/chat")
async def chat(msg: ChatMessage):
    """Send a message to the pre-visit interview agent."""
    session = sessions.get(msg.session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    try:
        import anthropic
    except ImportError:
        raise HTTPException(500, "anthropic package not installed")

    client = anthropic.Anthropic()

    # Handle synthetic interview-start signal from the frontend
    # Format: "__START_INTERVIEW__:<browser-locale>"
    is_start = msg.message.startswith("__START_INTERVIEW__:")
    if is_start:
        locale_tag = msg.message.split(":", 1)[1].strip() or "tr-TR"
        session["initial_language"] = locale_tag

    # Build the interview system prompt (includes initial language if set)
    system_prompt = _build_interview_system_prompt(session)

    # Add user message to history (skip the synthetic start marker)
    if not is_start:
        session["chat_history"].append({
            "role": "user",
            "content": msg.message,
            "timestamp": datetime.now().isoformat(),
        })

    # Build messages for Claude. If this is the start, seed with a neutral
    # user turn instructing the agent to greet in the initial language.
    if is_start:
        messages = [{
            "role": "user",
            "content": f"[SYSTEM] Please greet the patient warmly and begin the pre-visit interview. The patient's browser language is '{session.get('initial_language', 'tr-TR')}', so use that language for your opening. Introduce yourself briefly, confirm their name ({session.get('summary', {}).get('patient', {}).get('name', '')}), and ask the reason for today's visit.",
        }]
    else:
        messages = [{"role": m["role"], "content": m["content"]} for m in session["chat_history"]]

    response = client.messages.create(
        model="claude-opus-4-20250514",
        max_tokens=1024,
        system=system_prompt,
        messages=messages,
    )

    assistant_text = response.content[0].text

    # Strip emotion/action tags like [warmly] [gently] for chat display
    display_text = re.sub(r"\[[a-zA-Z ]{1,20}\]\s*", "", assistant_text).strip()

    session["chat_history"].append({
        "role": "assistant",
        "content": display_text,
        "timestamp": datetime.now().isoformat(),
    })

    # Check if interview is complete (assistant signals completion)
    is_complete = "PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ" in assistant_text or "PRE-VISIT PATIENT SUMMARY" in assistant_text

    return {
        "response": display_text,
        "tts_text": assistant_text,  # raw with emotion tags for TTS
        "is_complete": is_complete,
        "messages_count": len(session["chat_history"]),
    }


@app.post("/api/chat/stream")
async def chat_stream(msg: ChatMessage):
    """Stream response from the interview agent."""
    session = sessions.get(msg.session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    try:
        import anthropic
    except ImportError:
        raise HTTPException(500, "anthropic package not installed")

    client = anthropic.Anthropic()
    system_prompt = _build_interview_system_prompt(session)

    session["chat_history"].append({
        "role": "user",
        "content": msg.message,
        "timestamp": datetime.now().isoformat(),
    })

    messages = [{"role": m["role"], "content": m["content"]} for m in session["chat_history"]]

    async def generate():
        full_response = ""
        with client.messages.stream(
            model="claude-opus-4-20250514",
            max_tokens=1024,
            system=system_prompt,
            messages=messages,
        ) as stream:
            for text in stream.text_stream:
                full_response += text
                yield f"data: {json.dumps({'text': text})}\n\n"

        session["chat_history"].append({
            "role": "assistant",
            "content": full_response,
            "timestamp": datetime.now().isoformat(),
        })

        is_complete = "PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ" in full_response
        yield f"data: {json.dumps({'done': True, 'is_complete': is_complete})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/session/{session_id}/refresh-summary")
async def refresh_summary(session_id: str):
    """Re-extract facts from the live interview and merge into the patient summary.

    Runs a fast Claude Haiku pass over (base EHR summary + chat transcript so far)
    and returns an updated PatientSummary. The frontend calls this after every
    chat turn so the side panel can update in real time as the patient speaks.
    """
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    try:
        import anthropic
    except ImportError:
        raise HTTPException(500, "anthropic package not installed")

    history = session.get("chat_history", [])
    if not history:
        # Nothing new to extract — just return current summary.
        return {"summary": session.get("summary", {}), "updated": False}

    base_summary = session.get("summary", {}) or {}
    transcript = "\n".join(
        f"{'Patient' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
        for m in history[-40:]  # last ~40 turns is plenty of context
    )

    prompt = f"""You are a clinical fact extractor. Your job is to merge facts learned during a live pre-visit interview into the patient's structured summary.

Rules:
- START from the existing summary JSON (don't drop any fields).
- ADD or UPDATE fields based on what the patient told the assistant in the transcript.
- If the patient mentions a new symptom, add it to active_problems.
- If the patient mentions a medication, allergy, or chronic condition not already listed, add it.
- If the patient mentions severity, onset, or duration of a complaint, append it to pre_visit_focus_areas.
- Never invent facts — only use what the patient explicitly stated.
- Keep all pre-existing EHR fields (visit_history, recent_labs, etc.) intact.
- Return the COMPLETE updated summary JSON (same schema as input).

EXISTING SUMMARY:
{json.dumps(base_summary, ensure_ascii=False)[:20000]}

LIVE INTERVIEW TRANSCRIPT:
{transcript[:15000]}

Return ONLY the updated JSON object. No prose, no markdown fences."""

    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=3000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            updated = json.loads(match.group())
            # Persist back to session so subsequent turns see the richer context.
            session["summary"] = updated
            return {"summary": updated, "updated": True}
        return {"summary": base_summary, "updated": False}
    except json.JSONDecodeError:
        return {"summary": base_summary, "updated": False}
    except Exception as e:
        # Never break the UX if the extractor fails — just return the existing summary.
        return {"summary": base_summary, "updated": False, "error": str(e)[:200]}


@app.get("/api/session/{session_id}/interview-state")
async def get_interview_state(session_id: str):
    """Get current interview progress."""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    history = session["chat_history"]
    total_messages = len(history)
    user_messages = sum(1 for m in history if m["role"] == "user")

    # Estimate completion based on sections typically covered
    sections = [
        "Patient Demographics", "Chief Complaint", "History of Present Illness",
        "Past Medical History", "Current Medications", "Allergies",
        "Social History", "Review of Systems",
    ]

    return {
        "session_id": session_id,
        "total_messages": total_messages,
        "user_responses": user_messages,
        "sections": sections,
        "interview_state": session["interview_state"],
    }


@app.post("/api/session/{session_id}/generate-report")
async def generate_report(session_id: str):
    """Generate the final clinical report from the interview."""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    try:
        import anthropic
    except ImportError:
        raise HTTPException(500, "anthropic package not installed")

    client = anthropic.Anthropic()

    chat_transcript = "\n".join(
        f"{'Hasta' if m['role'] == 'user' else 'Asistan'}: {m['content']}"
        for m in session["chat_history"]
    )

    prompt = f"""Based on this pre-visit interview transcript, generate the structured clinical summary.
Use Turkish medical terminology. Follow the PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ format.

Patient Background Data:
{json.dumps(session.get('summary', {}), ensure_ascii=False, indent=2)[:10000]}

Interview Transcript:
{chat_transcript[:30000]}

Generate the complete clinical summary in the specified format."""

    response = client.messages.create(
        model="claude-opus-4-20250514",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    report = response.content[0].text

    return {
        "report": report,
        "format": "markdown",
        "generated_at": datetime.now().isoformat(),
    }


@app.post("/api/tts")
async def tts(req: TTSRequest):
    """Synthesize speech from text using ElevenLabs eleven_v3 (emotion-aware).

    Accepts the tagged text with [warmly] [gently] etc. and returns MP3 audio.
    """
    if not ELEVENLABS_API_KEY:
        raise HTTPException(503, "ELEVENLABS_API_KEY not configured")

    if not req.text.strip():
        raise HTTPException(400, "text is required")

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream",
                headers={
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                json={
                    "text": req.text,
                    "model_id": ELEVENLABS_MODEL,
                    "voice_settings": {
                        "stability": 0.35,
                        "similarity_boost": 0.85,
                        "style": 0.75,
                        "use_speaker_boost": True,
                    },
                    "output_format": "mp3_44100_128",
                },
            )
            if resp.status_code != 200:
                raise HTTPException(502, f"ElevenLabs error {resp.status_code}: {resp.text[:300]}")
            return Response(content=resp.content, media_type="audio/mpeg")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"TTS failed: {e}")


@app.post("/api/stt")
async def stt(audio: UploadFile = File(...), language: Optional[str] = None):
    """Transcribe audio using Deepgram nova-2 (multilingual)."""
    if not DEEPGRAM_API_KEY:
        raise HTTPException(503, "DEEPGRAM_API_KEY not configured")

    try:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(400, "Empty audio")

        params: dict[str, Any] = {
            "model": "nova-2",
            "smart_format": "true",
            "detect_language": "true",
        }
        if language:
            params["language"] = language

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://api.deepgram.com/v1/listen",
                params=params,
                headers={
                    "Authorization": f"Token {DEEPGRAM_API_KEY}",
                    "Content-Type": audio.content_type or "audio/webm",
                },
                content=audio_bytes,
            )
            if resp.status_code != 200:
                raise HTTPException(502, f"Deepgram error {resp.status_code}: {resp.text[:300]}")

            data = resp.json()
            alternatives = (
                data.get("results", {})
                .get("channels", [{}])[0]
                .get("alternatives", [{}])
            )
            transcript = alternatives[0].get("transcript", "") if alternatives else ""
            detected_lang = (
                data.get("results", {})
                .get("channels", [{}])[0]
                .get("detected_language")
            )
            return {
                "transcript": transcript,
                "detected_language": detected_lang,
                "confidence": alternatives[0].get("confidence") if alternatives else None,
            }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"STT failed: {e}")


@app.get("/api/export/{session_id}/{format}")
async def export_session(session_id: str, format: str):
    """Export session data in various formats."""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    if format == "json":
        export_data = {
            "patient_summary": session.get("summary"),
            "chat_history": session.get("chat_history"),
            "exported_at": datetime.now().isoformat(),
        }
        return JSONResponse(export_data)

    elif format == "markdown":
        md = _session_to_markdown(session)
        return StreamingResponse(
            iter([md]),
            media_type="text/markdown",
            headers={"Content-Disposition": f"attachment; filename=patient_{session['patient_id']}.md"},
        )

    raise HTTPException(400, f"Unsupported format: {format}. Use: json, markdown")


def _session_to_markdown(session: dict) -> str:
    """Convert session to markdown document."""
    s = session.get("summary", {})
    p = s.get("patient", {})

    lines = [
        f"# Pre-Visit Patient Summary",
        f"**Patient:** {p.get('name', 'N/A')} | **Age:** {p.get('age', 'N/A')} | **ID:** {p.get('patient_id', 'N/A')}",
        f"**Date:** {datetime.now().strftime('%d.%m.%Y')}",
        "",
        "## Clinical Timeline",
        s.get("clinical_timeline_summary", "N/A"),
        "",
        "## Active Problems",
        *[f"- {prob}" for prob in s.get("active_problems", [])],
        "",
        "## Chronic Conditions",
        *[f"- {c}" for c in s.get("chronic_conditions", [])],
        "",
        "## Current Medications",
        *[f"- {m.get('name', '')} {m.get('dose', '')} {m.get('frequency', '')}" for m in s.get("current_medications", [])],
        "",
        "## Allergies",
        *[f"- {a}" for a in s.get("allergies", ["Bilinen alerji yok"])],
        "",
        "## Visit History",
    ]

    for v in s.get("visit_history", []):
        lines.append(f"### {v.get('date', '')} — {v.get('department', '')}")
        lines.append(f"**Doctor:** {v.get('doctor', '')} | **Facility:** {v.get('facility', '')}")
        for d in v.get("diagnoses", []):
            lines.append(f"- [{d.get('icd_code', '')}] {d.get('name', '')}")
        if v.get("key_findings"):
            lines.append(f"**Findings:** {v['key_findings']}")
        lines.append("")

    lines.extend([
        "## Pre-Visit Focus Areas",
        *[f"- {a}" for a in s.get("pre_visit_focus_areas", [])],
        "",
        "---",
        f"*Generated by CerebralMCP on {datetime.now().strftime('%d.%m.%Y %H:%M')}*",
    ])

    return "\n".join(lines)


def _build_interview_system_prompt(session: dict) -> str:
    """Build the full system prompt for the pre-visit interview agent."""
    summary = session.get("summary", {})
    department = session.get("department", "Genel")
    patient = summary.get("patient", {})
    initial_language = session.get("initial_language", "tr-TR")

    patient_context = ""
    if summary:
        patient_context = f"""
PATIENT BACKGROUND (from EHR — use this to personalize questions, do NOT repeat this to the patient):
- Name: {patient.get('name', 'Bilinmiyor')}
- Age: {patient.get('age', 'Bilinmiyor')}
- Known Allergies: {json.dumps(summary.get('allergies', []), ensure_ascii=False)}
- Chronic Conditions: {json.dumps(summary.get('chronic_conditions', []), ensure_ascii=False)}
- Current Medications: {json.dumps(summary.get('current_medications', []), ensure_ascii=False)}
- Active Problems: {json.dumps(summary.get('active_problems', []), ensure_ascii=False)}
- Risk Factors: {json.dumps(summary.get('risk_factors', []), ensure_ascii=False)}
- Recent Visit Summary: {summary.get('clinical_timeline_summary', 'N/A')}
- Pre-Visit Focus: {json.dumps(summary.get('pre_visit_focus_areas', []), ensure_ascii=False)}
"""

    return f"""You are a pre-visit AI assistant working at Acıbadem Ataşehir Hospital, {department} outpatient clinic.
Your role is to collect the patient's medical history before they see their physician, and produce a structured clinical summary for the treating doctor.

You are NOT a doctor. You do NOT diagnose, interpret symptoms, suggest tests, or recommend treatment.

{patient_context}

LANGUAGE POLICY (CRITICAL):
- Your FIRST message (the opening greeting) MUST be in the language matching this BCP-47 tag: {initial_language}
  (e.g. "tr-TR" → Turkish, "en-US"/"en-GB" → English, "de-DE" → German, "fr-FR" → French, "ar-*" → Arabic, "fa-*" → Persian, "ru-RU" → Russian, etc.)
- Starting from the SECOND turn onward, AUTOMATICALLY DETECT the language the patient is writing/speaking in, and reply in THAT language.
- If the patient switches language mid-conversation, switch with them on the next reply.
- If the patient mixes languages in one message, reply in the dominant language of that message.
- Always use warm, accessible, non-clinical vocabulary appropriate to the language.

EMOTIONAL TONE (for TTS voice output):
- You may prepend short emotion/action tags at the START of sentences when appropriate, using square-bracket format: [warmly], [gently], [reassuring], [curious], [concerned], [empathetic], [softly], [pauses].
- Use tags sparingly — 1-2 per response, only when they add real warmth. Example: "[warmly] Merhaba, ben ön-görüşme asistanınızım."
- These tags will be interpreted by the ElevenLabs voice synthesizer to add emotional inflection. Never overuse.

COMMUNICATION STYLE (CRITICAL):
- Be PROFESSIONAL, DIRECT, and CONCISE. No filler, no redundancy.
- Do NOT echo back what the patient said ("Anladım, baş ağrınız var" is banned — just ask the next question).
- Do NOT announce what you are about to do ("Birkaç soru sormam gerekiyor" is banned).
- Go straight to the question. Maximum 2-3 short sentences per turn.
- Use clear clinical language the patient can understand, but without unnecessary softening.
- Prefer bullet-free prose — speak like a calm, experienced triage nurse, not a chatbot.

QUESTIONING:
- Ask EXACTLY ONE focused question per turn (occasionally 2 if tightly related).
- Start broad, then narrow based on the answer.
- Never ask multi-part questions separated by "and" / "or" unless they are two parts of the same concept.

VERIFICATION:
- Only verify CRITICAL info (medication dose, allergy, red-flag symptom). Do not parrot every answer.

EXAMPLE OF GOOD STYLE (Turkish):
BAD:  "Anladım, baş ağrınız var. Bu şikayetinizle ilgili birkaç soru sormam gerekiyor. Baş ağrınız ne zaman başladı? Ve başınızın tam olarak hangi bölgesinde ağrı hissediyorsunuz - ön taraf, yan taraflar, arka taraf veya tüm başınızda mı?"
GOOD: "Baş ağrısı ne zaman başladı?"
Then next turn: "Ağrıyı en çok nerede hissediyorsunuz?"

EXAMPLE OF GOOD STYLE (English):
BAD:  "I understand you have a headache. I need to ask you a few questions about this complaint. When did your headache start, and where exactly do you feel the pain?"
GOOD: "When did the headache start?"
Then next turn: "Where do you feel it most?"

INFORMATION TO COLLECT (in priority order):
P1 — CRITICAL: Chief complaint + Symptom characterization (location, character, severity 1-10, timing, exacerbating/relieving factors, associated symptoms)
P2 — HIGH: Complaint-related medications, allergies, relevant past medical history, risk factors for {department}
P3 — MEDIUM: Targeted review of systems for {department}, prior workup
P4 — LOW: Family history, social history, general background

OPENING SEQUENCE:
1. Introduce yourself (AI assistant, pre-visit data collection, not a doctor)
2. Confirm patient name and age
3. Ask reason for visit
4. Deep-dive into symptoms
5. Continue iterative loop

SAFETY:
- NEVER diagnose or suggest diagnosis probability
- NEVER recommend treatment or medication
- If red-flag symptoms: immediately say "Tarif ettiğiniz belirtiler acil tıbbi değerlendirme gerektirebilir. Lütfen hemen acil servise başvurun veya 112'yi arayın."
- If patient asks medical advice: "Bu soruyu doktorunuz çok daha doğru cevaplayacaktır."

When the interview is complete, generate the PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ in the specified format."""
