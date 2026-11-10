"""Centralized configuration.

All tunables live here so the rest of the app doesn't read ``os.environ``
directly. ``load_settings()`` validates required env vars up front.
"""
import os
from dataclasses import dataclass


DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful assistant for Adobe engineers. "
    "You have access to tools that can search Adobe Wiki, GitHub, and Jira. "
    "Use them when the question requires up-to-date or specific information. "
    "Always cite your sources with links in your final answer. "
    "When illustrating flows, architectures, sequences, or state machines, "
    "emit a ```mermaid code block so it renders as a diagram."
)


@dataclass(frozen=True)
class Settings:
    aws_region: str
    model: str
    max_iterations: int
    max_tokens: int
    max_history: int
    tool_timeout_seconds: float
    system_prompt: str


def load_settings() -> Settings:
    required = ["AWS_BEARER_TOKEN_BEDROCK"]
    missing = [k for k in required if not os.getenv(k)]
    if missing:
        raise RuntimeError(
            f"Missing required env vars: {missing}. "
            f"Copy .env.example to .env and fill them in."
        )

    return Settings(
        aws_region=os.getenv("AWS_REGION", "us-west-2"),
        model=os.getenv("BEDROCK_MODEL", "us.anthropic.claude-opus-4-7"),
        max_iterations=int(os.getenv("MAX_ITERATIONS", "6")),
        max_tokens=int(os.getenv("MAX_TOKENS", "4096")),
        max_history=int(os.getenv("MAX_HISTORY", "20")),
        tool_timeout_seconds=float(os.getenv("TOOL_TIMEOUT_SECONDS", "20")),
        system_prompt=os.getenv("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
    )
