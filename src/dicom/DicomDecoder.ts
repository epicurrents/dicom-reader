/**
 * Epicurrents DICOM decoder. For the time being this really just provides a typed interface to dcmjs.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { SignalDataDecoder, SignalDecodeResult } from '@epicurrents/core/types'
import type { DicomDataset, DicomWaveformSequence } from '#types'
import { eventsToBiosignalEvents, signalUnitScale } from '#util'
import DicomDatasetRecord from '#dicom/DicomDatasetRecord'
import { Log } from 'scoped-event-log'

const SCOPE = 'DicomDecoder'

/**
 * A view over the interleaved samples of a multiplex group, as its sample interpretation describes
 * them.
 *
 * Only the linear interpretations are supported. The two companded 8-bit forms are G.711 mu-law and
 * A-law, which have to be expanded rather than read, and the 64-bit widths do not fit a JavaScript
 * number without a BigInt round trip; a file using any of them is refused rather than misread.
 * @param waveform - The multiplex group whose data is being read.
 * @param buffer - The group's waveform data.
 * @returns A view over the samples, or null when the interpretation is unsupported or disagrees with the buffer.
 */
const sampleView = (waveform: DicomWaveformSequence, buffer: ArrayBuffer) => {
    let interpretation = waveform.WaveformSampleInterpretation
    if (!interpretation) {
        // The attribute is required, so a file without it is already malformed; assuming the signed
        // form of the allocated width reads the overwhelmingly common case correctly.
        interpretation = waveform.WaveformBitsAllocated === 8
                         ? 'SB'
                         : waveform.WaveformBitsAllocated === 32 ? 'SL' : 'SS'
        Log.warn(
            `The DICOM waveform declares no sample interpretation; assuming ${interpretation}.`,
            SCOPE
        )
    }
    const views = {
        SB: Int8Array,
        SL: Int32Array,
        SS: Int16Array,
        UB: Uint8Array,
        UL: Uint32Array,
        US: Uint16Array,
    }
    const view = views[interpretation as keyof typeof views]
    if (!view) {
        Log.error(`Waveform sample interpretation ${interpretation} is not supported.`, SCOPE)
        return null
    }
    if (buffer.byteLength%view.BYTES_PER_ELEMENT) {
        Log.error(
            `Waveform data of ${buffer.byteLength} bytes does not divide into ` +
            `${view.BYTES_PER_ELEMENT}-byte ${interpretation} samples.`,
            SCOPE
        )
        return null
    }
    return new view(buffer)
}

export default class DicomDecoder implements SignalDataDecoder {
    protected _dataset: DicomDataset | null = null
    protected _input: ArrayBuffer | null = null
    protected _output: null | DicomDatasetRecord = null

    constructor (dataset: DicomDataset) {
        this._dataset = dataset
    }

    get output (): DicomDatasetRecord | null {
        return this._output
    }

    decode () {
        const data = this.decodeData()
        const header = this.decodeHeader()
        if (header) {
            // `decodeHeader` leaves a record with no signals, so the decoded ones are attached here
            // rather than in a second record that would replace it.
            this._output = new DicomDatasetRecord(header, data?.signals ?? [])
        }
        return {
            data,
            header,
        }
    }

