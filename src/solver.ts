// Build a mixed-integer program for the seating problem and solve it with GLPK.
//
// Model
// -----
//   x[p][t] in {0,1}   person p is seated at table t
//   z[r][t] in {0,1}   both ends of relation r are seated at table t
//
//   maximise   sum_r w_r * ( sum_t z[r][t] )           // w_r counted iff same table
//   subject to sum_t x[p][t] = 1            for all p   // every person seated exactly once
//              min_t <= sum_p x[p][t] <= max_t  for all t  // table capacities
//              z[r][t] <= x[a_r][t]                     // } AND linearisation:
//              z[r][t] <= x[b_r][t]                     // } z is 1 iff both are at t
//              z[r][t] >= x[a_r][t] + x[b_r][t] - 1     // }
//
// z is 1 iff both people sit at table t. Because each person sits at exactly one
// table, sum_t z[r][t] is 0 or 1 = the indicator "a and b share a table". The
// lower bound forces z to 1 when they share (so negative weights are penalised
// correctly); the upper bounds stop z being 1 when they don't.
import GLPK, { type LP, type Options, type Result } from "glpk.js/node";
import type {
	Problem,
	RelationResult,
	Solution,
	TableAssignment,
} from "./model.js";

export interface SolveOptions {
	timeLimitSeconds?: number; // 0 or undefined => unlimited
	gap?: number;
}

const xName = (pi: number, ti: number) => `x_${pi}_${ti}`;
const zName = (ri: number, ti: number) => `z_${ri}_${ti}`;

/** Solve the problem to (near-)optimality. */
export async function solve(
	problem: Problem,
	opts: SolveOptions = {},
): Promise<Solution> {
	const glpk = await GLPK();
	const { persons, relations, tables } = problem;

	const personIndex = new Map<string, number>();
	persons.forEach((p, i) => personIndex.set(p.id, i));

	const objectiveVars: { name: string; coef: number }[] = [];
	const subjectTo: LP["subjectTo"] = [];
	const binaries: string[] = [];

	// each relation contributes w at each table it could be co-located at
	relations.forEach((rel, ri) => {
		for (let ti = 0; ti < tables.length; ti++) {
			const z = zName(ri, ti);
			binaries.push(z);
			objectiveVars.push({ name: z, coef: rel.weight });
		}
	});

	// every person is seated at exactly one table
	persons.forEach((_p, pi) => {
		for (let ti = 0; ti < tables.length; ti++) binaries.push(xName(pi, ti));
		subjectTo.push({
			name: `seat_p${pi}`,
			vars: tables.map((_t, ti) => ({ name: xName(pi, ti), coef: 1 })),
			bnds: { type: glpk.GLP_FX, ub: 1, lb: 1 },
		});
	});

	// table capacity bounds
	tables.forEach((t, ti) => {
		const vars = persons.map((_p, pi) => ({ name: xName(pi, ti), coef: 1 }));
		subjectTo.push({
			name: `cap_${t.id}_min`,
			vars,
			bnds: { type: glpk.GLP_LO, ub: 0, lb: t.min },
		});
		subjectTo.push({
			name: `cap_${t.id}_max`,
			vars: persons.map((_p, pi) => ({ name: xName(pi, ti), coef: 1 })),
			bnds: { type: glpk.GLP_UP, ub: t.max, lb: 0 },
		});
	});

	// AND linearisation for every relation/table
	relations.forEach((rel, ri) => {
		const aPi = personIndex.get(rel.a)!;
		const bPi = personIndex.get(rel.b)!;
		for (let ti = 0; ti < tables.length; ti++) {
			const z = zName(ri, ti);
			const xa = xName(aPi, ti);
			const xb = xName(bPi, ti);
			subjectTo.push({
				name: `${z}_le_${rel.a}`,
				vars: [
					{ name: z, coef: 1 },
					{ name: xa, coef: -1 },
				],
				bnds: { type: glpk.GLP_UP, ub: 0, lb: 0 },
			});
			subjectTo.push({
				name: `${z}_le_${rel.b}`,
				vars: [
					{ name: z, coef: 1 },
					{ name: xb, coef: -1 },
				],
				bnds: { type: glpk.GLP_UP, ub: 0, lb: 0 },
			});
			subjectTo.push({
				name: `${z}_ge_and`,
				vars: [
					{ name: z, coef: 1 },
					{ name: xa, coef: -1 },
					{ name: xb, coef: -1 },
				],
				bnds: { type: glpk.GLP_LO, ub: 0, lb: -1 },
			});
		}
	});

	const lp: LP = {
		name: "seat-plan",
		objective: {
			direction: glpk.GLP_MAX,
			name: "total_weight",
			vars: objectiveVars,
		},
		subjectTo,
		binaries,
	};

	// Build solver options. Omit tmlim when unlimited (GLPK default = INT_MAX).
	const solverOpts: Options = {
		msglev: glpk.GLP_MSG_OFF,
		presol: true,
		mipgap: opts.gap ?? problem.settings.gap ?? 0,
	};
	const tl = opts.timeLimitSeconds ?? problem.settings.timeLimitSeconds;
	if (tl && tl > 0) solverOpts.tmlim = tl;

	let res: Result;
	try {
		res = glpk.solve(lp, solverOpts);
	} catch (e) {
		throw new Error(`Solver crashed: ${(e as Error).message}`);
	}

	return decode(glpk, problem, res, {
		variables: binaries.length,
		constraints: subjectTo.length,
		binaries: binaries.length,
	});
}

