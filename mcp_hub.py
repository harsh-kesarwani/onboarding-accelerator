import asyncio
import json
import logging
import os
from contextlib import AsyncExitStack
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_PATH = Path(__file__).parent / "config" / "mcp.json"
_MAX_TOOL_DESCRIPTION_LEN = 1000  # Bedrock tool description limit


def _load_servers(config_path: Path) -> dict[str, StdioServerParameters]:
    """Parse an mcp.json file (Cursor/Claude Desktop format) into MCP params."""
    config = json.loads(config_path.read_text())
    return {
        name: StdioServerParameters(
            command=spec["command"],
            args=[os.path.expanduser(a) for a in spec.get("args", [])],
            env={**os.environ, **spec.get("env", {})},
        )
        for name, spec in config.get("mcpServers", {}).items()
    }


class MCPHub:
    def __init__(
        self,
        config_path: Path | str = DEFAULT_CONFIG_PATH,
        timeout_seconds: float = 20.0,
        fallback_message: str = "",
    ):
        self._config_path = Path(config_path)
        self._timeout_seconds = timeout_seconds
        self._fallback_message = fallback_message
        self._exit_stacks: list[AsyncExitStack] = []
        self._sessions: dict[str, ClientSession] = {}
        self._tools: list[dict] = []
        self._tool_map: dict[str, tuple[str, str]] = {}

    def set_fallback_message(self, message: str) -> None:
        self._fallback_message = message

    async def start(self) -> None:
        servers = _load_servers(self._config_path)
        for name, params in servers.items():
            stack = AsyncExitStack()
            try:
                read, write = await stack.enter_async_context(stdio_client(params))
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
            except Exception as e:
                await stack.aclose()
                logger.warning("Skipping MCP server %r: %s", name, e)
                continue

            self._exit_stacks.append(stack)
            self._sessions[name] = session
            self._register_tools(name, await session.list_tools())

        logger.info(
            "Loaded %d tools from servers: %s",
            len(self._tools),
            list(self._sessions.keys()),
        )

    def _register_tools(self, server_name: str, tools_result) -> None:
        for tool in tools_result.tools:
            prefixed = f"{server_name}__{tool.name}"
            self._tool_map[prefixed] = (server_name, tool.name)
            self._tools.append({
                "toolSpec": {
                    "name": prefixed,
                    "description": (tool.description or "")[:_MAX_TOOL_DESCRIPTION_LEN],
                    "inputSchema": {"json": tool.input_schema},
                }
            })

    async def stop(self) -> None:
        for stack in self._exit_stacks:
            await stack.aclose()

    def get_tools(self) -> list[dict]:
        return self._tools

    async def call_tool(self, prefixed_name: str, args: dict) -> str:
        server, name = self._tool_map[prefixed_name]
        session = self._sessions[server]
        try:
            result = await asyncio.wait_for(
                session.call_tool(name, args),
                timeout=self._timeout_seconds,
            )
            parts = [item.text for item in result.content if hasattr(item, "text")]
            return "\n".join(parts) or "(no result)"
        except asyncio.TimeoutError:
            logger.warning(
                "Tool call timed out after %.1fs: %s args=%s",
                self._timeout_seconds, prefixed_name, args,
            )
            return (
                f"Tool call '{prefixed_name}' timed out after "
                f"{self._timeout_seconds:.0f}s — the query may be too vague or "
                f"the source is slow.\n\n{self._fallback_message}"
            )
        except Exception as e:
            logger.exception("Tool call failed: %s", prefixed_name)
            return f"Tool call failed: {e}"
