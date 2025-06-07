/**
 * Epicurrents DICOM reader.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

//import type { DicomHeader } from '#types'
import { BiosignalCache, BiosignalMutex, GenericSignalReader } from '@epicurrents/core'
import { AppSettings, ConfigChannelFilter, SignalCachePart, SignalDataReader } from '@epicurrents/core/dist/types'
import DicomDecoder from '#dicom/DicomDecoder'
import { annotationsToBiosignalAnnotations } from '#util'
import type { DicomDataset } from '#types'
import * as dcmjs from 'dcmjs'
import { Log } from 'scoped-event-log/dist/Log'
import { type MutexExportProperties } from 'asymmetric-io-mutex'

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
            return
        }
        this._decoder ??= new DicomDecoder(this._fileTypeHeader)
        const data = this._decoder.decodeData(this._fileTypeHeader)
        if (!data?.signals) {
            Log.error(`Failed to decode DICOM dataset.`, SCOPE)
            return
        }
        const part = {
            start: 0,
            end: this._totalDataLength,
            signals: data.signals.map((sig) => {
                return {
                    data: sig,
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
    }

    /**
     * Cache data from the given file.
     * @param file - Optional file to cache signals from (defaults to cached dataset).
     * @returns Promise that resolves when the file is cached.
     */
    async cacheFile (file?: File) {
        if (file && !this.setupStudy(file)) {
            Log.error(`Failed to cache data from file ${file.name}.`, SCOPE)
            return
        }
        if (!this._fileTypeHeader) {
            Log.error(`No DICOM dataset available to cache data from.`, SCOPE)
            return
        }
        this._updateCache()
    }
    /**
     * Cache data from the given URL.
     * @param url - Optional URL of the DICOM file to cache signals from (defaults to cached dataset).
     * @returns Success (true/false).
     */
    async cacheUrl (url?: string): Promise<boolean> {
        if (url && !this.setupStudy(url)) {
            Log.error(`Failed to cache data from URL ${url}.`, SCOPE)
            return false
        }
        if (!this._fileTypeHeader) {
            Log.error(`No DICOM dataset available to cache signals from.`, SCOPE)
            return false
        }
        this._updateCache()
        return true
    }

    async getSignals(range: number[], config?: ConfigChannelFilter): Promise<SignalCachePart | null> {
        if (!this._fileTypeHeader || !this._cache) {
            Log.error("Cannot load signals, signal cache has not been set up yet.", SCOPE)
            return null
        }
        if (this._mutex && !this._isMutexReady) {
            Log.error(`Cannot load signals before signal cache has been initiated.`, SCOPE)
            return null
        }
        if (range[0] === range[1]) {
            Log.error(`Cannot load signals from an empty range ${range[0]} - ${range[1]}.`, SCOPE)
            return null
        }
        const requestedSigs = await this._cache.asCachePart()
        // Filter channels, if needed.
        const included = [] as number[]
        // Prioritize include -> only process those channels.
        if (config?.include?.length) {
            for (let i=0; i<requestedSigs.signals.length; i++) {
                if (config.include.indexOf(i) !== -1) {
                    included.push(i)
                } else {
                    Log.debug(`Not including channel #${i} in requested signals.`, SCOPE)
                }
            }
        } else if (config?.exclude?.length) {
            for (let i=0; i<requestedSigs.signals.length; i++) {
                if (config.exclude.indexOf(i) === -1) {
                    included.push(i)
                } else {
                    Log.debug(`Excuding channel #${i} from requested signals.`, SCOPE)
                }
            }
        }
        const responseSigs = {
            start: requestedSigs.start,
            end: requestedSigs.end,
            signals: [],
        } as SignalCachePart
        const rangeStart = range[0]
        const rangeEnd = range[1]
        for (let i=0; i<requestedSigs.signals.length; i++) {
            if (included.length && included.indexOf(i) === -1) {
                continue
            }
            const signalForRange = new Float32Array(
                Math.round((range[1] - range[0])*requestedSigs.signals[i].samplingRate)
            ).fill(0.0)
            const startSignalIndex = Math.round(
                (rangeStart - requestedSigs.start)*requestedSigs.signals[i].samplingRate
            )
            const endSignalIndex = Math.round(
                (rangeEnd - requestedSigs.start)*requestedSigs.signals[i].samplingRate
            )
            signalForRange.set(requestedSigs.signals[i].data.slice(startSignalIndex, endSignalIndex))
            responseSigs.signals.push({
                data: signalForRange,
                samplingRate: requestedSigs.signals[i].samplingRate,
            })
        }
        return responseSigs
    }

    setupCache (dataDuration = 0) {
        if (this._fallbackCache) {
            Log.warn(`Tried to re-initialize already initialized EDF signal cache.`, SCOPE)
        } else {
            this._fallbackCache = new BiosignalCache(dataDuration || this._totalDataLength || 0)
        }
        return this._fallbackCache
    }

    async setupMutex (buffer: SharedArrayBuffer, bufferStart: number): Promise<MutexExportProperties|null> {
        if (this._mutex) {
            Log.warn(`Tried to re-initialize already initialized DICOM signal cache.`, SCOPE)
            return this._mutex.propertiesForCoupling
        }
        if (!this._fileTypeHeader) {
            Log.error([`Cannot initialize mutex cache.`, `Dataset has not been set.`], SCOPE)
            return null
        }
        // Construct a SignalCachePart to initialize the mutex.
        const cacheProps = {
            start: 0,
            end: 0,
            signals: []
        } as SignalCachePart
        const ws = this._fileTypeHeader.WaveformSequence[0]
        for (const _sig of ws.ChannelDefinitionSequence) {
            cacheProps.signals.push({
                data: new Float32Array(),
                samplingRate: ws.SamplingFrequency,
            })
        }
        this._mutex = new BiosignalMutex()
        Log.debug(`Initiating DICOM reader mutex cache.`, SCOPE)
        this._mutex.initSignalBuffers(cacheProps, this._totalDataLength, buffer, bufferStart)
        Log.debug(`DICOM reader cache initiation complete.`, SCOPE)
        // Mutex is fully set up.
        this._isMutexReady = true
        return this._mutex.propertiesForCoupling
    }

    /**
     * Set the update callback to get loading updates.
     * @param callback A method that takes the loading update as a parameter.
     */
    setUpdateCallback (callback: ((update: { [prop: string]: unknown }) => void) | null) {
        this._updateCallback = callback
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
