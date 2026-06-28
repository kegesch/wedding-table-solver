#!/usr/bin/env bun
// Generate a seat-planner YAML config from a guest CSV.
//
// Usage:
//   bun run scripts/gen-from-csv.ts <guests.csv> <output.yaml>
//
// - One person per CSV row (columns: id,name,surname,status,food_choice,
//   dietary_restrictions,booking_id).
// - Guests sharing a booking_id get a mutual relation (they booked together).
// - The wedding couple is added explicitly with a stronger relation.
//
// Tunable weights:
import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync } from "node:fs";

const BOOKING_WEIGHT = 8; // same booking_id -> sit together
const COUPLE_WEIGHT = 10; // wedding couple   -> sit together (strongest)
const TABLE_MIN = 7; // default round-table bounds (adjust to your venue)
const TABLE_MAX = 10;

// The wedding couple (added on top of the CSV guests).
const COUPLE: { first: string; last: string }[] = [
	{ first: "Jonas", last: "Geschke" },
	{ first: "Maria", last: "Kuhn" },
];

interface Row {
	id: string;
	name: string;
	surname: string;
	status: string;
	food_choice: string;
	dietary_restrictions: string;
	booking_id: string;
}

/** Turn "Matthäus Kuhn" -> "matthaus_kuhn" (ASCII-safe, stable). */
function slugify(first: string, last: string): string {
	const full = (last ? `${first} ${last}` : first).toLowerCase();
	const ascii = full
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // strip accents
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return ascii || "guest";
}

function main() {
	const csvPath = process.argv[2];
	const outPath = process.argv[3];
	if (!csvPath || !outPath) {
		console.error(
			"Usage: bun run scripts/gen-from-csv.ts <guests.csv> <output.yaml>",
		);
		process.exit(1);
	}

	const rows = parse(readFileSync(csvPath, "utf8"), {
		columns: true,
		trim: true,
		skip_empty_lines: true,
		bom: true,
	}) as Row[];

	const usedSlugs = new Set<string>();
	const takeSlug = (first: string, last: string): string => {
		let slug = slugify(first, last);
		let n = 2;
		while (usedSlugs.has(slug)) slug = `${slugify(first, last)}${n++}`;
		usedSlugs.add(slug);
		return slug;
	};

	interface P {
		id: string;
		name: string;
		booking?: string;
	}
	const persons: P[] = [];
	const nonAccepted: string[] = [];

	for (const r of rows) {
		const first = (r.name || "").trim();
		const last = (r.surname || "").trim();
		const full = (first + " " + last).trim() || "Unknown Guest";
		const slug = takeSlug(first, last);
		persons.push({
			id: slug,
			name: full,
			booking: (r.booking_id || "").trim(),
		});
		if ((r.status || "").trim() !== "Accepted") nonAccepted.push(full);
	}

	const coupleSlugs = COUPLE.map((c) => {
		const slug = takeSlug(c.first, c.last);
		persons.push({ id: slug, name: `${c.first} ${c.last}` });
		return slug;
	});

	// Relations: a clique per booking_id, plus the wedding couple.
	const byBooking = new Map<string, string[]>();
	for (const p of persons) {
		if (!p.booking) continue;
		const arr = byBooking.get(p.booking) ?? [];
		arr.push(p.id);
		byBooking.set(p.booking, arr);
	}
	interface Rel {
		a: string;
		b: string;
		w: number;
	}
	const rels: Rel[] = [];
	let groupsUsed = 0;
	for (const [, ids] of byBooking) {
		if (ids.length < 2) continue;
		groupsUsed++;
		for (let i = 0; i < ids.length; i++)
			for (let j = i + 1; j < ids.length; j++)
				rels.push({ a: ids[i]!, b: ids[j]!, w: BOOKING_WEIGHT });
	}
	rels.push({ a: coupleSlugs[0]!, b: coupleSlugs[1]!, w: COUPLE_WEIGHT });

	// Default table layout: round tables sized from the headcount.
	const count = persons.length;
	const nTables = Math.max(1, Math.ceil(count / 8));
	const totalMin = TABLE_MIN * nTables;
	const min =
		totalMin > count ? Math.max(1, Math.floor(count / nTables)) : TABLE_MIN;

	// Emit clean YAML (flow sequences for `between`, block style elsewhere).
	const L: string[] = [];
	L.push("---");
	L.push(`# Generated from ${csvPath} by scripts/gen-from-csv.ts.`);
	L.push(
		`# ${count} guests, ${rels.length} relations (${groupsUsed} booking groups + wedding couple).`,
	);
	L.push(
		`# Weights: booking group = ${BOOKING_WEIGHT}, wedding couple = ${COUPLE_WEIGHT}.`,
	);
	L.push(
		`# Table layout is a default guess (${nTables} round tables, ${min}-${TABLE_MAX} each) -- adjust to your venue.`,
	);
	L.push("");
	L.push("persons:");
	for (const p of persons) L.push(`  - id: ${p.id}\n    name: ${p.name}`);
	L.push("");
	L.push("relations:");
	for (const r of rels)
		L.push(`  - between: [${r.a}, ${r.b}]\n    weight: ${r.w}`);
	L.push("");
	L.push("tables:");
	for (let i = 0; i < nTables; i++)
		L.push(
			`  - id: t${i + 1}\n    name: Table ${i + 1}\n    min: ${min}\n    max: ${TABLE_MAX}`,
		);
	L.push("");
	L.push("settings:");
	L.push("  timeLimitSeconds: 60");
	L.push("  gap: 0");
	L.push("");

	writeFileSync(outPath, L.join("\n"));

	console.log(
		`persons:  ${count} from CSV + couple${nonAccepted.length ? ` (non-Accepted: ${nonAccepted.join(", ")})` : ""}`,
	);
	console.log(
		`groups:   ${groupsUsed} booking groups (${[...byBooking.values()]
			.filter((g) => g.length >= 2)
			.map((g) => g.length)
			.join("+")})`,
	);
	console.log(`relations:${rels.length} (booking cliques + couple)`);
	console.log(
		`tables:   ${nTables} x ${min}-${TABLE_MAX} (total ${min * nTables}-${TABLE_MAX * nTables} seats for ${count} guests)`,
	);
	console.log(`wrote ${outPath}`);
}

main();
