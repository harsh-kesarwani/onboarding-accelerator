"""FastAPI entrypoint: HTTP wiring + session store + onboarding bootstrap.

Agent logic lives in ``agent.py``, MCP plumbing in ``mcp_hub.py``,
tunables in ``settings.py``, boot-time wiki context in ``bootstrap.py``.
"""
import asyncio
import dataclasses
import json
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # must run before boto3 is imported/constructed

import boto3
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from agent import run_agent
from bootstrap import build_bootstrap_context, load_onboarding
from settings import load_settings
from mcp_hub import MCPHub

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

settings = load_settings()
onboarding = load_onboarding()


def _build_fallback_message() -> str:
    wikis = onboarding.get("wikis", [])
    if not wikis:
        return (
            "No canonical onboarding wikis configured. Please narrow the "
            "question and try again."
        )
    lines = [
        "The search was unsuccessful or slow. These are the canonical "
        "onboarding wiki pages configured for this team — surface them to "
        "the user with clickable links and suggest they narrow their query:",
        "",
    ]
    for w in wikis:
        lines.append(f"- [{w['title']}]({w['url']})")
    return "\n".join(lines)


mcp_hub = MCPHub(
    timeout_seconds=settings.tool_timeout_seconds,
    fallback_message=_build_fallback_message(),
)

_INDEX_HTML = (Path(__file__).parent / "web" / "index.html").read_text()

# In-memory per-session history: { session_id: [ {role, content: [{text}]}, ... ] }
SESSIONS: dict[str, list[dict]] = {}
# Per-session user profile collected from the onboarding quiz.
PROFILES: dict[str, dict] = {}
# Adobe facts generated at bootstrap and served to the UI loading state.
_ADOBE_FACTS: list[str] = []


def _profile_to_system(profile: dict) -> str:
    if not profile:
        return ""
    exp = profile.get("experience", "unspecified")
    side = profile.get("tech_side", "unspecified")
    tenure = profile.get("tenure", "unspecified")
    return (
        "=== USER PROFILE (tailor every answer to this) ===\n"
        f"- Software engineering experience: {exp}\n"
        f"- Tech focus: {side}\n"
        f"- Adobe tenure: {tenure}\n"
        "Guidelines:\n"
        "- If experience is low (new grad / <2 yrs), explain fundamentals, define jargon, link to basics.\n"
        "- If experience is high, skip basics, be concise, focus on architecture and gotchas.\n"
        "- Tailor examples to the user's tech side (frontend vs backend vs fullstack).\n"
        "- If the user is new to Adobe, include access/tooling/process steps; if internal mobility, "
        "skip Adobe-general setup and focus on team-specific context.\n"
        "=== END USER PROFILE ==="
    )


def _generate_starter_prompts(profile: dict, wiki_context: str) -> list[dict]:
    """Ask the LLM to emit 6 tailored starter prompts as JSON."""
    exp = profile.get("experience", "unspecified")
    side = profile.get("tech_side", "unspecified")
    tenure = profile.get("tenure", "unspecified")

    system_text = (
        "You generate onboarding-chatbot starter prompts. "
        "You MUST respond with only a JSON array — no prose before or after, "
        "no code fences, no explanations. Each array item has exactly two "
        'keys: "icon" (one emoji) and "text" (a question under 90 chars). '
        "Return exactly 6 items."
    )

    user_text = (
        f"User profile:\n"
        f"- Experience: {exp}\n"
        f"- Tech side: {side}\n"
        f"- Adobe tenure: {tenure}\n\n"
        f"Team & wiki pages available:\n{wiki_context[:4000]}\n\n"
        "Tailoring rules:\n"
        "- New grads / <1yr: prefer fundamentals, setup walkthroughs, 'what is X', glossary-style.\n"
        "- 3+ yrs: prefer architecture, tradeoffs, migrations, gotchas, ownership.\n"
        "- Frontend: UI/component/client-integration angles.\n"
        "- Backend: services, APIs, data flow, infra.\n"
        "- Fullstack: end-to-end flows.\n"
        "- New hire at Adobe: include access, tooling, workstation, Buster/dev-env setup.\n"
        "- Internal mobility: skip generic Adobe onboarding; focus on team-specific context.\n\n"
        "Example output format (structure only — your content must differ and be "
        "specific to the profile and wikis):\n"
        '[{"icon":"🛠️","text":"How do I set up my workstation?"},'
        '{"icon":"🏗️","text":"What is the system architecture?"}]\n\n'
        "Now produce the 6 tailored prompts as a JSON array."
    )

    try:
        response = client.converse(
            modelId=settings.model,
            system=[{"text": system_text}],
            messages=[{"role": "user", "content": [{"text": user_text}]}],
            inferenceConfig={"maxTokens": 900},
        )
        text = ""
        for block in response["output"]["message"]["content"]:
            if "text" in block:
                text = block["text"]
                break

        logger.info("personalize raw model output: %s", text[:400])

        # Strip common wrappers: ```json ... ``` or ``` ... ```
        stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
        match = re.search(r"\[\s*\{.*\}\s*\]", stripped, re.DOTALL)
        if not match:
            raise ValueError(f"no JSON array found; got: {text[:200]!r}")
        prompts = json.loads(match.group(0))
        cleaned = [
            {"icon": str(p.get("icon", "💡"))[:4], "text": str(p.get("text", "")).strip()}
            for p in prompts if isinstance(p, dict) and p.get("text")
        ][:6]
        if len(cleaned) < 3:
            raise ValueError(f"only {len(cleaned)} valid prompts parsed")
        logger.info("personalize: generated %d tailored prompts", len(cleaned))
        return cleaned
    except Exception:
        logger.exception("starter-prompt generation failed; using static fallback")
        return onboarding.get("starter_prompts", [])


