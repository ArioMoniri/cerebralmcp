#!/usr/bin/env python3
"""
CerebralMCP — MCP server exposing Acıbadem Cerebral Plus EHR data.

Tools:
  - fetch_patient: Full patient record export (episodes, diagnoses, exams)
  - fetch_izlem: İzlem (follow-up) data for inpatient episodes
  - fetch_reports: Medical reports + PACS links
  - fetch_yatis: Hospitalization + episode details
  - summarize_patient: Claude Opus structured clinical summary
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import run_server
from mcp.types import Tool, TextContent

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
COOKIES_DIR = Path(__file__).resolve().parent.parent.parent / "cookies"


def _find_cookies() -> Path:
    """Find the most recent cookies.json."""
    candidates = sorted(COOKIES_DIR.glob("*.json"), key=os.path.getmtime, reverse=True)
    if not candidates:
        raise FileNotFoundError(f"No cookies.json found in {COOKIES_DIR}")
    return candidates[0]


def _get_cookie_string() -> str:
    """Convert cookies.json to a cookie header string."""
    cookies_path = _find_cookies()
    script = SCRIPTS_DIR / "cerebral_cookie_from_json.py"
    proc = subprocess.run(
        [sys.executable, str(script), str(cookies_path)],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Cookie conversion failed: {proc.stderr}")
    return proc.stdout.strip()


def _run_script(script_name: str, args: list[str], timeout: int = 180) -> str:
    """Run a cerebral script and return stdout."""
    script = SCRIPTS_DIR / script_name
    proc = subprocess.run(
        [sys.executable, str(script)] + args,
        capture_output=True, text=True, timeout=timeout,
        env={**os.environ, "COOKIES_FILE": str(_find_cookies())},
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{script_name} failed (exit {proc.returncode}): {proc.stderr[:2000]}")
    return proc.stdout


app = Server("cerebral-mcp")


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="fetch_patient",
            description=(
                "Fetch a patient's complete medical record from Acıbadem Cerebral Plus EHR. "
                "Returns demographics, episodes, diagnoses, complaints, examination notes, "
                "allergies, BMI, and previous prescriptions. Requires hospital VPN."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "patient_id": {
                        "type": "string",
                        "description": "Patient protocol number (e.g. '30256609')",
                    }
                },
                "required": ["patient_id"],
            },
        ),
        Tool(
            name="fetch_izlem",
            description=(
                "Fetch İzlem (follow-up/monitoring) data for all episodes of a patient. "
                "Includes: doctor notes, nurse notes, vitals, blood gas, medications, "
                "lab results, fall risk, infection control, pressure sore tracking, etc."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "patient_id": {
                        "type": "string",
                        "description": "Patient protocol number",
                    }
                },
                "required": ["patient_id"],
            },
        ),
        Tool(
            name="fetch_reports",
            description=(
                "Download all medical reports for a patient including lab results, "
                "radiology reports, pathology, and generate PACS viewer links for imaging."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "patient_id": {
                        "type": "string",
                        "description": "Patient protocol number",
                    }
                },
                "required": ["patient_id"],
            },
        ),
        Tool(
            name="fetch_yatis",
            description=(
                "Fetch hospitalization (Yatış) and all episode details. "
                "Includes admission/discharge dates, reasons, diagnoses, complaints, "
                "and examination notes for both inpatient and outpatient visits."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "patient_id": {
                        "type": "string",
                        "description": "Patient protocol number",
                    }
                },
                "required": ["patient_id"],
            },
        ),
        Tool(
            name="summarize_patient",
            description=(
                "Fetch all patient data and produce a structured clinical JSON summary. "
                "Uses Claude to synthesize demographics, medical history, medications, "
                "allergies, diagnoses, and visit timeline into a pre-visit briefing."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "patient_id": {
                        "type": "string",
                        "description": "Patient protocol number",
                    },
                    "department": {
                        "type": "string",
                        "description": "Target department (e.g. 'Kardiyoloji')",
                        "default": "Genel",
                    },
                },
                "required": ["patient_id"],
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    patient_id = arguments.get("patient_id", "")
    patient_id = re.sub(r"[\s\-]+", "", patient_id.strip())

    if not re.fullmatch(r"\d+", patient_id):
        return [TextContent(type="text", text=json.dumps({
            "error": "Invalid patient_id — must be numeric"
        }))]

    try:
        if name == "fetch_patient":
            cookie = _get_cookie_string()
            output = _run_script("cerebral_fetch.py", [
                patient_id, "--cookie", cookie, "--stdout"
            ])
            return [TextContent(type="text", text=output)]

        elif name == "fetch_izlem":
            output_file = f"/tmp/izlem_{patient_id}.json"
            _run_script("cerebral_izlem_export.py", [
                patient_id, "--output", output_file
            ])
            with open(output_file, "r") as f:
                data = f.read()
            return [TextContent(type="text", text=data)]

        elif name == "fetch_reports":
            # Reports script writes to a directory; we return the manifest
            _run_script("cerebral_reports_w_pacs.py", [patient_id], timeout=300)
            manifest_path = f"reports_{patient_id}/manifest.json"
            if os.path.exists(manifest_path):
                with open(manifest_path, "r") as f:
                    data = f.read()
                return [TextContent(type="text", text=data)]
            return [TextContent(type="text", text=json.dumps({"status": "completed", "note": "Check reports directory"}))]

        elif name == "fetch_yatis":
            _run_script("cerebral_yatis.py", [patient_id])
            manifest_path = f"episodes_{patient_id}/manifest.json"
            if os.path.exists(manifest_path):
                with open(manifest_path, "r") as f:
                    data = f.read()
                return [TextContent(type="text", text=data)]
            return [TextContent(type="text", text=json.dumps({"status": "completed"}))]

        elif name == "summarize_patient":
            department = arguments.get("department", "Genel")
            # First fetch the patient record
            cookie = _get_cookie_string()
            raw = _run_script("cerebral_fetch.py", [
                patient_id, "--cookie", cookie, "--stdout"
            ])
            patient_data = json.loads(raw)

            # Use the API summarize endpoint
            summary = await _summarize_with_claude(patient_data, department)
            return [TextContent(type="text", text=json.dumps(summary, ensure_ascii=False, indent=2))]

        else:
            return [TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}))]

    except Exception as e:
        return [TextContent(type="text", text=json.dumps({
            "error": str(e),
            "type": type(e).__name__,
        }))]


async def _summarize_with_claude(patient_data: dict, department: str) -> dict:
    """Call Claude API to produce a structured clinical summary."""
    try:
        import anthropic
    except ImportError:
        return {"error": "anthropic package not installed. Run: pip install anthropic"}

    client = anthropic.Anthropic()

    prompt = f"""You are a clinical data summarizer. Analyze this patient record from Acıbadem Hospital
