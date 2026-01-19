import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import fg from "fast-glob";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const ROOT_DIR = join(import.meta.dirname, "..");
const CONFIG_DIR = join(ROOT_DIR, "config");
const BASE_CONFIG_PATH = join(CONFIG_DIR, "base.json");
const OUTPUT_PATH = join(CONFIG_DIR, "opencode.json");
const AGENTS_DIR = join(CONFIG_DIR, "agents");
const COMMANDS_DIR = join(CONFIG_DIR, "commands");

// Schema validation
const SCHEMA_URL = "https://opencode.ai/config.json";
const CACHE_DIR = join(ROOT_DIR, ".cache");
const SCHEMA_CACHE_PATH = join(CACHE_DIR, "opencode-schema.json");
const SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface BuildError {
	file: string;
	line?: number;
	message: string;
}

interface AgentConfig extends Record<string, unknown> {
	description: string;
	prompt: string;
}

interface CommandConfig extends Record<string, unknown> {
	description: string;
	template: string;
}

type Config = {
	$schema?: string;
	agent?: Record<string, AgentConfig>;
	command?: Record<string, CommandConfig>;
	[key: string]: unknown;
};

const errors: BuildError[] = [];
const warnings: string[] = [];

function log(message: string): void {
	console.log(message);
}

function logSuccess(message: string): void {
	console.log(`  \x1b[32m✓\x1b[0m ${message}`);
}

function logWarning(message: string): void {
	console.log(`  \x1b[33m⚠\x1b[0m ${message}`);
	warnings.push(message);
}

function logError(error: BuildError): void {
	const location = error.line ? `${error.file}:${error.line}` : error.file;
	console.error(`\x1b[31mError:\x1b[0m ${location}`);
	console.error(`  ${error.message}`);
	errors.push(error);
}

function parseMarkdownFile(
	filePath: string
): { data: Record<string, unknown>; content: string } | null {
	try {
		const fileContent = readFileSync(filePath, "utf-8");
		const { data, content } = matter(fileContent);
		// All frontmatter fields are passed through to output
		// Schema validation is the safeguard for invalid fields
		return { data, content: content.trim() };
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to parse file";
		logError({ file: filePath, message });
		return null;
	}
}

function buildAgents(): Record<string, AgentConfig> {
	const agents: Record<string, AgentConfig> = {};

	if (!existsSync(AGENTS_DIR)) {
		logWarning("No agents directory found");
		return agents;
	}

	const files = fg.sync("*.md", { cwd: AGENTS_DIR, absolute: true });

	for (const filePath of files) {
		const name = basename(filePath, ".md");
		const parsed = parseMarkdownFile(filePath);

		if (!parsed) continue;

		const { data, content } = parsed;

		// Validate required fields
		if (!data.description) {
			logError({
				file: filePath,
				message: "Missing required field: description",
			});
			continue;
		}

		// Build agent config - pass through all frontmatter fields
		// Schema validation will catch any invalid fields
		const agent: AgentConfig = {
			...data,
			description: data.description as string,
			prompt: content,
		};

		agents[name] = agent;
	}

	return agents;
}

function buildCommands(): Record<string, CommandConfig> {
	const commands: Record<string, CommandConfig> = {};

	if (!existsSync(COMMANDS_DIR)) {
		logWarning("No commands directory found");
		return commands;
	}

	const files = fg.sync("*.md", { cwd: COMMANDS_DIR, absolute: true });

	for (const filePath of files) {
		const name = basename(filePath, ".md");
		const parsed = parseMarkdownFile(filePath);

		if (!parsed) continue;

		const { data, content } = parsed;

		// Validate required fields
		if (!data.description) {
			logError({
				file: filePath,
				message: "Missing required field: description",
			});
			continue;
		}

		// Build command config - pass through all frontmatter fields
		// Schema validation will catch any invalid fields
		const command: CommandConfig = {
			...data,
			description: data.description as string,
			template: content,
		};

		commands[name] = command;
	}

	return commands;
}

