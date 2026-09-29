/**
 * Epicurrents DICOM types.
 *
 * The shapes here describe a DICOM waveform instance as `dcmjs` presents it after
 * `DicomMetaDictionary.naturalizeDataset`: attribute keywords as property names, sequences as
 * arrays of items, and person names as objects rather than caret-delimited strings.
 *
 * Optionality follows the attribute types the standard assigns: type 1 attributes are declared
 * required, type 1C, 2 and 3 optional. A non-conforming instance can omit anything at all, which is
 * why the reader treats even required attributes defensively rather than trusting this file.
 *
 * Two properties of `dcmjs`'s naturalization shape these declarations more than the standard does.
 * An **empty type 2 attribute becomes `null`**, not an empty string, so every attribute the standard
 * allows to be empty is declared `| null`. And a **single-valued attribute is unwrapped to a
 * scalar**, so an attribute the standard allows several values for arrives as a bare value when the
 * instance carries one — which is why the multi-valued annotation attributes are declared as a union
 * with their element type and must be normalised before use.
 *
 * A single-*item* sequence is not unwrapped the same way: `dcmjs` leaves the array in place and
 * copies the item's properties onto it, so indexing a sequence with `[0]` is safe.
 *
 * @privateRemarks
 * Waveform module and channel definitions: PS3.3 C.10.9.
 * Waveform annotation: PS3.3 C.10.10, temporal coordinates PS3.3 C.18.7.
 * Code sequence macro: PS3.3 8.1.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * One item of a waveform annotation sequence.
 *
 * An annotation carries its content either as free text in `UnformattedTextValue` or as a code in
 * `ConceptNameCodeSequence`; the two are mutually exclusive, so both are optional here and at least
 * one is present in a conforming instance.
 *
 * Temporal placement is equally conditional. `TemporalRangeType` is absent when the annotation
 * applies to the whole temporal extent of the referenced channels, and present otherwise, in which
 * case exactly one of `ReferencedSamplePositions`, `ReferencedTimeOffsets` or `ReferencedDateTime`
 * accompanies it.
 *
 * @privateRemarks
 * https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.10.10.html
 */
export type DicomAnnotationSequence = {
    /**
     * Multiplex group number and channel number **pairs** — a flat list of two values per referenced
     * channel, not a list of channel numbers. A channel number of 0 refers to every channel in the
     * named multiplex group.
     */
    ReferencedWaveformChannels: number | number[]
    /** Logical grouping of several annotations. */
    AnnotationGroupNumber?: number
    /** Coded value of the annotation. Only a single item is permitted. */
    ConceptCodeSequence?: DicomCodeSequenceItem[]
    /** Coded name of the annotation, mutually exclusive with `UnformattedTextValue`. Single item. */
    ConceptNameCodeSequence?: DicomCodeSequenceItem[]
    /** Units of `NumericValue`. Only a single item is permitted. */
    MeasurementUnitsCodeSequence?: DicomCodeSequenceItem[]
    /** Numeric measurement value(s) carried by the annotation. */
    NumericValue?: number | number[]
    /** Absolute acquisition time(s) of the annotated point(s), `YYYYMMDDHHMMSS.FFFFFF`. */
    ReferencedDateTime?: string | string[]
    /**
     * Sample position(s) of the annotated point(s), **one-based**. Usable only when the referenced
     * channels all lie within a single multiplex group.
     */
    ReferencedSamplePositions?: number | number[]
    /** Offset(s) of the annotated point(s) in seconds from the start of the data. */
    ReferencedTimeOffsets?: number | number[]
    /** Absent when the annotation applies to the whole extent of the referenced channels. */
    TemporalRangeType?: DicomTemporalRangeType
    /** Free-text value, mutually exclusive with `ConceptNameCodeSequence`. */
    UnformattedTextValue?: string
}

/**
 * One item of a channel definition sequence, describing a single waveform channel.
 *
 * The calibration attributes form a conditional group: `ChannelSensitivity` is present only when
 * the samples represent defined physical units, and `ChannelSensitivityUnitsSequence`,
 * `ChannelSensitivityCorrectionFactor` and `ChannelBaseline` are present exactly when it is. A
 * channel without them carries uncalibrated sample values.
 *
 * @privateRemarks
 * https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.10.9.html
 */