    /**
     * Decode the signals of a DICOM dataset's first multiplex group.
     *
     * The samples are read into the SI unit of their quantity, applying the channel's calibration
     * where it has one. An uncalibrated channel is passed through unscaled, since its sample values
     * carry no defined unit to convert from.
     * @param dataset - Dataset to decode, defaulting to the one the decoder was constructed with.
     * @param buffer - Waveform data to decode instead of the dataset's own (optional).
     * @returns The decoded signals with the dataset's annotations, or null if decoding failed.
     */
    decodeData (dataset = this._dataset, buffer?: ArrayBuffer): SignalDecodeResult | null {
        if (!dataset) {
            Log.error('No DICOM dataset available to decode data from.', SCOPE)
            return null
        }
        const waveform = dataset.WaveformSequence?.[0]
        if (!waveform) {
            Log.error('No waveform sequence found in the DICOM dataset.', SCOPE)
            return null
        }
        // An explicitly given buffer wins, then the dataset's own data, and only then a buffer left
        // by `setInput` — which is the only way to decode a dataset whose data has been stripped.
        const input = buffer ?? waveform.WaveformData?.[0] ?? this._input
        if (!input) {
            Log.error('No waveform data found in the DICOM dataset.', SCOPE)
            return null
        }
        if (!(input instanceof ArrayBuffer)) {
            Log.error('Waveform data must be an ArrayBuffer.', SCOPE)
            return null
        }
        this._input = input
        if (dataset.WaveformPresentationGroupSequence) {
            // The presentation group carries display preferences — channel order, colours, scales —
            // and nothing that changes the samples, so it is ignored rather than refused.
            Log.warn(
                'The DICOM dataset carries a waveform presentation group, whose display preferences ' +
                'are not applied.',
                SCOPE
            )
        }
        const channelCount = waveform.NumberOfWaveformChannels
        const sampleCount = waveform.NumberOfWaveformSamples
        if (!channelCount || !sampleCount || !waveform.SamplingFrequency) {
            Log.error(
                `The DICOM waveform does not describe its data: ${channelCount} channels, ` +
                `${sampleCount} samples at ${waveform.SamplingFrequency} Hz.`,
                SCOPE
            )
            return null
        }
        const samples = sampleView(waveform, input)
        if (!samples) {
            return null
        }
        if (samples.length%channelCount) {
            Log.error(
                `Input data length ${samples.length} is not divisible by the number of waveform ` +
                `channels ${channelCount}.`,
                SCOPE
            )
            return null
        }
        if (samples.length/channelCount !== sampleCount) {
            Log.error(
                `Input data sample length ${samples.length} divided by the number of waveform ` +
                `channels ${channelCount} does not match the number of waveform samples ` +
                `${sampleCount}.`,
                SCOPE
            )
            return null
        }
        const definitions = waveform.ChannelDefinitionSequence ?? []
        // A skew or an offset displaces a channel's samples in time relative to the rest of the
        // group. Honouring one means resampling that channel onto the group's grid, which this
        // decoder does not do, so a file declaring any is decoded as though its channels aligned.
        const displaced = definitions.filter(
            channel => channel.ChannelSampleSkew || channel.ChannelTimeSkew || channel.ChannelOffset
        ).length
        if (displaced) {
            Log.warn(
                `${displaced} of ${definitions.length} DICOM channels declare a sample skew or an ` +
                `offset, which is not applied; their samples are placed as though aligned.`,
                SCOPE
            )
        }
        // Separate the multiplexed data into each channel.
        const signals = [] as number[][]
        for (let channel=0; channel<channelCount; channel++) {
            const definition = definitions[channel]
            // The calibration attributes accompany `ChannelSensitivity` and are present only for a
            // channel whose samples represent defined units.
            const sensitivity = definition?.ChannelSensitivity ?? 1
            const correction = definition?.ChannelSensitivityCorrectionFactor ?? 1
            // The baseline is the offset of sample value zero from actual zero, in the channel's own
            // physical units, so it is added to the scaled sample rather than subtracted from it.
            const baseline = definition?.ChannelBaseline ?? 0
            const unitScale = definition ? signalUnitScale(definition) : 1
            const values = new Array<number>(sampleCount).fill(0)
            for (let i=0; i<sampleCount; i++) {
                const value = samples[i*channelCount + channel]
                if (value === waveform.WaveformPaddingValue) {
                    // Zero stands in for padding, so a gap is flat rather than a spike.
                    continue
                }
                values[i] = (value*sensitivity*correction + baseline)*unitScale
            }
            signals.push(values)
        }
        return {
            events: eventsToBiosignalEvents(dataset.WaveformAnnotationSequence, waveform),
            interruptions: new Map(), // A DICOM multiplex group cannot be interrupted.
            signals,
        }
    }

    /**
     * Decode the header of a DICOM dataset, which is the dataset without its samples.
     * @param dataset - Dataset to decode, defaulting to the one the decoder was constructed with.
     * @returns The dataset with its waveform data removed, or null if there was nothing to decode.
     */
    decodeHeader (dataset = this._dataset): DicomDataset | null {
        if (!dataset) {
            Log.error('No DICOM dataset available to decode header.', SCOPE)
            return null
        }
        const header = {
            ...dataset,
            WaveformSequence: dataset.WaveformSequence.map((waveform, index) => {
                return {
                    ...waveform,
                    // Drop the samples; the header is kept for as long as the recording is open and
                    // a copy of the data would double its footprint.
                    WaveformData: index === 0 ? [] : waveform.WaveformData,
                }
            }),
        }
        this._output = new DicomDatasetRecord(header)
        return header
    }

    setInput (buffer: ArrayBuffer): void {
        this._input = buffer
    }
}
