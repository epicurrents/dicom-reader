/**
 * Epicurrents DICOM reader.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

//import type { DicomHeader } from '#types'
import { GenericSignalReader } from '@epicurrents/core'
import { AppSettings, BiosignalHeaderRecord, SignalDataReader } from '@epicurrents/core/dist/types'
import type { DicomHeader } from '#types'

export default class DicomReader extends GenericSignalReader implements SignalDataReader {
    /** A method to pass update messages through. */
    protected _updateCallback = null as ((update: { [prop: string]: unknown }) => void) | null
    /** Settings must be kept up-to-date with the main application. */
    SETTINGS: AppSettings

    constructor (settings: AppSettings) {
        super(Uint8Array)
        this.SETTINGS = settings
    }

    /**
     * Cache raw signals from the file at the given URL.
     * @returns Success (true/false).
     */
    async cacheSignalsFromUrl () {

    }

    /**
     * Set the update callback to get loading updates.
     * @param callback A method that takes the loading update as a parameter.
     */
    setUpdateCallback (callback: ((update: { [prop: string]: unknown }) => void) | null) {
        this._updateCallback = callback
    }

    /**
     * Set up study params for file loading. This will initializes the shared array buffer for storing
     * the signal data and can only be done once. This method will send the true recording duration
     * to the main thread as part of the worker response object (response.recordingLength).
     * @param header - General biosignal header.
     * @param dcmHeader - DICOM format-specific header.
     * @param url - Source URL of the DICOM data file.
     */
    async setupStudy (_header: BiosignalHeaderRecord, _dcmHeader: DicomHeader, _url: string): Promise<boolean> {
        return false
    }

}
