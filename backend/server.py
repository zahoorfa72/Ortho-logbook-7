from fastapi import FastAPI, APIRouter, File, Form, Header, HTTPException, UploadFile
import asyncio
import base64
import hmac
import json
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List
import uuid
from datetime import datetime


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)

class StatusCheckCreate(BaseModel):
    client_name: str

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.dict()
    status_obj = StatusCheck(**status_dict)
    _ = await db.status_checks.insert_one(status_obj.dict())
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find().to_list(1000)
    return [StatusCheck(**status_check) for status_check in status_checks]


# Optional AI-vision proxy for lab reports.
# Image bytes and OCR text are never written to MongoDB or application logs.
LAB_VISION_MAX_IMAGE_BYTES = 12 * 1024 * 1024

def _lab_vision_model_call(image_bytes: bytes, content_type: str, metadata: dict):
    import requests
    api_key = os.environ.get("LAB_VISION_API_KEY", "").strip()
    api_url = os.environ.get("LAB_VISION_API_URL", "https://api.openai.com/v1/chat/completions").strip()
    model = os.environ.get("LAB_VISION_MODEL", "gpt-4o-mini").strip()
    if not api_key:
        raise RuntimeError("AI vision provider is not configured")
    if not api_url.lower().startswith("https://"):
        raise RuntimeError("AI vision provider endpoint must use HTTPS")
    image_data = "data:" + content_type + ";base64," + base64.b64encode(image_bytes).decode("ascii")
    allowed_tests = metadata.get("configuredTests", [])
    if not isinstance(allowed_tests, list):
        allowed_tests = []
    template = metadata.get("matchedTemplate")
    prompt = (
        "Transcribe visually readable laboratory test labels and measured result values from this image. "
        "Do not diagnose, interpret, or infer values. Never use a reference interval as a measured result. "
        "Never borrow a value from a neighboring row. Omit rows if label/result alignment is uncertain. "
        "Return JSON only with schema {rows:[{test:string,result:string,unit?:string,confidence:number,reason?:string}]}. "
        "Confidence is visual certainty from 0 to 1, not clinical certainty. Do not include patient identifiers, "
        "dates of birth, names, MR numbers, diagnoses, or other demographics in the output. "
        "Configured test names and aliases for normalization only: "
        + json.dumps(allowed_tests[:250], ensure_ascii=True)
        + ". Matched layout hints (not medical ranges): "
        + json.dumps(template, ensure_ascii=True)
    )
    payload = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": "You are a conservative document transcription component. Abstain when uncertain. Never invent missing data."},
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data, "detail": "high"}},
            ]},
        ],
    }
    response = requests.post(api_url, headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"}, json=payload, timeout=55)
    response.raise_for_status()
    response_json = response.json()
    content = response_json.get("choices", [{}])[0].get("message", {}).get("content", "")
    decoded = json.loads(content) if isinstance(content, str) else content
    rows = decoded.get("rows", []) if isinstance(decoded, dict) else []
    if not isinstance(rows, list):
        return {"rows": []}
    clean_rows = []
    for row in rows[:100]:
        if not isinstance(row, dict):
            continue
        test = str(row.get("test", "")).strip()[:120]
        result = str(row.get("result", "")).strip()[:40]
        try:
            confidence = float(row.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0
        if not test or not result or confidence < 0.35:
            continue
        clean_rows.append({"test": test, "result": result, "unit": str(row.get("unit", "")).strip()[:30],
                           "confidence": max(0.0, min(1.0, confidence)), "reason": str(row.get("reason", "")).strip()[:180]})
    return {"rows": clean_rows}

@api_router.post("/lab-vision")
async def lab_vision(file: UploadFile = File(...), metadata: str = Form("{}"), authorization: str | None = Header(default=None)):
    if os.environ.get("LAB_VISION_ENABLE_EXTERNAL_PROCESSING", "").strip().lower() != "true":
        raise HTTPException(status_code=503, detail="AI vision external processing is disabled by the server administrator.")
    expected_token = os.environ.get("LAB_VISION_CLIENT_TOKEN", "").strip()
    supplied_token = (authorization or "").removeprefix("Bearer ").strip()
    if not expected_token or not supplied_token or not hmac.compare_digest(supplied_token, expected_token):
        raise HTTPException(status_code=401, detail="Invalid AI-vision client token.")
    content_type = (file.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Only image uploads are supported.")
    image_bytes = await file.read(LAB_VISION_MAX_IMAGE_BYTES + 1)
    if not image_bytes or len(image_bytes) > LAB_VISION_MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is empty or exceeds the 12 MB limit.")
    try:
        metadata_json = json.loads(metadata or "{}")
        if not isinstance(metadata_json, dict):
            raise ValueError("metadata must be an object")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request metadata.")
    # Upload bytes are held in memory only and discarded after the response.
    # Actual provider retention depends on provider contract/account settings.
    try:
        result = await asyncio.to_thread(_lab_vision_model_call, image_bytes, content_type, metadata_json)
        return result
    except Exception:
        logger.warning("Lab vision provider request failed (details intentionally omitted).")
        raise HTTPException(status_code=502, detail="AI-vision provider unavailable; use offline OCR or retry later.")


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
