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

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

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

    # Build the interview system prompt
    system_prompt = _build_interview_system_prompt(session)

    # Add user message to history
    session["chat_history"].append({
        "role": "user",
        "content": msg.message,
        "timestamp": datetime.now().isoformat(),
    })

    # Build messages for Claude
    messages = [{"role": m["role"], "content": m["content"]} for m in session["chat_history"]]

    response = client.messages.create(
        model="claude-opus-4-20250514",
        max_tokens=1024,
        system=system_prompt,
        messages=messages,
    )

    assistant_text = response.content[0].text

    session["chat_history"].append({
        "role": "assistant",
        "content": assistant_text,
        "timestamp": datetime.now().isoformat(),
    })

    # Check if interview is complete (assistant signals completion)
    is_complete = "PRE-VİZİT HASTA ÖN-GÖRÜŞME ÖZETİ" in assistant_text

    return {
        "response": assistant_text,
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

LANGUAGE: ALL patient-facing communication MUST be in Turkish. Use warm, accessible Turkish.
QUESTIONING: Ask 1-2 questions per turn. Start open-ended, then narrow.
VERIFICATION: Briefly repeat back critical information to confirm.

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
