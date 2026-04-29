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
# eleven_flash_v2_5: ElevenLabs' fastest model, ~75ms time-to-first-byte
# even on long inputs, designed for real-time voice agents. Quality is
# slightly below turbo_v2_5 but the latency win (4-5x on long sentences)
# dominates UX — agent voice now starts right after the text lands.
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5")
DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")

# Optional OpenAI provider — if set, /api/chat uses gpt-4o-mini instead of
# Anthropic Haiku for the per-turn HPI questions. gpt-4o-mini is ~2-3x faster
# than Haiku 3.5 on short structured outputs. Set OPENAI_API_KEY in .env to
# opt in; leave unset to keep Anthropic as the default.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
CHAT_PROVIDER = "openai" if OPENAI_API_KEY else "anthropic"

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
    # When true, skip the Cerebral EHR scrape + Claude summarization entirely
    # and create a session with empty patient context. Useful for testing or
    # when the cookies are stale. Returns in <1s.
    skip_ehr: bool = False
    # Optional: when skip_ehr is true, populate patient.name from this so the
    # interview agent can address the patient by name in Turn 1.
    patient_name: Optional[str] = None


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

    # Sonnet 4 finishes the EHR → structured-summary extraction in ~25-40s
    # vs Opus 4's 60-120s. Cloudflare's quick-tunnel HTTP response timeout
    # is 100s, so this also keeps remote (tunneled) ingest from 524ing.
    message = client.messages.create(
        model="claude-sonnet-4-20250514",
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
    """Ingest patient data: fetch from Cerebral, summarize, create session.

    If req.skip_ehr is true, skip the scrape+summary and create an empty
    session — the interview will run on a blank slate (the agent still
    asks the patient about their reason for visit).
    """
    patient_id = req.patient_id
    if not patient_id:
        raise HTTPException(400, "patient_id is required")

    patient_id = re.sub(r"[\s\-]+", "", patient_id.strip())

    # Skip-EHR mode: build a placeholder summary and return immediately.
    if req.skip_ehr:
        session_id = str(uuid.uuid4())
        placeholder_summary = {
            "patient": {
                "name": req.patient_name or "Hasta",
                "age": "",
                "sex": "",
                "patient_id": patient_id,
                "birth_date": "",
            },
            "allergies": [],
            "chronic_conditions": [],
            "current_medications": [],
            "visit_history": [],
            "active_problems": [],
            "risk_factors": [],
            "recent_labs": [],
            "recent_imaging": [],
            "surgical_history": [],
            "family_history": "",
            "social_history": "",
            "clinical_timeline_summary": "",
            "pre_visit_focus_areas": [],
        }
        sessions[session_id] = {
            "patient_id": patient_id,
            "department": req.department,
            "patient_data": {},
            "summary": placeholder_summary,
            "chat_history": [],
            "interview_state": {
                "phase": "not_started",
                "collected": {},
                "sections_completed": [],
            },
            "created_at": datetime.now().isoformat(),
            "skip_ehr": True,
        }
        return {
            "success": True,
            "session_id": session_id,
            "patient_summary": placeholder_summary,
            "skip_ehr": True,
        }

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

    # Provider switch: OpenAI gpt-4o-mini is fastest (~500ms-1s for short
    # Turkish HPI questions). Anthropic Haiku 3.5 is the default fallback —
    # ~1-2s with prompt caching on turns 2-3. Both produce a single Turkish
    # question well within 400 tokens for chat turns and 800 for the final
    # summary. The previous Sonnet 4 path was 3-5s/turn which made the
    # voice loop feel laggy.
    # Token budget: 400 for short HPI questions; 1200 for the final summary
    # (which is generated when turn_count >= 3).
    user_turn_so_far = sum(
        1 for m in session.get("chat_history", [])
        if m["role"] == "user" and not m["content"].startswith("__START_INTERVIEW__")
    )
    is_final_summary_turn = user_turn_so_far >= 3
    max_tok = 1200 if is_final_summary_turn else 400

    if CHAT_PROVIDER == "openai":
        try:
            import openai
        except ImportError:
            raise HTTPException(500, "openai package not installed (pip install openai)")
        oa_client = openai.OpenAI(api_key=OPENAI_API_KEY)
        oa_messages = [{"role": "system", "content": system_prompt}] + messages
        oa_resp = oa_client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=oa_messages,
            max_tokens=max_tok,
            temperature=0.6,
        )
        assistant_text = oa_resp.choices[0].message.content or ""
    else:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=max_tok,
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
            model="claude-haiku-4-5",
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
            model="claude-haiku-4-5",
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

    # Sonnet 4 finishes the structured report in ~1/3 the time of Opus 4 with
    # negligible quality difference for this fixed-template task.
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2500,
        messages=[{"role": "user", "content": prompt}],
    )

    report = response.content[0].text
    # Persist so the PDF export endpoint can render the same content.
    session["clinical_report"] = report

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

    # flash_v2_5 / turbo_v2_5 / multilingual_v2 don't interpret emotion tags
    # — strip them so the TTS doesn't read "[warmly]" out loud. Also collapse
    # extra whitespace which can cause unnatural pauses.
    cleaned = re.sub(r"\[[a-zA-Z ]{1,20}\]\s*", "", req.text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    # Stream the audio from ElevenLabs straight through to the browser. The
    # browser's <audio> element starts playing as soon as the first chunks
    # arrive (mp3 is progressively decodable), so playback begins ~150-300ms
    # after the request — instead of waiting for the full file. With
    # eleven_flash_v2_5 + optimize_streaming_latency=4 + mp3_22050_32, the
    # round-trip is well under a second on most sentences.
    async def stream_audio():
        async with httpx.AsyncClient(timeout=60) as client:
            async with client.stream(
                "POST",
                f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream",
                params={
                    # 0=quality, 4=max speed. 4 is the right pick for an
                    # interactive voice agent.
                    "optimize_streaming_latency": "4",
                    "output_format": "mp3_22050_32",
                },
                headers={
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                json={
                    "text": cleaned,
                    "model_id": ELEVENLABS_MODEL,
                    "voice_settings": {
                        # Lower stability + max speaker boost on flash =
                        # snappy, expressive Turkish without the artifacts
                        # turbo had at non-zero style.
                        "stability": 0.4,
                        "similarity_boost": 0.75,
                        "style": 0.0,
                        "use_speaker_boost": True,
                        # 1.0 is normal pace; 1.15 = ~15% faster delivery,
                        # close to a clinician's natural intake speed
                        # without sounding rushed.
                        "speed": 1.15,
                    },
                },
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    raise HTTPException(502, f"ElevenLabs error {resp.status_code}: {body[:300].decode(errors='ignore')}")
                async for chunk in resp.aiter_bytes(chunk_size=4096):
                    yield chunk

    return StreamingResponse(
        stream_audio(),
        media_type="audio/mpeg",
        headers={
            # Disable buffering layers between us and the browser so the
            # first audio chunks reach <audio> as soon as they're written.
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/stt")
async def stt(audio: UploadFile = File(...), language: Optional[str] = None):
    """Transcribe audio. Tries OpenAI Whisper first (fast, excellent Turkish),
    falls back to Deepgram nova-2 if OpenAI fails or isn't configured."""
    audio_bytes = await audio.read()
    print(f"[STT] received {len(audio_bytes)} bytes, content_type={audio.content_type}", flush=True)
    if not audio_bytes:
        raise HTTPException(400, "Empty audio")
    if len(audio_bytes) < 800:
        # Sub-second clips are usually accidental double-taps. Return empty
        # so the frontend doesn't surface a 502 to the user.
        print(f"[STT] clip too short ({len(audio_bytes)} bytes), returning empty", flush=True)
        return {"transcript": "", "detected_language": None, "confidence": None}

    lang = language or "tr"
    last_err: Optional[str] = None

    # ── Provider 1: OpenAI Whisper (gpt-4o-mini-transcribe) ─────────────
    if OPENAI_API_KEY:
        try:
            # Pick a sensible filename extension based on MIME so OpenAI's
            # multipart parser routes it correctly.
            mime = (audio.content_type or "audio/webm").split(";")[0].strip()
            ext = {
                "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav",
                "audio/mp3": "mp3", "audio/mpeg": "mp3", "audio/mp4": "mp4",
                "audio/m4a": "m4a", "audio/aac": "aac",
            }.get(mime, "webm")

            async with httpx.AsyncClient(timeout=30) as oa:
                files = {
                    "file": (f"speech.{ext}", audio_bytes, mime),
                }
                data = {
                    # gpt-4o-mini-transcribe is ~2x faster than whisper-1
                    # and at parity / better quality on short clips.
                    "model": "gpt-4o-mini-transcribe",
                    "language": lang,
                    "response_format": "json",
                }
                oa_resp = await oa.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                    files=files,
                    data=data,
                )
                if oa_resp.status_code == 200:
                    payload = oa_resp.json()
                    transcript = (payload.get("text") or "").strip()
                    print(f"[STT/OpenAI] OK — {len(transcript)} chars", flush=True)
                    return {
                        "transcript": transcript,
                        "detected_language": payload.get("language") or lang,
                        "confidence": None,
                        "provider": "openai",
                    }
                last_err = f"OpenAI Whisper {oa_resp.status_code}: {oa_resp.text[:300]}"
                print(f"[STT/OpenAI] {last_err}", flush=True)
        except Exception as e:
            last_err = f"OpenAI Whisper exception: {e}"
            print(f"[STT/OpenAI] {last_err}", flush=True)

    # ── Provider 2: Deepgram nova-2 ─────────────────────────────────────
    if DEEPGRAM_API_KEY:
        try:
            mime = (audio.content_type or "audio/webm").split(";")[0].strip()
            if mime not in ("audio/webm", "audio/ogg", "audio/wav", "audio/mp3",
                            "audio/mpeg", "audio/mp4", "audio/m4a", "audio/aac"):
                mime = "audio/webm"

            params: dict[str, Any] = {
                "model": "nova-2",
                "smart_format": "true",
                "language": lang,
            }
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    "https://api.deepgram.com/v1/listen",
                    params=params,
                    headers={
                        "Authorization": f"Token {DEEPGRAM_API_KEY}",
                        "Content-Type": mime,
                    },
                    content=audio_bytes,
                )
                if resp.status_code != 200:
                    last_err = f"Deepgram {resp.status_code}: {resp.text[:300]}"
                    print(f"[STT/Deepgram] {last_err}", flush=True)
                else:
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
                    print(f"[STT/Deepgram] OK — {len(transcript)} chars", flush=True)
                    return {
                        "transcript": transcript,
                        "detected_language": detected_lang,
                        "confidence": alternatives[0].get("confidence") if alternatives else None,
                        "provider": "deepgram",
                    }
        except Exception as e:
            last_err = f"Deepgram exception: {e}"
            print(f"[STT/Deepgram] {last_err}", flush=True)

    # Both providers failed (or none configured)
    raise HTTPException(502, f"STT failed: {last_err or 'no provider configured'}")


@app.get("/api/export/{session_id}/pdf")
async def export_pdf(session_id: str):
    """Generate a properly-typeset Turkish PDF with a working outline.

    Uses ReportLab + the bundled Noto Sans Variable font, which has full
    coverage of Latin Extended-A (ş, ğ, ı, etc. — the characters the previous
    jsPDF/Helvetica path was rendering as boxes/missing glyphs). H1/H2/H3
    paragraphs register PDF outline entries via afterFlowable so the doctor
    can navigate the report from the bookmarks panel.
    """
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import mm
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.enums import TA_LEFT
        from reportlab.lib.colors import HexColor
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.platypus import (
            BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
            HRFlowable, KeepTogether,
        )
    except ImportError:
        raise HTTPException(500, "reportlab not installed (pip install reportlab)")

    # Pick a Unicode TTF — bundled Noto Sans, with system fallbacks.
    bundled = Path(__file__).resolve().parent / "fonts" / "NotoSans.ttf"
    font_candidates = [
        str(bundled),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    font_path = next((p for p in font_candidates if Path(p).exists()), None)
    if not font_path:
        raise HTTPException(500, "No Unicode font found for PDF export")

    try:
        pdfmetrics.registerFont(TTFont("BodyFont", font_path))
    except Exception:
        pass  # already registered

    # Build report content
    summary = session.get("summary", {}) or {}
    patient = summary.get("patient", {})
    department = session.get("department", "Genel")
    chat_history = session.get("chat_history", [])

    # Use generated clinical report if available, otherwise fall back to live
    # summary built from the chat history.
    report_md = session.get("clinical_report")
    if not report_md:
        # Generate a quick summary block from session state.
        report_md = _build_pdf_fallback_markdown(session)

    import io
    from html import escape as html_escape

    buf = io.BytesIO()

    # Define styles
    H1 = ParagraphStyle(
        name="H1", fontName="BodyFont", fontSize=18, leading=22,
        textColor=HexColor("#1e3a5f"), spaceAfter=8, spaceBefore=4,
        alignment=TA_LEFT,
    )
    H2 = ParagraphStyle(
        name="H2", fontName="BodyFont", fontSize=13, leading=17,
        textColor=HexColor("#2e5a8a"), spaceAfter=6, spaceBefore=14,
    )
    H3 = ParagraphStyle(
        name="H3", fontName="BodyFont", fontSize=11, leading=14,
        textColor=HexColor("#444"), spaceAfter=4, spaceBefore=10,
    )
    Body = ParagraphStyle(
        name="Body", fontName="BodyFont", fontSize=10, leading=14,
        textColor=HexColor("#222"), spaceAfter=4,
    )
    Meta = ParagraphStyle(
        name="Meta", fontName="BodyFont", fontSize=9, leading=12,
        textColor=HexColor("#666"), spaceAfter=2,
    )
    BulletStyle = ParagraphStyle(
        name="Bullet", fontName="BodyFont", fontSize=10, leading=14,
        textColor=HexColor("#222"), leftIndent=12, bulletIndent=2,
        spaceAfter=2,
    )

    # Doc template with afterFlowable callback for PDF outline
    bookmark_counter = {"i": 0}

    class HPIDoc(BaseDocTemplate):
        def __init__(self, *args, **kwargs):
            BaseDocTemplate.__init__(self, *args, **kwargs)
            frame = Frame(
                self.leftMargin, self.bottomMargin,
                self.width, self.height,
                id='normal',
            )
            self.addPageTemplates([PageTemplate(id='Main', frames=frame)])

        def afterFlowable(self, flowable):
            if isinstance(flowable, Paragraph):
                style = flowable.style.name
                if style in ("H1", "H2", "H3"):
                    text = flowable.getPlainText()
                    bookmark_counter["i"] += 1
                    key = f"bm{bookmark_counter['i']}"
                    self.canv.bookmarkPage(key)
                    level = {"H1": 0, "H2": 1, "H3": 2}[style]
                    self.canv.addOutlineEntry(text, key, level=level, closed=False)

    doc = HPIDoc(
        buf, pagesize=A4,
        leftMargin=20*mm, rightMargin=20*mm,
        topMargin=18*mm, bottomMargin=18*mm,
        title="Pre-Visit Patient Summary",
        author="CerebraLink",
    )

    story = []

    # ── Header ──
    story.append(Paragraph("PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ", H1))
    story.append(HRFlowable(width="100%", thickness=1.2, color=HexColor("#1e3a5f"), spaceAfter=10))

    name = patient.get("name") or "Bilinmiyor"
    age = patient.get("age") or "?"
    sex = patient.get("sex") or "?"
    pid = patient.get("patient_id") or "?"
    today = datetime.now().strftime("%d.%m.%Y")
    story.append(Paragraph(f"<b>Hasta:</b> {html_escape(str(name))}, {html_escape(str(age))} yaş, {html_escape(str(sex))}", Meta))
    story.append(Paragraph(f"<b>Hasta No:</b> {html_escape(str(pid))} &nbsp;&nbsp; <b>Poliklinik:</b> {html_escape(department)} &nbsp;&nbsp; <b>Tarih:</b> {today}", Meta))
    story.append(Paragraph("<b>Görüşme Yöntemi:</b> AI Ön-Görüşme Asistanı (3 odaklı soru)", Meta))
    story.append(Spacer(1, 6))

    # ── Body — render the markdown report as Platypus flowables ──
    story.extend(_md_to_flowables(report_md, H2, H3, Body, BulletStyle))

    # ── Interview transcript appendix ──
    if chat_history:
        story.append(Spacer(1, 14))
        story.append(HRFlowable(width="100%", thickness=0.5, color=HexColor("#ccc")))
        story.append(Paragraph("Görüşme Dökümü (Ek)", H2))
        for m in chat_history:
            if m["content"].startswith("__START_INTERVIEW__"):
                continue
            role = "Hasta" if m["role"] == "user" else "Asistan"
            color = "#1e3a5f" if m["role"] == "assistant" else "#444"
            text_safe = html_escape(m["content"]).replace("\n", "<br/>")
            story.append(Paragraph(
                f'<font color="{color}"><b>{role}:</b></font> {text_safe}',
                Body,
            ))
            story.append(Spacer(1, 2))

    doc.build(story)

    pdf_bytes = buf.getvalue()
    buf.close()
    filename = f"previsit_{name.replace(' ', '_')}_{pid}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _md_to_flowables(md_text: str, H2, H3, Body, Bullet) -> list:
    """Quick markdown → ReportLab flowables converter for our report shape."""
    from reportlab.platypus import Paragraph, Spacer
    from html import escape as html_escape

    out = []
    lines = md_text.replace("\r\n", "\n").split("\n")

    def render(text: str) -> str:
        # Escape HTML, then convert simple markdown emphasis to mini-XML.
        s = html_escape(text)
        s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
        s = re.sub(r"(?<!\*)\*(?!\*)(.+?)\*(?!\*)", r"<i>\1</i>", s)
        s = re.sub(r"`(.+?)`", r'<font face="Courier">\1</font>', s)
        return s

    pending_bullets = []

    def flush_bullets():
        for b in pending_bullets:
            out.append(Paragraph(f"• {render(b)}", Bullet))
        pending_bullets.clear()

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            flush_bullets()
            out.append(Spacer(1, 4))
            continue
        if line.startswith("### "):
            flush_bullets()
            out.append(Paragraph(render(line[4:].strip()), H3))
        elif line.startswith("## "):
            flush_bullets()
            out.append(Paragraph(render(line[3:].strip()), H2))
        elif line.startswith("# "):
            flush_bullets()
            out.append(Paragraph(render(line[2:].strip()), H2))
        elif line.lstrip().startswith(("- ", "* ", "• ")):
            stripped = line.lstrip()[2:].strip()
            pending_bullets.append(stripped)
        elif set(line.strip()) <= {"─", "-", "═", "="} and len(line.strip()) >= 3:
            flush_bullets()
            # horizontal rule
            from reportlab.platypus import HRFlowable
            from reportlab.lib.colors import HexColor
            out.append(HRFlowable(width="100%", thickness=0.4, color=HexColor("#bbb"), spaceBefore=2, spaceAfter=4))
        else:
            flush_bullets()
            out.append(Paragraph(render(line), Body))

    flush_bullets()
    return out


def _build_pdf_fallback_markdown(session: dict) -> str:
    """If clinical_report wasn't generated, build a quick summary from history."""
    summary = session.get("summary", {}) or {}
    chat_history = session.get("chat_history", [])
    patient = summary.get("patient", {})

    parts = []
    parts.append("## Başvuru Yakınması")
    # Pull the patient's first non-system message as the chief complaint
    first_user = next(
        (m["content"] for m in chat_history
         if m["role"] == "user" and not m["content"].startswith("__START_INTERVIEW__")),
        None,
    )
    parts.append(first_user or "_(toplanmadı)_")

    parts.append("\n## Şimdiki Hastalık Öyküsü")
    user_lines = [m["content"] for m in chat_history
                  if m["role"] == "user" and not m["content"].startswith("__START_INTERVIEW__")]
    parts.append("\n".join(f"- {line}" for line in user_lines) or "_(toplanmadı)_")

    parts.append("\n## Özgeçmiş, İlaçlar, Alerjiler (EHR)")
    parts.append(f"- **Aktif problemler:** {', '.join(summary.get('active_problems', [])) or 'yok'}")
    parts.append(f"- **Kronik hastalıklar:** {', '.join(summary.get('chronic_conditions', [])) or 'yok'}")
    meds = summary.get("current_medications", []) or []
    med_strs = [f"{m.get('name','')} {m.get('dose','')} {m.get('frequency','')}".strip() for m in meds]
    parts.append(f"- **İlaçlar:** {', '.join(s for s in med_strs if s) or 'yok'}")
    parts.append(f"- **Alerjiler:** {', '.join(summary.get('allergies', [])) or 'bilinen yok'}")

    return "\n".join(parts)


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
    """Build the system prompt for the strict 3-turn HPI-deepening agent."""
    summary = session.get("summary", {})
    department = session.get("department", "Genel")
    patient = summary.get("patient", {})
    hospital_name = "Acıbadem Ataşehir Hastanesi"

    # Count user turns so far (excluding the synthetic start marker)
    user_turn_count = sum(
        1 for m in session.get("chat_history", [])
        if m["role"] == "user" and not m["content"].startswith("__START_INTERVIEW__:")
    )
    turns_remaining = max(0, 3 - user_turn_count)

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
• 3 question turns total. No more, ever.
• 1 question per turn. Multi-part questions FORBIDDEN unless two sub-parts are clinically inseparable. Standing exceptions: (a) onset + temporal course; (b) severity + functional impact.
• All 5 questions target HPI dimensions only. Do NOT ask about demographics, past medical history, medications, allergies, family history, or social history — these arrive pre-populated in the EHR context below.
• Turn 1 is fixed (introduction + open-ended chief-complaint invitation).
• Turns 2-3 are dynamically selected from the HPI priority hierarchy based on which dimensions remain unfilled.
• After Turn 3, immediately generate the clinical summary using the OUTPUT FORMAT below.

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

OVERRIDE CONDITIONS (legitimate exits from 3-turn rule):
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
SAFETY — emergency protocol overrides the 3-turn rule
═══════════════════════════════════════════════════════
HARD PROHIBITIONS: NEVER diagnose. NEVER recommend medication/treatment/tests. NEVER interpret symptoms.

RED-FLAG → terminate immediately, deliver in Turkish:
"Tarif ettiğiniz belirtiler acil tıbbi değerlendirme gerektirebilir. Lütfen hemen acil servise başvurun veya 112'yi arayın."

Red-flag examples (generalize): sudden severe chest pain + dyspnea + diaphoresis; sudden focal weakness/speech disturbance/facial droop/sudden severe headache ("worst of life"); severe active hemorrhage; anaphylaxis signs.

ACTIVE SUICIDAL IDEATION/PLAN → additionally:
"Şu anda çok önemli bir şey paylaştınız. Lütfen hemen 182 ALO Psikiyatri Hattı'nı arayın veya en yakın acil servise gidin."

═══════════════════════════════════════════════════════
OUTPUT FORMAT — generate AFTER Turn 3 (or on early termination)
═══════════════════════════════════════════════════════
Begin with brief thank-you, then output EXACTLY this Turkish report (the literal title "PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ" must appear — it triggers completion):

─────────────────────────────────────────────
PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ
─────────────────────────────────────────────

**Hasta:** [Ad], [Yaş], [Cinsiyet]   *[EHR]*
**Poliklinik:** {department}
**Tarih:** [bugünün tarihi]
**Görüşme Yöntemi:** AI Ön-Görüşme Asistanı (3 odaklı soru)

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
