/**
 * Epicurrents DICOM utilities.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeader } from '@epicurrents/core'
import type { AnnotationEventTemplate, BiosignalHeaderSignal } from '@epicurrents/core/types'
import { getSignalScale, secondsToTimeString } from '@epicurrents/core/util'
import type {
    DicomAnnotationSequence,
    DicomChannelDefinitionSequence,
    DicomDataset,
    DicomWaveformSequence,
} from '#types'
import { Log } from 'scoped-event-log'

const SCOPE = 'util'

/**
 * Normalise an attribute into an array. `dcmjs` unwraps a single-valued attribute to a bare value,
 * so an attribute the standard allows several values for arrives either way.
 */
const asArray = <T>(value: T | T[] | null | undefined): T[] => {
    if (value === null || value === undefined) {
        return []
    }
    return Array.isArray(value) ? value : [value]
}

/**
 * Annotation positions converted into seconds from the start of the data.
 *
 * DICOM places an annotation with time offsets, with sample positions or with absolute datetimes.
 * The first two are relative to the data start and are usable as they are; an absolute datetime
 * would have to be related to the acquisition time, which is only meaningful for a synchronised
 * acquisition, so it yields no position.
 */
const annotationPositions = (annotation: DicomAnnotationSequence, samplingRate: number): number[] => {
    const offsets = asArray(annotation.ReferencedTimeOffsets)
    if (offsets.length) {
        return offsets
    }
    const samples = asArray(annotation.ReferencedSamplePositions)
    if (samples.length && samplingRate) {
        // The position of the first sample is one, not zero.
        return samples.map(position => (position - 1)/samplingRate)
    }
    return []
}

/**
 * Start and duration pairs, in seconds, that the given annotation applies to.
 *
 * One annotation can describe several spans: `MULTIPOINT` carries a position per point and
 * `MULTISEGMENT` two per segment. An annotation with no temporal range type applies to the whole
 * extent of the channels it references, and one whose positions cannot be placed on a timeline
 * produces none.
 */
const annotationSpans = (
    annotation: DicomAnnotationSequence,
    samplingRate: number,
    recordingLength: number
): [number, number][] => {
    if (!annotation.TemporalRangeType) {
        return [[0, recordingLength]]
    }
    const positions = annotationPositions(annotation, samplingRate)
    if (!positions.length) {
        Log.warn(
            `A DICOM annotation of temporal range type ${annotation.TemporalRangeType} carries no ` +
            `position that can be placed on a timeline and was dropped.`,
            SCOPE
        )
        return []
    }
    switch (annotation.TemporalRangeType) {
        case 'BEGIN':
            // A range starting at the position and extending past the end of the data.
            return [[positions[0], Math.max(0, recordingLength - positions[0])]]
        case 'END':
            // A range starting before the data and ending at the position.
            return [[0, Math.max(0, positions[0])]]
        case 'MULTIPOINT':
            return positions.map((position): [number, number] => [position, 0])
        case 'MULTISEGMENT': {
            const spans = [] as [number, number][]
            for (let i=0; i<positions.length - 1; i+=2) {
                spans.push([positions[i], Math.max(0, positions[i + 1] - positions[i])])
            }
            return spans
        }
        case 'POINT':
            return [[positions[0], 0]]
        case 'SEGMENT':
            return [[positions[0], Math.max(0, (positions[1] ?? positions[0]) - positions[0])]]
    }
}

/**
 * Labels of the channels an annotation refers to, empty when it refers to all of them.
 *
 * `ReferencedWaveformChannels` is a flat list of multiplex group and channel number **pairs**; only
 * the channel numbers are of interest, as a reader sees one multiplex group. A channel number of
 * zero refers to every channel of its group, which makes the whole annotation a general one.
 *
 * A channel number indexes the group's channel definitions one-based, so it resolves through them
 * rather than through `WaveformChannelNumber`, which is optional and records the equipment's own
 * numbering rather than a position in the sequence.
 */
const referencedChannelLabels = (
    annotation: DicomAnnotationSequence,
    definitions: DicomChannelDefinitionSequence[]
): (number | string)[] => {
    const referenced = asArray(annotation.ReferencedWaveformChannels)
    const labels = [] as (number | string)[]
    for (let i=1; i<referenced.length; i+=2) {
        const channel = referenced[i]
        if (!channel) {
            return []
        }
        labels.push(definitions[channel - 1]?.ChannelLabel || channel - 1)
    }
    return labels
}

/**
 * Physical unit a channel's samples are expressed in, as the file writes it.
 * @param channel - Channel definition from the DICOM header.
 * @returns The unit, or an empty string for a channel whose samples carry no defined unit.
 */
