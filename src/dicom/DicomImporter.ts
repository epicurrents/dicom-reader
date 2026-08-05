/**
 * Epicurrents DICOM importer.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericStudyImporter } from '@epicurrents/core'
import type {
    BiosignalHeaderRecord,
    ConfigReadUrl,
    SignalStudyImporter,
    StudyContextFile,
    StudyFileContext,
} from '@epicurrents/core/dist/types'
import { headerToBiosignalHeader } from '#util'
import type { DicomDataset } from '#types'
import { Log } from 'scoped-event-log'
import * as dcmjs from 'dcmjs'

const SCOPE = 'DicomImporter'

export default class DicomImporter extends GenericStudyImporter implements SignalStudyImporter {
    //protected _decoder = new DicomDecoder()
    protected _useSAB: boolean

    constructor (useSAB = false) {
        const fileTypeAssocs = [
            {
                accept: {
                    "application/octet-stream": ['.dcm'],
                },
                description: "DICOM",
            },
        ]
        super(SCOPE, [], fileTypeAssocs)
        this._useSAB = useSAB
        //this._getWorkerSubstitute = () => new DicomWorkerSubstitute()
    }

    protected _readAndStoreMetadata (dataset: DicomDataset) {
        if (!this._study) {
            Log.error('No study available to insert channel info into.', SCOPE)
            return
        }
        if (!dataset.WaveformSequence || !dataset.WaveformSequence[0]) {
            Log.error('No waveform sequence found in the DICOM dataset.', SCOPE)
            return
        }
        const ws = dataset.WaveformSequence[0]
        const channels = []
        for (const c of ws.ChannelDefinitionSequence || []) {
            const cSensitivity = (c.ChannelSensitivity || 1)*(c.ChannelSensitivityCorrectionFactor || 1)
            channels.push({
                channelNumber: c.WaveformChannelNumber || 0,
                filter: {
                    bandreject: [],
                    highpass: c.FilterHighFrequency || 0,
                    lowpass: c.FilterLowFrequency || 0,
                    notch: c.NotchFilterFrequency || 0,
                },
                label: c.ChannelLabel || '',
                name: c.ChannelLabel || '',
                physicalMax: 32767*cSensitivity,
                physicalMin: -32768*cSensitivity,
                sampleCount: ws.NumberOfWaveformSamples || 0,
                samplesPerRecord: 1,
                samplingRate: ws.SamplingFrequency || 0,
                scale: 0, // Scale here is always 0 as we convert the source signals into volts.
                sensitivity: 0, // DICOM channel sensitivity is not the same as EC source channel sensitivity.
                signal: new Float32Array(),
                transducer: '', // Unknown.
                unit: c.ChannelSensitivityUnitsSequence[0].CodeValue || '',
            })
        }
        const datasetHeader = { ...dataset }
        datasetHeader.WaveformSequence[0].WaveformData.length = 0 // Remove the actual data to save memory.
        this._study.meta = {
            channels,
            header: headerToBiosignalHeader(dataset),
            formatHeader: null, // The DICOM dataset is not serializable so we won't return it in case this is a worker.
        }
        this._study.format = 'dicom'
        this._study.modality = 'signal'
    }

    getFileTypeWorker (override?: string): Worker | null {
        //if (override === 'substitute') {
        //    return this._getWorkerSubstitute()
        //}
        const getWorkerOverride = this._workerOverrides.get(override || 'dicom')
        const worker = getWorkerOverride ? getWorkerOverride() : new Worker(
            /* webpackChunkName: 'dicom.worker' */
            new URL('../workers/dicom.worker', import.meta.url),
            { type: 'module' }
        )
        Log.registerWorker(worker)
        return worker
    }

    async importFile (source: File | StudyFileContext, config?: ConfigReadUrl) {
        const file = (source as StudyFileContext).file || source as File
        Log.debug(`Loading DICOM from file ${file.webkitRelativePath || file.name}.`, SCOPE)
        const studyFile = {
            file: file,
            format: 'dicom',
            mime: config?.mime || file.type || null,
            name: config?.name || file.name || '',
            partial: false,
            range: [],
            role: 'data',
            modality: 'signal',
            url: config?.url || URL.createObjectURL(file),
        } as StudyContextFile
        this._study.files.push(studyFile)
        const dicom = await dcmjs.data.DicomMessage.readFile(file.arrayBuffer())
        const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict) as DicomDataset
        this._readAndStoreMetadata(dataset)
        return studyFile
    }

    async readHeader (_source: ArrayBuffer): Promise<BiosignalHeaderRecord | null> {
        return null
    }

    async importUrl (source: string | StudyFileContext, config?: ConfigReadUrl) {
        const url = (source as StudyFileContext).url || source as string
        Log.debug(`Loading DICOM from url ${url}.`, SCOPE)
        const studyFile = {
            file: null,
            format: 'dicom',
            mime: config?.mime || null,
            name: config?.name || '',
            partial: false,
            range: [],
            role: 'data',
            modality: 'signal',
            url: config?.url || url,
        } as StudyContextFile
        this._study.files.push(studyFile)
        try {
            // We need to get the whole file to read the header.
            const arrayBuffer = await this._fetchArrayBuffer(url, { authHeader: config?.authHeader })
            const dicom = await dcmjs.data.DicomMessage.readFile(arrayBuffer)
            const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict) as DicomDataset
            this._readAndStoreMetadata(dataset)
        } catch (e: unknown) {
            Log.error(`DICOM header parsing error:`, SCOPE, e as Error)
            return null
        }
        return studyFile
    }
}
