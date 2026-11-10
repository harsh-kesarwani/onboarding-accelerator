"""Tool-using agent loop.

``run_agent`` drives a Bedrock ``converse`` conversation, executing MCP
tools when the model requests them, until the model returns a final
answer or we hit ``max_iterations``.

Accepts a prior message history so multi-turn chat context is preserved.
Returns (final_answer, updated_history) where updated_history contains
only user questions and final assistant answers (no tool_use blocks),
safe to persist for the next turn.
"""
import logging

from settings import Settings
from mcp_hub import MCPHub

logger = logging.getLogger(__name__)

FALLBACK_ANSWER = "I was unable to generate a complete answer. Please try again."


async def run_agent(
    question: str,
    history: list[dict],
    hub: MCPHub,
    client,
    settings: Settings,
    extra_system: str = "",
) -> tuple[str, list[dict]]:
    """Run one chat turn.

    ``history`` is the persisted per-session conversation (user + final
    assistant messages only). A new user message is appended, the tool
    loop runs on a working copy that may accumulate tool blocks, and the
    final assistant text is appended back to ``history`` before returning.
    """
    history = list(history)
    history.append({"role": "user", "content": [{"text": question}]})

    messages = list(history)  # working copy; may accumulate tool_use/tool_result
    tools = hub.get_tools()

    system_blocks = [{"text": settings.system_prompt}]
    if extra_system:
        system_blocks.append({"text": extra_system})

    final_answer = None
    for _ in range(settings.max_iterations):
        response = client.converse(
            modelId=settings.model,
            system=system_blocks,
            messages=messages,
            inferenceConfig={"maxTokens": settings.max_tokens},
            **({"toolConfig": {"tools": tools}} if tools else {}),
        )
        message = response["output"]["message"]
        messages.append(message)
        stop_reason = response["stopReason"]

        if stop_reason == "tool_use":
            tool_results = await _run_tool_calls(message, hub)
            if not tool_results:
                # Model claimed tool_use but produced no toolUse blocks.
                # Finish with whatever text is present rather than sending an
                # empty user turn (which Claude rejects as a prefill).
                logger.warning(
                    "stop_reason=tool_use but no toolUse blocks; terminating loop"
                )
                final_answer = _final_answer(message)
                break
            messages.append({"role": "user", "content": tool_results})
            continue

        # Any other stop_reason (end_turn, max_tokens, stop_sequence,
        # guardrail_intervened, content_filtered) is terminal. Extract the
        # assistant text and exit — never loop again with a trailing
        # assistant message (Claude rejects conversations that don't end
        # with a user turn).
        final_answer = _final_answer(message)
        if stop_reason != "end_turn":
            logger.warning(
                "unexpected stop_reason=%s; returning partial answer", stop_reason
            )
        break

    if not final_answer:
        final_answer = FALLBACK_ANSWER

    history.append({"role": "assistant", "content": [{"text": final_answer}]})
    return final_answer, history


def _final_answer(message: dict) -> str:
    for block in message.get("content", []):
        if "text" in block:
            return block["text"]
    return ""


async def _run_tool_calls(message: dict, hub: MCPHub) -> list[dict]:
    results = []
    for block in message.get("content", []):
        if "toolUse" not in block:
            continue
        tool_use = block["toolUse"]
        logger.info("tool_use name=%s args=%s", tool_use["name"], tool_use["input"])
        output = await hub.call_tool(tool_use["name"], tool_use["input"])
        results.append({
            "toolResult": {
                "toolUseId": tool_use["toolUseId"],
                "content": [{"text": output}],
            }
        })
    return results
