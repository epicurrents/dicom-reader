/**
 * Epicurrents DICOM utilities.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { DicomHeader, DicomSignalInfo } from '#types'
import { GenericBiosignalHeader } from '@epicurrents/core'

/**
 * Try to extract the modality of signal from the signal info.
 * @param signal - Signal information from the DICOM header.
 * @param labelMatchers - A map of labels (RegExp strings) to signal modalities (optional).
 * @returns Modality of the signal or empty string if unsuccessful.
 */
export const extractSignalModality = (signal: DicomSignalInfo, labelMatchers?: Map<string, string>): string => {
    const label = signal.label
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
        if (label.match(new RegExp(matchLabel))) {
            return matchType
        }
    }
    return ""
}
/**
 * Convert the given DICOM header record into generic biosignal header.
 * @param header - Parsed DICOM header.
 * @returns Biosignal header record.
 */
export const headerToBiosignalHeader = (header: DicomHeader) => {
    const biosigheader = new GenericBiosignalHeader(
        header.dataFormat,
        header.patientId,
        header.patientId,
        header.dataRecordCount,
        header.dataRecordDuration,
        header.recordByteSize,
        header.signalCount,
        header.signalInfo.map((s: any) => {
            return {
                label: s.label,
                modality: extractSignalModality(s),
                name: s.label,
                physicalUnit: s.physicalUnit,
                prefiltering: '',
                sampleCount: s.sampleCount,
                samplingRate: 0,
                sensitivity: 0,
                sensor: s.transducerType,
            }
        }),
        header.recordingDate,
        header.discontinuous,
        [],
    )
    return biosigheader
}
/**
 * Convert a string to a UTF-8 byte array.
 * @param input - The string to convert to a UTF-8 byte array.
 * @returns An array of bytes representing the UTF-8 encoded string.
 * @privateRemarks
 * Not really needed since TextEncoder is available in most browsers, but I'll leave this here in case a polyfill is
 * needed at some point.
 * Inspired by from https://gist.github.com/joni/3760795.
 */
export const textToUTF8Array = (input: string) => {
    const output = [] as number[]
    for (let i=0; i<input.length; i++) {
        let charcode = input.charCodeAt(i)
        if (charcode < 0x80) {
            // 0x00-0x7F is a single byte in UTF-8, we can add it directly.
            output.push(charcode)
        }  else if (charcode < 0x800) {
            // 0x80-0x7FF is a two-byte sequence in UTF-8.
            // The first byte is 0xc0 + (charcode >> 6) and the second byte is 0x80 + (charcode & 0x3f).
            // This means the first byte has the two most significant bits set to 1 and the next six bits are the first
            // six bits of the character code, and the second byte has the two most significant bits set to 0 and the
            // next six bits are the last six bits of the character code.
            output.push(
                0xc0 | (charcode >> 6),
                0x80 | (charcode & 0x3f)
            )
        } else if (charcode < 0xd800 || charcode >= 0xe000) {
            // 0x800-0xFFFF is a three-byte sequence in UTF-8.
            // The first byte is 0xe0 + (charcode >> 12), the second byte is 0x80 + ((charcode >> 6) & 0x3f), and the
            // third byte is 0x80 + (charcode & 0x3f).
            // This means the first byte has the three most significant bits set to 1 and the next four bits are the
            // first four bits of the character code, the second byte has the two most significant bits set to 1 and
            // the next six bits are the next six bits of the character code, and the third byte has the two most
            // significant bits set to 0 and the next six bits are the last six bits of the character code.
            // We skip surrogate pairs (0xd800-0xdfff) here, as they are not valid UTF-8 characters.
            output.push(
                0xe0 | (charcode >> 12),
                0x80 | ((charcode >> 6) & 0x3f),
                0x80 | (charcode & 0x3f)
            )
        } else {
            // Surrogate pairs handling.
            // JavaScript's internal UTF-16 encodes 0x10000-0x10FFFF by subtracting 0x10000 and splits the 20 bits
            // from 0x0-0xFFFFF into two parts.
            // The first byte is 0xf0 + (charcode >> 18), the second byte is 0x80 + ((charcode >> 12) & 0x3f),
            // the third byte is 0x80 + ((charcode >> 6) & 0x3f), and the fourth byte is 0x80 + (charcode & 0x3f).
            // We need to increment the index to skip the next character, as we are processing a surrogate pair.
            // Note: The input string is expected to be a valid UTF-16 string, so we assume that the next character
            // is always a valid surrogate pair character.
            i++
            charcode = 0x10000 + (
                ((charcode & 0x3ff) << 10)
                | (input.charCodeAt(i) & 0x3ff)
            )
            output.push(
                0xf0 | (charcode >> 18),
                0x80 | ((charcode >> 12) & 0x3f),
                0x80 | ((charcode >> 6) & 0x3f),
                0x80 | (charcode & 0x3f)
            )
        }
    }
    return output
}
