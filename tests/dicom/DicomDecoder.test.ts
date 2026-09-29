/**
 * Unit tests for DicomDecoder.
 *
 * The calibration formula and the sample width are what these pin down. Both fail silently: a
 * wrong baseline sign or a buffer read at the wrong width produces plausible numbers, and nothing
 * downstream can tell them from the recording.
 *
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { DicomChannelDefinitionSequence, DicomDataset, DicomWaveformSequence } from '../../src/types'

vi.mock('scoped-event-log', () => ({
    Log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@epicurrents/core', () => ({
    GenericBiosignalHeader: class {},
}))

vi.mock('@epicurrents/core/util', () => ({
    // The real conversion, so the SI normalisation is exercised rather than stubbed away.
    getSignalScale: (unit: string) => (unit.toLowerCase() === 'uv' ? 1e-6 : unit.toLowerCase() === 'mv' ? 1e-3 : 1),
    secondsToTimeString: (seconds: number) => `${seconds}s`,
}))

import { Log } from 'scoped-event-log'
import DicomDecoder from '../../src/dicom/DicomDecoder'

type TypedArrayConstructor = {
    new (length: number): { [index: number]: number, buffer: ArrayBuffer }
}

/** Interleave per-channel samples the way a multiplex group stores them. */
const interleave = (samples: number[][], View: TypedArrayConstructor = Int16Array): ArrayBuffer => {
    const channelCount = samples.length
    const sampleCount = samples[0].length
    const array = new View(channelCount*sampleCount)
    for (let i=0; i<sampleCount; i++) {
        for (let j=0; j<channelCount; j++) {
            array[i*channelCount + j] = samples[j][i]
        }
    }
    return array.buffer
}

const channel = (overrides: Partial<DicomChannelDefinitionSequence> = {}): DicomChannelDefinitionSequence => {
    return {
        ChannelSourceSequence: [{ CodeMeaning: 'Fp1' }],
        WaveformBitsStored: 16,
        ...overrides,
    }
}

