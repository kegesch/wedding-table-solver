// Turn a Solution into human-readable output.
import type { Person, Problem, Solution } from "./model.js";

const nameOf = (problem: Problem, id: string): string =>
	problem.persons.find((p) => p.id === id)?.name ?? id;

function fmtWeight(w: number): string {
	return (w > 0 ? "+" : "") + w;
}

/** Default, readable summary of the seating plan. */
export function formatSolution(problem: Problem, sol: Solution): string {
	if (sol.provenInfeasible) {
		return (
			`${red("No feasible seating exists.")}\n` + explainInfeasible(problem)
		);
	}

	const lines: string[] = [];
	const scoreStr = sol.optimal
		? bold(green(String(sol.score)))
		: bold(yellow(String(sol.score)));
	lines.push(
		`${bold("Seating plan")} — score ${scoreStr} (${sol.statusText})`,
		`${problem.persons.length} people at ${problem.tables.length} tables · solved in ${sol.timeSeconds.toFixed(2)}s`,
		"",
	);

	for (const a of sol.assignments) {
		const { table } = a;
		const names = a.persons.map((p) => p.name).join(", ") || dim("(empty)");
		lines.push(
			`${bold(table.name)} ${dim(`(${a.persons.length}/${table.max} seated, capacity ${table.min}–${table.max})`)}`,
			`  ${names}`,
			"",
		);
	}

	if (sol.unseated.length > 0) {
		lines.push(
			yellow(
				`Unseated (${sol.unseated.length}): ${sol.unseated.map((p) => p.name).join(", ")}`,
			),
		);
		lines.push("");
	}

	const satisfied = sol.relations.filter(
		(r) => r.weight > 0 === r.together,
	).length;
	const total = sol.relations.length;
	if (total > 0) lines.push(dim(`${satisfied}/${total} relations satisfied.`));

	return lines.join("\n");
}

/** Verbose explanation of how and why the solution came out the way it did. */
export function formatDebug(problem: Problem, sol: Solution): string {
	const lines: string[] = [];
	lines.push(bold("── Problem ──"));
	lines.push(
		`persons:   ${problem.persons.length}`,
		`relations: ${problem.relations.length} (${problem.relations.filter((r) => r.weight > 0).length} affinity, ${problem.relations.filter((r) => r.weight < 0).length} aversion)`,
		`tables:    ${problem.tables.length} (seats ${tableSeatRange(problem)})`,
	);
	const totalMin = problem.tables.reduce((s, t) => s + t.min, 0);
	const totalMax = problem.tables.reduce((s, t) => s + t.max, 0);
	lines.push(
		`capacity:  ${problem.persons.length} people vs ${totalMin}–${totalMax} total seats ` +
			(problem.persons.length >= totalMin && problem.persons.length <= totalMax
				? green("[fits]")
				: red("[does not fit]")),
	);
	if (sol.stats) {
		lines.push(
			`model:     ${sol.stats.variables} variables (${sol.stats.binaries} binary), ${sol.stats.constraints} constraints`,
		);
	}
	lines.push("");

	lines.push(bold("── Result ──"));
	lines.push(
		`status: ${sol.statusText}`,
		`score:  ${sol.score} ` + dim(`(optimistic upper bound ${sol.upperBound})`),
		`time:   ${sol.timeSeconds.toFixed(2)}s`,
	);
	if (!sol.optimal && !sol.provenInfeasible)
		lines.push(
			yellow(
				"Tip: increase --time-limit (use 0 for unlimited) to prove optimality.",
			),
		);
	lines.push("");

	if (sol.provenInfeasible) {
		lines.push(explainInfeasible(problem));
		return lines.join("\n");
	}

	lines.push(bold("── Relations ──"));
	const rows: { mark: string; w: string; pair: string; state: string }[] = [];
	for (const r of [...sol.relations].sort(
		(a, b) => Math.abs(b.weight) - Math.abs(a.weight),
	)) {
		const want =
			r.weight > 0 ? "together" : r.weight < 0 ? "apart" : "indifferent";
		const got = r.together ? "together" : "apart";
		const ok = want === "indifferent" || want === got;
		rows.push({
			mark: ok ? green("✓") : red("✗"),
			w: fmtWeight(r.weight).padStart(5),
			pair: `${nameOf(problem, r.a)} & ${nameOf(problem, r.b)}`,
			state: ok ? `${got}` : `${got} ${dim(`(wanted ${want})`)}`,
		});
	}
	const pairW = Math.max(8, ...rows.map((r) => r.pair.length));
	lines.push(`  ${" "}  ${"w".padStart(5)}  ${"pair".padEnd(pairW)}  outcome`);
	for (const r of rows)
		lines.push(`  ${r.mark}  ${r.w}  ${r.pair.padEnd(pairW)}  ${r.state}`);

	// trade-off summary
	const missed = sol.relations.filter((r) => r.weight > 0 && !r.together);
	const penalty = sol.relations.filter((r) => r.weight < 0 && r.together);
	lines.push("");
	if (missed.length || penalty.length) {
		lines.push(bold("── Trade-offs ──"));
		if (missed.length)
			lines.push(
				`${missed.length} affinity pair(s) split apart — lost ${missed.reduce((s, r) => s + r.weight, 0)} points:`,
			);
		for (const r of missed)
			lines.push(
				`  ${nameOf(problem, r.a)} & ${nameOf(problem, r.b)} (${fmtWeight(r.weight)})`,
			);
		if (penalty.length)
			lines.push(
				`${penalty.length} aversion pair(s) seated together — cost ${penalty.reduce((s, r) => s + Math.abs(r.weight), 0)} points:`,
			);
		for (const r of penalty)
			lines.push(
				`  ${nameOf(problem, r.a)} & ${nameOf(problem, r.b)} (${fmtWeight(r.weight)})`,
			);
	} else if (sol.relations.some((r) => r.weight !== 0)) {
		lines.push(green("Every weighted relation was satisfied."));
	}
	return lines.join("\n");
}

function tableSeatRange(problem: Problem): string {
	return problem.tables.map((t) => `${t.min}-${t.max}`).join(", ");
}

function explainInfeasible(problem: Problem): string {
	const totalMin = problem.tables.reduce((s, t) => s + t.min, 0);
	const totalMax = problem.tables.reduce((s, t) => s + t.max, 0);
	const n = problem.persons.length;
	const reasons: string[] = [];
	if (n > totalMax)
		reasons.push(
			`${n} people but only ${totalMax} total seats (raise some table.max).`,
		);
	if (n < totalMin)
		reasons.push(
			`Tables require at least ${totalMin} seats but there are only ${n} people (lower some table.min).`,
		);
	return reasons.length
		? "Why:\n  - " + reasons.join("\n  - ")
		: "The capacity bounds leave no valid assignment.";
}

// --- minimal ANSI helpers (no deps) ---
// Disabled automatically when output is piped or NO_COLOR is set.
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const T = (s: string, c: string) => (useColor ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = (s: string) => T(s, "1");
const dim = (s: string) => T(s, "2");
const green = (s: string) => T(s, "32");
const yellow = (s: string) => T(s, "33");
const red = (s: string) => T(s, "31");

export const _ansi = { bold, dim, green, yellow, red };
export type { Person };
