/**
 * Epicurrents DICOM reader.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

//import type { DicomHeader } from '#types'
import { GenericSignalReader } from '@epicurrents/core'
import { AppSettings, SignalCachePart, SignalDataReader } from '@epicurrents/core/dist/types'
import DicomDecoder from '#dicom/DicomDecoder'
import { annotationsToBiosignalAnnotations } from '#util'
import type { DicomDataset } from '#types'
import * as dcmjs from 'dcmjs'
import { Log } from 'scoped-event-log/dist/Log'

const SCOPE = 'DicomReader'

export default class DicomReader extends GenericSignalReader implements SignalDataReader {
    protected _fileTypeHeader: DicomDataset | null = null
    protected _decoder: DicomDecoder | null = null
    /** A method to pass update messages through. */
    protected _updateCallback = null as ((update: { [prop: string]: unknown }) => void) | null
    /** Settings must be kept up-to-date with the main application. */
    SETTINGS: AppSettings

    constructor (settings: AppSettings) {
        super(Uint8Array)
        this.SETTINGS = settings
    }

    protected _updateCache () {
        if (!this._fileTypeHeader || !this._cache) {
            Log.error(`No DICOM dataset or cache available to update.`, SCOPE)
            return false
        }
        this._decoder ??= new DicomDecoder(this._fileTypeHeader)
        const data = this._decoder.decodeData(this._fileTypeHeader)
        if (!data?.signals) {
            Log.error(`Failed to decode DICOM dataset.`, SCOPE)
            return false
        }
        const part = {
            start: 0,
            end: this._totalDataLength,
            signals: data.signals.map((sig) => {
                return {
                    data: new Float32Array(sig),
                    samplingRate: this._fileTypeHeader!.WaveformSequence[0].SamplingFrequency,
                }
            })
        } as SignalCachePart
        this._cache.insertSignals(part)
        if (this._updateCallback) {
            // Notify that the cache has been updated.
            this._updateCallback({
                action: 'cache-signals',
                annotations: annotationsToBiosignalAnnotations(this._fileTypeHeader.WaveformAnnotationSequence),
                // DICOM files dont't have interruptions.
                interruptions: [],
                range: [0, this._totalRecordingLength],
                success: true,
            })
        }
        return true
    }

    async cacheSignals(): Promise<boolean> {
        return this._updateCache()
    }

    /**
     * Set up study params for file loading. This will initializes the shared array buffer.
     * @param source - Source URL or File of the DICOM data file.
     * @returns Success (true/false).
     */
    async setupStudy (source: string | File): Promise<boolean> {
        if (typeof source === 'string') {
            const response = await fetch(source)
            if (!response.ok) {
                Log.error(`Failed to fetch DICOM file from ${source}.`, SCOPE)
                return false
            }
            const arrayBuffer = await response.arrayBuffer()
            const dicom = await dcmjs.data.DicomMessage.readFile(arrayBuffer)
            const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict) as DicomDataset
            if (!dataset) {
                Log.error(`Failed to read DICOM file from ${source}.`, SCOPE)
                return false
            }
            this._fileTypeHeader = dataset
        } else if (source instanceof File) {
            const dicom = await dcmjs.data.DicomMessage.readFile(source.arrayBuffer())
            const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict) as DicomDataset
            if (!dataset) {
                Log.error(`Failed to read DICOM file ${source.name}.`, SCOPE)
                return false
            }
            this._fileTypeHeader = dataset
        } else {
            Log.error(`Invalid source type for DICOM setup: ${typeof source}.`, SCOPE)
            return false
        }
        const ws = this._fileTypeHeader.WaveformSequence[0]
        if (!ws || !ws.WaveformData || !ws.WaveformData[0]) {
            Log.error(`No waveform data found in the DICOM dataset.`, SCOPE)
            return false
        }
        this._decoder = new DicomDecoder(this._fileTypeHeader)
        this._totalDataLength = Math.ceil(ws.NumberOfWaveformSamples/ws.SamplingFrequency)
        this._totalRecordingLength = Math.ceil(ws.NumberOfWaveformSamples/ws.SamplingFrequency)
        return true
    }

}
