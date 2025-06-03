/**
 * Epicurrents DICOM importer.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericFileReader } from '@epicurrents/core'
import type {
    BiosignalHeaderRecord,
    ConfigReadUrl,
    SignalFileReader,
    StudyContextFile,
    StudyFileContext,
} from '@epicurrents/core/dist/types'
import Log from 'scoped-event-log'

import * as dcmjs from 'dcmjs'

const SCOPE = 'DicomImporter'

export default class DicomImporter extends GenericFileReader implements SignalFileReader {
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

    async readFile (source: File | StudyFileContext, config?: ConfigReadUrl) {
        const file = (source as StudyFileContext).file || source as File
        Log.debug(`Loading DICOM from file ${file.webkitRelativePath}.`, SCOPE)
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
        try {
            const dcmBuffer = file.arrayBuffer()
            let DicomDict = dcmjs.data.DicomMessage.readFile(dcmBuffer)
            const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(DicomDict.dict)
            console.log(dataset)
            // Re-encode dataset: DicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
            // Get writer buffer: DicomDict.write()
        } catch (e: unknown) {
            Log.error(`DICOM header parsing error:`, SCOPE, e as Error)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }

    async readHeader (_source: ArrayBuffer): Promise<BiosignalHeaderRecord | null> {

        return null
    }

    async readUrl (source: string | StudyFileContext, config?: ConfigReadUrl) {
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
        try {
            const dicom = await fetch(url)
            const dcmBuffer = await dicom.arrayBuffer()
            let DicomDict = dcmjs.data.DicomMessage.readFile(dcmBuffer)
            const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(DicomDict.dict)
            console.log(dataset)
        } catch (e: unknown) {
            Log.error(`DICOM header parsing error:`, SCOPE, e as Error)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }
}
