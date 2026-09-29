/**
 * Unit tests for DicomImporter — the entry point a `.dcm` source is loaded through. What it owes its
 * caller is a populated `study.meta`, which the resource wrapping the study reads at construction,
 * before any worker has run.
 *
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { DicomChannelDefinitionSequence, DicomDataset, DicomWaveformSequence } from '../../src/types'

vi.mock('scoped-event-log', () => ({
    Log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), registerWorker: vi.fn(), warn: vi.fn() },
}))

// The inlined worker bundle is produced by the build, so the test stands in for it. Constructing one
// is all `getFileTypeWorker` does with it.
vi.mock('../../src/workers/dicom.worker.ts?worker&inline', () => ({
    default: class InlineWorkerStub {},
}))

vi.mock('@epicurrents/core', () => ({
    GenericBiosignalHeader: class {},
    // Reached through the substitute the importer wires up.
    GenericSignalReader: class {
        SETTINGS: unknown
        constructor (_encoding: unknown) {
            this.SETTINGS = { app: { dataChunkSize: 1024*1024 } }
        }
        setUpdateCallback () {}
    },
    GenericStudyImporter: class {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        protected _study: any = { files: [], meta: {} }
        protected _workerOverrides = new Map<string, (() => Worker) | null>()
        protected _getWorkerSubstitute: (() => Worker) | null = null
        protected _fetchArrayBuffer = vi.fn()
        constructor (
            public name: string,
            public modalities: string[],
            public fileTypes: any[],
        ) {}
    },
    SignalReaderWorkerSubstitute: class SubstituteStub {
        protected _reader: unknown
        constructor (reader: unknown) {
            this._reader = reader
        }
        extendActionMap () {}
        returnMessage () {}
    },
}))

vi.mock('@epicurrents/core/util', () => ({
    getSignalScale: (unit: string) => (unit.toLowerCase() === 'uv' ? 1e-6 : 1),
    secondsToTimeString: (seconds: number) => `${seconds}s`,
}))

let parsed: DicomDataset | null = null
const readFile = vi.fn((_buffer: unknown) => ({ dict: {}, meta: {} }))
vi.mock('dcmjs', () => ({
    data: {
        DicomMessage: { readFile: (buffer: unknown) => readFile(buffer) },
        DicomMetaDictionary: { naturalizeDataset: () => parsed },
    },
}))

import { Log } from 'scoped-event-log'
import DicomImporter from '../../src/dicom/DicomImporter'

/* eslint-disable @typescript-eslint/no-explicit-any */
const internals = (importer: DicomImporter) => importer as unknown as Record<string, any>

const channel = (overrides: Partial<DicomChannelDefinitionSequence> = {}): DicomChannelDefinitionSequence => {
    return {
        ChannelLabel: 'EEG Fp1',
        ChannelSourceSequence: [{ CodeMeaning: 'Fp1' }],
        WaveformBitsStored: 16,
        ...overrides,
    }
}

const dataset = (
    channels: DicomChannelDefinitionSequence[] = [channel()],
    waveformOverrides: Partial<DicomWaveformSequence> = {}
): DicomDataset => {
    return {
        AcquisitionDateTime: '20250131143005',
        InstanceNumber: 1,
        Modality: 'EEG',
        PatientID: 'patient-1',
        StudyID: 'study-1',
        WaveformSequence: [{
            ChannelDefinitionSequence: channels,
            NumberOfWaveformChannels: channels.length,
            NumberOfWaveformSamples: 1000,
            SamplingFrequency: 100,
            WaveformBitsAllocated: 16,
            WaveformData: [new Int16Array(1000*channels.length).buffer],
            WaveformOriginality: 'ORIGINAL',
            WaveformSampleInterpretation: 'SS',
            ...waveformOverrides,
        }],
    }
}

const sourceFile = () => {
    return {
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
        name: 'study.dcm',
        type: 'application/octet-stream',
    } as unknown as File
}

