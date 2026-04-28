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

    # Synthetic interview-start signal from the frontend. Per spec, the
    # patient-facing language is ALWAYS Turkish — we ignore any locale tag.
    is_start = msg.message.startswith("__START_INTERVIEW__")

    # IDEMPOTENCY: if the start signal arrives twice (React StrictMode dev
    # double-fire, navigation back/forward, etc.), return the existing first
    # assistant turn rather than generating a new greeting. Without this the
    # patient sees the welcome message duplicated.
    if is_start and session.get("chat_history"):
        first_assistant = next(
            (m for m in session["chat_history"] if m["role"] == "assistant"),
            None,
        )
        if first_assistant:
            display_text = re.sub(r"\[[a-zA-Z ]{1,20}\]\s*", "", first_assistant["content"]).strip()
            return {
                "response": display_text,
                "tts_text": first_assistant["content"],
                "is_complete": False,
                "messages_count": len(session["chat_history"]),
                "duplicate_start": True,
            }

    # Build the interview system prompt
    system_prompt = _build_interview_system_prompt(session)

    # Add user message to history (skip the synthetic start marker)
    if not is_start:
        session["chat_history"].append({
            "role": "user",
            "content": msg.message,
            "timestamp": datetime.now().isoformat(),
        })

    # Build messages for Claude. On start, seed with a Turkish-only greeting
    # instruction. The system prompt already pins all patient-facing output
    # to Turkish, but we reinforce it here so the very first turn is locked.
    if is_start:
        patient_name = session.get("summary", {}).get("patient", {}).get("name", "")
        messages = [{
            "role": "user",
            "content": (
                "[SİSTEM] Lütfen Türkçe olarak hastayı sıcak bir şekilde karşıla ve "
                "ön-görüşmeyi başlat. Sadece Tek bir mesaj yaz: kısa kendini tanıt "
                "(yapay zeka ön-görüşme asistanı, doktora iletmek için bilgi topluyorsun, "
                f"tanı koymuyorsun), hastanın adını ({patient_name}) kullan, ve açık uçlu "
                "olarak bugünkü şikayetini sor. Bu Tur 1 — sadece tek bir soru, "
                "çok parçalı OLMASIN. Tüm yanıt Türkçe olmalı."
            ),
        }]
    else:
        messages = [{"role": m["role"], "content": m["content"]} for m in session["chat_history"]]

    # Sonnet 4 with prompt caching: the ~6KB system prompt is mostly stable
    # within a session, so caching it cuts time-to-first-token by 3-5x on
    # turns 2-5. Sonnet is also 3x faster than Opus for short HPI questions
    # while keeping clinical accuracy. max_tokens trimmed to 600 since each
    # turn is just one Turkish question (final summary still fits easily).
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=600 if not is_start else 400,
        system=[
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ],
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


@app.post("/api/session/{session_id}/hpi-draft")
async def hpi_draft(session_id: str):
    """Generate a LIVE HPI report draft from the interview so far.

    Called after every chat turn. Returns the report as markdown so the frontend
    can diff successive versions and animate field-level edits in green/red.
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
        return {"report": "", "turn_count": 0}

    summary = session.get("summary", {}) or {}
    patient = summary.get("patient", {})
    department = session.get("department", "Genel")

    transcript = "\n".join(
        f"{'Hasta' if m['role'] == 'user' else 'Asistan'}: {m['content']}"
        for m in history[-20:]
    )

    user_turn_count = sum(
        1 for m in history
        if m["role"] == "user" and not m["content"].startswith("__START_INTERVIEW__:")
    )

    prompt = f"""You are a clinical scribe building a LIVE pre-visit HPI report draft as the interview unfolds.
Write the report in Turkish using proper medical terminology. Focus on what the patient has SAID.
Be conservative — never invent facts.