_FALLBACK_FACTS = [
    "Adobe was founded in December 1982 by John Warnock and Charles Geschke, who left Xerox PARC to start the company.",
    "The name 'Adobe' comes from Adobe Creek, a stream that ran behind the house of co-founder John Warnock in Los Altos.",
    "Adobe invented the PDF format in 1993 — it's now an ISO open standard used by billions of people worldwide.",
    "Photoshop was originally created by brothers Thomas and John Knoll in 1987 and acquired by Adobe in 1988.",
    "Adobe Creative Cloud has over 30 million subscribers globally across creative professionals and students.",
    "Adobe's Document Cloud processes over 8 billion PDF transactions per year.",
    "Adobe Experience Cloud serves over 85% of the Fortune 100 companies.",
    "The iconic Adobe logo splash screen with the feather has been a beloved Easter egg for designers for decades.",
    "Adobe Systems went public on NASDAQ in 1986 and has been in the S&P 500 since 1997.",
    "Adobe acquired Macromedia in 2005, bringing Flash, Dreamweaver, and ColdFusion into the Adobe family.",
    "Adobe's headquarters in San Jose, California is known as the 'Warnock Building' in honor of its co-founder.",
    "Adobe employees refer to themselves as 'Adobeans' — a term of pride used across the company culture.",
    "Adobe's annual MAX conference is one of the largest creativity conferences in the world, drawing tens of thousands.",
    "Adobe pioneered the PostScript page description language, which revolutionized desktop publishing in the 1980s.",
    "The term 'photoshopped' has become so common it's in the Merriam-Webster dictionary as a verb.",
]


def _generate_adobe_facts(bedrock_client) -> list[str]:
    system_text = (
        "You generate fun, surprising, and accurate facts about Adobe Inc. for new employees. "
        "Respond with ONLY a JSON array of strings — no prose, no code fences. "
        "Each string is one concise fact under 150 characters. Return exactly 20 items."
    )
    user_text = (
        "Generate 20 amusing and memorable facts about Adobe Inc. — cover history, products, "
        "culture, milestones, fun trivia, and innovations. Make them delightful for a new hire "
        "to read while waiting for a chat response. JSON array only."
    )
    try:
        response = bedrock_client.converse(
            modelId=settings.model,
            system=[{"text": system_text}],
            messages=[{"role": "user", "content": [{"text": user_text}]}],
            inferenceConfig={"maxTokens": 1200},
        )
        text = ""
        for block in response["output"]["message"]["content"]:
            if "text" in block:
                text = block["text"]
                break
        stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
        match = re.search(r"\[.*\]", stripped, re.DOTALL)
        if not match:
            raise ValueError("no JSON array found")
        facts = json.loads(match.group(0))
        cleaned = [str(f).strip() for f in facts if isinstance(f, str) and f.strip()][:20]
        if len(cleaned) < 5:
            raise ValueError(f"only {len(cleaned)} facts parsed")
        logger.info("bootstrap: generated %d Adobe facts", len(cleaned))
        return cleaned
    except Exception:
        logger.exception("Adobe facts generation failed; using fallback list")
        return _FALLBACK_FACTS


