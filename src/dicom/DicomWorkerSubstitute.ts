/**
 * Epicurrents DICOM worker substitute. Drives the DICOM reader on the main thread for environments
 * without SharedArrayBuffer / cross-origin isolation.
 *
 * The shared commissions are answered by {@link SignalReaderWorkerSubstitute}, which runs the
 * worker's own handlers, so the two cannot answer the same commission differently. What is added
 * here is `setup-worker`, the one commission where the formats differ, and it is the same method the
 * DICOM worker registers.
 *
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { SignalReaderWorkerSubstitute } from '@epicurrents/core'
import type { WorkerMessage, WorkerSubstitute } from '@epicurrents/core/types'
import { Log } from 'scoped-event-log'
import DicomReader from '#dicom/DicomReader'

const SCOPE = 'DicomWorkerSubstitute'

export default class DicomWorkerSubstitute extends SignalReaderWorkerSubstitute<DicomReader>
    implements WorkerSubstitute {

    constructor () {
        if (!window.__EPICURRENTS__?.RUNTIME) {
            Log.error(`Reference to main application was not found!`, SCOPE)
        }
        super(new DicomReader(window.__EPICURRENTS__.RUNTIME!.SETTINGS))
        this._reader.setUpdateCallback((update: { [prop: string]: unknown }) => {
            if (update.action === 'cache-signals') {
                this.returnMessage(update as WorkerMessage['data'])
            }
        })
        // The substitute binds an added handler to itself before registering it, so an entry passed
        // unbound here still runs with this substitute as its `this`.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        this.extendActionMap([['setup-worker', this.setupWorker]])
    }

    /**
     * Open the study the commission describes.
     * @param msgData - Data property from the commission.
     */
    async setupWorker (msgData: WorkerMessage['data']) {
        const data = this._validate(
            msgData as WorkerMessage['data'] & {
                authHeader?: string
                file?: File
                url?: string
            },
            {
                // A local study is read from the File and a remote one from the URL, so neither can
                // be required on its own; `setupStudy` rejects a source that has neither.
                authHeader: 'String?',
                file: 'File?',
                url: 'String?',
            }
        )
        if (!data) {
            return false
        }
        if (!await this._reader.setupStudy({ authHeader: data.authHeader, file: data.file, url: data.url })) {
            return this._failure(msgData, `Setting up study failed.`)
        }
        return this._success(msgData, {
            dataLength: this._reader.dataLength,
            recordingLength: this._reader.totalLength,
        })
    }
}