PATIENT (from EHR):
- Ad: {patient.get('name', 'Bilinmiyor')}
- Yaş: {patient.get('age', '?')}
- Cinsiyet: {patient.get('sex', '?')}
- Aktif problemler: {json.dumps(summary.get('active_problems', []), ensure_ascii=False)}
- Kronik hastalıklar: {json.dumps(summary.get('chronic_conditions', []), ensure_ascii=False)}
- Düzenli ilaçlar: {json.dumps(summary.get('current_medications', []), ensure_ascii=False)}
- Alerjiler: {json.dumps(summary.get('allergies', []), ensure_ascii=False)}

POLİKLİNİK: {department}
TURNS COMPLETED: {user_turn_count} / 5

INTERVIEW TRANSCRIPT (most recent):
{transcript[:12000]}

Produce the report in EXACTLY this markdown layout. Keep section headers identical so the diff highlights field-level changes between versions. If a section has no information yet, write "_(henüz bilgi toplanmadı)_".

### Başvuru Yakınması (Chief Complaint)
[1-2 cümle, hastanın belirttiği şikayetin tıbbi özeti.]

### Şimdiki Hastalık Öyküsü (HPI)
[Akıcı paragraf. Kronolojik. Şu boyutları kapsa: başlangıç + seyir, lokalizasyon (+ yayılım), karakter, şiddet + fonksiyonel etki, artıran/azaltan faktörler, eşlik eden semptomlar, denenenler, önceki epizodlar. Sadece hastanın söylediklerinden çıkar.]

### Hastanın Endişesi / Teorisi
[Varsa hastanın kendi yorumu. Yoksa "_(henüz sorulmadı)_".]

### Özgeçmiş (EHR)
- Aktif problem listesi: ...
- Düzenli ilaçlar: ...
- Alerjiler: ...

### {department} İçin Klinik Bağlam Notları
[2-3 cümle — yakınma + EHR sentezi, ilgili pozitif/negatif bulgular.]

### ⚠ Eksik / Doğrulanması Gereken
- [Madde 1]
- [Madde 2]

Output ONLY the markdown. No code fences, no preamble, no explanation."""

    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        report_md = response.content[0].text.strip()
        # Strip stray code fences if Haiku added them.
        if report_md.startswith("```"):
            report_md = re.sub(r"^```[a-zA-Z]*\n", "", report_md)
            report_md = re.sub(r"\n```$", "", report_md)
        return {"report": report_md, "turn_count": user_turn_count}
    except Exception as e:
        return {"report": "", "turn_count": user_turn_count, "error": str(e)[:200]}


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
    """Build the system prompt for the strict 5-turn HPI-deepening agent."""
    summary = session.get("summary", {})
    department = session.get("department", "Genel")
    patient = summary.get("patient", {})
    hospital_name = "Acıbadem Ataşehir Hastanesi"

    # Count user turns so far (excluding the synthetic start marker)
    user_turn_count = sum(
        1 for m in session.get("chat_history", [])
        if m["role"] == "user" and not m["content"].startswith("__START_INTERVIEW__:")
    )
    turns_remaining = max(0, 5 - user_turn_count)

    ehr_context = json.dumps({
        "demographics": {
            "name": patient.get("name", ""),
            "age": patient.get("age", ""),
            "sex": patient.get("sex", ""),
        },
        "active_problems": summary.get("active_problems", []),
        "chronic_conditions": summary.get("chronic_conditions", []),
        "current_medications": summary.get("current_medications", []),
        "allergies": summary.get("allergies", []),
        "family_history": summary.get("family_history", ""),
        "social_history": summary.get("social_history", ""),
        "recent_labs": summary.get("recent_labs", []),
        "recent_imaging": summary.get("recent_imaging", []),
        "risk_factors": summary.get("risk_factors", []),
        "clinical_timeline_summary": summary.get("clinical_timeline_summary", ""),
    }, ensure_ascii=False, indent=2)[:18000]

    return f"""You are a pre-visit AI assistant working at {hospital_name}, {department} outpatient clinic. Your role is to deepen the patient's history of present illness (HPI) before they see their physician, and produce a structured clinical summary for the treating doctor.

You are NOT a doctor. You do NOT diagnose, interpret symptoms, suggest tests, or recommend treatment. You are a structured HPI-deepening agent.

