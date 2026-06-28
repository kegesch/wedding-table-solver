// Parse and validate the YAML config into a fully-checked Problem.
import { parse } from "yaml";
import type {
	Person,
	Problem,
	Relation,
	Settings,
	Table,
	FixedTable,
} from "./model.js";

/** Thrown when the config is structurally invalid or infeasible by inspection. */
export class ConfigError extends Error {}

/** A raw, loosely-typed view of the YAML document for validation. */
type YamlMap = Record<string, unknown>;

function isObj(v: unknown): v is YamlMap {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asStr(v: unknown, field: string): string {
	if (typeof v !== "string" || v.length === 0)
		throw new ConfigError(`Expected a non-empty string for "${field}".`);
	return v;
}
function asNum(v: unknown, field: string): number {
	if (typeof v !== "number" || !Number.isFinite(v))
		throw new ConfigError(
			`Expected a number for "${field}", got ${JSON.stringify(v)}.`,
		);
	return v;
}
function asInt(v: unknown, field: string, min: number): number {
	const n = asNum(v, field);
	if (!Number.isInteger(n) || n < min)
		throw new ConfigError(`"${field}" must be an integer >= ${min}, got ${n}.`);
	return n;
}

/** Parse raw YAML text into a validated Problem (throws ConfigError on any issue). */
export function loadProblem(text: string): Problem {
	let doc: unknown;
	try {
		doc = parse(text);
	} catch (e) {
		throw new ConfigError(`YAML could not be parsed: ${(e as Error).message}`);
	}
	if (!isObj(doc)) throw new ConfigError("Top-level YAML must be a mapping.");

	// Collect every problem, then fail with the full list at once for nicer UX.
	const errors: string[] = [];
	const tryPush = (fn: () => void) => {
		try {
			fn();
		} catch (e) {
			errors.push((e as Error).message);
		}
	};

	// --- persons ---
	const persons: Person[] = [];
	const personIds = new Set<string>();
	const personsRaw = doc["persons"];
	if (!Array.isArray(personsRaw) || personsRaw.length === 0) {
		errors.push('"persons" must be a non-empty list.');
	} else {
		personsRaw.forEach((p, i) => {
			tryPush(() => {
				if (!isObj(p))
					throw new ConfigError(`persons[${i}]: must be a mapping.`);
				const id = asStr(p["id"], `persons[${i}].id`);
				if (personIds.has(id))
					throw new ConfigError(`persons[${i}]: duplicate id "${id}".`);
				personIds.add(id);
				const name =
					typeof p["name"] === "string" && p["name"].length ? p["name"] : id;
				persons.push({ id, name });
			});
		});
	}

	// --- tables ---
	const tables: Table[] = [];
	const tableIds = new Set<string>();
	const tablesRaw = doc["tables"];
	if (!Array.isArray(tablesRaw) || tablesRaw.length === 0) {
		errors.push('"tables" must be a non-empty list.');
	} else {
		tablesRaw.forEach((t, i) => {
			tryPush(() => {
				if (!isObj(t))
					throw new ConfigError(`tables[${i}]: must be a mapping.`);
				const id = asStr(t["id"], `tables[${i}].id`);
				if (tableIds.has(id))
					throw new ConfigError(`tables[${i}]: duplicate id "${id}".`);
				tableIds.add(id);
				const name =
					typeof t["name"] === "string" && t["name"].length ? t["name"] : id;
				const max = asInt(t["max"], `tables[${i}].max`, 1);
				const minRaw = t["min"];
				const min =
					minRaw === undefined ? 0 : asInt(minRaw, `tables[${i}].min`, 0);
				if (min > max)
					throw new ConfigError(
						`tables[${i}]: min (${min}) must be <= max (${max}).`,
					);
				tables.push({ id, name, min, max });
			});
		});
	}

	// --- fixedTables (optional) ---
	const fixedTables: FixedTable[] = [];
	const fixedTablesRaw = doc["fixedTables"];
	if (fixedTablesRaw !== undefined) {
		if (!Array.isArray(fixedTablesRaw)) {
			errors.push('"fixedTables" must be a list when present.');
		} else {
			const assignedFixedPersons = new Set<string>();
			fixedTablesRaw.forEach((ft, i) => {
				tryPush(() => {
					if (!isObj(ft))
						throw new ConfigError(`fixedTables[${i}]: must be a mapping.`);
					const tableId = asStr(ft["tableId"], `fixedTables[${i}].tableId`);
					if (!tableIds.has(tableId))
						throw new ConfigError(
							`fixedTables[${i}]: unknown table "${tableId}".`,
						);
					const personsRaw = ft["persons"];
					if (!Array.isArray(personsRaw) || personsRaw.length === 0) {
						throw new ConfigError(
							`fixedTables[${i}].persons: must be a non-empty list.`,
						);
					}
					const personIdsList: string[] = [];
					personsRaw.forEach((pid, j) => {
						if (typeof pid !== "string") {
							throw new ConfigError(
								`fixedTables[${i}].persons[${j}]: must be a string.`,
							);
						}
						if (!personIds.has(pid)) {
							throw new ConfigError(
								`fixedTables[${i}].persons[${j}]: unknown person "${pid}".`,
							);
						}
						if (assignedFixedPersons.has(pid)) {
							throw new ConfigError(
								`fixedTables[${i}].persons[${j}]: person "${pid}" is already assigned to another fixed table.`,
							);
						}
						assignedFixedPersons.add(pid);
						personIdsList.push(pid);
					});

					// Validate capacity constraints for fixed tables
					const table = tables.find((t) => t.id === tableId)!;
					if (personIdsList.length > table.max) {
						throw new ConfigError(
							`fixedTables[${i}]: ${personIdsList.length} persons assigned to table "${tableId}" but max is ${table.max}.`,
						);
					}
					if (personIdsList.length < table.min) {
						throw new ConfigError(
							`fixedTables[${i}]: ${personIdsList.length} persons assigned to table "${tableId}" but min is ${table.min}.`,
						);
					}

					fixedTables.push({ tableId, persons: personIdsList });
				});
			});
		}
	}

	// --- relations (optional) ---
	const relations: Relation[] = [];
	const relKey = (a: string, b: string) =>
		a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
	const relMap = new Map<string, Relation>();
	const relationsRaw = doc["relations"];
	if (relationsRaw !== undefined) {
		if (!Array.isArray(relationsRaw)) {
			errors.push('"relations" must be a list when present.');
		} else {
			relationsRaw.forEach((r, i) => {
				tryPush(() => {
					if (!isObj(r))
						throw new ConfigError(`relations[${i}]: must be a mapping.`);
					const between = r["between"];
					if (!Array.isArray(between) || between.length !== 2)
						throw new ConfigError(
							`relations[${i}].between: must be a 2-element list.`,
						);
					const [a, b] = between;
					if (typeof a !== "string" || typeof b !== "string")
						throw new ConfigError(
							`relations[${i}].between: both entries must be strings.`,
						);
					if (a === b)
						throw new ConfigError(
							`relations[${i}]: a person cannot relate to themselves ("${a}").`,
						);
					if (!personIds.has(a))
						throw new ConfigError(`relations[${i}]: unknown person "${a}".`);
					if (!personIds.has(b))
						throw new ConfigError(`relations[${i}]: unknown person "${b}".`);
					const weight = asNum(r["weight"], `relations[${i}].weight`);
					const key = relKey(a, b);
					const prev = relMap.get(key);
					if (prev)
						prev.weight += weight; // aggregate duplicates (sum)
					else
						relMap.set(key, { a: a <= b ? a : b, b: a <= b ? b : a, weight });
				});
			});
		}
	}
	for (const rel of relMap.values()) relations.push(rel);

	// --- settings (optional) ---
	const settings: Settings = {};
	const settingsRaw = doc["settings"];
	if (settingsRaw !== undefined) {
		tryPush(() => {
			if (!isObj(settingsRaw))
				throw new ConfigError('"settings" must be a mapping.');
			const tl = settingsRaw["timeLimitSeconds"];
			if (tl !== undefined) {
				const n = asNum(tl, "settings.timeLimitSeconds");
				if (n < 0 || !Number.isFinite(n))
					throw new ConfigError(
						"settings.timeLimitSeconds must be a finite number >= 0.",
					);
				settings.timeLimitSeconds = n;
			}
			const gap = settingsRaw["gap"];
			if (gap !== undefined) {
				const n = asNum(gap, "settings.gap");
				if (n < 0 || n >= 1)
					throw new ConfigError(
						"settings.gap must be in [0, 1) (e.g. 0.02 = 2%).",
					);
				settings.gap = n;
			}
		});
	}

	// --- feasibility by inspection ---
	// Account for fixed tables: only the non-fixed people need to fit into the
	// non-fixed tables. Fixed tables are already filled to an exact (validated)
	// count, so they neither absorb free people nor impose min/max on the rest.
	if (persons.length > 0 && tables.length > 0) {
		const fixedTableIdSet = new Set(fixedTables.map((ft) => ft.tableId));
		const fixedPersonCount = fixedTables.reduce(
			(s, ft) => s + ft.persons.length,
			0,
		);
		const freePersons = persons.length - fixedPersonCount;
		const freeTables = tables.filter((t) => !fixedTableIdSet.has(t.id));

		if (freePersons > 0 && freeTables.length === 0) {
			errors.push(
				`Infeasible: ${freePersons} unassigned people but every table is fixed (add a free table or free a fixed one).`,
			);
		} else if (freeTables.length > 0) {
			const totalMin = freeTables.reduce((s, t) => s + t.min, 0);
			const totalMax = freeTables.reduce((s, t) => s + t.max, 0);
			if (freePersons > totalMax)
				errors.push(
					`Infeasible: ${freePersons} unassigned people but only ${totalMax} free seats (sum of non-fixed table max).`,
				);
			if (freePersons < totalMin)
				errors.push(
					`Infeasible: ${freePersons} unassigned people but free tables require at least ${totalMin} seats (sum of non-fixed table min). Lower some table.min, or move people off fixed tables.`,
				);
		}
	}

	if (errors.length > 0) {
		throw new ConfigError("Invalid config:\n  - " + errors.join("\n  - "));
	}

	return { persons, relations, tables, settings, fixedTables };
}
