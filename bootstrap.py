"""Boot-time wiki context loader.

Fetches a configured set of wiki pages via the wiki MCP server on startup
so the agent has curated onboarding context without needing a tool call
each turn. Falls back gracefully: if a page can't be fetched, we still
list its URL so the model can fetch it on demand via the wiki tool.
"""
import json
import logging
from pathlib import Path

from mcp_hub import MCPHub

logger = logging.getLogger(__name__)

DEFAULT_ONBOARDING_PATH = Path(__file__).parent / "config" / "onboarding.json"
_MAX_PAGE_CHARS = 8000  # per-page cap so we don't blow the context window

# Candidate tool names on the wiki MCP server, tried in order.
_WIKI_FETCH_TOOLS = ["wiki__get_wiki_content", "wiki__get_page", "wiki__fetch_page"]
# Candidate argument key variants (different wiki MCP builds use different names).
_URL_ARG_KEYS = ["url", "page_url", "wiki_url", "link"]


def load_onboarding(path: Path = DEFAULT_ONBOARDING_PATH) -> dict:
    if not path.exists():
        return {"wikis": [], "starter_prompts": []}
    return json.loads(path.read_text())


async def _try_fetch(hub: MCPHub, url: str) -> str | None:
    available = {t["toolSpec"]["name"] for t in hub.get_tools()}
    for tool_name in _WIKI_FETCH_TOOLS:
        if tool_name not in available:
            continue
        for arg_key in _URL_ARG_KEYS:
            try:
                text = await hub.call_tool(tool_name, {arg_key: url})
                if text and not text.startswith("Tool call failed"):
                    return text
            except Exception:
                continue
    return None


async def build_bootstrap_context(hub: MCPHub, onboarding: dict) -> str:
    """Return a system-prompt-ready context block summarizing configured wikis."""
    wikis = onboarding.get("wikis", [])
    if not wikis:
        return ""

    sections = [
        "=== ONBOARDING CONTEXT (primary sources) ===",
        "The user is onboarding. Prefer the content below when answering, "
        "and cite these URLs. If a page's content isn't pre-fetched, use the "
        "wiki search tools to fetch it on demand.",
        "",
    ]

    for w in wikis:
        title, url = w["title"], w["url"]
        logger.info("bootstrap: fetching %s", title)
        body = await _try_fetch(hub, url)
        sections.append(f"--- {title} ---")
        sections.append(f"Source: {url}")
        if body:
            sections.append(body[:_MAX_PAGE_CHARS])
            if len(body) > _MAX_PAGE_CHARS:
                sections.append(f"[...truncated at {_MAX_PAGE_CHARS} chars]")
        else:
            sections.append("(content not pre-fetched — use wiki tools if asked)")
            logger.warning("bootstrap: could not pre-fetch %s", url)
        sections.append("")

    sections.append("=== END ONBOARDING CONTEXT ===")
    return "\n".join(sections)
