#!/usr/bin/env tsx

/**
 * Helper script to view team configurations and usage
 * 
 * Usage:
 *   npm run view-teams
 *   npm run view-teams -- --env staging
 *   npm run view-teams -- team-alpha
 *   npm run view-teams -- team-alpha --env staging
 */

import { execSync } from "child_process";

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

interface KVKey {
	name: string;
}

function getKVValue(key: string, binding: string, env?: string): string | null {
	const envFlag = env ? `--env ${env}` : "";

	try {
		const result = execSync(
			`wrangler kv key get "${key}" --binding ${binding} --remote ${envFlag}`,
			{ encoding: "utf-8", stdio: ['pipe', 'pipe', 'pipe'] }
		);
		const trimmed = result.trim();
		// Check if the result is an error message
		if (trimmed === "Value not found" || trimmed.includes("Error")) {
			return null;
		}
		return trimmed;
	} catch (error) {
		return null;
	}
}

function listKVKeys(binding: string, env?: string): string[] {
	const envFlag = env ? `--env ${env}` : "";

	try {
		const result = execSync(
			`wrangler kv key list --binding ${binding} --remote ${envFlag}`,
			{ encoding: "utf-8", stdio: ['pipe', 'pipe', 'pipe'] }
		);
		const keys = JSON.parse(result) as KVKey[];
		return keys.map(k => k.name);
	} catch (error) {
		console.error(`Failed to list keys from ${binding}:`, error);
		return [];
	}
}

function displayTeam(teamId: string, env?: string): void {
	const configStr = getKVValue(teamId, "O4E_TEAM_CONFIG", env);

	if (!configStr) {
		console.log(`Team "${teamId}" not found\n`);
		return;
	}

	const config = JSON.parse(configStr) as TeamConfig;
	const usageStr = getKVValue(teamId, "O4E_TEAM_USAGE", env);
	const usage: TeamUsage = usageStr
		? JSON.parse(usageStr)
		: { teamId, totalCost: 0, lastUpdated: "N/A", requestCount: 0 };

	const remaining = config.creditLimit - usage.totalCost;
	const percentUsed = (usage.totalCost / config.creditLimit * 100).toFixed(1);

	console.log(`Team: ${config.teamId}`);
	console.log(`  Members (${config.emails.length}):`);
	config.emails.forEach(email => {
		console.log(`    - ${email}`);
	});
	console.log(`  Credit Limit: $${config.creditLimit.toFixed(2)}`);
	console.log(`  Used: $${usage.totalCost.toFixed(2)} (${percentUsed}%)`);
	console.log(`  Remaining: $${remaining.toFixed(2)}`);
	console.log(`  Requests: ${usage.requestCount}`);
	console.log(`  Last Updated: ${usage.lastUpdated}`);
	console.log();
}

function displayAllTeams(env?: string): void {
	const teamIds = listKVKeys("O4E_TEAM_CONFIG", env);

	if (teamIds.length === 0) {
		console.log("No teams configured");
		return;
	}

	console.log(`Found ${teamIds.length} team(s)${env ? ` in ${env}` : ""}:\n`);

	// Calculate totals
	let totalLimit = 0;
	let totalUsed = 0;
	let totalRequests = 0;

	teamIds.forEach(teamId => {
		const configStr = getKVValue(teamId, "O4E_TEAM_CONFIG", env);
		const usageStr = getKVValue(teamId, "O4E_TEAM_USAGE", env);

		if (configStr) {
			const config = JSON.parse(configStr) as TeamConfig;
			const usage: TeamUsage = usageStr
				? JSON.parse(usageStr)
				: { teamId, totalCost: 0, lastUpdated: "N/A", requestCount: 0 };

			totalLimit += config.creditLimit;
			totalUsed += usage.totalCost;
			totalRequests += usage.requestCount;

			displayTeam(teamId, env);
		}
	});

	console.log("=".repeat(50));
	console.log("Summary:");
	console.log(`  Total Teams: ${teamIds.length}`);
	console.log(`  Total Credit Limit: $${totalLimit.toFixed(2)}`);
	console.log(`  Total Used: $${totalUsed.toFixed(2)} (${(totalUsed / totalLimit * 100).toFixed(1)}%)`);
	console.log(`  Total Remaining: $${(totalLimit - totalUsed).toFixed(2)}`);
	console.log(`  Total Requests: ${totalRequests}`);
}

function main() {
	const args = process.argv.slice(2);

	const envIndex = args.indexOf("--env");
	const env = envIndex !== -1 ? args[envIndex + 1] : undefined;

	// Filter out --env flags
	const teamId = args.find(arg => arg !== "--env" && arg !== env);

	if (teamId) {
		// Display specific team
		displayTeam(teamId, env);
	} else {
		// Display all teams
		displayAllTeams(env);
	}
}

main();
