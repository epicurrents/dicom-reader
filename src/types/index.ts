/**
 * Epicurrents DICOM types.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

//import type {
//    SafeObject,
//} from "@epicurrents/core/dist/types"


/**
 *
 * - Only one of `ReferencedDateTime`, `ReferencedSamplePositions`, or `ReferencedTimeOffsets` is present.
 *
 * @privateRemarks
 * https://dicom.innolitics.com/ciods/respiratory-waveform/waveform-annotation/0040b020/0040a043
 */
export type DicomAnnotationSequence = {
    AnnotationGroupNumber: number // 1, 2, 3, ...
    ReferencedWaveformChannels: number[]
    TemporalRangeType: DicomTempralRangeType
    /** Only one item is allowed. */
    ConceprtCodeSequence?: DicomConceptCodeSequence[]
    /** Mutually exclusive with `UnformattedTextValue`. */
    ConceptNameCodeSequence?: DicomConceptNameCodeSequence[]
    NumericValue?: number
    // One position reference is required.
    ReferencedDateTime?: string // "YYYYMMDDHHMMSS"
    ReferencedSamplePositions?: number[] // Sample numbers, e.g. [1, 2, 3, ...]
    ReferencedTimeOffsets?: number // Seconds since the start of the recording.
    /** Mutually exclusive with `ConceptNameCodeSequence`. */
    UnformattedTextValue: string
}

export type DicomChannelDefinitionSequence = {
    ChannelBaseline: number
    ChannelImpedanceSequence: DicomChannelImpedanceSequence[]
    ChannelLabel: string // "<modality> <label>-(<ref>)"" e.g. "EEG FP1-(A1~A2)"
    ChannelOffset: number
    ChannelSensitivity: number
    ChannelSensitivityCorrectionFactor: number
    ChannelSensitivityUnitsSequence: DicomChannelSensitivityUnitsSequence[]
    ChannelSourceModifiersSequence: DicomChannelSourceModifiersSequence[]
    ChannelSourceSequence: DicomChannelSourceSequence[]
    FilterHighFrequency: number
    FilterLowFrequency: number
    NotchFilterBandwidth: number
    NotchFilterFrequency: number
    WaveformBitsStored: number // 16 or 24
    WaveformChannelNumber: number // 1, 2, 3, ...
    // One skew property is required.
    ChannelSampleSkew?: number
    ChannelTimeSkew?: number // Seconds
}

export type DicomChannelImpedanceSequence = {
    ImpedanceMeasurementCurrentType: string // "AC"
    ImpedanceMeasurementDateTime: string // "YYYYMMDDHHMMSS"
    ImpedanceMeasurementFrequency: number // Hz
    ImpedanceValue: number // Ohms
}

export type DicomChannelSensitivityUnitsSequence = {
    CodeMeaning: string // e.g. "microVolt"
    CodeValue: string // e.g. "uV"
    CodingSchemeDesignator: string // "UCUM"
}

export type DicomChannelSourceSequence = {
    CodeMeaning: string // "Fp1"
    CodeValue: string // "7:1041"
    CodingSchemeDesignator: string // "MDC"
}

export type DicomChannelSourceModifiersSequence = {
    CodeMeaning: string // "(A1~A2)"
    CodeValue: string // "Unknown"
    CodingSchemeDesignator: string // "Unknown"
}

export type DicomConceptCodeSequence = object

export type DicomConceptNameCodeSequence = object

export type DicomDataset = {
    AccessionNumber: string
    AcquisitionContextSequence: unknown[]
    AcquisitionDateTime: string // "YYYYMMMDDHHMMSS.000000 "
    AcquisitionTimeSynchronized: string // "Y|N" ?
    AdmissionID: string
    ContentDate: string // "YYYYMMDD"
    ContentTime: string // "HHMMSS"
    DeviceSerialNumber: string
    InstanceCreationDate: string // "YYYYMMDD"
    InstanceCreationTime: string // "HHMMSS"
    InstanceCreatorUID: string // Dot-delimited numerical string
    InstanceNumber: number // 1, 2, 3, ...
    Manufacturer: string
    ManufacturerModelName: string
    Modality: string // Upper-case e.g. "EEG"
    PatientBirthDate: string // "YYYYMMDD"
    PatientID: string
    PatientName: {
        Aphabetical: string // ^-delimited name parts, e.g. "Last^First"
    }[]
    PatientSex: string
    ReferringPhysicianName: unknown[]
    SOPClassUID: string // Dot-delimited numerical string
    SOPInstanceUID: string // Dot-delimited numerical string
    SeriesInstanceUID: string // Dot-delimited numerical string
    SeriesNumber: number // 1, 2, 3, ...
    SoftwareVersions: string
    SpecificCharacterSet: string // "ISO_IR 100" or "ISO_IR 192"
    StudyDate: string // "YYYYMMDD"
    StudyDescription: string
    StudyID: string
    StudyInstanceUID: string // Dot-delimited numerical string
    StudyTime: string // "HHMMSS.000000"
    SynchronizationFrameOfReferenceUID: string // Dot-delimited numerical string
    SynchronizationTrigger: string // "NO TRIGGER" or "TRIGGER" ?
    WaveformAnnotationSequence: DicomAnnotationSequence[]
    WaveformSequence: DicomWaveformSequence[]
    // Optional properties.
    WaveformPresentationGroupSequence?: unknown
}

export type DicomRecordingType = 'eeg'

export type DicomTempralRangeType = 'BEGIN' | 'END' | 'MULTIPOINT' | 'MULTISEGMENT' | 'POINT' | 'SEGMENT'

export type DicomWaveformSequence = {
    ChannelDefinitionSequence: DicomChannelDefinitionSequence[]
    MultiplexGroupLabel: string // Upper-case e.g. "EEG"
    NumberOfWaveformChannels: number
    NumberOfWaveformSamples: number
    SamplingFrequency: number
    WaveformBitsAllocated: 16 | 32
    WaveformData: ArrayBuffer[]
    WaveformOriginality: 'DERIVED' | 'ORIGINAL'
    WaveformSampleInterpretation: 'LS' | 'SS'
    WaveformPaddingValue?: number
}
