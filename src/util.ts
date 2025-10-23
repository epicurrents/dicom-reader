/**
 * Epicurrents DICOM utilities.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { DicomDataset } from '#types'
import { GenericBiosignalHeader } from '@epicurrents/core'
import type { DicomAnnotationSequence, DicomChannelDefinitionSequence } from '#types'
import { secondsToTimeString } from '@epicurrents/core/dist/util'
import type { AnnotationTemplate } from '@epicurrents/core/dist/types'

export const annotationsToBiosignalAnnotations = (annotations: DicomAnnotationSequence[]) => {
    return annotations.map((annotation) => {
        // Required properties of a biosignal annotation are:
        // start: number, duration: number, label: string.
        return {
            channels: annotation.ReferencedWaveformChannels || [],
            class: "event",
            duration: 0,
            label: annotation.UnformattedTextValue || '',
            priority: 400,
            start: annotation.ReferencedTimeOffsets || 0, // This is in seconds.
        } as AnnotationTemplate
    })
}

/**
 * Convert DICOM date time to a JavaScript Date object.
 * @param dateTime - DICOM date time in the format "YYYYMMDD[HHMMSS[.FFFFFF]]"
 * @returns JavaScript Date object representing the DICOM date time.
 */
export const convertDicomDateTime = (dateTime: string): Date => {
    // DICOM date time is in the format "YYYYMMDD[HHMMSS[.FFFFFF]]"
    // Time is expressed in local time (of the recording) and we'll display it as such.
    const trimmed = dateTime.trim() // Datetime can be padded at the end.
    const y = trimmed.slice(0, 4)
    const m = trimmed.slice(4, 6)
    const d = trimmed.slice(6, 8)
    if (trimmed.length < 14) {
        // If the date time is only in the format "YYYYMMDD", we can set the time to midnight.
        return new Date(`${y}-${m}-${d}T00:00:00`)
    }
    // Otherwise, we need to parse the time component as well.
    // DICOM date time can have milliseconds, so we need to handle that as well.
    const hr = trimmed.slice(8, 10)
    const min = trimmed.slice(10, 12)
    const sec = trimmed.slice(12, 14)
    const msec = trimmed.length > 14 ? trimmed.slice(14) : ''
    //
    // If milliseconds are present, we need to add a dot before them.
    const isoDateTime = `${y}-${m}-${d}T${hr}:${min}:${sec}${msec || ''}`
    return new Date(isoDateTime)
}
/**
 * Convert DICOM time to a formatted time string or an object with time components.
 * @param time - DICOM time in the format "HH[MM[SS[.FFFFFF]]]"
 * @param components - Return an object with hours, minutes, seconds and milliseconds instead of a formatted string.
 * @returns Formatted time string or an object with time components.
 */
export const dicomTimeToTimeString = (time: string, components = false): ReturnType<typeof secondsToTimeString> => {
    // DICOM time is in the format "HH[MM[SS[.FFFFFF]]]"
    // We can safely assume that the time is always in UTC, so we can use the Date constructor directly.
    const trimmed = time.trim() // Time can be padded at the end.
    const hr = trimmed.slice(0, 2)
    const min = trimmed.length >= 4 ? trimmed.slice(2, 4) : '0'
    const sec = trimmed.length >= 6 ? trimmed.slice(4) : '0'
    // Convert to seconds and return a formatted string.
    const totalSeconds = parseInt(hr)*3600 + parseInt(min)*60 + parseFloat(sec)
    return secondsToTimeString(totalSeconds, components)
}
/**
 * Try to extract the modality of signal from the signal info.
 * @param channel - Channel definition from the DICOM header.
 * @param labelMatchers - A map of labels (RegExp strings) to signal modalities (optional).
 * @returns Modality of the signal or empty string if unsuccessful.
 */
export const extractSignalModality = (
    channel: DicomChannelDefinitionSequence,
    labelMatchers?: Map<string, string>
): string => {
    const label = channel.ChannelLabel || ''
    const matchers = labelMatchers
                        ? labelMatchers
                        : new Map<string, string>()
    // Apply a set of default label matchers after the custom matchers.
    const defaultMatchers = [
        ["emg", "emg"],
        ["eog", "eog"],
        ["ecg|ekg", "ekg"],
        ["eeg", "eeg"],
    ]
    for (const [defLabel, defType] of defaultMatchers) {
        if (!matchers.has(defLabel)) {
            matchers.set(defLabel, defType)
        }
    }
    for (const [matchLabel, matchType] of matchers) {
        if (label.match(new RegExp(matchLabel, 'i'))) {
            return matchType
        }
    }
    return ""
}
/**
 * Convert the given DICOM header record into generic biosignal header.
 * @param header - Parsed DICOM header (essentially the whole DICOM recording).
 * @returns Biosignal header record.
 */
export const headerToBiosignalHeader = (header: DicomDataset) => {
    // There should be only one waveform sequence in the DICOM header.
    const ws = header.WaveformSequence[0]
    // Multiplexed DICOM signals contain channel samples in a consecutive order. The parsed DICOM file already contains
    // the extracted signals so we can basically ignore this.
    const nDataUnits = ws.NumberOfWaveformSamples
    const dataUnitLength = 1/ws.SamplingFrequency
    const dataUnitSize = (ws.WaveformBitsAllocated/8)*ws.NumberOfWaveformChannels
    const biosigheader = new GenericBiosignalHeader(
        'dicom',
        header.StudyID,
        header.PatientID,
        nDataUnits,
        dataUnitLength,
        dataUnitSize,
        ws.NumberOfWaveformChannels,
        ws.ChannelDefinitionSequence.map((s: DicomChannelDefinitionSequence) => {
            return {
                label: s.ChannelLabel,
                modality: extractSignalModality(s),
                name: s.ChannelLabel,
                physicalUnit: s.ChannelSensitivityUnitsSequence[0].CodeValue || '',
                prefiltering: {
                    bandreject: [],
                    highpass: s.FilterHighFrequency || 0,
                    lowpass: s.FilterLowFrequency || 0,
                    notch: s.NotchFilterFrequency || 0,
                },
                sampleCount: ws.NumberOfWaveformSamples,
                samplingRate: ws.SamplingFrequency,
                sensitivity: 0, // Has a different meaning in DICOM, so we set it to 0.
                sensor: 'Unknown',
            }
        }),
        convertDicomDateTime(header.AcquisitionDateTime),
        false, // DICOM files are always continuous.
        [],
    )
    return biosigheader
}
