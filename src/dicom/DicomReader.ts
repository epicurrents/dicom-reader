/**
 * Epicurrents DICOM reader.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

//import type { DicomHeader } from '#types'
import { GenericSignalReader } from '@epicurrents/core'
import { AppSettings, SignalCachePart, SignalSourceOptions, SignalStudyReader } from '@epicurrents/core/dist/types'
import DicomDecoder from '#dicom/DicomDecoder'
import { eventsToBiosignalEvents } from '#util'
import type { DicomDataset } from '#types'
import * as dcmjs from 'dcmjs'
import { Log } from 'scoped-event-log/dist/Log'

const SCOPE = 'DicomReader'

export default class DicomReader extends GenericSignalReader implements SignalStudyReader {
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

    /**
     * Fetch the full DICOM file from the source URL. Returns null when there is no URL to fetch from
     * or the request fails; the caller reports the failure with the source name it already has.
     */
    protected async _fetchSource (source: SignalSourceOptions): Promise<ArrayBuffer | null> {
        if (!source.url) {
            Log.error(`Neither a source file nor a source URL was given for the DICOM study.`, SCOPE)
            return null
        }
        const headers = new Headers()
        if (source.authHeader) {
            headers.set('Authorization', source.authHeader)
        }
        const response = await fetch(source.url, { headers })
        if (!response.ok) {
            Log.error(`Failed to fetch DICOM file from ${source.url} (HTTP ${response.status}).`, SCOPE)
            return null
        }
        return response.arrayBuffer()
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
                events: eventsToBiosignalEvents(this._fileTypeHeader.WaveformAnnotationSequence),
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

    async setupStudy (source: SignalSourceOptions): Promise<boolean> {
        const sourceName = source.file?.name || source.url || 'DICOM source'
        try {
            const arrayBuffer = source.file
                                ? await source.file.arrayBuffer()
                                : await this._fetchSource(source)
            if (!arrayBuffer) {
                return false
            }
            const dicom = await dcmjs.data.DicomMessage.readFile(arrayBuffer)
            const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict) as DicomDataset
            if (!dataset) {
                Log.error(`Failed to read DICOM file from ${sourceName}.`, SCOPE)
                return false
            }
            this._fileTypeHeader = dataset
        } catch (e: unknown) {
            // A transport or read failure (offline, DNS, CORS, TLS, a file that moved) must resolve
            // to false, not reject up into the worker handler where no reply would be posted and the
            // commission hangs.
            Log.error(`Failed to load DICOM file from ${sourceName}: ${(e as Error).message}.`, SCOPE)
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