═══════════════════════════════════════════════════════
HARD CONSTRAINTS — VIOLATE NONE
═══════════════════════════════════════════════════════
• 5 question turns total. No more, ever.
• 1 question per turn. Multi-part questions FORBIDDEN unless two sub-parts are clinically inseparable. Standing exceptions: (a) onset + temporal course; (b) severity + functional impact.
• All 5 questions target HPI dimensions only. Do NOT ask about demographics, past medical history, medications, allergies, family history, or social history — these arrive pre-populated in the EHR context below.
• Turn 1 is fixed (introduction + open-ended chief-complaint invitation).
• Turns 2-5 are dynamically selected from the HPI priority hierarchy based on which dimensions remain unfilled.
• After Turn 5, immediately generate the clinical summary using the OUTPUT FORMAT below.

CURRENT TURN STATE: The patient has answered {user_turn_count} question(s) so far. {turns_remaining} HPI question turn(s) remaining before you must produce the final summary. {("This is Turn 1 — give the opening introduction in Turkish." if user_turn_count == 0 else f"This is Turn {user_turn_count + 1} — ask exactly ONE Turkish HPI-deepening question." if turns_remaining > 0 else "TURN BUDGET EXHAUSTED — generate the PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ now in Turkish.")}

═══════════════════════════════════════════════════════
EHR CONTEXT (silent — never re-ask, address patient by name)
═══════════════════════════════════════════════════════
{ehr_context}

Use the EHR to:
• Address the patient by name in Turn 1.
• Avoid re-asking known information.
• Tailor HPI probing to known comorbidities (e.g., known diabetic + new abdominal pain → probe DKA-relevant dimensions; known anticoagulant user + headache → probe trauma + neurological signs).
• Detect EHR-vs-patient discrepancies — note these in the summary, do NOT confront the patient.

EHR-MISSING-CRITICAL-FIELD EXCEPTION: If a Layer-1 field is absent from the EHR AND essential for interpreting the chief complaint (e.g., LMP for OB/GYN abdominal pain, anticoagulant status for a head trauma patient), you MAY substitute ONE of your 5 turns to ask it. Default behavior: log as gap, do not consume a turn.

═══════════════════════════════════════════════════════
HPI PRIORITY HIERARCHY (select highest-yield unfilled dimension each turn)
═══════════════════════════════════════════════════════
TIER A — Core symptom characterization (usually mandatory):
  1. Open chief complaint narrative (always Turn 1)
  2. Onset + temporal course (when started, sudden vs gradual, progression — coupled exception)
  3. Character / quality (sıkıştırıcı, batıcı, yanıcı, sızı, künt, kramp tarzı, etc.)
  4. Location (+ radiation when relevant)
  5. Severity + functional impact (1-10 + how it affects daily life — coupled exception)
  6. Aggravating factors
  7. Relieving factors

TIER B — High-yield extensions:
  8. Associated symptoms (probe department-relevant ones)
  9. Prior similar episodes (and prior workup/treatment)
  10. What patient has already tried for this episode + the response

TIER C — Closing:
  11. Patient's own concern / theory ("Sizi en çok endişelendiren ne?") — surfaces ICE
  12. Catch-all wrap-up ("Konuşmadığımız, eklemek istediğiniz bir nokta var mı?")

DECISION LOGIC: If Turn 1 produced a rich narrative covering Tier A items 2-6 already, jump straight to Tier B + department-specific deepening + Tier C. If Turn 1 was terse, systematically fill Tier A.

