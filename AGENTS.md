# @epicurrents/dicom-reader — architecture notes for AI coding assistants

This file is the entry point for AI coding assistants working in the `@epicurrents/dicom-reader` package: a reader for DICOM waveform instances. It is tool-agnostic.

The package follows the reader pattern that [edf-reader's AGENTS.md](../edf-reader/AGENTS.md) documents as the reference implementation — the same `src/` layout, the same importer / reader / worker / substitute decomposition and the same worker-bundle contract. Read that file for the shared pattern; this file covers only what DICOM adds, and [README.md](README.md) carries the format notes and the public surface.

## Toolchain compliance — HIGH PRIORITY

This package depends on `@epicurrents/core` and shares a single toolchain with it. **Never pin package-specific versions that diverge from the canonical set** — a divergent TypeScript produces structurally incompatible `.d.ts` files that type-check locally but corrupt data at runtime, because the worker bundle and the main-thread code can then disagree on data layouts while everything still compiles.

| Tool | Version |
|---|---|
| `@epicurrents/core` | `^2.0.0` |
| TypeScript | `^5.7.0` |
| Vite | `^7.3.1` |
| ESLint | `^9.19.0`, flat config in [eslint.config.mjs](eslint.config.mjs) |
| tsconfig base | extends `@epicurrents/core/tsconfig.base.json` |

Both build outputs must be regenerated together after any shared-code change: `dist/` carries the worker inlined and `umd/` holds the standalone bundle, so rebuilding one leaves a mismatch the type system cannot see.

The core version appears in `devDependencies`, `peerDependencies` and in the APIs the source actually calls, and the three must agree. The workspace symlinks core rather than installing it, so a stale range builds perfectly against whatever is checked out and only an external consumer sees the mismatch. Bump the range in the same commit as any change that depends on a new core API.

`dcmjs` is the one real runtime dependency. It is a `dependency` rather than a peer so a consumer gets it automatically, and it stays external in `dist/` while being bundled into the worker, which resolves no bare specifiers of its own.

## The types describe the standard, not one file

[src/types/index.ts](src/types/index.ts) is written from DICOM PS3.3 — the waveform module in C.10.9, waveform annotation in C.10.10, temporal coordinates in C.18.7 and the code sequence macro in 8.1 — and each declaration cites the section it came from. **Do not widen or narrow an attribute's optionality from what a sample file happens to contain.** The types were originally inferred from a single example instance, and every field that file happened to carry was declared required; the crashes that followed were all in the gap between that and the standard.

The rule: type 1 attributes are declared required, type 1C, 2 and 3 optional. A type 2 attribute is present in a conforming instance but may be empty, and a type 1C attribute's condition is what the docstring records.

## Two dcmjs naturalization traps shape everything

`DicomMetaDictionary.naturalizeDataset` is not a straight rename of tags to keywords, and both of its quirks have produced bugs here.

**An empty type 2 attribute becomes `null`, not an empty string.** So `dataset.PatientID` is `string | null | undefined`, and anything that reaches for a string method on one throws. Guard with `|| ''` at the point of use; the biosignal header requires strings and will not take null.

**A single-valued attribute is unwrapped to a bare value.** An attribute the standard allows several values for arrives as a scalar when the instance carries one, which is why `ReferencedTimeOffsets` and friends are typed `number | number[]`. Normalise through `asArray` in [src/util.ts](src/util.ts) before touching one — the original conversion assigned the attribute straight to a numeric `start`, which silently produced an array where a number belonged.

A single-*item* sequence is the exception: `dcmjs` leaves the array in place and copies the item's properties onto it, so indexing a sequence with `[0]` is always safe.

`dcmjs` ships no type declarations, and [src/types/dcmjs.shim.d.ts](src/types/dcmjs.shim.d.ts) deliberately declares only the slice this package uses rather than the bare module. Declaring the module types the whole library as `any`, which is how a promise reached `readFile` in place of a buffer and type-checked. **Do not replace it with `declare module 'dcmjs'`**; extend it instead when a new call site needs more.

## Three spec details that fail silently

Each of these is a value the compiler cannot check and a rendered recording will not obviously contradict, so each has a test naming it.

**The pass band edges are named after the band, not the filter.** `FilterLowFrequency` is the *low edge of the pass band*, which is the **high-pass** cutoff, and `FilterHighFrequency` is the **low-pass** one. The standard's own notes say so. Mapping them across by name inverts every channel's prefiltering.

**The channel baseline is added, not subtracted.** It is "the offset of encoded sample Value 0 from actual 0", expressed in the units of `ChannelSensitivityUnitsSequence` — physical units, so the formula is `sample × sensitivity × correction + baseline`, which is what pydicom applies too.

**Sample width comes from the interpretation, not from a constant.** `WaveformSampleInterpretation` fixes both width and signedness, and `WaveformBitsAllocated` must agree with it. Viewing every buffer as `Int16Array` reads 8-bit data as merged pairs of bytes and 32-bit data as split halves, producing plausible garbage.

## Annotation conversion is one-to-many

One DICOM annotation can yield several biosignal events or none, so the output of `eventsToBiosignalEvents` does not correspond index for index with its input. `MULTIPOINT` and `MULTISEGMENT` carry several positions, an annotation placed only by absolute datetime yields none, and an annotation with no temporal range type covers the whole recording.

Events carry the text in `value`, which is the required raw value of an annotation; `label` only overrides it in listings. The old conversion set `label` alone behind an `as` cast, so the required field was simply absent at run time — a reminder that a cast on an object literal here hides missing properties rather than checking them.

## Two lengths, derived differently

`_totalDataLength` and `_totalRecordingLength` answer different questions. The cache extent is padded up to whole one-second data units, because the mutex stores its range end as an `Int32` and an insert crossing the truncated boundary trips an out-of-bounds warning. The reported extent is `sampleCount / samplingRate`, the true data extent, which may end mid-unit.

Reporting the padded length as the recording length advertises a phantom partial-second tail. The same split is documented at greater length in [csv-reader's AGENTS.md](../csv-reader/AGENTS.md); a test asserting one against the other's value is asserting the bug.

`setupStudy` also has to populate `_header`, `_dataUnitDuration`, `_dataUnitSize`, `_dataUnitCount` and `_chunkUnitCount`. The base class refuses to read any part of a recording without them, so leaving them unset limits the reader to the load-everything-at-once path it happens to take today.

## The cache is written asynchronously

Every cache implementation's `insertSignals` returns a promise — the mutex-backed one takes a lock — so `_updateCache` must await it **before** announcing the update through the callback. Announcing first lets a consumer act on the notification and read the range before the samples are in it, which is a race that shows up as intermittently empty signals under the `SharedArrayBuffer` path and never under the fallback.

## The worker and the substitute run the same handlers

`DicomWorker` extends core's `SignalReaderWorker` and `DicomWorkerSubstitute` extends core's `SignalReaderWorkerSubstitute`, which runs those same handlers on the main thread with the reply transport redirected. What each adds is `setup-worker`, the one commission where formats differ because it is where the file is opened. **Those two method bodies are identical and must stay so.** Write the handler against `this._validate`, `this._success` and `this._failure`, which both bases provide with the same signatures, and it can be moved between them unchanged.

A validation failure returns `false` rather than calling `this._failure`: `_validate` has already replied, and failing again answers the same commission twice.

`DicomImporter` wires `_getWorkerSubstitute` and honours the `'substitute'` override in `getFileTypeWorker`, which is how core's own fallback obtains one. Note that this is not the only route: the builder and the platform both construct a substitute themselves inside a `setWorkerOverride('eeg', …)` factory, choosing between it and the real worker on whether shared memory is available. So the importer's own substitute wiring has no downstream caller today, and breaking it fails quietly.

`getFileTypeWorker` registers the worker it constructs itself with `Log.registerWorker` and leaves an override's product alone, as [edf-reader](../edf-reader) does. Neither choice decides whether a worker's log messages reach the application. Core's `GenericService` constructor registers every non-shared worker it is handed, `Log.registerWorker` is idempotent, and the worker this method returns is passed into a service by the study loader — so the relay is core's doing and the reader-side call only covers a worker that has not reached a service yet. A substitute is registered the same way and implements `addEventListener` for the purpose.

The one path that relays nothing is a shared worker, which arrives at the service as a `MessagePort` and is not registered. This reader does not use one.

## Internal path aliases

Two alias tables have to agree, and they are not written the same way. [tsconfig.json](tsconfig.json) maps `#*` to `src/*` — a wildcard, so any name resolves. `ALIASES` in [vite.shared.mjs](vite.shared.mjs) enumerates the directories in a regular expression, because the package declares no `imports` field and an unlisted alias has nothing to fall through to.
