/**
 * Epicurrents DICOM reader.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericSignalReader } from '@epicurrents/core'
import { AppSettings, SignalCachePart, SignalSourceOptions, SignalStudyReader } from '@epicurrents/core/types'
import DicomDecoder from '#dicom/DicomDecoder'
import { headerToBiosignalHeader } from '#util'
import type { DicomDataset } from '#types'
import * as dcmjs from 'dcmjs'
import { Log } from 'scoped-event-log'

const SCOPE = 'DicomReader'

export default class DicomReader extends GenericSignalReader implements SignalStudyReader {
    protected _decoder: DicomDecoder | null = null
    protected _fileTypeHeader: DicomDataset | null = null
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

    protected async _updateCache () {
        if (!this._fileTypeHeader || !this._cache) {
            Log.error(`No DICOM dataset or cache available to update.`, SCOPE)
            return false
        }
        const waveform = this._fileTypeHeader.WaveformSequence[0]
        this._decoder ??= new DicomDecoder(this._fileTypeHeader)
        const data = this._decoder.decodeData(this._fileTypeHeader)
        if (!data?.signals.length) {
            Log.error(`Failed to decode DICOM dataset.`, SCOPE)
            return false
        }
        const part = {
            start: 0,
            // The signals hold exactly the samples the file declares, so the part ends at the true
            // data extent rather than at the cache extent, which is padded up to a whole data unit.
            end: this._totalRecordingLength,
            signals: data.signals.map(signal => {
                return {
                    data: new Float32Array(signal),
                    samplingRate: waveform.SamplingFrequency,
                }
            })
        } as SignalCachePart
        // Every cache implementation writes asynchronously — the mutex-backed one takes a lock —
        // so the write has to finish before the update is announced, or a consumer acting on the
        // announcement reads the range before the samples are in it.
        await this._cache.insertSignals(part)
        if (this._updateCallback) {
            // Notify that the cache has been updated.
            this._updateCallback({
                action: 'cache-signals',
                events: data.events ?? [],
                // DICOM files don't have interruptions.
                interruptions: [],
                range: [0, this._totalRecordingLength],
                success: true,
            })
        }
        return true
    }

    async cacheSignals (): Promise<boolean> {
        return this._updateCache()
    }

    async setupStudy (source: SignalSourceOptions): Promise<boolean> {
        const sourceName = source.file?.name || source.url || 'DICOM source'
        let dataset: DicomDataset
        try {
            const arrayBuffer = source.file
                                ? await source.file.arrayBuffer()
                                : await this._fetchSource(source)
            if (!arrayBuffer) {
                return false
            }
            const dicom = dcmjs.data.DicomMessage.readFile(arrayBuffer)
            dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict) as DicomDataset
            if (!dataset) {
                Log.error(`Failed to read DICOM file from ${sourceName}.`, SCOPE)
                return false
            }
        } catch (e: unknown) {
            // A transport or read failure (offline, DNS, CORS, TLS, a file that moved) must resolve
            // to false, not reject up into the worker handler where no reply would be posted and the
            // commission hangs. A malformed file reaches here the same way.
            Log.error(`Failed to load DICOM file from ${sourceName}: ${(e as Error).message}.`, SCOPE)
            return false
        }
        const waveform = dataset.WaveformSequence?.[0]
        if (!waveform?.WaveformData?.[0]) {
            Log.error(`No waveform data found in the DICOM dataset from ${sourceName}.`, SCOPE)
            return false
        }
        const { NumberOfWaveformChannels: channelCount, NumberOfWaveformSamples: sampleCount } = waveform
        if (!channelCount || !sampleCount || !waveform.SamplingFrequency) {
            Log.error(
                `The DICOM dataset from ${sourceName} does not describe its waveform: ${channelCount} ` +
                `channels, ${sampleCount} samples at ${waveform.SamplingFrequency} Hz.`,
                SCOPE
            )
            return false
        }
        this._fileTypeHeader = dataset
        this._decoder = new DicomDecoder(dataset)
        // The base class drives its cache layout off the biosignal header, so from here the study
        // behaves like any other reader-backed source.
        this._header = headerToBiosignalHeader(dataset)
        // Data-unit shape, at the same one-second granularity the other non-streaming readers use.
        // `_dataUnitSize` is the cached Float32 footprint of a second rather than the file's own
        // bytes per second, because what it budgets is the cache and not the read.
        this._dataUnitDuration = 1
        this._dataUnitSize = waveform.SamplingFrequency*channelCount*4
        this._chunkUnitCount = this._dataUnitSize*2 < this.SETTINGS.app.dataChunkSize
            ? Math.floor(this.SETTINGS.app.dataChunkSize/this._dataUnitSize) - 1
            : 1
        // The cache extent is padded up to whole data units because the mutex stores its range end
        // as an `Int32`, and an insert crossing the truncated boundary trips an out-of-bounds
        // warning. The reported recording length is the true extent, which may end mid-unit;
        // reporting the padded one instead advertises a partial-second tail that holds no data.
        this._dataUnitCount = Math.ceil(sampleCount/waveform.SamplingFrequency)
        this._totalDataLength = this._dataUnitCount*this._dataUnitDuration
        this._totalRecordingLength = sampleCount/waveform.SamplingFrequency
        this._discontinuous = false
        this._url = source.url || ''
        if (source.authHeader) {
            this._authHeader = source.authHeader
        }
        Log.debug(
            `DICOM setup complete for ${sourceName}: ${channelCount} channels, ${sampleCount} samples ` +
            `at ${waveform.SamplingFrequency} Hz.`,
            SCOPE
        )
        return true
    }

}
