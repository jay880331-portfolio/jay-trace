# Regression Fixtures

Frozen, S3-shaped documents plus `expected` assertions that validate JayTrace CLI
behavior (join by `traceId`, AI prompt building, and `--list` flags like
`screenshots=missing` / platform filtering) **without any live devices, collector,
console, or S3**.

## Layout

```
regression/
├── scenarios/
│   ├── offline-reconnect.json      # SDK buffer survives an offline window, then flushes
│   ├── minified-stack.json         # minified web error joins backend 500 by traceId + release tag
│   └── mobile-no-screenshot.json   # flutter replay with event timeline but no image frames
└── run-regression.mjs              # dependency-free runner (node builtins + @jaytrace/cli only)
```

Each scenario file is the exact `{ scenario, input, expected }` block from
`architecture-final-spec.md` → "Regression Dataset". The `input[].document` bodies
match the exported S3 document shape; the `expected` block is the ground-truth
assertion set that rides alongside the mock documents.

## How it works

For each scenario the runner writes every `input[].document` into a temp dir laid
out like S3 (`prod/2026/07/01/<traceId>/<file>`), then calls the **real** CLI API —
`collectTraceFiles` → `joinTraces` → `createAnalysisPrompt` — and asserts every
`expected` field against the CLI output (plus a couple of small pure derivations
that operate on the joined trace, proving the pipeline preserves the data). It
prints per-scenario PASS/FAIL with the specific failing assertion and exits `0`
only when all three scenarios pass.

## Run

```bash
pnpm build            # emits packages/cli/dist (required — the runner imports @jaytrace/cli)
pnpm test:regression  # node regression/run-regression.mjs
```

`pnpm check` runs `test:regression` automatically, after `pnpm build`.
