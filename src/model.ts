// Core domain types for the seat planner.

/** A guest. `id` is the stable handle used in relations; `name` is for display. */
export interface Person {
	id: string;
	name: string;
}

/**
 * An undirected, weighted relation between two guests.
 *  - positive weight => affinity (want them seated together)
 *  - negative weight => aversion (want them seated apart)
 *  - magnitude is relative; only the ordering/scale between weights matters.
 */
export interface Relation {
	a: string; // person id (a <= b after normalisation in the loader)
	b: string; // person id
	weight: number;
}

/** A table with seating bounds (inclusive). `min` defaults to 0. */
export interface Table {
	id: string;
	name: string;
	min: number;
	max: number;
}

/** Optional global solver settings, overridable per-invocation via CLI flags. */
export interface Settings {
	timeLimitSeconds?: number; // 0 or undefined => unlimited
	gap?: number; // MIP relative optimality gap tolerance (e.g. 0.02 = 2%)
}

/** The fully-validated problem read from the YAML config. */
export interface Problem {
	persons: Person[];
	relations: Relation[]; // deduplicated + aggregated, pairs sorted
	tables: Table[];
	settings: Settings;
}

/** One relation as realised by a particular seating. */
export interface RelationResult {
	a: string;
	b: string;
	weight: number;
	together: boolean; // were the two people placed at the same table?
	contribution: number; // weight if together else 0 (the part of the objective)
}

/** The people assigned to a single table. */
export interface TableAssignment {
	table: Table;
	persons: Person[];
}

/** The solver's verdict, ready to be printed. */
export interface Solution {
	statusText: string; // human-readable solver status
	optimal: boolean; // proven optimal?
	provenInfeasible: boolean; // no feasible seating exists at all?
	score: number; // realised objective value
	upperBound: number; // sum of positive weights (an optimistic, possibly unreachable ceiling)
	assignments: TableAssignment[];
	relations: RelationResult[];
	unseated: Person[]; // always empty for a feasible problem (kept for safety)
	timeSeconds: number;
	/** model statistics, populated for --debug */
	stats?: { variables: number; constraints: number; binaries: number };
}
