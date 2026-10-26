# Sequencer Event Poller MCP Server

[![LightNow capabilities](https://lightnow.ai/badge/com.mambabuilt/mcp-sequencer-event-poller)](https://lightnow.ai/servers/com.mambabuilt/mcp-sequencer-event-poller) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-sequencer-event-poller/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-sequencer-event-poller) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-sequencer-event-poller%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-sequencer-event-poller&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-sequencer-event-poller)](https://www.npmjs.com/package/@mambalabsdev/mcp-sequencer-event-poller) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-sequencer-event-poller)](https://www.npmjs.com/package/@mambalabsdev/mcp-sequencer-event-poller) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-sequencer-event-poller)](https://github.com/mambalabsdev/mcp-sequencer-event-poller/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-sequencer-event-poller)

An MCP server for the Mamba Labs Sequencer Event Poller actor on Apify. It reads replies, bounces, unsubscribes, meetings booked, interest changes, and LinkedIn replies from your own Instantly, Smartlead, HeyReach, and lemlist accounts, and returns one flat row per event.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tool](#tool)
- [Inputs](#inputs)
- [Pricing](#pricing)
- [Your keys](#your-keys)
- [Full actor documentation](#full-actor-documentation)
- [License](#license)

## What it does

Pick a time window, for example the last 24 hours, and get every event from the sequencers you have keys for in one table: vendor, event type, when it happened, the lead's email, name, and company, the campaign, and the reply text where the vendor returns it. One free run summary row gives counts per vendor and event type and says whether each vendor was read, skipped, or refused the key. With only new events on, a scheduled run returns only events an earlier run has not returned.

The actor only reads. It never creates, edits, pauses, or sends anything in a sequencer, and it never creates a campaign.

All of the work runs on Apify. This package is a thin client that starts the actor run, waits for it, and hands back the dataset rows.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "mamba-sequencer-event-poller": {
      "command": "npx",
      "args": [
        "-y",
        "@mambalabsdev/mcp-sequencer-event-poller"
      ],
      "env": {
        "APIFY_TOKEN": "your-apify-token",
        "LEMLIST_API_KEY": "your-lemlist-key"
      }
    }
  }
}
```

Restart the client. The `poll_sequencer_events` tool appears.

## Prerequisites

- Node.js 18 or newer.
- An Apify API token from [console.apify.com/account/integrations](https://console.apify.com/account/integrations), set as `APIFY_TOKEN`. The server lists its tool without a token; a call needs one.
- At least one of your own vendor keys: `INSTANTLY_API_KEY` (API v2, read scope; Instantly API access needs a paid Instantly plan), `SMARTLEAD_API_KEY`, `HEYREACH_API_KEY`, `LEMLIST_API_KEY`. With none set, a call returns one summary row that says no key was given.

## Example prompts

- "Which leads replied in Smartlead or lemlist in the last 24 hours?"
- "List every bounce and unsubscribe across my sequencers this week."
- "Who replied on LinkedIn through HeyReach since Monday, and what did they say?"

## Tool

`poll_sequencer_events`. One tool. Example arguments:

```json
{
  "since_hours": 24,
  "event_types": ["reply", "linkedin_reply", "bounce", "meeting_booked"]
}
```

## Inputs

Every buyer facing input of the actor except the four vendor keys, which are read from this server's environment, never from tool arguments. Omitted inputs take the actor's own defaults.

| Input | Type | Required | Description |
|---|---|---|---|
| `since_hours` | integer | no | Look back this many hours, at most 2160. Default 24. |
| `since`, `until` | string | no | Optional exact window in UTC. |
| `event_types` | array | no | Any of reply, linkedin_reply, bounce, unsubscribe, meeting_booked, interested, not_interested, out_of_office, connection_accepted, open, click. |
| `only_new` | boolean | no | Skip events an earlier run returned. Default true. |
| `state_key` | string | no | Name for the only new events memory. |
| `instantly_campaign_ids`, `smartlead_campaign_ids`, `heyreach_campaign_ids`, `lemlist_campaign_ids` | array | no | Read only these campaigns. |
| `max_pages_per_query` | integer | no | Pages of 100 records per vendor query. Default 20. |
| `max_events` | integer | no | Event rows per run. Default 5000. |
| `max_charge_usd` | string | no | Optional cost cap for the run. |

## Pricing

Pay per event on Apify, billed to your Apify account. Prices in USD.

| Event | Free plan | Bronze | Silver | Gold |
|---|---|---|---|---|
| `event-row`, per sequencer event | $0.008 | $0.0076 | $0.0072 | $0.0068 |
| `apify-actor-start`, per run start | $0.001 | $0.001 | $0.001 | $0.001 |

The run summary row and already delivered events are free. Mamba Labs pays the platform costs of the run.

## Your keys

The actor stores no key. Each vendor key is your own: this server reads it from its environment and sends it in the run input of that run only. The vendor API calls run on your own vendor account, under that vendor's plan and rate limits.

## Full actor documentation

[apify.com/mambalabs/sequencer-event-poller](https://apify.com/mambalabs/sequencer-event-poller)

## License

MIT. See [LICENSE](LICENSE).
