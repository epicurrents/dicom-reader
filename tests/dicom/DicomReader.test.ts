/**
 * Unit tests for DicomReader's cache bridge: `setupStudy` populates the inherited data-unit fields
 * the base class drives its cache off, and `_updateCache` inserts the decoded signals before
 * announcing that it has.
 *
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { DicomDataset, DicomWaveformSequence } from '../../src/types'

vi.mock('scoped-event-log', () => ({
    Log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@epicurrents/core', () => ({
    GenericBiosignalHeader: class {},
    GenericSignalReader: class {
        SETTINGS: { app: { dataChunkSize: number } }
        protected _authHeader = ''
        protected _cache: { insertSignals: (part: unknown) => Promise<void> } | null = null
        protected _chunkUnitCount = 0
        protected _dataUnitCount = 0
        protected _dataUnitDuration = 0
        protected _dataUnitSize = 0
        protected _decoder: unknown = null
        protected _discontinuous = false
        protected _header: unknown = null
        protected _totalDataLength = 0
        protected _totalRecordingLength = 0
        protected _url = ''
        protected _updateCallback: ((update: Record<string, unknown>) => void) | null = null
        constructor (_encoding: unknown) {
            this.SETTINGS = { app: { dataChunkSize: 1024*1024 } }
        }
        setUpdateCallback (callback: ((update: Record<string, unknown>) => void) | null) {
            this._updateCallback = callback
        }
    },
}))

vi.mock('@epicurrents/core/util', () => ({
    getSignalScale: () => 1,
    secondsToTimeString: (seconds: number) => `${seconds}s`,
}))

/** The dataset `dcmjs` is made to return for the file under test. */
let parsed: DicomDataset | null = null
const readFile = vi.fn(() => ({ dict: {}, meta: {} }))
vi.mock('dcmjs', () => ({
    data: {
        DicomMessage: { readFile: (...args: unknown[]) => readFile(...(args as [])) },
        DicomMetaDictionary: { naturalizeDataset: () => parsed },
    },
}))

import { Log } from 'scoped-event-log'
import DicomReader from '../../src/dicom/DicomReader'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The reader's inherited fields are protected; the tests read them as the base class stores them. */
const fields = (reader: DicomReader) => reader as unknown as Record<string, any>

const waveform = (overrides: Partial<DicomWaveformSequence> = {}): DicomWaveformSequence => {
    const channelCount = overrides.NumberOfWaveformChannels ?? 2
    const sampleCount = overrides.NumberOfWaveformSamples ?? 1000
    return {
        ChannelDefinitionSequence: [
            { ChannelLabel: 'EEG Fp1', ChannelSourceSequence: [{ CodeMeaning: 'Fp1' }], WaveformBitsStored: 16 },
            { ChannelLabel: 'EEG Fp2', ChannelSourceSequence: [{ CodeMeaning: 'Fp2' }], WaveformBitsStored: 16 },
        ],
        NumberOfWaveformChannels: 2,
        NumberOfWaveformSamples: 1000,
        SamplingFrequency: 100,
        WaveformBitsAllocated: 16,
        WaveformData: [new Int16Array(channelCount*sampleCount).buffer],
        WaveformOriginality: 'ORIGINAL',
        WaveformSampleInterpretation: 'SS',
        ...overrides,
    }
}

const dataset = (waveformOverrides: Partial<DicomWaveformSequence> = {}): DicomDataset => {
    return {
        AcquisitionDateTime: '20250131143005',
        InstanceNumber: 1,
        Modality: 'EEG',
        PatientID: 'patient-1',
        StudyID: 'study-1',
        WaveformSequence: [waveform(waveformOverrides)],
    }
}

const sourceFile = () => new File([new Uint8Array([1, 2, 3])], 'study.dcm')

beforeEach(() => {
    vi.clearAllMocks()
    // `clearAllMocks` forgets calls but keeps implementations, so the parse failure one test installs
    // would otherwise fail every test after it.
    readFile.mockImplementation(() => ({ dict: {}, meta: {} }))
    parsed = dataset()
})

