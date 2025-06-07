/**
 * Epicurrents DICOM worker.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { SETTINGS } from '@epicurrents/core'
import type {
    ConfigChannelFilter,
    WorkerMessage,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'
import { validateCommissionProps } from '@epicurrents/core/dist/util'
import DicomReader from '#dicom/DicomReader'


const SCOPE = "DicomWorker"

const READER = new DicomReader(SETTINGS)

onmessage = async (message: WorkerMessage) => {
    if (!message?.data?.action) {
        return
    }
    const { action, rn } = message.data
    /** Return a success response to the service. */
    const returnSuccess = (results?: { [key: string]: unknown }) => {
        postMessage({
            rn: rn,
            action: action,
            success: true,
            ...results
        })
    }
    /** Return a failure response to the service. */
    const returnFailure = (error: string | string[]) => {
        postMessage({
            rn: rn,
            action: action,
            success: false,
            error: error,
        })
    }
    Log.debug(`Received message with action ${action}.`, SCOPE)
    if (action === 'cache-signals-from-url') {
        try {
            const success = await cacheSignalsFromUrl()
            return returnSuccess({ complete: success })
        } catch (e) {
            Log.error(
                `An error occurred while trying to cache signals, operation was aborted.`,
            SCOPE, e as Error)
        }
    } else if (action === 'get-signals') {
        // The direct get-signals should only be encountered when the requested signals have not been cached yet,
        // so whenever raw signals are requested and very rarely in other cases. Thus no need to use a lot of
        // time to optimize this method.
        if (!READER.cacheReady) {
            return returnFailure(`Cannot return signals if signal cache is not yet initialized.`)
        }
        const data = validateCommissionProps(
            message.data as WorkerMessage['data'] & {
                config?: ConfigChannelFilter
                range: number[]
            },
            {
                config: ['Object', 'undefined'],
                range: ['Number', 'Number'],
            }
        )
        if (!data) {
            return
        }
        try {
            const sigs = await getSignals(data.range, data.config)
            const annos = getAnnotations(data.range)
            if (sigs) {
                return returnSuccess({
                    annotations: annos,
                    interruptions: [],
                    range: message.data.range,
                    ...sigs
                })
            } else {
                return returnFailure(`Reader did not return any signals.`)
            }
        } catch (e) {
            return returnFailure(e as string)
        }
    } else if (action === 'release-cache') {
        await READER.releaseCache()
        return returnSuccess()
    } else if (action === 'setup-cache') {
        if (message.data.useMemoryManager) {
            const data = validateCommissionProps(
                message.data as WorkerMessage['data'] & {
                    buffer: SharedArrayBuffer
                    range: { start: number }
                },
                {
                    buffer: 'SharedArrayBuffer',
                    range: 'Object',
                }
            )
            if (!data) {
                return
            }
            const exportProps = await READER.setupMutex(data.buffer, data.range.start)
            if (exportProps) {
                // Pass the generated shared buffers back to main thread.
                return returnSuccess({
                    cacheProperties: exportProps,
                })
            } else {
                return returnFailure(`Mutex setup failed.`)
            }
        } else {
            const success = READER.setupCache()
            if (success) {
                return returnSuccess()
            } else {
                return returnFailure(`Cache setup failed.`)
            }
        }
    } else if (action === 'setup-worker') {
        const data = validateCommissionProps(
            message.data as WorkerMessage['data'] & {
                url: string
            },
            {
                url: 'String',
            }
        )
        if (!data) {
            Log.error(`Invalid data for setup-worker action.`, SCOPE)
            return returnFailure(`Validating commission props failed.`)
        }
        if (await setupStudy(data.url)) {
            return returnSuccess({
                dataLength: READER.dataLength,
                recordingLength: READER.totalLength,
            })
        } else {
            Log.error(`Setting up study failed.`, SCOPE)
            return returnFailure(`Setting up study failed.`)
        }
    } else if (action === 'shutdown') {
        await READER.releaseCache()
    } else if (action === 'update-settings') {
        const data = validateCommissionProps(
            message.data,
            {
                settings: 'Object',
            }
        )
        if (!data) {
            return
        }
        Object.assign(SETTINGS, data.settings)
        return returnSuccess()
    }
}

const updateCallback = (update: { [prop: string]: unknown }) => {
    if (update.action === 'cache-signals') {
        postMessage(update)
    }
}
READER.setUpdateCallback(updateCallback)

const getAnnotations = (range: number[]) => {
    return READER.getAnnotations(range)
}

const getSignals = (range: number[], config?: ConfigChannelFilter) => {
    return READER.getSignals(range, config)
}

/**
 * Cache raw signals from the file at the preset URL.
 * @param startFrom - Start caching from the given time point (in seconds) - optional.
 * @returns Success (true/false).
 */
const cacheSignalsFromUrl = () => {
    return READER.cacheUrl()
}

const setupStudy = async (url: string) => {
    return READER.setupStudy(url)
}
