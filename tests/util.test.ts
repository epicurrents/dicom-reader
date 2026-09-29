/**
 * Unit tests for the DICOM utilities: the annotation conversion, which has to survive every temporal
 * range type and `dcmjs`'s habit of unwrapping single-valued attributes, the datetime parsing across
 * the format's optional precision, and the channel description the header is built from.
 *
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import type {
    DicomAnnotationSequence,
    DicomChannelDefinitionSequence,
    DicomDataset,
    DicomWaveformSequence,
} from '../src/types'

vi.mock('scoped-event-log', () => ({
    Log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const headerArgs = [] as unknown[][]
vi.mock('@epicurrents/core', () => ({
    GenericBiosignalHeader: class {
        constructor (...args: unknown[]) {
            headerArgs.push(args)
        }
    },
}))

vi.mock('@epicurrents/core/util', () => ({
    getSignalScale: vi.fn((unit: string) => (unit === 'uV' ? 1e-6 : 1)),
    secondsToTimeString: vi.fn((seconds: number) => `${seconds}s`),
}))

import { Log } from 'scoped-event-log'
import { getSignalScale, secondsToTimeString } from '@epicurrents/core/util'
import {
    channelPhysicalUnit,
    convertDicomDateTime,
    dicomTimeToTimeString,
    eventsToBiosignalEvents,
    extractSignalModality,
    headerToBiosignalHeader,
    signalPropertiesFromWaveform,
    signalUnitScale,
} from '../src/util'

const channel = (overrides: Partial<DicomChannelDefinitionSequence> = {}): DicomChannelDefinitionSequence => {
    return {
        ChannelSourceSequence: [{ CodeMeaning: 'Fp1' }],
        WaveformBitsStored: 16,
        ...overrides,
    }
}

const waveform = (overrides: Partial<DicomWaveformSequence> = {}): DicomWaveformSequence => {
    return {
        ChannelDefinitionSequence: [channel({ ChannelLabel: 'EEG Fp1' }), channel({ ChannelLabel: 'EEG Fp2' })],
        NumberOfWaveformChannels: 2,
        NumberOfWaveformSamples: 100,
        SamplingFrequency: 10,
        WaveformBitsAllocated: 16,
        WaveformData: [new ArrayBuffer(400)],
        WaveformOriginality: 'ORIGINAL',
        WaveformSampleInterpretation: 'SS',
        ...overrides,
    }
}

const annotation = (overrides: Partial<DicomAnnotationSequence> = {}): DicomAnnotationSequence => {
    return {
        ReferencedWaveformChannels: [1, 0],
        UnformattedTextValue: 'Eyes closed',
        ...overrides,
    }
}

beforeEach(() => {
    headerArgs.length = 0
    vi.clearAllMocks()
})

describe('eventsToBiosignalEvents', () => {

    test('returns nothing when the annotation sequence is absent', () => {
        // The waveform annotation module is optional, so most recordings omit it entirely.
        expect(eventsToBiosignalEvents(undefined, waveform())).toStrictEqual([])
        expect(eventsToBiosignalEvents(null, waveform())).toStrictEqual([])
        expect(eventsToBiosignalEvents([], waveform())).toStrictEqual([])
    })

    test('carries the text as the annotation value', () => {
        const events = eventsToBiosignalEvents([annotation()], waveform())
        expect(events).toHaveLength(1)
        // `value` is the required raw value; `label` only overrides it in listings.
        expect(events[0].value).toEqual('Eyes closed')
        expect(events[0].class).toEqual('event')
        expect(events[0].priority).toEqual(400)
    })

    test('falls back to the coded meaning when there is no text', () => {
        const events = eventsToBiosignalEvents(
            [annotation({
                ConceptNameCodeSequence: [{ CodeMeaning: 'Photic stimulation', CodeValue: '1234' }],
                UnformattedTextValue: undefined,
            })],
            waveform()
        )
        expect(events[0].value).toEqual('Photic stimulation')
    })

    test('spans the whole recording when no temporal range type is given', () => {
        // An absent range type means the annotation applies to the full extent of its channels.
        const events = eventsToBiosignalEvents([annotation()], waveform())
        expect(events[0].start).toEqual(0)
        // 100 samples at 10 Hz.
        expect(events[0].duration).toEqual(10)
    })

    test('places a POINT at its single offset with no duration', () => {
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedTimeOffsets: [4.5], TemporalRangeType: 'POINT' })],
            waveform()
        )
        expect(events).toHaveLength(1)
        expect(events[0].start).toEqual(4.5)
        expect(events[0].duration).toEqual(0)
    })

    test('accepts an offset that dcmjs unwrapped to a scalar', () => {
        // A single-valued attribute does not arrive as an array, so a numeric `start` cannot be taken
        // from it directly.
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedTimeOffsets: 4.5, TemporalRangeType: 'POINT' })],
            waveform()
        )
        expect(events[0].start).toEqual(4.5)
    })

    test('turns a SEGMENT into a start and a duration', () => {
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedTimeOffsets: [2, 6], TemporalRangeType: 'SEGMENT' })],
            waveform()
        )
        expect(events).toHaveLength(1)
        expect(events[0].start).toEqual(2)
        expect(events[0].duration).toEqual(4)
    })

    test('splits MULTIPOINT into one event per position', () => {
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedTimeOffsets: [1, 2, 3], TemporalRangeType: 'MULTIPOINT' })],
            waveform()
        )
        expect(events.map(event => [event.start, event.duration])).toStrictEqual([[1, 0], [2, 0], [3, 0]])
    })

    test('splits MULTISEGMENT into one event per pair', () => {
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedTimeOffsets: [1, 2, 5, 9], TemporalRangeType: 'MULTISEGMENT' })],
            waveform()
        )
        expect(events.map(event => [event.start, event.duration])).toStrictEqual([[1, 1], [5, 4]])
    })

    test('runs BEGIN to the end of the recording and END from its start', () => {
        const begin = eventsToBiosignalEvents(
            [annotation({ ReferencedTimeOffsets: [7], TemporalRangeType: 'BEGIN' })],
            waveform()
        )
        expect([begin[0].start, begin[0].duration]).toStrictEqual([7, 3])
        const end = eventsToBiosignalEvents(
            [annotation({ ReferencedTimeOffsets: [7], TemporalRangeType: 'END' })],
            waveform()
        )
        expect([end[0].start, end[0].duration]).toStrictEqual([0, 7])
    })

    test('converts sample positions, which are one-based, into seconds', () => {
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedSamplePositions: [11], TemporalRangeType: 'POINT' })],
            waveform()
        )
        // The first sample is position 1, so position 11 is the eleventh sample, at 1.0 s in a 10 Hz group.
        expect(events[0].start).toEqual(1)
    })

    test('drops an annotation placed only by absolute datetime', () => {
        // Relating an absolute time to the data start needs a synchronised acquisition.
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedDateTime: '20250101120000', TemporalRangeType: 'POINT' })],
            waveform()
        )
        expect(events).toStrictEqual([])
        expect(Log.warn).toHaveBeenCalled()
    })

    test('resolves referenced channel pairs to labels, dropping the group numbers', () => {
        // The attribute is a flat list of multiplex-group and channel-number pairs.
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedWaveformChannels: [1, 2] })],
            waveform()
        )
        expect(events[0].channels).toStrictEqual(['EEG Fp2'])
    })

    test('treats channel zero as referring to every channel', () => {
        // Channel 0 of a group means the whole group, which is a general event.
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedWaveformChannels: [1, 0] })],
            waveform()
        )
        expect(events[0].channels).toStrictEqual([])
    })

    test('falls back to a channel index when the channel carries no label', () => {
        const events = eventsToBiosignalEvents(
            [annotation({ ReferencedWaveformChannels: [1, 1] })],
            waveform({ ChannelDefinitionSequence: [channel(), channel()] })
        )
        expect(events[0].channels).toStrictEqual([0])
    })
})

describe('convertDicomDateTime', () => {

    test('parses a full datetime as local time', () => {
        const parsed = convertDicomDateTime('20250131143005')
        expect(parsed).toBeInstanceOf(Date)
        expect(parsed?.getFullYear()).toEqual(2025)
        expect(parsed?.getMonth()).toEqual(0)
        expect(parsed?.getDate()).toEqual(31)
        expect(parsed?.getHours()).toEqual(14)
        expect(parsed?.getMinutes()).toEqual(30)
        expect(parsed?.getSeconds()).toEqual(5)
    })

    test('treats a date-only value as midnight', () => {
        const parsed = convertDicomDateTime('20250131')
        expect(parsed?.getHours()).toEqual(0)
        expect(parsed?.getDate()).toEqual(31)
    })

    test('keeps the time of a value whose precision stops short of seconds', () => {
        // Every component below the year is optional, so a value may stop short of seconds and still
        // carry a time.
        const parsed = convertDicomDateTime('202501311430')
        expect(parsed?.getHours()).toEqual(14)
        expect(parsed?.getMinutes()).toEqual(30)
    })

    test('keeps fractional seconds to millisecond precision', () => {
        const parsed = convertDicomDateTime('20250131143005.123456')
        expect(parsed?.getMilliseconds()).toEqual(123)
    })

    test('ignores a UTC offset suffix', () => {
        // The value is the recording's local time and is displayed as such.
        const parsed = convertDicomDateTime('20250131143005+0200')
        expect(parsed?.getHours()).toEqual(14)
    })

    test('tolerates padding', () => {
        expect(convertDicomDateTime(' 20250131143005 ')?.getDate()).toEqual(31)
    })

    test('returns null rather than an invalid date for anything unusable', () => {
        // An empty type 2 attribute naturalizes to null, which must not reach a string method.
        expect(convertDicomDateTime(null)).toBeNull()
        expect(convertDicomDateTime(undefined)).toBeNull()
        expect(convertDicomDateTime('')).toBeNull()
        expect(convertDicomDateTime('  ')).toBeNull()
        expect(convertDicomDateTime('202')).toBeNull()
        expect(convertDicomDateTime('not a date')).toBeNull()
    })
})

describe('dicomTimeToTimeString', () => {

    test('sums the components it is given', () => {
        dicomTimeToTimeString('143005')
        expect(secondsToTimeString).toHaveBeenCalledWith(14*3600 + 30*60 + 5, false)
    })

    test('treats absent components as zero', () => {
        dicomTimeToTimeString('14')
        expect(secondsToTimeString).toHaveBeenCalledWith(14*3600, false)
    })

    test('keeps fractional seconds', () => {
        dicomTimeToTimeString('143005.5')
        expect(secondsToTimeString).toHaveBeenCalledWith(14*3600 + 30*60 + 5.5, false)
    })

    test('reads an absent or unparseable value as zero', () => {
        dicomTimeToTimeString(null)
        expect(secondsToTimeString).toHaveBeenCalledWith(0, false)
    })
})

describe('extractSignalModality', () => {

    test('recognises the default modalities from the channel label', () => {
        expect(extractSignalModality(channel({ ChannelLabel: 'EEG Fp1-(A1~A2)' }))).toEqual('eeg')
        expect(extractSignalModality(channel({ ChannelLabel: 'ECG II' }))).toEqual('ekg')
        expect(extractSignalModality(channel({ ChannelLabel: 'EOG left' }))).toEqual('eog')
        expect(extractSignalModality(channel({ ChannelLabel: 'EMG chin' }))).toEqual('emg')
    })

    test('answers with an empty string for a label it cannot place', () => {
        expect(extractSignalModality(channel({ ChannelLabel: 'Pressure' }))).toEqual('')
        expect(extractSignalModality(channel())).toEqual('')
    })

    test('lets a custom matcher take precedence over the defaults', () => {
        const matchers = new Map([['eeg', 'custom']])
        expect(extractSignalModality(channel({ ChannelLabel: 'EEG Fp1' }), matchers)).toEqual('custom')
    })
})

describe('signalPropertiesFromWaveform', () => {

    test('maps the DICOM pass band edges onto the right filter kinds', () => {
        // DICOM names its cutoffs after the pass band: the low frequency is the high-pass cutoff.
        const [signal] = signalPropertiesFromWaveform(waveform({
            ChannelDefinitionSequence: [channel({ FilterHighFrequency: 70, FilterLowFrequency: 0.5 })],
        }))
        expect(signal.prefiltering.highpass).toEqual(0.5)
        expect(signal.prefiltering.lowpass).toEqual(70)
    })

    test('carries the label, rate and sample count of the group', () => {
        const [signal] = signalPropertiesFromWaveform(waveform())
        expect(signal.label).toEqual('EEG Fp1')
        expect(signal.name).toEqual('EEG Fp1')
        expect(signal.samplingRate).toEqual(10)
        expect(signal.sampleCount).toEqual(100)
    })

    test('reports the unit the file wrote, and none for an uncalibrated channel', () => {
        const [calibrated] = signalPropertiesFromWaveform(waveform({
            ChannelDefinitionSequence: [channel({
                ChannelSensitivity: 1,
                ChannelSensitivityUnitsSequence: [{ CodeMeaning: 'microvolt', CodeValue: 'uV' }],
            })],
        }))
        expect(calibrated.physicalUnit).toEqual('uV')
        // The units sequence accompanies the sensitivity and is absent without it.
        const [uncalibrated] = signalPropertiesFromWaveform(waveform({
            ChannelDefinitionSequence: [channel()],
        }))
        expect(uncalibrated.physicalUnit).toEqual('')
    })

    test('describes every channel of the group', () => {
        expect(signalPropertiesFromWaveform(waveform())).toHaveLength(2)
    })
})

describe('channelPhysicalUnit and signalUnitScale', () => {

    test('reads the unit out of the sensitivity units sequence', () => {
        expect(channelPhysicalUnit(channel({
            ChannelSensitivityUnitsSequence: [{ CodeMeaning: 'microvolt', CodeValue: 'uV' }],
        }))).toEqual('uV')
    })

    test('answers with an empty unit when the sequence or its code is absent', () => {
        expect(channelPhysicalUnit(channel())).toEqual('')
        expect(channelPhysicalUnit(channel({
            ChannelSensitivityUnitsSequence: [{ CodeMeaning: 'microvolt' }],
        }))).toEqual('')
    })

    test('delegates the scale to the shared conversion', () => {
        // Every reader in the family normalises samples to SI through the same helper.
        const scale = signalUnitScale(channel({
            ChannelSensitivityUnitsSequence: [{ CodeMeaning: 'microvolt', CodeValue: 'uV' }],
        }))
        expect(getSignalScale).toHaveBeenCalledWith('uV')
        expect(scale).toEqual(1e-6)
    })
})

describe('headerToBiosignalHeader', () => {

    const dataset = (overrides: Partial<DicomDataset> = {}): DicomDataset => {
        return {
            AcquisitionDateTime: '20250131143005',
            InstanceNumber: 1,
            Modality: 'EEG',
            PatientID: 'patient-1',
            StudyID: 'study-1',
            WaveformSequence: [waveform()],
            ...overrides,
        }
    }

    test('derives the data unit shape from the multiplex group', () => {
        headerToBiosignalHeader(dataset())
        const [args] = headerArgs
        expect(args[0]).toEqual('dicom')
        expect(args[1]).toEqual('study-1')
        expect(args[2]).toEqual('patient-1')
        // One data unit is one sample of every channel: 100 units of 1/10 s, four bytes each.
        expect(args[3]).toEqual(100)
        expect(args[4]).toEqual(0.1)
        expect(args[5]).toEqual(4)
        expect(args[6]).toEqual(2)
    })

    test('substitutes an empty string for identifiers the file leaves empty', () => {
        // An empty type 2 attribute naturalizes to null, and the header requires strings.
        headerToBiosignalHeader(dataset({ PatientID: null, StudyID: null }))
        const [args] = headerArgs
        expect(args[1]).toEqual('')
        expect(args[2]).toEqual('')
    })

    test('carries no annotations, which the reader reports with the signals instead', () => {
        // Carrying them here as well would add every event to the recording twice.
        headerToBiosignalHeader(dataset({
            WaveformAnnotationSequence: [annotation()],
        }))
        expect(headerArgs[0][10]).toStrictEqual([])
    })

    test('passes a null start time through rather than inventing one', () => {
        headerToBiosignalHeader(dataset({ AcquisitionDateTime: '' }))
        expect(headerArgs[0][8]).toBeNull()
    })
})