export const channelPhysicalUnit = (channel: DicomChannelDefinitionSequence): string => {
    // The units sequence accompanies `ChannelSensitivity` and is absent for an uncalibrated channel.
    return channel.ChannelSensitivityUnitsSequence?.[0]?.CodeValue || ''
}

/**
 * Convert a DICOM datetime into a Date object.
 *
 * The value is expressed in the local time of the recording and is used as such; a UTC offset
 * suffix is therefore dropped rather than applied. Every component below the year is optional in
 * the format and defaults to the start of its range, so a date-only value becomes midnight.
 * @param dateTime - DICOM datetime, `YYYY[MM[DD[HH[MM[SS[.FFFFFF]]]]]][&ZZXX]`.
 * @returns The datetime, or null when it is absent or cannot be parsed.
 */
export const convertDicomDateTime = (dateTime?: string | null): Date | null => {
    // The value can be padded at either end, and an empty type 2 attribute arrives as null.
    const trimmed = (dateTime || '').trim()
    if (!trimmed) {
        return null
    }
    const offsetIndex = trimmed.search(/[+-]/)
    const value = offsetIndex > 0 ? trimmed.slice(0, offsetIndex) : trimmed
    const year = value.slice(0, 4)
    if (year.length < 4) {
        Log.warn(`DICOM datetime "${trimmed}" is too short to carry a year.`, SCOPE)
        return null
    }
    const seconds = value.slice(12)
    const [wholeSeconds, fraction] = seconds.split('.')
    const parsed = new Date(
        `${year}-${value.slice(4, 6) || '01'}-${value.slice(6, 8) || '01'}` +
        `T${value.slice(8, 10) || '00'}:${value.slice(10, 12) || '00'}` +
        // DICOM allows six fractional digits where the Date parser is only specified for three.
        `:${(wholeSeconds || '00').padStart(2, '0')}${fraction ? `.${fraction.slice(0, 3)}` : ''}`
    )
    if (isNaN(parsed.getTime())) {
        Log.warn(`DICOM datetime "${trimmed}" could not be parsed.`, SCOPE)
        return null
    }
    return parsed
}

/**
 * Convert a DICOM time into a formatted time string or an object with the time components.
 * @param time - DICOM time, `HH[MM[SS[.FFFFFF]]]`.
 * @param components - Return an object with hours, minutes, seconds and milliseconds instead of a formatted string.
 * @returns Formatted time string or an object with the time components.
 */
export const dicomTimeToTimeString = (
    time?: string | null,
    components = false
): ReturnType<typeof secondsToTimeString> => {
    // The value can be padded at the end and carries only the components the writer had.
    const trimmed = (time || '').trim()
    const hours = parseInt(trimmed.slice(0, 2)) || 0
    const minutes = trimmed.length >= 4 ? parseInt(trimmed.slice(2, 4)) || 0 : 0
    const seconds = trimmed.length >= 6 ? parseFloat(trimmed.slice(4)) || 0 : 0
    return secondsToTimeString(hours*3600 + minutes*60 + seconds, components)
}

/**
 * Convert DICOM waveform annotations into biosignal event templates.
 *
 * One annotation can yield several events or none at all, so the returned list does not correspond
 * index for index with the given annotations.
 * @param events - Waveform annotation sequence, absent for a recording that carries no annotations.
 * @param waveform - The multiplex group the annotations refer into, needed to place them and resolve channels.
 * @returns Event templates for every annotation that could be placed on a timeline.
 */
export const eventsToBiosignalEvents = (
    events?: DicomAnnotationSequence[] | null,
    waveform?: DicomWaveformSequence
): AnnotationEventTemplate[] => {
    // The waveform annotation module is optional, so a recording without annotations omits it.
    const annotations = asArray(events)
    if (!annotations.length) {
        return []
    }
    const definitions = waveform?.ChannelDefinitionSequence ?? []
    const samplingRate = waveform?.SamplingFrequency ?? 0
    const recordingLength = samplingRate ? (waveform?.NumberOfWaveformSamples ?? 0)/samplingRate : 0
    const converted = [] as AnnotationEventTemplate[]
    for (const annotation of annotations) {
        // An annotation carries its content either as free text or as a code, never as both. The
        // coded form contributes its human-readable meaning; the code itself is not carried over,
        // because nothing maps a DICOM coding scheme onto the annotation vocabularies yet.
        const value = annotation.UnformattedTextValue
                      || annotation.ConceptNameCodeSequence?.[0]?.CodeMeaning
                      || ''
        const channels = referencedChannelLabels(annotation, definitions)
        for (const [start, duration] of annotationSpans(annotation, samplingRate, recordingLength)) {
            converted.push({
                channels,
                class: 'event',
                duration,
                priority: 400,
                start,
                value,
            })
        }
    }
    return converted
}