export type DicomChannelDefinitionSequence = {
    /** Coded descriptor of the signal source. Exactly one item. */
    ChannelSourceSequence: DicomCodeSequenceItem[]
    /** Number of significant bits in each sample, at most `WaveformBitsAllocated`. */
    WaveformBitsStored: number
    /** Offset of a sample value of zero, in the units of `ChannelSensitivityUnitsSequence`. */
    ChannelBaseline?: number
    /** Free-text description of how a derived channel was produced. */
    ChannelDerivationDescription?: string
    /** Electrode impedance measurements for this channel. */
    ChannelImpedanceSequence?: DicomChannelImpedanceSequence[]
    /** Display label, conventionally `"<modality> <label>-(<reference>)"`, e.g. `"EEG Fp1-(A1~A2)"`. */
    ChannelLabel?: string
    /** Largest sample value the acquisition equipment can represent. */
    ChannelMaximumValue?: number
    /** Smallest sample value the acquisition equipment can represent. */
    ChannelMinimumValue?: number
    /** Additional offset of this channel's samples from the multiplex group start, in seconds. */
    ChannelOffset?: number
    /** Skew of this channel's samples within the multiplex group, in samples. */
    ChannelSampleSkew?: number
    /** Physical units one sample value step represents. Present when the samples are calibrated. */
    ChannelSensitivity?: number
    /** Multiplier applied to `ChannelSensitivity` to correct for calibration. */
    ChannelSensitivityCorrectionFactor?: number
    /** Units of `ChannelSensitivity`. Exactly one item when present. */
    ChannelSensitivityUnitsSequence?: DicomCodeSequenceItem[]
    /** Refinements of `ChannelSourceSequence`, such as the reference a derivation was taken against. */
    ChannelSourceModifiersSequence?: DicomCodeSequenceItem[]
    /** Acquisition status of the channel. */
    ChannelStatus?: DicomChannelStatus
    /** Skew of this channel's samples within the multiplex group, in seconds. */
    ChannelTimeSkew?: number
    /** High-pass cutoff of the acquisition filter, in Hz. Forbidden for a DC amplifier. */
    FilterHighFrequency?: number
    /** Low-pass cutoff of the acquisition filter, in Hz. Forbidden for a DC amplifier. */
    FilterLowFrequency?: number
    /** Width of the notch filter, in Hz. */
    NotchFilterBandwidth?: number
    /** Centre frequency of the notch filter, in Hz. */
    NotchFilterFrequency?: number
    /** Coupling of the amplifier the channel was acquired with. */
    WaveformAmplifierType?: 'AC' | 'DC'
    /** Physical channel number on the acquisition equipment. */
    WaveformChannelNumber?: number
}

/** One electrode impedance measurement of a waveform channel. */
export type DicomChannelImpedanceSequence = {
    /** Time the impedance was measured, `YYYYMMDDHHMMSS.FFFFFF`. */
    ImpedanceMeasurementDateTime: string
    /** Measured impedance, in ohms. */
    ImpedanceValue: number
    /** Whether the measurement current was alternating or direct. */
    ImpedanceMeasurementCurrentType?: 'AC' | 'DC'
    /** Frequency the impedance was measured at, in Hz. */
    ImpedanceMeasurementFrequency?: number
}

/** Acquisition status of a waveform channel. */
export type DicomChannelStatus = 'DISCONNECTED' | 'INVALID' | 'OK' | 'QUESTIONABLE' | 'TEST DATA'
                                 | 'UNCALIBRATED' | 'UNZEROED'

/**
 * One item of any coded-value sequence.
 *
 * `CodeMeaning` is the human-readable text and is always present. `CodeValue` and
 * `CodingSchemeDesignator` are present unless the code is carried by `LongCodeValue` or
 * `URNCodeValue` instead, which is why neither can be relied on.
 *
 * @privateRemarks
 * https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_8.1.html
 */