and produce a structured JSON summary for a pre-visit briefing.

Department: {department}

Patient Data:
{json.dumps(patient_data, ensure_ascii=False, indent=2)[:50000]}

Return ONLY valid JSON with this structure:
{{
  "patient": {{
    "name": "...",
    "age": "...",
    "sex": "...",
    "patient_id": "...",
    "birth_date": "..."
  }},
  "allergies": ["..."],
  "chronic_conditions": ["..."],
  "current_medications": [
    {{"name": "...", "dose": "...", "frequency": "..."}}
  ],
  "visit_history": [
    {{
      "date": "...",
      "department": "...",
      "facility": "...",
      "doctor": "...",
      "diagnoses": [{{"icd_code": "...", "name": "..."}}],
      "complaints": ["..."],
      "key_findings": "...",
      "treatment": "..."
    }}
  ],
  "active_problems": ["..."],
  "risk_factors": ["..."],
  "recent_labs": [
    {{"test": "...", "value": "...", "date": "...", "flag": "normal|high|low"}}
  ],
  "recent_imaging": [
    {{"type": "...", "date": "...", "findings": "..."}}
  ],
  "surgical_history": ["..."],
  "family_history": "...",
  "social_history": "...",
  "clinical_timeline_summary": "A 2-3 sentence chronological narrative of the patient's medical journey",
  "pre_visit_focus_areas": ["2-3 areas the physician should focus on based on history"]
}}"""

    message = client.messages.create(
        model="claude-opus-4-20250514",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    text = message.content[0].text
    # Extract JSON from response
    json_match = re.search(r'\{.*\}', text, re.DOTALL)
    if json_match:
        return json.loads(json_match.group())
    return {"raw_summary": text}


async def main():
    await run_server(app)


if __name__ == "__main__":
    asyncio.run(main())
