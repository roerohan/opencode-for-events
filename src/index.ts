import { Hono } from "hono";
import configTemplate from "../config/opencode.json";
import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";

interface Env {
  GATEWAY_API_KEY: string;
  GATEWAY_URL: string;
  GATEWAY_ACCOUNT_ID: string;
  GATEWAY_ID: string;
  CF_ACCESS_TEAM_NAME: string;
  O4E_CONFIG_CACHE: KVNamespace;
  O4E_TEAM_CONFIG: KVNamespace;
  O4E_TEAM_USAGE: KVNamespace;
}

interface TeamConfig {
  teamId: string;
  emails: string[];
  creditLimit: number;
}

interface TeamUsage {
  teamId: string;
  totalCost: number;
  lastUpdated: string;
  requestCount: number;
}

// KV key for storing OpenAI models list
const OPENAI_MODELS_KEY = "openai-models";

// Fallback models if KV is empty and models.dev fetch fails
const FALLBACK_OPENAI_MODELS = [
  "codex-mini-latest",
  "gpt-3.5-turbo",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-2024-05-13",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "gpt-4o-mini",
  "gpt-5",
  "gpt-5-chat-latest",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5.1",
  "gpt-5.1-chat-latest",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-chat-latest",
  "gpt-5.2-pro",
  "o1",
  "o1-mini",
  "o1-preview",
  "o1-pro",
  "o3",
  "o3-deep-research",
  "o3-mini",
  "o3-pro",
  "o4-mini",
  "o4-mini-deep-research",
];

interface ErrorResponse {
  error: string;
  message: string;
  status?: number;
  timestamp: string;
}

const app = new Hono<{ Bindings: Env }>();

let cachedKeys: HonoJsonWebKey[] | null = null;
let cacheExpiration = 0;

async function withRetry<T>(
  fn: () => Promise<T>,
  delays: number[] = [5000, 10000]
): Promise<T> {
  let lastError: Error;
  const maxAttempts = delays.length + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < delays.length) {
        const delay = delays[attempt];
        console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms:`, lastError.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

async function getPublicKeys(cfAccessTeamName: string): Promise<HonoJsonWebKey[]> {
  const now = Date.now();
  if (cachedKeys && now < cacheExpiration) {
    return cachedKeys;
  }

  const cfAccessCertsUri = `https://${cfAccessTeamName}.cloudflareaccess.com/cdn-cgi/access/certs`;

  const keys = await withRetry(async () => {
    const response = await fetch(cfAccessCertsUri);
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }

    const data = await response.json() as { keys: HonoJsonWebKey[] };
    return data.keys;
  });

  cachedKeys = keys;
  cacheExpiration = now + 3600 * 1000; // 1 hour
  return cachedKeys;
}