beforeEach(() => {
    vi.clearAllMocks()
    readFile.mockImplementation(() => ({ dict: {}, meta: {} }))
    parsed = dataset()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:study' })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('importFile', () => {

    test('hands dcmjs the file contents rather than the promise for them', async () => {
        // `readFile` is synchronous, so an unawaited `arrayBuffer()` reached it as a promise and the
        // parse silently produced nothing usable.
        await new DicomImporter().importFile(sourceFile())
        expect(readFile).toHaveBeenCalledTimes(1)
        expect(readFile.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer)
    })

    test('describes the study as a DICOM biosignal', async () => {
        const importer = new DicomImporter()
        await importer.importFile(sourceFile())
        expect(internals(importer)._study.format).toEqual('dicom')
        expect(internals(importer)._study.modality).toEqual('signal')
        expect(internals(importer)._study.meta.header).toBeDefined()
        expect(internals(importer)._study.meta.channels).toHaveLength(1)
    })

    test('maps the DICOM pass band edges onto the right filter kinds', async () => {
        // The low frequency is the high-pass cutoff; swapping them mislabels every channel.
        parsed = dataset([channel({ FilterHighFrequency: 70, FilterLowFrequency: 0.5, NotchFilterFrequency: 50 })])
        const importer = new DicomImporter()
        await importer.importFile(sourceFile())
        const [channelMeta] = internals(importer)._study.meta.channels
        expect(channelMeta.filter.highpass).toEqual(0.5)
        expect(channelMeta.filter.lowpass).toEqual(70)
        expect(channelMeta.filter.notch).toEqual(50)
    })

    test('states the physical bounds in the unit the samples are cached in', async () => {
        parsed = dataset([channel({
            ChannelSensitivity: 2,
            ChannelSensitivityCorrectionFactor: 1,
            ChannelSensitivityUnitsSequence: [{ CodeMeaning: 'microvolt', CodeValue: 'uV' }],
        })])
        const importer = new DicomImporter()
        await importer.importFile(sourceFile())
        const [channelMeta] = internals(importer)._study.meta.channels
        // A signed 16-bit sample spans -32768..32767, at 2 uV per step, cached in volts.
        expect(channelMeta.physicalMax).toBeCloseTo(32767*2e-6, 12)
        expect(channelMeta.physicalMin).toBeCloseTo(-32768*2e-6, 12)
        expect(channelMeta.unit).toEqual('uV')
    })

    test('derives the bounds from the sample width when the equipment does not state them', async () => {
        parsed = dataset([channel()], {
            WaveformBitsAllocated: 8,
            WaveformSampleInterpretation: 'UB',
            WaveformData: [new Uint8Array(1000).buffer],
        })
        const importer = new DicomImporter()
        await importer.importFile(sourceFile())
        const [channelMeta] = internals(importer)._study.meta.channels
        // An unsigned 8-bit sample spans 0..255, and an uncalibrated channel is unscaled.
        expect(channelMeta.physicalMax).toEqual(255)
        expect(channelMeta.physicalMin).toEqual(0)
    })

    test('shifts the bounds by the channel baseline', async () => {
        // The baseline offsets where sample value zero sits, so it moves both ends of the range.
        parsed = dataset([channel({
            ChannelBaseline: 100,
            ChannelMaximumValue: 1000,
            ChannelMinimumValue: -1000,
            ChannelSensitivity: 1,
            ChannelSensitivityCorrectionFactor: 1,
        })])
        const importer = new DicomImporter()
        await importer.importFile(sourceFile())
        const [channelMeta] = internals(importer)._study.meta.channels
        expect(channelMeta.physicalMax).toBeCloseTo(1100, 10)
        expect(channelMeta.physicalMin).toBeCloseTo(-900, 10)
    })

    test('prefers the bounds the equipment states', async () => {
        parsed = dataset([channel({ ChannelMaximumValue: 4095, ChannelMinimumValue: -4096 })])
        const importer = new DicomImporter()
        await importer.importFile(sourceFile())
        const [channelMeta] = internals(importer)._study.meta.channels
        expect(channelMeta.physicalMax).toEqual(4095)
        expect(channelMeta.physicalMin).toEqual(-4096)
    })

    test('releases the samples once the header has been built', async () => {
        // The importer parsed the whole file to reach the metadata; the worker parses it again for
        // itself, so keeping this copy alive would double the recording's footprint.
        const source = dataset()
        parsed = source
        await new DicomImporter().importFile(sourceFile())
        expect(source.WaveformSequence[0].WaveformData).toStrictEqual([])
    })

    test('lists the file on the study once it has parsed', async () => {
        const importer = new DicomImporter()
        const studyFile = await importer.importFile(sourceFile())
        expect(studyFile).not.toBeNull()
        expect(internals(importer)._study.files).toHaveLength(1)
        expect(internals(importer)._study.files[0].format).toEqual('dicom')
    })

    test('lists nothing and answers null when the file cannot be parsed', async () => {
        // A study that lists a file it could not read describes a recording that is not there.
        readFile.mockImplementation(() => {
            throw new Error('not a DICOM file')
        })
        const importer = new DicomImporter()
        expect(await importer.importFile(sourceFile())).toBeNull()
        expect(internals(importer)._study.files).toStrictEqual([])
        expect(Log.error).toHaveBeenCalled()
    })

    test('reports a dataset with no waveform sequence instead of throwing', async () => {
        parsed = { WaveformSequence: [] } as unknown as DicomDataset
        const importer = new DicomImporter()
        await importer.importFile(sourceFile())
        expect(Log.error).toHaveBeenCalled()
    })
})