export type DicomCodeSequenceItem = {
    /** Human-readable meaning of the code, e.g. `"microvolt"`. */
    CodeMeaning: string
    /** The code itself, e.g. `"uV"`. Absent when `LongCodeValue` or `URNCodeValue` carries it. */
    CodeValue?: string
    /** Registry the code belongs to, e.g. `"UCUM"`. */
    CodingSchemeDesignator?: string
    /** Version of the coding scheme, when the designator alone is ambiguous. */
    CodingSchemeVersion?: string
    /** Code too long for the 16-byte `CodeValue`. */
    LongCodeValue?: string
    /** Code expressed as a URN or URI. */
    URNCodeValue?: string
}

/**
 * A naturalized DICOM waveform instance.
 *
 * Only the attributes a waveform instance is required to carry are declared required here; the
 * modality-specific waveform IODs add more, and any of them may be absent from a non-conforming
 * instance.
 */
export type DicomDataset = {
    /** Time the waveform data acquisition started, `YYYYMMDDHHMMSS.FFFFFF`. */
    AcquisitionDateTime: string
    /** Instance number within the series. */
    InstanceNumber: number
    /** Modality of the instance, upper-case, e.g. `"EEG"`. */
    Modality: string
    /** Waveform multiplex groups, in significant order. At least one item. */
    WaveformSequence: DicomWaveformSequence[]
    /** Order number of an imaging service request. May be empty. */
    AccessionNumber?: string | null
    /** Observation context of the acquisition. May be empty. */
    AcquisitionContextSequence?: unknown[] | null
    /** Whether acquisition was synchronized with an external time reference. */
    AcquisitionTimeSynchronized?: string
    /** Admission identifier. May be empty. */
    AdmissionID?: string | null
    /** Date the instance content was created, `YYYYMMDD`. */
    ContentDate?: string
    /** Time the instance content was created, `HHMMSS.FFFFFF`. */
    ContentTime?: string
    /** Serial number of the acquisition equipment. */
    DeviceSerialNumber?: string
    /** Date the instance was created, `YYYYMMDD`. */
    InstanceCreationDate?: string
    /** Time the instance was created, `HHMMSS.FFFFFF`. */
    InstanceCreationTime?: string
    /** UID of the equipment that created the instance. */
    InstanceCreatorUID?: string
    /** Manufacturer of the acquisition equipment. May be empty. */
    Manufacturer?: string | null
    /** Model name of the acquisition equipment. */
    ManufacturerModelName?: string
    /** Subject's date of birth, `YYYYMMDD`. May be empty. */
    PatientBirthDate?: string | null
    /** Subject identifier. May be empty. */
    PatientID?: string | null
    /** Subject name. May be empty. */
    PatientName?: DicomPersonName | DicomPersonName[] | null
    /** Subject's sex, `M`, `F` or `O`. May be empty. */
    PatientSex?: string | null
    /** Referring physician's name. May be empty. */
    ReferringPhysicianName?: DicomPersonName | DicomPersonName[] | null
    /** Series number within the study. May be empty. */
    SeriesNumber?: number | null
    /** UID of the series the instance belongs to. */
    SeriesInstanceUID?: string
    /** Version of the software that produced the instance. */
    SoftwareVersions?: string
    /** UID of the SOP class the instance conforms to. */
    SOPClassUID?: string
    /** UID of this instance. */
    SOPInstanceUID?: string
    /** Character sets used by the instance's text values, e.g. `"ISO_IR 100"` or `"ISO_IR 192"`. */
    SpecificCharacterSet?: string
    /** Date the study started, `YYYYMMDD`. May be empty. */
    StudyDate?: string | null
    /** Description of the study. */
    StudyDescription?: string
    /** Study identifier. May be empty. */
    StudyID?: string | null
    /** UID of the study the instance belongs to. */
    StudyInstanceUID?: string
    /** Time the study started, `HHMMSS.FFFFFF`. May be empty. */
    StudyTime?: string | null
    /** UID of the time reference the acquisition was synchronized against. */
    SynchronizationFrameOfReferenceUID?: string
    /** How the acquisition was triggered, e.g. `"NO TRIGGER"`. */
    SynchronizationTrigger?: string
    /** Annotations on the waveform data. Absent when the instance carries none. */
    WaveformAnnotationSequence?: DicomAnnotationSequence[]
    /** Display grouping of the waveform channels. */
    WaveformPresentationGroupSequence?: unknown[]
}