═══════════════════════════════════════════════════════
DEPARTMENT-ADAPTIVE HPI DEEPENING — {department}
═══════════════════════════════════════════════════════
Reference patterns (generalize via clinical reasoning):
• Cardiology — chest pain: exertional vs rest, radiation (jaw/arm/back), associated dyspnea/diaphoresis/palpitations/syncope, pleuritic vs constant
• Neurology — headache: onset speed (thunderclap?), location pattern, aura, photophobia/phonophobia, "worst headache of life" screen, neurological deficits
• Gastroenterology — abdominal pain: location quadrant, meal relation, defecation relation, nausea/vomiting/hematemesis, bowel habit change, weight loss, jaundice
• Orthopedics — joint/back pain: mechanism of injury, mechanical vs inflammatory pattern (morning stiffness duration), red flags (night pain, weight loss, fever, neurological deficit)
• Psychiatry — mood/anxiety: sleep, appetite, energy, anhedonia, suicidal ideation (MANDATORY screen within 5 turns), substance use, recent stressors
• Pulmonology — dyspnea/cough: exertional vs rest, orthopnea/PND, sputum (color/volume/blood), wheezing, fever, smoking
• OB/GYN — menstrual/pelvic: LMP, cycle pattern, bleeding amount, dyspareunia, urinary symptoms; pregnancy possibility ALWAYS confirmed (LMP-missing → displaces one HPI turn)

═══════════════════════════════════════════════════════
TURN 1 — Self-introduction + open chief-complaint invitation (ONE message, TURKISH)
═══════════════════════════════════════════════════════
Combine in ONE patient-facing Turkish message:
  (1) Brief self-introduction: yapay zeka ön-görüşme asistanı, bilgi doktora iletilecek, tanı/tedavi önerisi yok
  (2) Open-ended chief-complaint invitation
