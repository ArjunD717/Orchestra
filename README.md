# Orchestra

Orchestra is a local-first agentic coding TUI for running multi-step workflows against a repository.

It keeps workflow definitions, memory, run logs, and config on disk under your Orchestra home directory, while the app itself runs from this repo.

## Features

- Terminal UI for planning, coding, UI work, debugging, and review workflows
- Local workflow builder and editor
- Per-step memory and run history
- RLM-style context packet built from repo state, memory hits, tool history, and prior outputs
- Replayable run artifacts stored on disk

## Requirements

- Node.js 22+ (developed and tested on Node 24)
- npm

Optional provider tooling depends on how you configure Orchestra. For example, the default workflow references the Codex subscription CLI by default.

## Install

```bash
npm install
```

To use the `orchestra` command globally:

```bash
npm run build
npm link
```

## Run

Development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Run built app:

```bash
npm start
```

Or, after `npm link`:

```bash
orchestra
```

## Storage

By default Orchestra stores its data here:

- `~/.orchestra/workflows`
- `~/.orchestra/memory`
- `~/.orchestra/runs`
- `~/.orchestra/config.json`

You can override the base directory with the `ORCHESTRA_HOME` environment variable.

## Workflows

Orchestra creates a default example workflow automatically the first time it initializes its home directory.

The built-in template is defined in `src/paths.ts` and written out to:

- `example.yaml` inside the workflows directory

The default workflow is:

1. `plan`
2. `logic`
3. `ui`
4. `debug`
5. `review`

The review step can restart the workflow with a planner handoff, and Orchestra can also accept a temporary review-generated follow-up workflow.

### Ignoring files

The repo summarizer respects a `.orchestraignore` file in the target repo root.
One pattern per line, `#` comments allowed. Supported forms:

- `path/to/file` — exact relative-path match
- `*.log` — suffix match (anything after the `*` must end the path)

There is no negation (`!keep.log`) and no directory-only (`dir/`) syntax:
patterns are matched literally, not as globs. To exclude a directory,
list the paths explicitly or use a `*dirname` suffix.

## Config

Orchestra reads config from `config.json` in the Orchestra home directory.

Current default provider config includes:

- OpenAI-compatible endpoints
- OpenRouter
- NVIDIA NIM
- Codex API
- Codex subscription CLI
- Claude subscription CLI

## Development Notes

- Entry point: `src/index.ts`
- TUI implementation: `src/ui.ts`
- Runner loop: `src/runner.ts`
- RLM context engine: `src/rlm-context.ts`

## Status

Orchestra is actively being iterated on in this repo, so UI behavior and workflow defaults may continue to change.

## License

No license file is present in this repo yet — all rights reserved by default.
Do not redistribute or reuse this code until a `LICENSE` file is added.