/**
 * A person name as `dcmjs` naturalizes it: the caret-delimited components of one of the name's three
 * representations, each present only when the source string carried it.
 */
export type DicomPersonName = {
    /** The name in the instance's primary character set, `Last^First^Middle^Prefix^Suffix`. */
    Alphabetic?: string
    /** Ideographic representation of the name. */
    Ideographic?: string
    /** Phonetic representation of the name. */
    Phonetic?: string
}

/**
 * Temporal extent an annotation applies to, and with it the number of positions the accompanying
 * `ReferencedTimeOffsets`, `ReferencedSamplePositions` or `ReferencedDateTime` carries:
 * - `POINT` — a single instant, one position.
 * - `MULTIPOINT` — several instants, one position each.
 * - `SEGMENT` — a range, two positions delimiting it.
 * - `MULTISEGMENT` — several ranges, two positions each.
 * - `BEGIN` — a range starting at one position and continuing past the end of the data.
 * - `END` — a range starting before the data and ending at one position.
 *
 * @privateRemarks
 * https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.18.7.html
 */
export type DicomTemporalRangeType = 'BEGIN' | 'END' | 'MULTIPOINT' | 'MULTISEGMENT' | 'POINT' | 'SEGMENT'

/**
 * How the bits of each waveform sample are to be read. The code determines both the width and the
 * signedness, and must agree with `WaveformBitsAllocated`:
 * - 8 bits — `SB` signed, `UB` unsigned, `MB` mu-law, `AB` A-law.
 * - 16 bits — `SS` signed, `US` unsigned.
 * - 32 bits — `SL` signed, `UL` unsigned.
 * - 64 bits — `SV` signed, `UV` unsigned.
 *
 * The two companded 8-bit forms are ITU-T G.711 audio encodings and are not linear.
 */
export type DicomWaveformSampleInterpretation = 'AB' | 'MB' | 'SB' | 'SL' | 'SS' | 'SV'
                                                | 'UB' | 'UL' | 'US' | 'UV'

/**
 * One waveform multiplex group: a set of channels sharing a sampling frequency, with their samples
 * interleaved channel by channel in `WaveformData`.
 */
export type DicomWaveformSequence = {
    /** Definitions of this group's channels, in the order their samples are interleaved. */
    ChannelDefinitionSequence: DicomChannelDefinitionSequence[]
    /** Number of channels interleaved in `WaveformData`. */
    NumberOfWaveformChannels: number
    /** Number of samples **per channel**. */
    NumberOfWaveformSamples: number
    /** Sampling frequency shared by every channel of the group, in Hz. */
    SamplingFrequency: number
    /** Bits each sample occupies: 8, 16, 32 or 64. */
    WaveformBitsAllocated: 8 | 16 | 32 | 64
    /** The interleaved samples. One item in practice. */
    WaveformData: ArrayBuffer[]
    /** Whether the waveform is as acquired or was derived from another. */
    WaveformOriginality: 'DERIVED' | 'ORIGINAL'
    /** How to read the bits of each sample; must agree with `WaveformBitsAllocated`. */
    WaveformSampleInterpretation: DicomWaveformSampleInterpretation
    /** Offset of this group from the acquisition time reference, in milliseconds. */
    MultiplexGroupTimeOffset?: number
    /** UID identifying this group where it is shared between instances. */
    MultiplexGroupUID?: string
    /** Display label of the group, upper-case, e.g. `"EEG"`. */
    MultiplexGroupLabel?: string
    /** Mains frequency at the acquisition site, in Hz. */
    PowerlineFrequency?: number
    /** Sample position corresponding to the trigger. */
    TriggerSamplePosition?: number
    /** Offset of the trigger from the acquisition time reference, in milliseconds. */
    TriggerTimeOffset?: number
    /** Sample value the equipment inserts where it has no data. Present only when it inserts any. */
    WaveformPaddingValue?: number
}