async function fetchSchema(): Promise<Record<string, unknown> | null> {
	if (existsSync(SCHEMA_CACHE_PATH)) {
		try {
			const stats = statSync(SCHEMA_CACHE_PATH);
			const age = Date.now() - stats.mtimeMs;

			if (age < SCHEMA_CACHE_TTL_MS) {
				return JSON.parse(readFileSync(SCHEMA_CACHE_PATH, "utf-8")) as Record<string, unknown>;
			}
		} catch {
			// Cache read failed, fetch fresh
		}
	}

	try {
		const response = await fetch(SCHEMA_URL);
		if (!response.ok) {
			logWarning(`Failed to fetch schema: HTTP ${response.status}`);
			return null;
		}

		const schema = (await response.json()) as Record<string, unknown>;

		// Cache the schema
		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}
		writeFileSync(SCHEMA_CACHE_PATH, JSON.stringify(schema, null, "\t"));

		return schema;
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		logWarning(`Failed to fetch schema: ${message}`);
		return null;
	}
}

async function validateConfig(config: Config): Promise<boolean> {
	const schema = await fetchSchema();
	
	if (!schema) {
		logWarning("Schema validation skipped (could not fetch schema)");
		return true; // Don't fail build if schema unavailable
	}

	const ajv = new Ajv2020({ 
		strict: false,
		allErrors: true,
	});
	addFormats(ajv);

	const validate = ajv.compile(schema);
	const valid = validate(config);

	if (!valid && validate.errors) {
		console.error(`  \x1b[31m✗\x1b[0m Schema validation failed:`);
		for (const error of validate.errors) {
			const path = error.instancePath || "(root)";
			console.error(`    - ${path}: ${error.message}`);
		}
		return false;
	}

	logSuccess("Validated against OpenCode schema");
	return true;
}

function parseArgs(): { skipValidate: boolean } {
	const args = process.argv.slice(2);
	return {
		skipValidate: args.includes("--skip-validate"),
	};
}

async function main(): Promise<void> {
	const startTime = Date.now();
	log("\nBuilding OpenCode config...");

	if (!existsSync(BASE_CONFIG_PATH)) {
		logError({ file: BASE_CONFIG_PATH, message: "Base config not found" });
		process.exit(1);
	}

	let baseConfig: Config;
	try {
		baseConfig = JSON.parse(readFileSync(BASE_CONFIG_PATH, "utf-8"));
		logSuccess("Loaded config/base.json");
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to parse base config";
		logError({ file: BASE_CONFIG_PATH, message });
		process.exit(1);
	}

	const agents = buildAgents();
	const agentCount = Object.keys(agents).length;
	if (agentCount > 0) {
		logSuccess(`Parsed ${agentCount} agents: ${Object.keys(agents).join(", ")}`);
	}

	const commands = buildCommands();
	const commandCount = Object.keys(commands).length;
	if (commandCount > 0) {
		logSuccess(
			`Parsed ${commandCount} commands: ${Object.keys(commands).join(", ")}`
		);
	}

	if (errors.length > 0) {
		console.error(`\n\x1b[31mBuild failed with ${errors.length} error(s)\x1b[0m`);
		process.exit(1);
	}

	const finalConfig: Config = {
		...baseConfig,
	};

	if (agentCount > 0) {
		finalConfig.agent = agents;
	}

	if (commandCount > 0) {
		finalConfig.command = commands;
	}

	writeFileSync(OUTPUT_PATH, JSON.stringify(finalConfig, null, "\t") + "\n");
	logSuccess("Written to config/opencode.json");

	// Schema validation
	const { skipValidate } = parseArgs();
	if (skipValidate) {
		logWarning("Schema validation skipped (--skip-validate)");
	} else {
		const isValid = await validateConfig(finalConfig);
		if (!isValid) {
			console.error(`\n\x1b[31mBuild failed: schema validation error(s)\x1b[0m`);
			process.exit(1);
		}
	}

	const elapsed = Date.now() - startTime;
	log(`\nDone in ${elapsed}ms\n`);

	if (warnings.length > 0) {
		log(`\x1b[33m${warnings.length} warning(s)\x1b[0m`);
	}
}

main();
