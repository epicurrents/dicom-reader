/**
 * Epicurrents DICOM decoder. For the time being this really just provides a typed interface to dcmjs.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */


import type { FileDecoder } from '@epicurrents/core/dist/types'
import type { DicomDataset } from '#types'
import { annotationsToBiosignalAnnotations } from '#util'
import DicomDatasetRecord from '#dicom/DicomDatasetRecord'
import { Log } from 'scoped-event-log'

const SCOPE = 'DicomDecoder'

export default class DicomDecoder implements FileDecoder {
    protected _dataset: DicomDataset | null = null
    protected _input: ArrayBuffer | null = null
    protected _output: null | DicomDatasetRecord = null

    constructor (dataset: DicomDataset) {
        this._dataset = dataset
    }

    get output (): DicomDatasetRecord | null {
        return this._output
    }

    decodeData (dataset = this._dataset) {
        if (!dataset) {
            Log.error('No DICOM dataset available to decode data from.', SCOPE)
            return null
        }
        if (dataset.WaveformSequence[0].WaveformData[0]) {
            this._input = dataset.WaveformSequence[0].WaveformData[0]
        }
        if (!this._input) {
            Log.error('No waveform data found in the DICOM dataset.', SCOPE)
            return null
        }
        if (dataset.WaveformPresentationGroupSequence) {
            Log.error('Waveform presentation group sequence is not supported yet.', SCOPE)
            return null
        }
        const ws = dataset.WaveformSequence[0]
        if (!(this._input instanceof ArrayBuffer)) {
            Log.error('Input must be an ArrayBuffer.', SCOPE)
            return null
        }
        const sampleBytes = ws.WaveformBitsAllocated/8
        const sampleLen = this._input.byteLength/sampleBytes
        if (sampleLen%ws.NumberOfWaveformChannels) {
            Log.error(
                `Input data length ${this._input.byteLength} is not divisible by the number of waveform channels ` +
                `${ws.NumberOfWaveformChannels}.`,
                SCOPE
            )
            return null
        }
        if (sampleLen/ws.NumberOfWaveformChannels !== ws.NumberOfWaveformSamples) {
            Log.error(
                `Input data sample length ${sampleLen} divided by the number of waveform channels ` +
                `${ws.NumberOfWaveformChannels} does not match the number of waveform samples ` +
                `${ws.NumberOfWaveformSamples}.`,
                SCOPE
            )
            return null
        }
        // Separate multiplex data to each channel.
        const digChannels = [] as Int16Array[]
        const physChannels = [] as Float32Array[]
        const maxSamples = this._input.byteLength/ws.NumberOfWaveformChannels
        for (let i=0; i<ws.NumberOfWaveformChannels; i++) {
            const channel = ws.ChannelDefinitionSequence[i]
            const channelOffset = channel.ChannelOffset || 0
            const sampleSkew = (channel.ChannelSampleSkew || 0) + channelOffset*ws.SamplingFrequency
            const timeSkew = (channel.ChannelTimeSkew || 0) + channelOffset
            const nSamples = Math.min(
                maxSamples - sampleSkew,
                maxSamples - timeSkew*ws.SamplingFrequency
            )
            Log.debug(`Channel ${i} has a skew of ${sampleSkew} samples / ${timeSkew} seconds.`, SCOPE)
            digChannels.push(new Int16Array(new ArrayBuffer(nSamples*2)))
            physChannels.push(new Float32Array(new ArrayBuffer(nSamples*4)))
        }
        const multiplexArray = new Int16Array(this._input)
        for (let i=0; i<ws.NumberOfWaveformSamples; i++) {
            for (let j=0; j<ws.NumberOfWaveformChannels; j++) {
                const channel = ws.ChannelDefinitionSequence[j]
                const channelOffset = channel.ChannelOffset || 0
                const sampleSkew = (channel.ChannelSampleSkew || 0) + channelOffset*ws.SamplingFrequency
                const timeSkew = (channel.ChannelTimeSkew || 0) + channelOffset
                const sampleTime = i/ws.SamplingFrequency
                if (i < sampleSkew || sampleTime < timeSkew) {
                    // Channel data is starting later.
                    continue
                }
                const sampleOffset = i*ws.NumberOfWaveformChannels + j
                const sampleValue = multiplexArray[sampleOffset]
                if (
                    isNaN(sampleValue)
                    || sampleValue < -32768 || sampleValue > 32767
                    || sampleValue === Infinity || sampleValue === -Infinity
                ) {
                    Log.warn(`Sample value at index ${i} for channel ${j} is not valid.`, SCOPE)
                    digChannels[j][i] = 0
                    physChannels[j][i] = 0
                    continue
                }
                digChannels[j][i] = sampleValue
                if (sampleValue === ws.WaveformPaddingValue) {
                    // Use zero as a visual padding value.
                    physChannels[j][i] = 0
                    continue
                }
                // Convert digital sample to a floating point value.
                const physValue = sampleValue*ws.ChannelDefinitionSequence[j].ChannelSensitivity
                                  * ws.ChannelDefinitionSequence[j].ChannelSensitivityCorrectionFactor
                                  - ws.ChannelDefinitionSequence[j].ChannelBaseline
                // Directly assigning the values is considerably faster than using `set()`.
                physChannels[j][i] = physValue
            }
        }
        return {
            annotations: annotationsToBiosignalAnnotations(dataset.WaveformAnnotationSequence),
            interruptions: [], // DICOM waveform sequence does not have interruptions.
            signals: physChannels,
        }
    }
    decodeHeader (dataset = this._dataset): DicomDataset | null {
        if (!dataset) {
            Log.error('No DICOM dataset available to decode header.', SCOPE)
            return null
        }
        const header = {
            ...dataset,
            WaveformSequence: [
                {
                    ...dataset.WaveformSequence[0],
                    WaveformData: [], // Remove the actual data fromt the header to save memory.
                }
            ]
        }
        this._output = new DicomDatasetRecord(header)
        return header
    }
    decode () {
        const data = this._input ? this.decodeData(this._dataset as DicomDataset) : null
        this._output = new DicomDatasetRecord(
            this._dataset as DicomDataset,
            [],
            data?.signals || [],
        )
        return {
            data,
            header: this.decodeHeader(),
        }
    }
    setInput (buffer: ArrayBuffer): void {
        this._input = buffer
    }

}
