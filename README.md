# table-seat-planner

A small CLI that finds the **optimal** seating plan for a wedding (or any
event) from a YAML description of the guests, their weighted relationships, and
the tables. It models the problem as a mixed-integer program and solves it with
[GLPK](https://www.gnu.org/software/glpk/) (via [`glpk.js`](https://www.npmjs.com/package/glpk.js)),
so it can **prove** the result is optimal rather than just guess.

## Install

```sh
bun install
```

## Quick start

```sh
bun run src/index.ts examples/wedding.example.yaml
bun run src/index.ts examples/wedding.example.yaml --debug
```

## Config format

The config is a YAML file with five sections (`settings` and `fixedTables` are optional):

```yaml
persons:          # every guest; `id` is the handle used in relations
  - id: alice
    name: Alice Anderson
  - id: bob
    name: Bob Brown

relations:        # optional; undirected, weighted pairs
  - between: [alice, bob]     # weight semantics ↓
    weight: 10
  - between: [alice, carol]
    weight: -5                # negative = keep them apart

tables:           # each table needs a max; min defaults to 0
  - id: top
    name: Top Table
    min: 6
    max: 8

fixedTables:      # optional; pre-allocate guests to tables (excluded from optimization)
  - tableId: top
    persons:
      - alice
      - bob
      - carol

settings:         # optional; overridable by CLI flags
  timeLimitSeconds: 30
  gap: 0
```

### Weight semantics

- **positive** (`> 0`): want them seated **together** (higher = stronger)
- **negative** (`< 0`): want them seated **apart** (more negative = stronger)
- omitted / `0`: indifferent

Only the relative scale of the weights matters. Relations are undirected, so
`between: [alice, bob]` and `between: [bob, alice]` are the same (listing both
adds the weights). The objective the solver maximises is the sum of weights over
pairs that end up at the same table.

### Fixed tables

The `fixedTables` section allows you to pre-allocate guests to specific tables.
These guests and tables are excluded from the optimization, which is useful when:

- Some tables are already assigned (e.g., head table, family tables)
- You want to manually control certain assignments while optimizing the rest
- Running incremental optimizations after manual adjustments

**Rules for fixed tables:**
- All person IDs must exist in the `persons` section
- All table IDs must exist in the `tables` section
- Each person can only be assigned to one fixed table (no duplicates)
- Fixed table assignments must respect each table's `min` and `max` capacity

**Example:**
```yaml
fixedTables:
  - tableId: head
    persons: [bride, groom, parents, family_member1, family_member2]
  - tableId: family_a
    persons: [uncle1, aunt1, cousin1, cousin2]
```

The solver will only optimize seating for guests not listed in `fixedTables`,
and only use tables not referenced in `fixedTables`. Relations involving fixed
guests are still evaluated in the final score, but not used for optimization decisions.

## CLI options

```sh
seat-plan <config> [options]

  -d, --debug             explain the solution in detail
  -t, --time-limit <sec>  max solve time in seconds; 0 = no limit (default 30)
  -g, --gap <ratio>       optimality gap, e.g. 0.02 = 2% (default 0)
```

## Output

By default it prints one block per table with its guests, the total score, and
how many relations were satisfied. With `--debug` it additionally shows the
problem summary, the model size, the solver status, the optimistic upper bound,
every relation's outcome (✓ satisfied / ✗ not, with what was wanted), and a
**Trade-offs** section listing exactly which desired-together pairs were split
and which avoid-pairs were forced together — i.e. *why* the plan is what it is.

### Exit codes

- `0` — proven-optimal plan found
- `1` — bad config or unreadable file
- `2` — no feasible seating exists
- `3` — a plan was found but optimality is **not** proven (time/gap limit hit)

## How it works

For each guest `p` and table `t` there is a binary variable `x[p,t]` (is `p` at
`t`?), and for each relation/table a binary `z[r,t]` (are both ends of relation
`r` at table `t`?). The objective maximises `Σ wᵣ · Σₜ z[r,t]`. Constraints:

- every guest is seated at exactly one table;
- each table's guest count stays within its `[min, max]`;
- `z[r,t]` is linked to `x` via the standard AND-linearisation, so the relation
  weight is counted exactly when the two guests share a table.

Because every person sits at exactly one table, `Σₜ z[r,t]` is `0` or `1`, i.e.
the indicator "these two share a table" — so positive and negative weights are
both handled correctly.

## Notes

- Color is on by default for a terminal and off when output is piped.
  Set `NO_COLOR=1` to force it off.
- For very large weddings (hundreds of guests), proving true optimality may
  take a while. Raise `--time-limit` (or use `0` for unlimited), or relax
  `--gap` slightly to accept a near-optimal plan faster.