/**
 * Try to extract the modality of the signal from the channel definition.
 * @param channel - Channel definition from the DICOM header.
 * @param labelMatchers - A map of labels (RegExp strings) to signal modalities (optional).
 * @returns Modality of the signal or an empty string if unsuccessful.
 */
export const extractSignalModality = (
    channel: DicomChannelDefinitionSequence,
    labelMatchers?: Map<string, string>
): string => {
    const label = channel.ChannelLabel || ''
    const matchers = labelMatchers ?? new Map<string, string>()
    // Apply a set of default label matchers after the custom matchers.
    const defaultMatchers = [
        ['emg', 'emg'],
        ['eog', 'eog'],
        ['ecg|ekg', 'ekg'],
        ['eeg', 'eeg'],
    ]
    for (const [defaultLabel, defaultModality] of defaultMatchers) {
        if (!matchers.has(defaultLabel)) {
            matchers.set(defaultLabel, defaultModality)
        }
    }
    for (const [matchLabel, matchModality] of matchers) {
        if (label.match(new RegExp(matchLabel, 'i'))) {
            return matchModality
        }
    }
    return ''
}

/**
 * Convert the given DICOM dataset into a generic biosignal header.
 * @param header - Parsed DICOM dataset (essentially the whole DICOM recording).
 * @returns Biosignal header record.
 */
export const headerToBiosignalHeader = (header: DicomDataset) => {
    // There should be only one waveform sequence in a DICOM biosignal recording.
    const waveform = header.WaveformSequence[0]
    // A multiplex group interleaves its channels sample by sample, so one sample of every channel is
    // the smallest unit the data divides into.
    const dataUnitCount = waveform.NumberOfWaveformSamples
    const dataUnitDuration = 1/waveform.SamplingFrequency
    const dataUnitSize = (waveform.WaveformBitsAllocated/8)*waveform.NumberOfWaveformChannels
    return new GenericBiosignalHeader(
        'dicom',
        header.StudyID || '',
        header.PatientID || '',
        dataUnitCount,
        dataUnitDuration,
        dataUnitSize,
        waveform.NumberOfWaveformChannels,
        signalPropertiesFromWaveform(waveform),
        convertDicomDateTime(header.AcquisitionDateTime),
        false, // A DICOM multiplex group is continuous.
        // Annotations are reported once, by the reader when it caches the signals they belong to.
        // Carrying them here as well would add every event to the recording twice.
        [],
    )
}

/**
 * Describe a multiplex group's channels as biosignal header signals.
 *
 * Shared by {@link headerToBiosignalHeader} and `DicomDatasetRecord`, which describe the same
 * channels for the same consumer and must not disagree about them.
 * @param waveform - The multiplex group to describe.
 * @returns One signal descriptor per channel, in the order the group interleaves them.
 */
export const signalPropertiesFromWaveform = (waveform: DicomWaveformSequence): BiosignalHeaderSignal[] => {
    return waveform.ChannelDefinitionSequence.map(channel => {
        return {
            label: channel.ChannelLabel || '',
            modality: extractSignalModality(channel),
            name: channel.ChannelLabel || '',
            physicalUnit: channelPhysicalUnit(channel),
            prefiltering: {
                bandreject: [],
                // DICOM names the cutoffs after the edges of the pass band, so the *low* frequency
                // is the high-pass cutoff and the *high* frequency the low-pass one.
                highpass: channel.FilterLowFrequency || 0,
                lowpass: channel.FilterHighFrequency || 0,
                notch: channel.NotchFilterFrequency || 0,
            },
            sampleCount: waveform.NumberOfWaveformSamples,
            samplingRate: waveform.SamplingFrequency,
            sensitivity: 0, // Channel sensitivity means something else in DICOM, so it is not carried over.
            sensor: 'Unknown',
        }
    })
}

/**
 * Factor that converts a channel's sample values into the SI unit of their quantity.
 *
 * Every reader in the family normalises samples on decode, so a channel recorded in microvolts is
 * cached in volts. The unit the header reports stays as the file wrote it, because that is what a
 * consumer displays the signal against.
 * @param channel - Channel definition from the DICOM header.
 * @returns The scaling factor, 1 for a channel whose unit is already SI or is unknown.
 */
export const signalUnitScale = (channel: DicomChannelDefinitionSequence): number => {
    return getSignalScale(channelPhysicalUnit(channel))
}