@asynccontextmanager
async def lifespan(app: FastAPI):
    global settings, _ADOBE_FACTS
    await mcp_hub.start()
    context = await build_bootstrap_context(mcp_hub, onboarding)
    if context:
        settings = dataclasses.replace(
            settings,
            system_prompt=settings.system_prompt + "\n\n" + context,
        )
        logger.info("bootstrap: injected %d chars of wiki context", len(context))
    _ADOBE_FACTS = await asyncio.to_thread(_generate_adobe_facts, client)
    yield
    await mcp_hub.stop()


app = FastAPI(lifespan=lifespan)
client = boto3.client("bedrock-runtime", region_name=settings.aws_region)


class ChatRequest(BaseModel):
    question: str
    session_id: str


class ChatResponse(BaseModel):
    answer: str
    suggestions: list[str] = []


class ResetRequest(BaseModel):
    session_id: str


class PersonalizeRequest(BaseModel):
    session_id: str
    experience: str
    tech_side: str
    tenure: str


_WEB_DIR = Path(__file__).parent / "web"


@app.get("/", response_class=HTMLResponse)
def root() -> str:
    return _INDEX_HTML


@app.get("/styles.css")
def styles_css() -> FileResponse:
    return FileResponse(_WEB_DIR / "styles.css", media_type="text/css")


@app.get("/app.js")
def app_js() -> FileResponse:
    return FileResponse(
        _WEB_DIR / "app.js", media_type="application/javascript"
    )


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "tools": len(mcp_hub.get_tools())}


@app.get("/suggestions")
def suggestions() -> dict:
    return {
        "team": onboarding.get("team", "Adobe"),
        "starter_prompts": onboarding.get("starter_prompts", []),
        "wikis": onboarding.get("wikis", []),
    }


@app.get("/facts")
def facts() -> dict:
    return {"facts": _ADOBE_FACTS or _FALLBACK_FACTS}


@app.post("/reset")
def reset(req: ResetRequest) -> dict:
    SESSIONS.pop(req.session_id, None)
    PROFILES.pop(req.session_id, None)
    return {"ok": True}


@app.post("/personalize")
def personalize(req: PersonalizeRequest) -> dict:
    profile = {
        "experience": req.experience,
        "tech_side": req.tech_side,
        "tenure": req.tenure,
    }
    PROFILES[req.session_id] = profile
    # Build a compact context summary for the prompt generator.
    wiki_summary_lines = [f"Team: {onboarding.get('team', 'Adobe')}"]
    for w in onboarding.get("wikis", []):
        wiki_summary_lines.append(f"- {w['title']} ({w['url']})")
    wiki_summary = "\n".join(wiki_summary_lines)
    prompts = _generate_starter_prompts(profile, wiki_summary)
    return {"starter_prompts": prompts, "profile": profile}


def _generate_followup_suggestions(question: str, answer: str) -> list[str]:
    system_text = (
        "You generate follow-up questions for an onboarding chatbot. "
        "Respond with ONLY a JSON array of exactly 3 strings — no prose, no code fences. "
        "Each string is a short, specific follow-up question under 90 characters."
    )
    user_text = (
        f"The user asked: {question}\n\n"
        f"The assistant answered: {answer[:1500]}\n\n"
        "Generate 3 natural follow-up questions the user might want to ask next. "
        "Make them specific and actionable. JSON array only."
    )
    try:
        response = client.converse(
            modelId=settings.model,
            system=[{"text": system_text}],
            messages=[{"role": "user", "content": [{"text": user_text}]}],
            inferenceConfig={"maxTokens": 300},
        )
        text = ""
        for block in response["output"]["message"]["content"]:
            if "text" in block:
                text = block["text"]
                break
        stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
        match = re.search(r"\[.*\]", stripped, re.DOTALL)
        if not match:
            return []
        items = json.loads(match.group(0))
        return [str(s).strip() for s in items if isinstance(s, str) and s.strip()][:3]
    except Exception:
        logger.exception("follow-up suggestion generation failed")
        return []


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    history = SESSIONS.get(req.session_id, [])
    extra_system = _profile_to_system(PROFILES.get(req.session_id, {}))
    try:
        answer, updated = await run_agent(
            req.question, history, mcp_hub, client, settings, extra_system=extra_system
        )
    except Exception as e:
        logger.exception("chat request failed")
        raise HTTPException(status_code=500, detail="Agent failed, check server logs") from e

    if len(updated) > settings.max_history:
        updated = updated[-settings.max_history:]
    SESSIONS[req.session_id] = updated

    suggestions = await asyncio.to_thread(_generate_followup_suggestions, req.question, answer)
    return ChatResponse(answer=answer, suggestions=suggestions)
