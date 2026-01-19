# AGENTS.md

Guidelines for AI agents working in this repository.

## Project Overview

Cloudflare Worker that distributes OpenCode access to event participants with team-based credit limits:
- Validates JWT tokens via JWKS
- Maps user emails to teams and enforces per-team credit limits
- Tracks AI usage costs per team in Cloudflare KV
- Blocks requests when team exceeds allocated credit limit
- Proxies authenticated requests to AI Gateway with usage tracking
- Serves OpenCode configuration at `/.well-known/opencode`

**Use Case:** Event hackathons where participants are organized into teams, each with a fixed credit allocation (e.g., $20). Once a team exhausts their credits, access is automatically denied.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, Wrangler, KV Storage

## Commands

```bash
npm install              # Install dependencies
npm run build:config     # Build OpenCode config (runs automatically)
npm run setup-teams      # Upload team configurations
npm run view-teams       # View team usage
npm run dev              # Development server (wrangler dev)
npm run deploy           # Production deployment
npm run cf-typegen       # Generate Cloudflare types
```

## Project Structure

```
config/
  base.json               # Core config (providers and settings)
  opencode.json           # Generated - DO NOT EDIT (gitignored)
public/
  index.html              # Landing page
scripts/
  build-config.ts         # Compiles config into opencode.json
  setup-teams.ts          # Bulk upload team configurations
  view-teams.ts           # View team usage and status
src/
  index.ts                # Main Hono app entry point
wrangler.jsonc            # Wrangler config
teams.example.json        # Example team configuration
```

## TypeScript Configuration

- Target: ESNext
- Module: ESNext with Bundler resolution
- **Strict mode enabled**
- JSX: react-jsx with hono/jsx import source

## Code Style Guidelines

### Imports

```typescript
// Named imports from libraries
import { Hono } from "hono";

// Type-only imports (use 'import type' for types)
import type { JwtVariables } from "hono/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";

// Local imports
import configTemplate from "../config/opencode.json";

// Default exports for app/tool modules
export default app;
```

### Naming Conventions

| Type       | Convention          | Example                    |
|------------|---------------------|----------------------------|
| Constants  | SCREAMING_SNAKE     | `CF_ACCESS_TEAM_NAME`      |
| Functions  | camelCase           | `createErrorResponse`      |
| Interfaces | PascalCase          | `ErrorResponse`            |
| Variables  | camelCase           | `cachedKeys`               |

### Type Definitions

```typescript
// Define interfaces for data structures
interface Env {
  GATEWAY_API_KEY: string;
  GATEWAY_URL: string;
}

interface ErrorResponse {
  error: string;
  message: string;
  status?: number;
  timestamp: string;
}

// Type Hono apps with bindings and variables
type Variables = JwtVariables<{ email?: string }>;
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Type JSON responses explicitly
const data = await response.json() as { keys: HonoJsonWebKey[] };
```

### Error Handling

Use structured error responses with consistent format:

```typescript
interface ErrorResponse {
  error: string;      // Error type (e.g., "Unauthorized", "Gateway Error")
  message: string;    // Human-readable message
  status?: number;    // HTTP status code
  timestamp: string;  // ISO timestamp
}

function createErrorResponse(message: string, status = 500, error = 'Internal Server Error'): Response {
  const errorResponse: ErrorResponse = {
    error,
    message,
    status,
    timestamp: new Date().toISOString()
  };
  console.log(errorResponse);  // Always log errors
  return new Response(JSON.stringify(errorResponse), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
```

For tools, return error strings (don't throw):
```typescript
return `Error: ${message}`;
```

### Comments

- Focus on "why", not "what"
- Don't comment single variables or short functions
- Comment logic with I/O, validation, or edge cases

```typescript
// Good: explains why
// 1 hour TTL for JWKS cache
cacheExpiration = now + 3600 * 1000;

// Good: documents configurable behavior
// JIRA fields to extract from API response
// Add/remove field paths here to control what's included
const JIRA_INCLUDED_FIELDS = [...]
```

### Formatting

- Tabs for indentation
- Double quotes for strings
- Semicolons at end of statements

## Environment Variables

Worker bindings (defined in wrangler.jsonc):
- `GATEWAY_API_KEY` - AI Gateway authorization key
- `GATEWAY_URL` - AI Gateway base URL
- `GATEWAY_ACCOUNT_ID` - Cloudflare account ID
- `GATEWAY_ID` - Gateway identifier
- `ASSETS` - Static assets binding
- `O4E_TEAM_USAGE` - KV namespace for tracking team credit usage
- `O4E_TEAM_CONFIG` - KV namespace for team configuration (email mappings, credit limits)
- `O4E_CONFIG_CACHE` - KV namespace for caching OpenAI models list

## Configuration

OpenCode configuration is managed in `config/base.json` and compiled by `npm run build:config`.

The generated `config/opencode.json` is gitignored - do not edit directly.
Changes are served at `/.well-known/opencode`.

## Key Patterns

### Caching (JWKS example)

```typescript
let cachedKeys: HonoJsonWebKey[] | null = null;
let cacheExpiration = 0;

async function getPublicKeys(): Promise<HonoJsonWebKey[]> {
  const now = Date.now();
  if (cachedKeys && now < cacheExpiration) {
    return cachedKeys;
  }
  // Fetch and cache...
  cacheExpiration = now + 3600 * 1000; // 1 hour
  return cachedKeys;
}
```

### Team Credit Management

Team data structure stored in `TEAM_CONFIG` KV:
```typescript
interface TeamConfig {
  teamId: string;
  emails: string[];      // List of participant emails
  creditLimit: number;   // Maximum credits in USD (e.g., 20.00)
}
```

Usage tracking stored in `TEAM_USAGE` KV:
```typescript
interface TeamUsage {
  teamId: string;
  totalCost: number;     // Accumulated cost in USD
  lastUpdated: string;   // ISO timestamp
  requestCount: number;  // Total requests made
}
```

Flow:
1. Extract email from validated JWT
2. Look up team via email → teamId mapping in `TEAM_CONFIG`
3. Check current usage from `TEAM_USAGE`
4. If `totalCost >= creditLimit`, return 429 (quota exceeded)
5. Proxy request to AI Gateway
6. Parse usage cost from response metadata
7. Update `TEAM_USAGE` with incremented cost

### Request Proxying

- Strip incoming `Authorization` header
- Add `cf-aig-authorization` with GATEWAY_API_KEY
- Add `cf-aig-metadata` with user context (email, teamId)
- Return streaming response for SSE
- Track usage cost from response headers/metadata

## Development Guidelines

- Minimize introducing dependencies unless necessary
- Install dependencies using project toolchain (npm)
- Do NOT commit/push without explicit instruction
