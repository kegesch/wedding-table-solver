#!/usr/bin/env bun
import { Command } from "commander";
import { loadProblem, ConfigError } from "./loader.js";
import { solve } from "./solver.js";
import { formatSolution, formatDebug } from "./format.js";

const program = new Command();

program
	.name("seat-plan")
	.description(
		"Find the optimal wedding seating plan from a YAML config of people, weighted relations and tables.",
	)
	.argument("<config>", "path to the YAML config file")
	.option(
		"-d, --debug",
		"explain the solution in detail (problem, model, per-reason trade-offs)",
	)
	.option(
		"-t, --time-limit <seconds>",
		"solver time limit in seconds (0 = unlimited)",
		"30",
	)
	.option(
		"-g, --gap <ratio>",
		"optimality gap tolerance as a fraction, e.g. 0.02 = 2%",
		"0",
	)
	.option(
		"--min-weight <weight>",
		"minimum relation weight to include (relations with lower weight are ignored)",
	)
	.action(
		async (
			config: string,
			opts: {
				debug: boolean;
				timeLimit: string;
				gap: string;
				minWeight?: string;
			},
		) => {
			let text: string;
			try {
				text = await Bun.file(config).text();
			} catch (e) {
				fatal(
					`Could not read config file "${config}": ${(e as Error).message}`,
				);
			}

			let problem;
			try {
				problem = loadProblem(text);
			} catch (e) {
				if (e instanceof ConfigError) fatal(e.message);
				throw e;
			}

			const timeLimit = parseNumber(opts.timeLimit, "--time-limit");
			const gap = parseNumber(opts.gap, "--gap");
			if (gap < 0 || gap >= 1)
				fatal("--gap must be in [0, 1), e.g. 0.02 for 2%.");
			if (timeLimit < 0) fatal("--time-limit must be >= 0.");

			let minWeight: number | undefined;
			if (opts.minWeight !== undefined) {
				minWeight = parseNumber(opts.minWeight, "--min-weight");
			}

			// Filter relations by minimum weight if specified
			if (minWeight !== undefined) {
				const beforeCount = problem.relations.length;
				problem.relations = problem.relations.filter(
					(r) => r.weight >= minWeight!,
				);
				if (opts.debug && beforeCount !== problem.relations.length) {
					console.error(
						`[filter] Removed ${beforeCount - problem.relations.length} relations with weight < ${minWeight}`,
					);
				}
			}

			const solution = await solve(problem, {
				timeLimitSeconds: timeLimit === 0 ? undefined : timeLimit,
				gap,
			});

			if (opts.debug) console.log(formatDebug(problem, solution));
			else console.log(formatSolution(problem, solution));

			// Exit non-zero when the result is unusable, so scripts can detect it.
			if (solution.provenInfeasible || solution.unseated.length > 0)
				process.exit(2);
			if (!solution.optimal) process.exit(3); // feasible but not proven optimal
		},
	);

function parseNumber(s: string, label: string): number {
	const n = Number(s);
	if (!Number.isFinite(n)) fatal(`${label} must be a number, got "${s}".`);
	return n;
}

function fatal(msg: string): never {
	const c = process.stderr.isTTY === true && !process.env.NO_COLOR;
	console.error(`${c ? "\x1b[31m" : ""}Error:${c ? "\x1b[0m" : ""} ${msg}`);
	process.exit(1);
}

program.parseAsync(process.argv);
