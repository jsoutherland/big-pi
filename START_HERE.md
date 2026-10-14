# Start here

## What big-pi is

big-pi is a standalone Pi extension for model-driven conversation compression. It stores block history beside the Pi session transcript, which remains authoritative and unchanged.

## Prerequisites

- Pi is already installed and runs with its supported Node.js runtime.
- big-pi has no additional runtime dependencies.
- The account running Pi can write to its Pi configuration/session locations and to the installation directory during upgrades.
- No minimum Pi or Node.js version is asserted here; use a Pi release that supports local packages and the extension APIs described in [Architecture](docs/ARCHITECTURE.md).

## Verify the release

For a release archive, verify its externally supplied hash before extracting it:

```text
big-pi-0.1.0.zip
big-pi-0.1.0.zip.sha256
```

Compare the SHA-256 value in the `.sha256` file with a trusted, independently approved expected value. The hash detects transfer damage or unexpected modification when compared with that trusted value; it is not a digital signature and does not by itself prove who published the files.

On POSIX systems, from the directory containing both files:

```sh
sha256sum -c big-pi-0.1.0.zip.sha256
```

In Windows PowerShell, calculate the archive hash and compare it with the approved value:

```powershell
(Get-FileHash .\big-pi-0.1.0.zip -Algorithm SHA256).Hash
```

After extraction, verify the package's individual files:

```sh
node verify-release.js
```

The verifier checks each payload file's SHA-256 and size against `RELEASE_MANIFEST.json`, checks that `SHA256SUMS` agrees (including the manifest), and reports missing, modified, or unexpected files. The release manifest excludes itself and `SHA256SUMS` to avoid self-reference; `SHA256SUMS` covers all payload files and the release manifest, but not itself.

## Install from a local directory

Extract or copy the verified package to a permanent location first. Then run the documented Pi local-package command with that directory:

```sh
pi install /opt/big-pi
```

Windows example:

```text
pi install C:\tools\big-pi
```

Pi records the local package path in its settings and loads it from that path; it does not copy the package into Pi's managed package cache. Do not install from a temporary extraction directory that may later disappear. A user-local permanent directory is also suitable when administrator access is unavailable.

The package declares its JavaScript entry point in `package.json` as `pi.extensions: ["./index.js"]`. No target-side `npm install`, npm registry access, TypeScript compiler, or network fetch is required by big-pi's installation.

## First run

Start Pi, then run:

```text
/big-pi status
```

A healthy session reports `State: active` and `Compaction owner: big-pi`. This confirms big-pi is ready to intercept native compaction; it does not mean a native compaction has already occurred. If status is degraded or unavailable, Pi owns native compaction.

## Files and locations

- User configuration: `~/.pi/big-pi.json` (or the path selected by `BIG_PI_CONFIG`).
- Best-effort log: `~/.pi/big-pi.log` (rotation may create `~/.pi/big-pi.log.1`).
- Per-session state: `<session>.jsonl.big-pi/`, adjacent to that session's JSONL transcript.

The Pi JSONL transcript remains authoritative and is never rewritten by big-pi. The session folder contains `manifest.json` and immutable `blocks/` chunk files. The manifest stores stable references, chunk index/relationships, metrics, and cadence; each chunk stores its agent-written summary and source provenance. See the [Pi-vot on-disk contract](README.md#pi-vot-on-disk-contract).

## Basic configuration

Configuration is optional. For example, save this as `~/.pi/big-pi.json`:

```json
{
  "nudge": {
    "mode": "percentage",
    "growthTriggerTokens": 50000,
    "thresholdPercentage": 75,
    "repeatEveryPercentage": 5,
    "display": "used"
  }
}
```

The default is the benchmarking [baseline-config](benchmarks/examples/baseline-config.json)

See [Configuration](docs/CONFIGURATION.md) for settings, defaults, and environment overrides.

## Diagnostics

```text
/big-pi status
/big-pi blocks
/big-pi inspect <block-id>
/big-pi dump-context
```

`status` reports ownership, pressure, nudges, and estimates. `blocks` lists persisted blocks; `inspect` shows one block's provenance and summary. `dump-context` writes a readable projection dump under `~/.pi/big-pi-dumps/`; dumps can contain sensitive session content. See [Diagnostics](docs/DIAGNOSTICS.md).

## Air-gapped deployment

No npm registry access, target-side `npm install`, TypeScript compiler, or network fetch is required as part of big-pi installation.

1. On a connected build machine, run the release build and tests.
2. Record and approve the archive's SHA-256 through your trusted release process.
3. Transfer the archive and adjacent `.sha256` file through the approved mechanism. Ideally transfer/record the expected hash separately from the archive and hash file.
4. Verify the archive hash inside the controlled environment.
5. Extract the release to a permanent local path.
6. Run `node verify-release.js` in the extracted directory.
7. Run `pi install <local-path>`.
8. Start Pi and run `/big-pi status`.

The connected build machine creates the package/archive. The target only needs Pi, Node.js as required by Pi, and the extracted JavaScript package.

## Upgrade

Use a stable package directory, for example `C:\tools\big-pi` or `/opt/big-pi`. A versioned release can first be extracted separately, verified, then safely copied/replaced at the stable location. Do not overwrite an existing package automatically.

For a local package, Pi loads the configured filesystem path directly; it does not reinstall/copy local package contents. With the path unchanged, replacing the package files is the upgrade. Stop Pi before replacing the directory, then start Pi again so the new extension code is loaded; a `pi install` rerun is not required just to refresh the contents. Keep `~/.pi/big-pi.json` and session storage folders separate and preserve them. This storage format does not migrate the previous single-sidecar format.

Recommended sequence: acquire the new release, verify its archive hash, extract separately, run `node verify-release.js`, stop Pi, safely replace the stable package directory, preserve user configuration and session storage folders, start Pi, and confirm `/big-pi status`.

## Uninstall

Remove the configured package path using Pi's supported package command:

```text
pi remove /opt/big-pi
```

`pi uninstall <source>` is an alias for `pi remove <source>`. Use the exact local path recorded in Pi settings (and `--local` if the package was installed into project settings). Removing a local package removes its settings entry; it does not delete the package directory or big-pi user data.

Optional cleanup is separate:

- User configuration: `~/.pi/big-pi.json`
- Logs: `~/.pi/big-pi.log` and optionally its rotated `.1` file
- Session state: matching `*.jsonl.big-pi/` folders

Do not remove session storage folders unless you intend to discard big-pi's compressed block/history state for those sessions. Deleting a storage folder does not delete or rewrite the Pi transcript. Back up any state you may need before cleanup.

## Release contents

The source repository additionally contains maintainer guidance, task tracking, tests, and release scripts. The installable release contains only `package.json`, user documentation, license/changelog, `verify-release.js`, `RELEASE_MANIFEST.json`, `SHA256SUMS`, and the runtime `index.js`/`lib/` files. It excludes `AGENTS.md`, `TASK.md`, tests, scripts, Git metadata, and local state.

Build/stage with `npm run release`. On systems with the `zip` utility, `npm run release:archive` also creates `dist/big-pi-0.1.0.zip` and its adjacent `.sha256` file. The ZIP hash is calculated for each produced archive; ZIP metadata may differ between builds, while staged payload hashes and manifests are deterministic for identical source contents.
