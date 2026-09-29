# @epicurrents/dicom-reader

DICOM waveform reader for Epicurrents. It reads the biosignal waveform IODs — EEG, ECG, EMG and the other multiplex-group formats built on the [Waveform module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.10.9.html) — and presents them to the application as an ordinary signal study.

Parsing the DICOM container itself is [dcmjs](https://github.com/dcmjs-org/dcmjs)'s job. What this package adds is the step from a parsed dataset to a biosignal recording: the channel descriptors, the calibration, the annotations and the cache layout.

## Public surface

| Export | Role |
|---|---|
| `DicomImporter` | Opens a `.dcm` source, populates `study.meta` and hands out the worker. This is what the application calls. |
| `DicomReader` | Decodes the study inside the worker and fills the signal cache. |
| `DicomDecoder` | Turns a parsed dataset's interleaved samples into per-channel signals. Usable on its own. |
| `DicomDatasetRecord` | A biosignal header built from a dataset, carrying the decoded signals where there are any. |
| `DicomWorkerSubstitute` | Runs the reader on the main thread where `SharedArrayBuffer` is unavailable. |

The utilities in [src/util.ts](src/util.ts) are internal: the package entry point exports the five classes above and nothing else.

## What it reads

A DICOM waveform instance holds its samples in one or more **multiplex groups**, each a set of channels sharing a sampling frequency, with their samples interleaved one sample of every channel at a time. This reader reads the **first** group of an instance, which is what the biosignal IODs use; an instance with several groups is read as though it carried only the first.

Sample widths follow the instance's `WaveformSampleInterpretation`. The linear forms are supported at their own widths — `SB`/`UB` at 8 bits, `SS`/`US` at 16, `SL`/`UL` at 32. The two companded 8-bit forms, `MB` and `AB`, are G.711 mu-law and A-law and have to be expanded rather than read, and the 64-bit forms do not fit a JavaScript number; an instance using any of them is refused rather than misread.

Samples are normalised to the SI unit of their quantity on decode, so a channel recorded in microvolts is cached in volts — the same convention every reader in the family follows. The unit each channel reports stays as the file wrote it, because that is what a consumer displays the signal against.

Calibration follows the standard's formula, `sample × ChannelSensitivity × ChannelSensitivityCorrectionFactor + ChannelBaseline`. These attributes are conditional: a channel whose samples carry no defined unit has none of them, and its samples are passed through unscaled.

## Annotations

`WaveformAnnotationSequence` is optional, and most recordings omit it. Where it is present, each annotation becomes one or more biosignal events, because DICOM's temporal range types are not all single instants: a `POINT` is one event, a `SEGMENT` is one event with a duration, and `MULTIPOINT` and `MULTISEGMENT` are several. An annotation with no temporal range type applies to the whole recording.

An annotation is placed by time offset or by sample position; one placed only by absolute datetime is dropped, since relating an absolute time to the start of the data needs a synchronised acquisition. Annotations referring to a specific channel carry that channel's label.

## Building

```bash
npm run build          # build:workers then build:tsc — produces BOTH outputs
npm run build:workers  # vite → umd/dicom.worker.js, the standalone bundle
npm run build:tsc      # vite + epicurrents-build-types → dist/, carrying the worker inlined
npm run lint           # eslint src
npm test               # vitest run --coverage
```

`dist/` inlines the worker as a Blob, which needs `worker-src blob:` in the consumer's content security policy. A consumer that cannot grant it serves [umd/dicom.worker.js](umd) instead and registers a URL-based factory, which takes precedence over the inlined default.

The inlined worker carries its own copy of dcmjs and is correspondingly large. Consumers who load the reader but never open a DICOM file still pay for it, which is the trade for a worker that resolves nothing at run time.
