/**
 * Epicurrents DICOM worker substitute. Allows using the DICOM reader in the main thread without an actual worker.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import DicomReader from '#dicom/DicomReader'
import { ServiceWorkerSubstitute } from '@epicurrents/core'
import { validateCommissionProps } from '@epicurrents/core/dist/util'
import type {
    ConfigChannelFilter,
    GetSignalsResponse,
    WorkerMessage,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'

const SCOPE = 'DicomWorkerSubstitute'

export default class DicomWorkerSubstitute extends ServiceWorkerSubstitute {
    protected _reader: DicomReader
    constructor () {
        super()
        if (!window.__EPICURRENTS__?.RUNTIME) {
            Log.error(`Reference to main application was not found!`, SCOPE)
        }
        this._reader = new DicomReader(window.__EPICURRENTS__.RUNTIME!.SETTINGS)
        const updateCallback = (update: { [prop: string]: unknown }) => {
            if (update.action === 'cache-signals') {
                this.returnMessage(update as WorkerMessage['data'])
            }
        }
        this._reader.setUpdateCallback(updateCallback)
    }
    async postMessage (message: WorkerMessage['data']) {
        if (!message?.action) {
            return
        }
        const action = message.action
        Log.debug(`Received message with action ${action}.`, SCOPE)
        switch (action) {
            case 'cache-signals': {
                try {
                    const success = await this._reader.cacheSignals()
                    return this.returnSuccess({
                        ...message,
                        complete: success,
                    })
                } catch (e) {
                    Log.error(
                        `An error occurred while trying to cache signals, operation was aborted.`,
                    SCOPE, e as Error)
                    return this.returnFailure(message)
                }
            }
            case 'get-signals': {
                // Extract job parameters.
                const data = validateCommissionProps(
                    message as WorkerMessage['data'] & {
                        config?: ConfigChannelFilter
                        range: number[]
                    },
                    {
                        config: 'Object?',
                        range: ['Number', 'Number'],
                    },
                    true,
                    this.returnMessage.bind(this)
                )

                if (!data) {
                    Log.error(`Invalid data for get-signals action.`, SCOPE)
                    return this.returnFailure(message)
                }
                try {
                    const sigs = await this._reader.getSignals(data.range, data.config)
                    const events = this._reader.getEvents(data.range)
                    const interruptions = this._reader.getInterruptions(data.range)
                    if (sigs) {
                        return this.returnSuccess({
                            ...message,
                            events,
                            interruptions,
                            ...sigs,
                        } as WorkerMessage['data'] & Omit<GetSignalsResponse, 'success'>)
                    } else {
                        Log.error(`Failed to get signals for range ${data.range.join('-')}.`, SCOPE)
                        return this.returnFailure(message)
                    }
                } catch (e) {
                    Log.error(`Getting signals failed.`, SCOPE, e as Error)
                    return this.returnFailure(message)
                }
            }
            case 'release-cache': {
                this._reader.releaseCache()
                return this.returnSuccess(message)
            }
            case 'setup-cache': {
                // Duration is not a mandatory property.
                const duration = (message.dataDuration as number) || 0
                const cache = this._reader.setupCache(duration)
                return this.returnSuccess({
                    ...message,
                    cacheProperties: cache,
                })
            }
            case 'setup-worker': {
                const data = validateCommissionProps(
                    message as WorkerMessage['data'] & {
                        url: string
                    },
                    {
                        url: 'String',
                    },
                    true,
                    this.returnMessage.bind(this)
                )
                if (!data) {
                    return
                }
                const result = await this._reader.setupStudy(data.url)
                if (result) {
                    return this.returnSuccess({
                        ...message,
                        dataLength: this._reader.dataLength,
                        recordingLength: this._reader.totalLength,
                    })
                } else {
                    return this.returnFailure(message)
                }
            }
            case 'shutdown':
            case 'decommission': {
                await this._reader.destroy()
                this._reader = null as unknown as DicomReader
                super.shutdown()
                return this.returnSuccess(message)
            }
            default: {
                super.postMessage(message)
            }
        }
    }
}
