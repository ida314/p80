# P80 Documentation

| File | What it is |
|---|---|
| [`../README.md`](../README.md) | Start here — what P80 is and how to run it |
| [`SETUP.md`](SETUP.md) | Full setup. **Not just `pnpm install`** — models, dumps, and indexes |
| [`roadmap.md`](roadmap.md) | The fourteen stages and why they are ordered as they are |
| [`contracts/`](contracts/00-README.md) | **Authoritative** — data shapes, schema, endpoints, interfaces, formulas |
| [`decisions/`](decisions/README.md) | ADRs. Why anything is the way it is |
| [`original_spec.md`](original_spec.md) | Original product intent. **Frozen — never edited** |
| `internal/` | Working notes: current status and per-stage build briefs |

## How to read this

Start with the root `README.md`, then `roadmap.md` for the shape of the build.

**Before writing code that touches a data shape, an endpoint, a provider, or a formula, read
the relevant file in `contracts/`.** Those documents are the specification. `original_spec.md`
is the intent behind them, and it is frozen — it records what was *originally intended*,
while `contracts/` records what is *now believed*. Where the two disagree, the contract wins;
the divergence is marked `RESOLVED` inline and backed by an ADR.

Keeping both readable, rather than letting one silently overwrite the other, is deliberate.
It must always be possible to see how the design moved.

## Documentation hygiene

Documentation is portable or it is not documentation. Two consequences, both checked by
`test/docs-hygiene.test.ts` under `pnpm test`:

- **No machine-local paths.** A path that resolves on one contributor's machine is noise to
  everyone else. Name a sibling repository, not a directory on disk; if it is private, say
  so and make the document stand on its own without it.
- **No contact details or real people's names**, including in examples. Use a neutral
  placeholder — a real name in a sample sentence reads as residue from someone's drafting.

Where a specific detail is load-bearing, **abstract it into the property that mattered**
rather than deleting it. *"A 128 GB unified-memory workstation, bandwidth-constrained rather
than capacity-constrained"* explains a decision; a product name does not. A redaction leaves
a hole where an explanation should be.