const dataset = (
    samples: number[][],
    waveformOverrides: Partial<DicomWaveformSequence> = {},
    datasetOverrides: Partial<DicomDataset> = {}
): DicomDataset => {
    const view = (waveformOverrides.WaveformData ? undefined : Int16Array) as TypedArrayConstructor | undefined
    const waveform = {
        ChannelDefinitionSequence: samples.map(() => channel()),
        NumberOfWaveformChannels: samples.length,
        NumberOfWaveformSamples: samples[0].length,
        SamplingFrequency: 10,
        WaveformBitsAllocated: 16,
        WaveformData: [interleave(samples, view)],
        WaveformOriginality: 'ORIGINAL',
        WaveformSampleInterpretation: 'SS',
        ...waveformOverrides,
    } as DicomWaveformSequence
    return {
        AcquisitionDateTime: '20250131143005',
        InstanceNumber: 1,
        Modality: 'EEG',
        WaveformSequence: [waveform],
        ...datasetOverrides,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('sample calibration', () => {

    test('passes an uncalibrated channel through unscaled', () => {
        // The calibration attributes are absent for samples that carry no defined unit.
        const decoded = new DicomDecoder(dataset([[1, -2, 3]])).decodeData()
        expect(decoded?.signals).toStrictEqual([[1, -2, 3]])
    })

    test('applies the sensitivity and its correction factor', () => {
        const decoded = new DicomDecoder(dataset([[10]], {
            ChannelDefinitionSequence: [channel({
                ChannelSensitivity: 2,
                ChannelSensitivityCorrectionFactor: 1.5,
            })],
        })).decodeData()
        expect(decoded?.signals[0][0]).toBeCloseTo(30, 10)
    })

    test('adds the channel baseline rather than subtracting it', () => {
        // The baseline is the offset of sample value zero from actual zero, in the channel's own
        // physical units, so it shifts the scaled sample upwards.
        const decoded = new DicomDecoder(dataset([[10]], {
            ChannelDefinitionSequence: [channel({
                ChannelBaseline: 5,
                ChannelSensitivity: 1,
                ChannelSensitivityCorrectionFactor: 1,
            })],
        })).decodeData()
        expect(decoded?.signals[0][0]).toBeCloseTo(15, 10)
    })

    test('normalises the samples into the SI unit of their quantity', () => {
        const decoded = new DicomDecoder(dataset([[100]], {
            ChannelDefinitionSequence: [channel({
                ChannelSensitivity: 2,
                ChannelSensitivityCorrectionFactor: 1,
                ChannelSensitivityUnitsSequence: [{ CodeMeaning: 'microvolt', CodeValue: 'uV' }],
            })],
        })).decodeData()
        // 100 samples of 2 uV each, cached in volts.
        expect(decoded?.signals[0][0]).toBeCloseTo(2e-4, 12)
    })

    test('replaces a padding sample with zero', () => {
        // Zero keeps a gap flat instead of drawing it as a spike.
        const decoded = new DicomDecoder(dataset([[5, -32768, 7]], {
            WaveformPaddingValue: -32768,
        })).decodeData()
        expect(decoded?.signals).toStrictEqual([[5, 0, 7]])
    })

    test('separates the channels of an interleaved group', () => {
        const decoded = new DicomDecoder(dataset([[1, 2, 3], [10, 20, 30]])).decodeData()
        expect(decoded?.signals).toStrictEqual([[1, 2, 3], [10, 20, 30]])
    })
})

describe('sample interpretation', () => {

    test('reads signed 16-bit samples, negatives included', () => {
        const decoded = new DicomDecoder(dataset([[-32768, 0, 32767]])).decodeData()
        expect(decoded?.signals).toStrictEqual([[-32768, 0, 32767]])
    })

    test('reads unsigned 8-bit samples at their own width', () => {
        // Each interpretation has its own width; reading an 8-bit buffer as Int16 merges byte pairs.
        const decoded = new DicomDecoder(dataset([[1, 200, 255]], {
            WaveformBitsAllocated: 8,
            WaveformData: [interleave([[1, 200, 255]], Uint8Array)],
            WaveformSampleInterpretation: 'UB',
        })).decodeData()
        expect(decoded?.signals).toStrictEqual([[1, 200, 255]])
    })

    test('reads signed 32-bit samples at their own width', () => {
        const values = [[-2147483648, 0, 2147483647]]
        const decoded = new DicomDecoder(dataset(values, {
            WaveformBitsAllocated: 32,
            WaveformData: [interleave(values, Int32Array)],
            WaveformSampleInterpretation: 'SL',
        })).decodeData()
        expect(decoded?.signals).toStrictEqual(values)
    })

    test('refuses a companded interpretation rather than misreading it', () => {
        // Mu-law samples have to be expanded, not read.
        const decoded = new DicomDecoder(dataset([[1, 2]], {
            WaveformBitsAllocated: 8,
            WaveformData: [interleave([[1, 2]], Uint8Array)],
            WaveformSampleInterpretation: 'MB',
        })).decodeData()
        expect(decoded).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    test('assumes the signed form of the width when the interpretation is missing', () => {
        const decoded = new DicomDecoder(dataset([[-5, 5]], {
            WaveformSampleInterpretation: undefined as unknown as 'SS',
        })).decodeData()
        expect(decoded?.signals).toStrictEqual([[-5, 5]])
        expect(Log.warn).toHaveBeenCalled()
    })

    test('refuses data that does not divide into whole samples', () => {
        const decoded = new DicomDecoder(dataset([[1, 2]], {
            WaveformBitsAllocated: 32,
            // Three bytes cannot hold whole 32-bit samples.
            WaveformData: [new ArrayBuffer(3)],
            WaveformSampleInterpretation: 'SL',
        })).decodeData()
        expect(decoded).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })
})

describe('refusals and warnings', () => {

    test('refuses a dataset with no waveform sequence', () => {
        const decoded = new DicomDecoder({ WaveformSequence: [] } as unknown as DicomDataset).decodeData()
        expect(decoded).toBeNull()
    })

    test('refuses a waveform with no data', () => {
        const decoded = new DicomDecoder(dataset([[1]], { WaveformData: [] })).decodeData()
        expect(decoded).toBeNull()
    })

    test('refuses a waveform that does not describe its own data', () => {
        expect(new DicomDecoder(dataset([[1]], { SamplingFrequency: 0 })).decodeData()).toBeNull()
        expect(new DicomDecoder(dataset([[1]], { NumberOfWaveformChannels: 0 })).decodeData()).toBeNull()
    })

    test('refuses data whose length disagrees with the channel count', () => {
        const decoded = new DicomDecoder(dataset([[1, 2, 3]], {
            // Three samples do not divide between two channels.
            NumberOfWaveformChannels: 2,
        })).decodeData()
        expect(decoded).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    test('refuses data whose length disagrees with the declared sample count', () => {
        const decoded = new DicomDecoder(dataset([[1, 2, 3]], {
            NumberOfWaveformSamples: 99,
        })).decodeData()
        expect(decoded).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    test('warns that a declared channel skew is not applied, and still decodes', () => {
        const decoded = new DicomDecoder(dataset([[1, 2]], {
            ChannelDefinitionSequence: [channel({ ChannelSampleSkew: 3 })],
        })).decodeData()
        expect(decoded?.signals).toStrictEqual([[1, 2]])
        expect(Log.warn).toHaveBeenCalled()
    })

    test('decodes a dataset carrying a presentation group, warning that its preferences are ignored', () => {
        // The group holds display preferences only, so refusing the file over one loses the data for
        // nothing.
        const decoded = new DicomDecoder(dataset([[1, 2]], {}, {
            WaveformPresentationGroupSequence: [{}],
        })).decodeData()
        expect(decoded?.signals).toStrictEqual([[1, 2]])
        expect(Log.warn).toHaveBeenCalled()
    })
})

describe('annotations, header and output', () => {

    test('returns the dataset annotations with the signals', () => {
        const decoded = new DicomDecoder(dataset([[1, 2]], {}, {
            WaveformAnnotationSequence: [{
                ReferencedTimeOffsets: [0.1],
                ReferencedWaveformChannels: [1, 0],
                TemporalRangeType: 'POINT',
                UnformattedTextValue: 'Marker',
            }],
        })).decodeData()
        expect(decoded?.events).toHaveLength(1)
        expect(decoded?.events?.[0].value).toEqual('Marker')
    })

    test('reports no interruptions, which a multiplex group cannot have', () => {
        const decoded = new DicomDecoder(dataset([[1, 2]])).decodeData()
        expect(decoded?.interruptions?.size).toEqual(0)
    })

    test('strips the samples out of the decoded header', () => {
        const source = dataset([[1, 2]])
        const header = new DicomDecoder(source).decodeHeader()
        expect(header?.WaveformSequence[0].WaveformData).toStrictEqual([])
        // The source dataset keeps its own data; the header is a separate object.
        expect(source.WaveformSequence[0].WaveformData).toHaveLength(1)
    })

    test('keeps the decoded signals in the output record', () => {
        // The record is the decoder's output, so it has to carry the signals and not the header alone.
        const decoder = new DicomDecoder(dataset([[1, 2]]))
        const { data, header } = decoder.decode()
        expect(data?.signals).toStrictEqual([[1, 2]])
        expect(header).not.toBeNull()
        expect(decoder.output?.physicalSignals).toStrictEqual([[1, 2]])
    })

    test('decodes a stripped dataset from a buffer given through setInput', () => {
        const source = dataset([[3, 4]])
        const buffer = source.WaveformSequence[0].WaveformData[0]
        const stripped = dataset([[0, 0]], { WaveformData: [] })
        const decoder = new DicomDecoder(stripped)
        decoder.setInput(buffer)
        expect(decoder.decodeData()?.signals).toStrictEqual([[3, 4]])
    })

    test('prefers an explicitly given buffer over the dataset own data', () => {
        const other = dataset([[7, 8]])
        const decoder = new DicomDecoder(dataset([[1, 2]]))
        const decoded = decoder.decodeData(undefined, other.WaveformSequence[0].WaveformData[0])
        expect(decoded?.signals).toStrictEqual([[7, 8]])
    })
})
