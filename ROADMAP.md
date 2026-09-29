# @epicurrents/dicom-reader — roadmap

Work left open by the first audit pass over this package, which rewrote the types against DICOM PS3.3, corrected the calibration and annotation handling, wired the worker substitute and gave the package its first collected tests. Items are roughly in order of how much they matter.

## No DICOM fixture, so the end-to-end path is unverified

Every test in the package works against synthetic datasets built in memory: a plain object shaped like a naturalized instance, with an `ArrayBuffer` of interleaved samples. That covers the decoding, the conversions and the cache bridge, which is where the defects were, but nothing exercises `dcmjs` itself, and therefore nothing has confirmed that a real `.dcm` file produces the dataset shape these types describe.

This is the largest open risk in the package, and it is the reason several items below are stated as questions rather than fixed. A single small waveform instance committed as a fixture — an EEG one for preference, a few channels and a few seconds — would close it, and would also settle whether the channel-label mapping below is right.

## The reader loads the whole recording rather than reading parts

`DicomReader` overrides `cacheSignals` to decode the entire file in one pass and insert it as a single cache part, where every other reader in the family implements `_readSignalPart` and lets the base class drive a rolling cache. Both work: the whole file is already in memory once `dcmjs` has parsed it, so there is nothing to fetch.

The audit pass populated `_header` and the data-unit fields that the base class requires, so the streaming path is now reachable rather than blocked. Converting to `_readSignalPart` would bring the rolling cache, range requests and polarity correction that come with it for free, and would retire the bespoke `_updateCache` and its update callback. [csv-reader](../csv-reader) is the worked example of that shape for a source that is likewise parsed in full up front. Left as a decision rather than done, because it is a redesign of the reader's central path and there is no fixture to verify it against.

## Only the first multiplex group is read

A DICOM instance may hold several waveform multiplex groups, each with its own channels and sampling frequency, and this reader takes `WaveformSequence[0]` everywhere. The biosignal IODs use a single group, so this is not known to be a live limitation, but an instance with more is read as though it carried only the first, silently.

What to do about it depends on what a second group means in practice — a second recording, or channels at a different sampling rate belonging to the same one. Worth settling before a file that has one turns up.

## Channel skew and offset are not applied

`ChannelSampleSkew`, `ChannelTimeSkew` and `ChannelOffset` displace an individual channel's samples in time relative to the rest of its group. Honouring one means resampling that channel onto the group's grid, which the decoder does not do; it logs a warning and places the samples as though the channels were aligned.

The previous code attempted a partial shift that applied the same offset twice in two different units — once as a sample count and once as seconds — and dropped the leading samples of any skewed channel rather than moving them. Ignoring the skew with a warning is at least coherent. Doing it properly needs interpolation and a view on how much precision the display actually requires.

## Companded and 64-bit sample interpretations are refused

`MB` and `AB` are G.711 mu-law and A-law, which have to be expanded through a lookup rather than read as linear samples, and `SV`/`UV` are 64-bit, which do not fit a JavaScript number without a BigInt round trip. An instance using any of the four is refused with a logged error.

None of them is plausible for a biosignal recording — the companded forms exist for the audio waveform IODs — so this is recorded as a known boundary rather than a gap to close.

## Annotations placed by absolute datetime are dropped

`ReferencedDateTime` places an annotation at an absolute time rather than at an offset into the data. Relating one to the start of the recording needs the acquisition datetime and a synchronised acquisition, and while the instance usually carries `AcquisitionDateTime`, nothing guarantees the two clocks agree unless `AcquisitionTimeSynchronized` says so. Such annotations are dropped with a warning.

Closing this means deciding whether to trust `AcquisitionDateTime` when the synchronisation flag is absent — which is most of the time.

## DICOM codes do not reach the annotation vocabulary

An annotation may carry a coded concept in `ConceptNameCodeSequence` — a code value, a coding scheme designator and a meaning — and the conversion keeps only the meaning, as the event's text. The platform has its own registered annotation vocabularies with a `codes` field on the event template designed to hold exactly this.

Mapping DICOM coding schemes onto those vocabularies is the work, and it belongs with whoever owns the vocabulary rather than with the reader.

## The channel-label mapping is unverified

An annotation referring to specific channels resolves them to channel labels, because `channels` on an event template takes numbers or strings and a label is the one identifier that is stable across a montage. No other reader in the family sets event channels at all — they all pass an empty list — so there is no established convention to follow and nothing has rendered one of these events.

The previous code passed DICOM's raw `ReferencedWaveformChannels` through, which is a flat list of multiplex-group and channel-number *pairs*, so the group numbers were being handed over as though they were channels. The current mapping is at least coherent; whether a consumer resolves it is untested.

## The importer creates an object URL per file and never revokes it

`importFile` stores `URL.createObjectURL(file)` on the study file whenever the caller supplies no URL of its own, and nothing in the family revokes one. The blob it pins stays alive for the life of the document. The reader never reads it back — the parse happens on the buffer already in hand — so the question to settle is whether a study file needs the URL at all, rather than where to revoke it.

This is the same item [csv-reader's roadmap](../csv-reader/ROADMAP.md) carries, and it wants one answer across the readers rather than a local one here.

## The substitute reports a missing application and then dereferences it

`DicomWorkerSubstitute`'s constructor logs an error when `window.__EPICURRENTS__.RUNTIME` is absent and then reads `SETTINGS` off it on the next line, so the log is immediately followed by a `TypeError`. The substitute genuinely cannot work without the running application's settings, so throwing is arguably right and the misleading part is the log.

Every reader's substitute is written this way, so the fix belongs to all of them at once — or to core, which could supply the settings rather than having each substitute reach for the global.

## The worker is untested

`DicomImporter`, `DicomReader`, `DicomDecoder` and the utilities are covered; [src/workers/dicom.worker.ts](src/workers/dicom.worker.ts) is at zero. Its `setup-worker` is character for character the method the substitute registers, and the substitute's path is exercised, so what is left uncovered is the worker's own wiring: that the reader's cache-fill updates are posted, and that the class registers `setup-worker` against the reader it was constructed with.

## dcmjs makes the inlined worker large

The worker bundle is about 1.6 MB, nearly all of it dcmjs, and `dist/` carries it inlined as a source string — so a consumer that loads the reader pays for it whether or not a DICOM file is ever opened. That is the deliberate trade for a worker that resolves nothing at run time, but this package pays far more for it than its siblings.

Whether a lighter path through dcmjs exists — importing the waveform parsing without the whole dictionary — has not been investigated.

## Smaller things

`sensor` on every channel descriptor is the literal `'Unknown'`, though `ChannelSourceSequence` is a required attribute naming the electrode the channel was taken from, and its `CodeMeaning` is what a transducer field wants.

The decoder holds the parsed dataset with its samples *and* the decoded per-channel arrays, so a recording occupies both forms at once while cached. Core's `SignalDecodeResult` declares `signals: number[][]`, so the decoded form is boxed numbers rather than a `Float32Array`, roughly doubling it again; changing that is core's call.

`dicomTimeToTimeString` has no caller. It is the DICOM `TM` counterpart to the `DT` conversion beside it and is kept as a pair with it, but [src/util.ts](src/util.ts) is not re-exported from the package entry point, so nothing outside the package can reach it either.