function createErrorResponse(message: string, status: number = 500, error: string = 'Internal Server Error'): Response {
  const errorResponse: ErrorResponse = {
    error,
    message,
    status,
    timestamp: new Date().toISOString()
  };

  console.log(errorResponse);

  return new Response(JSON.stringify(errorResponse), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Fetch OpenAI models from models.dev and cache in KV
async function fetchAndCacheOpenAIModels(kv: KVNamespace): Promise<string[]> {
  try {
    const response = await fetch("https://models.dev/api.json");
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json() as Record<string, { models?: Record<string, unknown> }>;
    const openaiModels = data.openai?.models;

    if (openaiModels) {
      // Filter out embedding models (they don't use the store parameter)
      const modelIds = Object.keys(openaiModels).filter(
        id => !id.startsWith("text-embedding")
      );

      // Store in KV with 24-hour expiry (buffer beyond hourly cron)
      await kv.put(OPENAI_MODELS_KEY, JSON.stringify(modelIds), {
        expirationTtl: 86400
      });

      console.log(`Cached ${modelIds.length} OpenAI models from models.dev`);
      return modelIds;
    }

    throw new Error("No OpenAI models found in response");
  } catch (error) {
    console.error("Failed to fetch/cache models from models.dev:", error instanceof Error ? error.message : error);
    return FALLBACK_OPENAI_MODELS;
  }
}

// Get OpenAI models from KV cache, with fallback
async function getOpenAIModels(kv: KVNamespace): Promise<string[]> {
  try {
    const cached = await kv.get(OPENAI_MODELS_KEY);
    if (cached) {
      return JSON.parse(cached) as string[];
    }
  } catch (error) {
    console.error("Failed to read models from KV:", error instanceof Error ? error.message : error);
  }

  // KV empty or error - return fallback
  return FALLBACK_OPENAI_MODELS;
}

// Find team configuration for a given email
async function getTeamForEmail(email: string, teamConfigKV: KVNamespace): Promise<TeamConfig | null> {
  try {
    // List all team configs and find the one containing this email
    const list = await teamConfigKV.list();

    for (const key of list.keys) {
      const configStr = await teamConfigKV.get(key.name);
      if (!configStr) continue;

      const config = JSON.parse(configStr) as TeamConfig;
      if (config.emails.includes(email.toLowerCase())) {
        return config;
      }
    }

    return null;
  } catch (error) {
    console.error("Failed to get team for email:", error instanceof Error ? error.message : error);
    return null;
  }
}

// Get current usage for a team
async function getTeamUsage(teamId: string, teamUsageKV: KVNamespace): Promise<TeamUsage> {
  try {
    const usageStr = await teamUsageKV.get(teamId);
    if (usageStr) {
      return JSON.parse(usageStr) as TeamUsage;
    }
  } catch (error) {
    console.error("Failed to get team usage:", error instanceof Error ? error.message : error);
  }

  // Return initial usage state
  return {
    teamId,
    totalCost: 0,
    lastUpdated: new Date().toISOString(),
    requestCount: 0
  };
}

// Update team usage with new cost
async function updateTeamUsage(
  teamId: string,
  additionalCost: number,
  teamUsageKV: KVNamespace
): Promise<void> {
  try {
    const currentUsage = await getTeamUsage(teamId, teamUsageKV);

    const updatedUsage: TeamUsage = {
      teamId,
      totalCost: currentUsage.totalCost + additionalCost,
      lastUpdated: new Date().toISOString(),
      requestCount: currentUsage.requestCount + 1
    };

    await teamUsageKV.put(teamId, JSON.stringify(updatedUsage));
    console.log(`Updated usage for team ${teamId}: $${updatedUsage.totalCost.toFixed(4)} (${updatedUsage.requestCount} requests)`);
  } catch (error) {
    console.error("Failed to update team usage:", error instanceof Error ? error.message : error);
  }
}

// Extract usage cost from AI Gateway response
function extractUsageCost(response: Response): number {
  try {
    // Check for cf-aig-cost-usd header
    const costHeader = response.headers.get("cf-aig-cost-usd");
    if (costHeader) {
      const cost = parseFloat(costHeader);
      if (!isNaN(cost)) {
        return cost;
      }
    }

    // Default to a small amount if no cost header found
    // This ensures we still track usage even if cost isn't reported
    return 0.001;
  } catch (error) {
    console.error("Failed to extract usage cost:", error instanceof Error ? error.message : error);
    return 0.001;
  }
}

app.get("/.well-known/opencode", async (c) => {
  const ENV_NAME = "TOKEN";
  const baseURL = `https://${c.req.header("host") || "http://localhost:8787"}`;

  // Get OpenAI models from KV cache
  const openaiModels = await getOpenAIModels(c.env.O4E_CONFIG_CACHE);

  // Build models config with store: false for ZDR compatibility
  const modelsConfig: Record<string, { options: { store: boolean } }> = {};
  for (const modelId of openaiModels) {
    modelsConfig[modelId] = { options: { store: false } };
  }

  // Deep clone and replace placeholders in the config
  const configStr = JSON.stringify(configTemplate)
    .replace(/\{baseURL\}/g, baseURL)
    .replace(/\{ENV_NAME\}/g, ENV_NAME);

  const config = JSON.parse(configStr) as { provider?: { openai?: { models?: unknown } } };

  // Inject dynamic OpenAI models with store: false
  if (config.provider?.openai) {
    config.provider.openai.models = modelsConfig;
  }

  const response = {
    "auth": {
      "command": ["cloudflared", "access", "login", "--no-verbose", `-app=${baseURL}`],
      "env": ENV_NAME,
    },
    "config": config
  };

  return c.json(response);
});

app.post("*", async (c) => {
  const token = c.req.header("cf-access-token");
  if (!token) {
    return createErrorResponse("Missing authentication token", 401, "Unauthorized");
  }

  // Verify JWT with JWKS (cryptographic verification)
  let payload: { email?: string };
  try {
    if (!c.env.CF_ACCESS_TEAM_NAME) {
      return createErrorResponse("CF_ACCESS_TEAM_NAME not configured", 500, "Configuration Error");
    }
    const keys = await getPublicKeys(c.env.CF_ACCESS_TEAM_NAME);
    payload = await Jwt.verifyWithJwks(token, { keys }) as { email?: string };
  } catch (e) {
    console.error("JWT verification failed:", e instanceof Error ? e.message : "Unknown error");
    return createErrorResponse("Invalid token", 401, "Unauthorized");
  }

  const email = payload.email;
  if (!email) {
    return createErrorResponse("Email not found in token", 401, "Unauthorized");
  }

  try {
    // Validate required environment variables
    if (!c.env.GATEWAY_API_KEY) {
      return createErrorResponse("API key not configured", 500, "Configuration Error");
    }

    // Look up team for this email
    const teamConfig = await getTeamForEmail(email, c.env.O4E_TEAM_CONFIG);
    if (!teamConfig) {
      return createErrorResponse(
        `Email ${email} is not assigned to any team`,
        403,
        "Forbidden"
      );
    }

    // Check current team usage against credit limit
    const teamUsage = await getTeamUsage(teamConfig.teamId, c.env.O4E_TEAM_USAGE);
    if (teamUsage.totalCost >= teamConfig.creditLimit) {
      return createErrorResponse(
        `Team ${teamConfig.teamId} has exceeded credit limit ($${teamConfig.creditLimit}). Current usage: $${teamUsage.totalCost.toFixed(2)}`,
        429,
        "Quota Exceeded"
      );
    }

    // Extract the path from the request and append to gateway URL
    const url = new URL(c.req.url);
    const gatewayUrl = c.env.GATEWAY_URL + url.pathname;

    const headers = Object.fromEntries(c.req.raw.headers.entries());

    // Drop any Authorization headers as we will use wholesale authorization
    delete headers["authorization"];
    delete headers["x-api-key"];

    const proxyResponse = await fetch(gatewayUrl, {
      method: c.req.method,
      headers: {
        ...headers,
        "cf-aig-authorization": `Bearer ${c.env.GATEWAY_API_KEY}`,
        "cf-aig-metadata": JSON.stringify({
          email,
          teamId: teamConfig.teamId
        })
      },
      body: await c.req.text()
    });

    if (!proxyResponse.ok) {
      console.error(`Gateway error:`, {
        status: proxyResponse.status,
        url: gatewayUrl
      });
    }

    // Extract and track usage cost
    const usageCost = extractUsageCost(proxyResponse);
    await updateTeamUsage(teamConfig.teamId, usageCost, c.env.O4E_TEAM_USAGE);

    return proxyResponse;
  } catch (error) {
    console.error('Proxy request failed:', error instanceof Error ? error.message : 'Unknown error');
    return createErrorResponse(
      "Failed to process request",
      500,
      "Internal Server Error"
    );
  }
});

export default {
  fetch: app.fetch,

  // Scheduled handler - runs hourly to refresh OpenAI models cache
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(fetchAndCacheOpenAIModels(env.O4E_CONFIG_CACHE));
  }
};