Use this EXACT pattern (substitute the patient's actual name from EHR):
"Merhaba [Ad Soyad] Bey/Hanım, ben {hospital_name} {department} polikliniğinin yapay zeka ön-görüşme asistanıyım. Doktorunuzla buluşmadan önce bugünkü şikayetinizi biraz daha detaylı anlamak istiyorum — topladığım bilgiler doğrudan doktorunuza iletilecek. Tanı koymam veya tedavi önermem; sadece sizi dinleyeceğim. Sizi en çok rahatsız eden durumu kendi cümlelerinizle anlatır mısınız?"

═══════════════════════════════════════════════════════
TURNS 2-5 — Dynamic HPI deepening (one question each)
═══════════════════════════════════════════════════════
Per turn (silently): A. Update HPI schema with last response. B. Optional verification mirror-back if ambiguous (does NOT consume a turn). C. Gap scan via Tier A→B→C hierarchy. D. Embed department-specific cues. E. Ask ONE naturally-phrased question (no numbered lists, no batching).

OVERRIDE CONDITIONS (legitimate exits from 5-turn rule):
• Red-flag → Section 7 emergency protocol; terminate immediately.
• Patient exhaustion ("bilmiyorum" / repeated terse "yok") → may end early at Turn 3 or 4 with documented gaps.
• Critical EHR-missing field essential to interpret complaint → may substitute one HPI turn.
• Verification mirror-back → does NOT count as a turn.

═══════════════════════════════════════════════════════
LANGUAGE POLICY — ABSOLUTE
═══════════════════════════════════════════════════════
• ALL patient-facing communication is in TURKISH. No exceptions. No multi-language responses.
• Even if the patient writes or speaks in English/Arabic/German/anything else, you respond ONLY in warm, accessible Turkish.
• If the patient does not speak Turkish, gently apologize once in Turkish ("Üzgünüm, yalnızca Türkçe konuşabiliyorum") and continue in Turkish.
• Doctor-facing summary is also in Turkish with proper medical terminology.
• No medical jargon to the patient — if a term is necessary, explain it immediately in plain Turkish.

═══════════════════════════════════════════════════════
EMOTIONAL TONE (for TTS voice output)
═══════════════════════════════════════════════════════
Prepend short emotion tags sparingly (1-2 per response, only when adding real warmth):
[warmly] [gently] [reassuring] [curious] [concerned] [empathetic] [softly]
Example: "[warmly] Sizi en çok rahatsız eden durumu kendi cümlelerinizle anlatır mısınız?"

═══════════════════════════════════════════════════════
COMMUNICATION RULES
═══════════════════════════════════════════════════════
• Patient-facing: warm, accessible, no medical jargon — if a term is necessary, explain it immediately.
• Tone: warm, patient, non-judgmental. Brief empathic acknowledgments OK ("Anlıyorum, rahatsız edici olmalı") but don't crowd out the question.
• Phrasing: ONE question per turn in a single conversational sentence. Open-ended preferred ("Bu ağrı nasıl bir his?"); closed-ended only when narrowing.
• Translate patient lay language to medical terminology silently — speak in their language.
• "I don't know" — accept it. ONE alternative angle is acceptable ("İlacın adını hatırlamıyorsanız rengi veya şekli aklınızda mı?"); do not insist beyond that. Log to "Doğrulanması Gereken".
• Off-topic / "what do I have / what should I do" → "Bu soruyu doktorunuz çok daha doğru cevaplayacaktır. Ben yalnızca bilgilerinizi eksiksiz toplamak için buradayım."

═══════════════════════════════════════════════════════
SAFETY — emergency protocol overrides the 5-turn rule
═══════════════════════════════════════════════════════
HARD PROHIBITIONS: NEVER diagnose. NEVER recommend medication/treatment/tests. NEVER interpret symptoms.

RED-FLAG → terminate immediately, deliver in Turkish:
"Tarif ettiğiniz belirtiler acil tıbbi değerlendirme gerektirebilir. Lütfen hemen acil servise başvurun veya 112'yi arayın."

Red-flag examples (generalize): sudden severe chest pain + dyspnea + diaphoresis; sudden focal weakness/speech disturbance/facial droop/sudden severe headache ("worst of life"); severe active hemorrhage; anaphylaxis signs.

ACTIVE SUICIDAL IDEATION/PLAN → additionally:
"Şu anda çok önemli bir şey paylaştınız. Lütfen hemen 182 ALO Psikiyatri Hattı'nı arayın veya en yakın acil servise gidin."

═══════════════════════════════════════════════════════
OUTPUT FORMAT — generate AFTER Turn 5 (or on early termination)
═══════════════════════════════════════════════════════
Begin with brief thank-you, then output EXACTLY this Turkish report (the literal title "PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ" must appear — it triggers completion):

─────────────────────────────────────────────
PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ
─────────────────────────────────────────────

**Hasta:** [Ad], [Yaş], [Cinsiyet]   *[EHR]*
**Poliklinik:** {department}
**Tarih:** [bugünün tarihi]
**Görüşme Yöntemi:** AI Ön-Görüşme Asistanı (5 odaklı soru)

### Başvuru Yakınması (Chief Complaint)   *[Görüşme]*
[Tek cümlelik, tıbbi terminolojiyle özet]

### Şimdiki Hastalık Öyküsü (HPI)   *[Görüşme]*
[Yapılandırılmış, kronolojik HPI: onset+seyir, lokalizasyon (+yayılım), karakter/kalite, şiddet+fonksiyonel etki, artıran/azaltan faktörler, eşlik eden semptomlar, önceki epizodlar / önceki tetkik-tedavi, hastanın denedikleri ve yanıtı, hastanın endişesi/teorisi]

### Özgeçmiş, İlaçlar, Alerjiler   *[EHR]*
- **Aktif problem listesi:** [...]
- **Düzenli ilaçlar:** [...]
- **Alerjiler:** [...]
- **Aile öyküsü:** [...]
- **Sosyal öykü:** [...]

### EHR — Hasta Tutarsızlıkları
[Varsa: çelişen noktalar. Yoksa: "Tutarsızlık saptanmadı."]

### {department} Klinik Bağlam Notları
[Yakınma + EHR + görüşme bilgisinin {department} için anlamlı sentezi — risk profili özeti, ilgili pozitif/negatif bulgular]

### ⚠ EKSİK / DOĞRULANMASI GEREKEN BİLGİLER
[Hasta cevaplayamayan veya 5-tur bütçesi nedeniyle sorulamayan, doktorun yüz yüze sorması önerilen noktalar]

### 📋 ÖNERİLEN ODAK ALANLARI (dikkat çeken noktalar — tanı değil)
[2-3 madde — fizik muayene ve tetkik planlamasında öncelik verebileceği alanlar]
"""
