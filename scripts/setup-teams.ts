#!/usr/bin/env tsx

/**
 * Helper script to bulk-upload team configurations to KV
 *
 * Usage:
 *   npm run setup-teams -- teams.json
 *   npm run setup-teams -- teams.json --env staging
 *   npm run setup-teams -- teams.json --remote (to upload to remote KV)
 *
 * teams.json format:
 * [
 *   {
 *     "teamId": "team-alpha",
 *     "emails": ["alice@example.com", "bob@example.com"],
 *     "creditLimit": 20.00
 *   },
 *   ...
 * ]
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";

interface TeamConfig {
	teamId: string;
	emails: string[];
	creditLimit: number;
}

function validateTeamConfig(config: TeamConfig, index: number): string[] {
	const errors: string[] = [];

	if (!config.teamId || typeof config.teamId !== "string") {
		errors.push(`Team ${index}: teamId is required and must be a string`);
	}

	if (!Array.isArray(config.emails) || config.emails.length === 0) {
		errors.push(`Team ${index}: emails must be a non-empty array`);
	}

	if (typeof config.creditLimit !== "number" || config.creditLimit <= 0) {
		errors.push(`Team ${index}: creditLimit must be a positive number`);
	}

	return errors;
}

function uploadTeamConfig(config: TeamConfig, env?: string, remote: boolean = false): void {
	const envFlag = env ? `--env ${env}` : "";
	const remoteFlag = remote ? "--remote" : "";
	const configJson = JSON.stringify(config);

	try {
		// Use the value as a positional argument instead of piping via stdin
		const command = `wrangler kv key put "${config.teamId}" '${configJson}' --binding O4E_TEAM_CONFIG ${envFlag} ${remoteFlag}`;
		execSync(command, { stdio: "inherit" });
		console.log(`✓ Uploaded team: ${config.teamId}`);
	} catch (error) {
		console.error(`✗ Failed to upload team ${config.teamId}:`, error);
		throw error;
	}
}

function main() {
	const args = process.argv.slice(2);

	if (args.length === 0) {
		console.error("Usage: npm run setup-teams -- <teams.json> [--env staging] [--remote]");
		process.exit(1);
	}

	const filePath = args[0];
	const envIndex = args.indexOf("--env");
	const env = envIndex !== -1 ? args[envIndex + 1] : undefined;
	const remote = args.includes("--remote");

	let teamsData: TeamConfig[];
	try {
		const fileContent = readFileSync(filePath, "utf-8");
		teamsData = JSON.parse(fileContent) as TeamConfig[];
	} catch (error) {
		console.error(`Failed to read or parse ${filePath}:`, error);
		process.exit(1);
	}

	if (!Array.isArray(teamsData)) {
		console.error("Error: teams.json must contain an array of team configurations");
		process.exit(1);
	}

	// Validate all teams first
	const allErrors: string[] = [];
	teamsData.forEach((config, index) => {
		const errors = validateTeamConfig(config, index);
		allErrors.push(...errors);
	});

	if (allErrors.length > 0) {
		console.error("Validation errors:");
		allErrors.forEach(error => console.error(`  - ${error}`));
		process.exit(1);
	}

	// Check for duplicate team IDs
	const teamIds = teamsData.map(t => t.teamId);
	const duplicates = teamIds.filter((id, index) => teamIds.indexOf(id) !== index);
	if (duplicates.length > 0) {
		console.error("Error: Duplicate team IDs found:", duplicates);
		process.exit(1);
	}

	// Upload all teams
	const location = remote ? "remote" : "local";
	console.log(`Uploading ${teamsData.length} team(s) to ${location} ${env || "production"}...\n`);

	let successCount = 0;
	let failureCount = 0;

	for (const config of teamsData) {
		try {
			uploadTeamConfig(config, env, remote);
			successCount++;
		} catch (error) {
			failureCount++;
		}
	}

	console.log(`\nResults: ${successCount} succeeded, ${failureCount} failed`);

	if (failureCount > 0) {
		process.exit(1);
	}
}

main();
