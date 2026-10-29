#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. Fleet standard
// (standing build rule 5, 2026-10-05). A large Instantly backfill is paced at
// about 3 s per request, so a long window can take several minutes.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-sequencer-event-poller",
  version: pkg.version,
});

// Provider keys come from this server's own environment, never from tool
// arguments, so an agent transcript never carries them. Each is the caller's
// own key; the actor stores none.
function keysFromEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const k0 = process.env.INSTANTLY_API_KEY?.trim();
  if (k0) out.instantly_api_key = k0;
  const k1 = process.env.SMARTLEAD_API_KEY?.trim();
  if (k1) out.smartlead_api_key = k1;
  const k2 = process.env.HEYREACH_API_KEY?.trim();
  if (k2) out.heyreach_api_key = k2;
  const k3 = process.env.LEMLIST_API_KEY?.trim();
  if (k3) out.lemlist_api_key = k3;
  return out;
}

// Sequencer Event Poller (immutable actor ID S6s8Rjd61tGdrMRk4). Every buyer facing input of the actor is exposed except the four vendor keys, which come from the environment (see keysFromEnv). The actor takes numbers and booleans as strings, so those inputs are strings here too.
const bool = () => z.enum(["true", "false"]).optional();
server.registerTool(
  "poll_sequencer_events",
  {
    title: "Poll sequencer events",
    description:
      "Read replies, bounces, unsubscribes, meetings booked, interest changes, and LinkedIn replies from your own Instantly, Smartlead, HeyReach, and lemlist accounts for a time window. Returns one flat row per event (vendor, event type, time, lead email and name, company, campaign, reply text where the vendor returns it) plus one free run summary row with counts and the status of each vendor. Vendor keys are read from this server's environment (INSTANTLY_API_KEY, SMARTLEAD_API_KEY, HEYREACH_API_KEY, LEMLIST_API_KEY); vendors with no key are skipped. Read-only: it never creates, edits, pauses, or sends anything in a sequencer. A run that does not succeed is returned as an error with its run ID. Requires an APIFY_TOKEN and is billed per event row.",
    annotations: {
      title: "Poll sequencer events",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      since_hours: z.string().optional().describe("Read events from this many hours before the run, 1 to 2160 (90 days). Default 24. Ignored when since is set."),
      since: z.string()
        .optional()
        .describe("Optional start of the window in UTC, for example 2026-10-20T00:00:00Z."),
      until: z.string()
        .optional()
        .describe("Optional end of the window in UTC. Default now."),
      event_types: z.array(z.enum(["reply", "linkedin_reply", "bounce", "unsubscribe", "meeting_booked", "interested", "not_interested", "out_of_office", "connection_accepted", "open", "click"]))
        .optional()
        .describe("Which events to return. Default: reply, linkedin_reply, bounce, unsubscribe, meeting_booked, interested, connection_accepted."),
      only_new: bool().describe("Skip events an earlier run already returned (free). Default true."),
      state_key: z.string()
        .optional()
        .describe("Optional name for the only new events memory, so two schedules keep separate memories."),
      instantly_campaign_ids: z.array(z.string())
        .optional()
        .describe("Read only these Instantly campaigns (UUIDs). Empty: all campaigns."),
      smartlead_campaign_ids: z.array(z.string())
        .optional()
        .describe("Read only these Smartlead campaigns. Empty: all non draft campaigns."),
      heyreach_campaign_ids: z.array(z.string())
        .optional()
        .describe("Read only these HeyReach campaigns (numeric ids). Empty: all campaigns."),
      lemlist_campaign_ids: z.array(z.string())
        .optional()
        .describe("Read only these lemlist campaigns (cam_ ids). Empty: all campaigns."),
      max_pages_per_query: z.string().optional().describe("Pages of 100 records per vendor query, 1 to 100. Default 20."),
      max_events: z.string().optional().describe("Event rows per run, oldest first, up to 50000. Each event row is billed. Default 5000."),
      max_charge_usd: z.string()
        .optional()
        .describe("Optional. The run stops before a charge that would pass this amount."),
    },
  },
  async (args) => runActor("S6s8Rjd61tGdrMRk4", "Sequencer Event Poller", { ...compact(args as Record<string, unknown>), ...keysFromEnv() }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
