# hkesarwa — AI Week April 2026

## Project Title

Onboarding Accelerator

## Description

An AI teammate for new Adobe engineers that turns your team's Wiki, GitHub, and Jira into one conversational source of truth — answering questions  with live, grounded data instead of stale snippets.

Powered by **Claude Opus on AWS Bedrock** and **MCP servers** for each internal system, with a FastAPI backend and chat UI. Drop in a small JSON config and the assistant instantly speaks your team's stack — so new joinees ramp in days, not weeks.

## How to Use

### Prerequisites

- **Python 3.9+**
- **Docker** (running) — the MCP servers run as containers
- **Built MCP images** — from [adobe-mcp-servers](https://github.com/Adobe-AIFoundations/adobe-mcp-servers):
  - `adobe-wiki-confluence` (build from `src/adobe-wiki`)
  - `corp-github` (build from `src/corp-github`)
  - `corp-jira` (build from `src/corp-jira`)
- **AWS Bedrock access** — account `567119266820`, region `us-west-2`
- **Five tokens** (see `.env.example`):
  - `AWS_BEARER_TOKEN_BEDROCK` — from AWS Secrets Manager (`bedrock/AWS5004/Sandbox/api-key`, field `api_key`) or the CAMP provisioning portal's "View API Key" page
  - `WIKI_MCP_TOKEN` — Adobe Wiki PAT: https://wiki.corp.adobe.com → profile → settings → Personal Access Token
  - `GITHUB_PERSONAL_ACCESS_TOKEN` — Adobe GitHub PAT: https://git.corp.adobe.com/settings/tokens
  - `JIRA_EMAIL` — your Adobe email address (e.g. `you@adobe.com`)
  - `JIRA_PERSONAL_ACCESS_TOKEN` — Adobe Jira PAT: https://jira.corp.adobe.com → Profile → Personal Access Tokens

### Local Setup

#### 1. Clone and enter the project

```bash
git clone <repo-url>
cd Onboarding-Accelerator-AI-Week
```

#### 2. Create and activate a virtual environment

```bash
python3 -m venv venv
source venv/bin/activate
```

You should see `(venv)` in your shell prompt. To exit the venv later: `deactivate`.

#### 3. Install Python dependencies

```bash
pip install -r requirements.txt
```

#### 4. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in the five tokens (no quotes around values). See [Prerequisites](#prerequisites) for where to obtain each.

#### 5. Make sure Docker is running and MCP images are built

All MCP servers run as Docker containers. Verify:

```bash
docker ps            # should not error
docker images | grep -E 'adobe-wiki-confluence|corp-github|corp-jira'
```

If any image is missing, build from the [adobe-mcp-servers](https://github.com/Adobe-AIFoundations/adobe-mcp-servers) repo (see Prerequisites).

#### 6. Run the app

```bash
python3 -m uvicorn main:app --reload --port 8000
```

#### 7. Verify it's working

- UI: [http://localhost:8000](http://localhost:8000)
- Health check: [http://localhost:8000/healthz](http://localhost:8000/healthz) — should return `{"status": "ok", "tools": <N>}` where `N > 0`.

## Artifacts

### Project Structure

```
.
├── main.py              # FastAPI app: /chat, /healthz, HTML, static
├── agent.py             # Bedrock converse loop + tool dispatch
├── bootstrap.py         # Onboarding-data + wiki context loader
├── settings.py          # Settings dataclass + env validation
├── mcp_hub.py           # MCP server lifecycle + tool routing
├── requirements.txt
├── .env                 # Your credentials (gitignored)
├── .env.example         # Template
├── config/              # JSON configuration (data only)
│   ├── mcp.json         # MCP server definitions (Cursor/Claude Desktop schema)
│   └── onboarding.json  # Team-specific onboarding data (wikis, prompts)
└── web/                 # Frontend assets served by FastAPI
    ├── index.html       # Markup + third-party deps
    ├── styles.css       # Design tokens + components
    └── app.js           # Chat UI behavior
```

### Adding a new MCP server

Edit `config/mcp.json` and add an entry under `mcpServers`. Pass credentials as `-e VAR_NAME` args so Docker picks them up from the host environment (populated from your `.env`):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MY_SERVER_TOKEN", "my-server-image"]
    }
  }
}
```

Add the corresponding variable to `.env.example` (and your `.env`). No Python code changes needed. A server that fails to start is logged and skipped — the rest still come up.

### Configuration

All tunables are env-driven via `settings.py`. Defaults are sensible; override in `.env` if needed:

| Variable | Default |
| --- | --- |
| `BEDROCK_MODEL` | `us.anthropic.claude-opus-4-7` |
| `AWS_REGION` | `us-west-2` |
| `MAX_ITERATIONS` | `6` |
| `MAX_TOKENS` | `4096` |
| `SYSTEM_PROMPT` | (defined in `settings.py`) |

## Resources

Presentations, videos, and demos are in [`Onboarding-Accelerator/resources/`](resources):

- [`adobe_onboarding_demo.pptx`](resources/adobe_onboarding_demo.pptx) — slide deck walking through the assistant
- [`demo_recording.webm`](resources/demo_recording.webm) — recorded demo of the chatbot in action