describe('setupStudy', () => {

    test('populates the data unit shape the base class caches by', async () => {
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        expect(await reader.setupStudy({ file: sourceFile() })).toEqual(true)
        // One-second data units, as the other non-streaming readers use.
        expect(fields(reader)._dataUnitDuration).toEqual(1)
        // The cached Float32 footprint of a second: 100 Hz over two channels.
        expect(fields(reader)._dataUnitSize).toEqual(100*2*4)
        expect(fields(reader)._dataUnitCount).toEqual(10)
        expect(fields(reader)._discontinuous).toEqual(false)
        // Without these the base class refuses to read any part of the recording.
        expect(fields(reader)._header).not.toBeNull()
        expect(fields(reader)._decoder).not.toBeNull()
    })

    test('reports the true recording length while padding the cache extent', async () => {
        // 3201 samples at 100 Hz is 32.01 s of data held in a 33 s cache, because the mutex stores
        // its range end as an Int32. Reporting the padded length advertises a tail with no data in it.
        parsed = dataset({ NumberOfWaveformSamples: 3201 })
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        expect(await reader.setupStudy({ file: sourceFile() })).toEqual(true)
        expect(fields(reader)._totalDataLength).toEqual(33)
        expect(fields(reader)._totalRecordingLength).toBeCloseTo(32.01, 10)
    })

    test('keeps the two lengths equal when the data ends on a whole second', async () => {
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        await reader.setupStudy({ file: sourceFile() })
        expect(fields(reader)._totalDataLength).toEqual(10)
        expect(fields(reader)._totalRecordingLength).toEqual(10)
    })

    test('refuses a dataset with no waveform data', async () => {
        parsed = dataset({ WaveformData: [] })
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        expect(await reader.setupStudy({ file: sourceFile() })).toEqual(false)
        expect(Log.error).toHaveBeenCalled()
    })

    test('refuses a waveform that does not describe itself', async () => {
        parsed = dataset({ SamplingFrequency: 0 })
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        expect(await reader.setupStudy({ file: sourceFile() })).toEqual(false)
    })

    test('resolves false instead of rejecting when the file cannot be parsed', async () => {
        // A rejection here would leave the worker commission without a reply, and it would hang.
        readFile.mockImplementation(() => {
            throw new Error('not a DICOM file')
        })
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        await expect(reader.setupStudy({ file: sourceFile() })).resolves.toEqual(false)
        expect(Log.error).toHaveBeenCalled()
    })

    test('refuses a source that is neither a file nor a URL', async () => {
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        expect(await reader.setupStudy({})).toEqual(false)
    })

    test('sends the authorization header with a URL fetch and keeps it for later reads', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
            ok: true,
            status: 200,
        })
        vi.stubGlobal('fetch', fetchMock)
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        expect(await reader.setupStudy({ authHeader: 'Bearer token', url: 'https://host/study.dcm' })).toEqual(true)
        const headers = fetchMock.mock.calls[0][1].headers as Headers
        expect(headers.get('Authorization')).toEqual('Bearer token')
        expect(fields(reader)._authHeader).toEqual('Bearer token')
        expect(fields(reader)._url).toEqual('https://host/study.dcm')
        vi.unstubAllGlobals()
    })

    test('refuses a URL the server does not serve', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        expect(await reader.setupStudy({ url: 'https://host/missing.dcm' })).toEqual(false)
        vi.unstubAllGlobals()
    })
})

describe('_updateCache', () => {

    const preparedReader = async () => {
        const reader = new DicomReader({ app: { dataChunkSize: 1024*1024 } } as any)
        await reader.setupStudy({ file: sourceFile() })
        return reader
    }

    test('inserts the signals before announcing that the cache was updated', async () => {
        // Every cache implementation writes asynchronously, so announcing first lets a consumer read
        // the range before the samples are in it.
        const order = [] as string[]
        let releaseInsert = () => {}
        const reader = await preparedReader()
        fields(reader)._cache = {
            insertSignals: vi.fn(() => {
                order.push('insert')
                return new Promise<void>(resolve => {
                    releaseInsert = () => {
                        order.push('inserted')
                        resolve()
                    }
                })
            }),
        }
        reader.setUpdateCallback(() => {
            order.push('announce')
        })
        const cached = reader.cacheSignals()
        await Promise.resolve()
        expect(order).toStrictEqual(['insert'])
        releaseInsert()
        expect(await cached).toEqual(true)
        expect(order).toStrictEqual(['insert', 'inserted', 'announce'])
    })

    test('inserts a part that ends at the true data extent, not at the padded cache extent', async () => {
        parsed = dataset({ NumberOfWaveformSamples: 3201 })
        const reader = await preparedReader()
        const insertSignals = vi.fn().mockResolvedValue(undefined)
        fields(reader)._cache = { insertSignals }
        expect(await reader.cacheSignals()).toEqual(true)
        const part = insertSignals.mock.calls[0][0]
        expect(part.start).toEqual(0)
        expect(part.end).toBeCloseTo(32.01, 10)
        expect(part.signals).toHaveLength(2)
        expect(part.signals[0].samplingRate).toEqual(100)
        expect(part.signals[0].data).toBeInstanceOf(Float32Array)
    })

    test('reports the annotations and the range through the update callback', async () => {
        parsed = dataset()
        parsed.WaveformAnnotationSequence = [{
            ReferencedTimeOffsets: [1.5],
            ReferencedWaveformChannels: [1, 0],
            TemporalRangeType: 'POINT',
            UnformattedTextValue: 'Marker',
        }]
        const reader = await preparedReader()
        fields(reader)._cache = { insertSignals: vi.fn().mockResolvedValue(undefined) }
        const update = vi.fn()
        reader.setUpdateCallback(update)
        await reader.cacheSignals()
        expect(update).toHaveBeenCalledTimes(1)
        const announced = update.mock.calls[0][0]
        expect(announced.action).toEqual('cache-signals')
        expect(announced.success).toEqual(true)
        expect(announced.range).toStrictEqual([0, 10])
        expect(announced.events).toHaveLength(1)
        expect(announced.events[0].value).toEqual('Marker')
        expect(announced.interruptions).toStrictEqual([])
    })

    test('fails without a cache to insert into', async () => {
        const reader = await preparedReader()
        fields(reader)._cache = null
        expect(await reader.cacheSignals()).toEqual(false)
        expect(Log.error).toHaveBeenCalled()
    })
})