interface Stats {
	variables: number;
	constraints: number;
	binaries: number;
}

function decode(
	glpk: Awaited<ReturnType<typeof GLPK>>,
	problem: Problem,
	res: Result,
	stats: Stats,
): Solution {
	const status = res.result.status;
	const optimal = status === glpk.GLP_OPT;
	const provenInfeasible =
		status === glpk.GLP_NOFEAS || status === glpk.GLP_INFEAS;

	let statusText: string;
	if (optimal) statusText = "optimal (proven)";
	else if (status === glpk.GLP_FEAS)
		statusText = "feasible (not proven optimal — time/gap limit reached)";
	else if (provenInfeasible) statusText = "infeasible";
	else if (status === glpk.GLP_UNDEF)
		statusText = "undefined (no solution returned)";
	else if (status === glpk.GLP_UNBND) statusText = "unbounded";
	else statusText = `unknown (status code ${status})`;

	const vars = res.result.vars ?? {};
	const { persons, relations, tables } = problem;

	// Determine each person's table.
	const seatOf = new Map<string, number>(); // personId -> table index
	for (let pi = 0; pi < persons.length; pi++) {
		for (let ti = 0; ti < tables.length; ti++) {
			if ((vars[xName(pi, ti)] ?? 0) > 0.5) {
				seatOf.set(persons[pi]!.id, ti);
				break;
			}
		}
	}

	// Group people by table.
	const assignments: TableAssignment[] = tables.map((table) => ({
		table,
		persons: [],
	}));
	const unseated: typeof persons = [];
	for (const p of persons) {
		const ti = seatOf.get(p.id);
		if (ti === undefined) unseated.push(p);
		else assignments[ti]!.persons.push(p);
	}

	// Realise each relation.
	const relResults: RelationResult[] = relations.map((rel) => {
		const ta = seatOf.get(rel.a);
		const tb = seatOf.get(rel.b);
		const together = ta !== undefined && ta === tb;
		return {
			a: rel.a,
			b: rel.b,
			weight: rel.weight,
			together,
			contribution: together ? rel.weight : 0,
		};
	});

	// The realised score from GLPK (authoritative) — fall back to recomputed sum.
	const score =
		typeof res.result.z === "number"
			? res.result.z
			: sum(relResults.map((r) => r.contribution));
	const upperBound = sum(
		relations.filter((r) => r.weight > 0).map((r) => r.weight),
	);

	return {
		statusText,
		optimal,
		provenInfeasible,
		score,
		upperBound,
		assignments,
		relations: relResults,
		unseated,
		timeSeconds: res.time ?? 0,
		stats,
	};
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