describe('importUrl', () => {

    test('fetches the whole file and describes it', async () => {
        const importer = new DicomImporter()
        internals(importer)._fetchArrayBuffer.mockResolvedValue(new Uint8Array([1]).buffer)
        const studyFile = await importer.importUrl('https://host/study.dcm')
        expect(studyFile?.url).toEqual('https://host/study.dcm')
        expect(internals(importer)._study.meta.channels).toHaveLength(1)
    })

    test('passes the authorization header on', async () => {
        const importer = new DicomImporter()
        internals(importer)._fetchArrayBuffer.mockResolvedValue(new Uint8Array([1]).buffer)
        await importer.importUrl('https://host/study.dcm', { authHeader: 'Bearer token' } as any)
        expect(internals(importer)._fetchArrayBuffer).toHaveBeenCalledWith(
            'https://host/study.dcm',
            { authHeader: 'Bearer token' }
        )
    })

    test('lists nothing and answers null when the fetch fails', async () => {
        const importer = new DicomImporter()
        internals(importer)._fetchArrayBuffer.mockRejectedValue(new Error('offline'))
        expect(await importer.importUrl('https://host/study.dcm')).toBeNull()
        expect(internals(importer)._study.files).toStrictEqual([])
    })
})

describe('getFileTypeWorker', () => {

    test('answers with the substitute when one is asked for', () => {
        // This is the route core's own fallback takes when shared memory is unavailable. The
        // substitute reads the running application's settings, so it only constructs inside one.
        (window as unknown as Record<string, unknown>).__EPICURRENTS__ = {
            RUNTIME: { SETTINGS: { app: { dataChunkSize: 1024*1024 } } },
        }
        const worker = new DicomImporter().getFileTypeWorker('substitute')
        expect(worker).not.toBeNull()
        delete (window as unknown as Record<string, unknown>).__EPICURRENTS__
    })

    test('prefers a registered override and leaves its registration to its owner', () => {
        const override = { name: 'override' } as unknown as Worker
        const importer = new DicomImporter()
        internals(importer)._workerOverrides.set('dicom', () => override)
        expect(importer.getFileTypeWorker()).toBe(override)
        expect(Log.registerWorker).not.toHaveBeenCalled()
    })

    test('registers the inlined worker it constructs itself', () => {
        const worker = new DicomImporter().getFileTypeWorker()
        expect(worker).not.toBeNull()
        expect(Log.registerWorker).toHaveBeenCalledTimes(1)
    })
})

describe('readHeader', () => {

    test('answers null, DICOM having no header prefix to read ahead of the data', async () => {
        expect(await new DicomImporter().readHeader(new ArrayBuffer(8))).toBeNull()
    })
})
